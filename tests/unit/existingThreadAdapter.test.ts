import { describe, expect, it, vi } from 'vitest';
import { CyberBossBridgeClient } from '../../src/main/adapters/CyberBossBridgeClient';
import { ExistingThreadAdapter } from '../../src/main/adapters/ExistingThreadAdapter';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';

const threadId = '00000000-0000-7000-8000-000000000001';

function responseStream(text: string) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } }), { status: 200 });
}

describe('ExistingThreadAdapter', () => {
  it.each(['accepted', 'upload failed', 'thread changed'] as const)(
    'sends image-only messages through the media API, including %s', async (scenario) => {
      const bytes = new Uint8Array([137, 80, 78, 71]);
      const attachment = { id: 'image-1', name: '样图.png', mediaType: 'image/png', sizeBytes: bytes.length };
      const readImage = vi.fn(async () => bytes);
      const calls: string[] = [];
      let sessionReads = 0;
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname === '/api/auth') return new Response('{}', { headers: { 'Set-Cookie': 'cyberboss_web_session=s; Secure' } });
        if (url.pathname === '/api/session') {
          const current = ++sessionReads === 2 && scenario === 'thread changed' ? 'other-thread' : threadId;
          return Response.json({ threadId: current });
        }
        if (url.pathname === '/api/media') {
          expect(init?.method).toBe('POST');
          expect(init?.redirect).toBe('error');
          expect(new Headers(init?.headers).get('origin')).toBe('https://cyberboss.example.invalid');
          expect(new Headers(init?.headers).get('cookie')).toBe('cyberboss_web_session=s');
          expect(new Headers(init?.headers).get('content-type')).toBe('image/png');
          expect(new Headers(init?.headers).get('x-file-name-b64')).toBe(Buffer.from(attachment.name).toString('base64url'));
          expect(init?.body).toEqual(bytes);
          if (scenario === 'upload failed') return new Response('{}', { status: 415 });
          return Response.json({ ok: true, media: { mediaId: 'image-ref' } }, { status: 201 });
        }
        if (url.pathname === '/api/messages') {
          expect(JSON.parse(String(init?.body))).toEqual({ text: '', clientMessageId: 'client-image', mediaIds: ['image-ref'] });
          return new Response('{}', { status: 202 });
        }
        if (url.pathname === '/api/events') return responseStream([
          'id: 1\nevent: chat\ndata: {"role":"user","text":"","clientMessageId":"client-image","media":[{}]}\n\n',
          'id: 2\nevent: chat\ndata: {"role":"assistant","text":"收到图片。"}\n\n',
        ].join(''));
        throw new Error('unexpected endpoint');
      });
      const adapter = new ExistingThreadAdapter(new CyberBossBridgeClient({
        serviceUrl: 'https://cyberboss.example.invalid', secret: 'synthetic', fetcher,
      }), threadId, undefined, readImage);
      const events: PartnerEvent[] = [];
      for await (const event of adapter.sendMessage({
        protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'command', partnerId: 'external', conversationId: 'conversation',
        connectionSource: 'existing_thread', clientMessageId: 'client-image', sessionId: threadId, messageId: 'message-image',
        content: { type: 'text', text: '' }, attachments: [attachment],
      })) events.push(event);

      if (scenario === 'accepted') {
        expect(readImage).toHaveBeenCalledWith('image-1', 'conversation', 'message-image');
        expect(calls).toEqual(['/api/auth', '/api/session', '/api/media', '/api/session', '/api/events', '/api/messages']);
        expect(events.at(-1)).toMatchObject({ type: 'run.completed' });
      } else {
        expect(calls).not.toContain('/api/messages');
        expect(calls).toContain('/api/media');
        expect(events.at(-1)).toMatchObject({ type: 'run.failed', error: { code: {
          'upload failed': 'CYBERBOSS_CHAT_IMAGE_UPLOAD_FAILED',
          'thread changed': 'CYBERBOSS_CHAT_THREAD_CHANGED',
        }[scenario] } });
      }
    },
  );

  it.each(['mixed', 'files only', 'upload rejected', 'thread changed', 'retry', 'uncertain', 'over total', 'unsupported host'] as const)(
    'routes ordinary chat attachments as one message (%s)', async scenario => {
      const bytes = new TextEncoder().encode('# hello');
      const file = { id: 'local-file', name: '方案.md', mediaType: 'text/markdown', sizeBytes: bytes.length };
      const image = { id: 'local-image', name: '截图.png', mediaType: 'image/png', sizeBytes: bytes.length };
      const includeImage = scenario !== 'files only';
      const calls: string[] = [];
      const submissions: unknown[] = [];
      const threadMismatch = { error: 'thread_changed' };
      const remoteFile = { kind: 'file', attachmentId: 'remote-file', fileName: file.name, contentType: file.mediaType, sizeBytes: file.sizeBytes, url: '/api/attachments/remote-file' };
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname;
        calls.push(pathname);
        if (pathname === '/api/auth') return new Response('{}', { headers: { 'Set-Cookie': 'cyberboss_web_session=s; Secure' } });
        if (pathname === '/api/attachments/capabilities') {
          if (scenario === 'unsupported host') return new Response(null, { status: 404 });
          return Response.json({
            ok: true,
            files: { version: 1, maxFileBytes: 20_971_520, maxAttachmentsPerMessage: 10, maxTotalBytes: scenario === 'over total' ? 10 : 52_428_800,
              uncommittedTtlSeconds: 3600, mixedWithImages: true, types: [{ extension: '.md', contentType: 'text/markdown' }] },
            images: { maxFileBytes: 10_485_760, maxImagesPerMessage: 4 },
          });
        }
        if (pathname === '/api/session') return Response.json({ threadId });
        if (pathname === '/api/media') return Response.json({ ok: true, media: { mediaId: 'remote-image' } }, { status: 201 });
        if (pathname === '/api/attachments') {
          const headers = new Headers(init?.headers);
          expect(Array.from(init?.body as Uint8Array)).toEqual(Array.from(bytes));
          expect(headers.get('content-type')).toBe('text/markdown');
          expect(headers.get('x-cyberboss-thread-id')).toBe(threadId);
          expect(headers.get('x-file-name-b64')).toBe(Buffer.from(file.name).toString('base64url'));
          expect(headers.get('origin')).toBe('https://cyberboss.example.invalid');
          expect(headers.get('cookie')).toBe('cyberboss_web_session=s');
          if (scenario === 'upload rejected') return Response.json({ error: 'attachment_signature_mismatch' }, { status: 400 });
          return Response.json({ ok: true, threadId, attachment: remoteFile }, { status: 201 });
        }
        if (pathname === '/api/messages') {
          submissions.push(JSON.parse(String(init?.body)));
          if (scenario === 'thread changed') return Response.json(threadMismatch, { status: 409 });
          if (scenario === 'uncertain' || (scenario === 'retry' && submissions.length === 1)) throw new TypeError('mock network interruption');
          return Response.json({
            ok: true, clientMessageId: 'client-file', duplicate: submissions.length > 1,
            message: { role: 'user', clientMessageId: 'client-file', media: [], attachments: [remoteFile] },
          }, { status: 202 });
        }
        if (pathname === '/api/events') return responseStream([
          `id: 1\nevent: chat\ndata: ${JSON.stringify({ role: 'user', text: '', clientMessageId: 'client-file', attachments: [remoteFile] })}\n\n`,
          'id: 2\nevent: chat\ndata: {"role":"assistant","text":"收到文件。"}\n\n',
        ].join(''));
        throw new Error('unexpected endpoint');
      });
      const client = new CyberBossBridgeClient({ serviceUrl: 'https://cyberboss.example.invalid', secret: 'synthetic', fetcher });
      const readAttachment = vi.fn(async () => bytes);
      const adapter = new ExistingThreadAdapter(client, threadId, undefined, readAttachment);
      const events: PartnerEvent[] = [];
      const text = includeImage ? '请看图和文件' : '';
      for await (const event of adapter.sendMessage({
        protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'command', partnerId: 'external', conversationId: 'conversation',
        connectionSource: 'existing_thread', clientMessageId: 'client-file', sessionId: threadId, messageId: 'message-file',
        content: { type: 'text', text }, attachments: includeImage ? [image, file] : [file],
      })) events.push(event);

      const expected = { text, clientMessageId: 'client-file', threadId, mediaIds: includeImage ? ['remote-image'] : [], attachmentIds: ['remote-file'] };
      if (scenario === 'mixed' || scenario === 'files only' || scenario === 'retry') {
        expect(submissions, JSON.stringify({ calls, lastEvent: events.at(-1) })).toEqual(scenario === 'retry' ? [expected, expected] : [expected]);
        expect(calls.filter(path => path === '/api/attachments')).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({ type: 'run.completed' });
      } else {
        expect(submissions).toEqual(scenario === 'uncertain' ? [expected, expected] : scenario === 'thread changed' ? [expected] : []);
        if (scenario === 'over total' || scenario === 'unsupported host') expect(readAttachment).not.toHaveBeenCalled();
        expect(events.at(-1)).toMatchObject({ type: 'run.failed', error: { code: {
          'upload rejected': 'CYBERBOSS_CHAT_FILE_SIGNATURE',
          'thread changed': 'CYBERBOSS_CHAT_THREAD_CHANGED',
          uncertain: 'CYBERBOSS_CHAT_MESSAGE_UNCERTAIN',
          'over total': 'CYBERBOSS_CHAT_TOTAL_SIZE',
          'unsupported host': 'CYBERBOSS_CHAT_FILE_UNAVAILABLE',
        }[scenario] } });
      }
    },
  );

  it('keeps follow-ups through a repeated own echo after reconnect and stops at a different user turn', async () => {
    let reconnected = false;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/auth')) return new Response('{}', { status: 200, headers: { 'Set-Cookie': 'cyberboss_web_session=s; Secure' } });
      if (url.endsWith('/api/session')) return new Response('{}', { status: 200 });
      if (url.endsWith('/api/messages')) return new Response('{}', { status: 202 });
      if (url.endsWith('/api/events?lastEventId=4')) {
        reconnected = true;
        return responseStream([
          'id: 4\nevent: chat\ndata: {"role":"assistant","text":"示例用户，我在～","clientMessageId":null}\n\n',
          'id: 5\nevent: chat\ndata: {"role":"user","text":"在吗？","clientMessageId":"client-stable"}\n\n',
          'id: 6\nevent: chat\ndata: {"role":"assistant","text":"这是工具后的回复","clientMessageId":null}\n\n',
          'id: 7\nevent: chat\ndata: {"role":"user","text":"其他客户端发送的新消息","clientMessageId":"other"}\n\n',
          'id: 8\nevent: chat\ndata: {"role":"assistant","text":"其他轮回复","clientMessageId":null}\n\n',
        ].join(''));
      }
      if (url.includes('/api/events')) return responseStream([
        'id: 1\nevent: chat\ndata: {"role":"assistant","text":"更早的回复","status":"","clientMessageId":"","createdAt":"","media":[]}\n\n',
        'id: 2\nevent: chat\ndata: {"role":"user","text":"在吗？","status":"","clientMessageId":"client-stable","createdAt":"","media":[]}\n\n',
        'id: 3\nevent: chat\ndata: {"role":"status","text":"","status":"typing","clientMessageId":"","createdAt":"","media":[]}\n\n',
        'id: 4\nevent: chat\ndata: {"role":"assistant","text":"示例用户，我在～","status":"","clientMessageId":"","createdAt":"","media":[]}\n\n',
      ].join(''));
      throw new Error(`unexpected ${url}`);
    });
    const onReply = vi.fn();
    const adapter = new ExistingThreadAdapter(new CyberBossBridgeClient({
      serviceUrl: 'https://cyberboss.example.invalid', secret: 'x', fetcher, reconnectDelay: async () => undefined,
    }), threadId, onReply);
    const command: SendMessageCommand = {
      protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'command', partnerId: 'external', conversationId: 'conversation',
      connectionSource: 'existing_thread', clientMessageId: 'client-stable', sessionId: threadId, content: { type: 'text', text: '在吗？' },
    };
    const events: PartnerEvent[] = [];
    for await (const event of adapter.sendMessage(command)) events.push(event);
    expect(events[0]).toMatchObject({ type: 'session.bound', sessionId: threadId, isNew: false });
    expect(events.map((event) => event.type)).toEqual(['session.bound', 'message.accepted', 'work.status', 'text.delta', 'work.status', 'run.completed']);
    expect(events.find((event) => event.type === 'text.delta')).toMatchObject({ text: '示例用户，我在～' });
    expect(events.some((event) => event.type === 'text.delta' && event.text === '更早的回复')).toBe(false);
    try {
      await vi.waitFor(() => expect(onReply).toHaveBeenCalledWith(command, threadId, expect.objectContaining({ id: '6', text: '这是工具后的回复' })));
      expect(reconnected).toBe(true);
      expect(onReply).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.dispose();
    }
    expect(adapter.capabilities.cancellation).toBe(false);
  });
});
