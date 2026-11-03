import { describe, expect, it, vi } from 'vitest';
import { CyberBossBridgeClient } from '../../src/main/adapters/CyberBossBridgeClient';
import { ExistingThreadAdapter } from '../../src/main/adapters/ExistingThreadAdapter';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';

const threadId = '01a08723-bee6-7640-8917-28257cf5d1ab';

function responseStream(text: string) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } }), { status: 200 });
}

describe('ExistingThreadAdapter', () => {
  it('binds the fixed existing thread and maps typing plus assistant events', async () => {
    let reconnected = false;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/auth')) return new Response('{}', { status: 200, headers: { 'Set-Cookie': 'cyberboss_web_session=s; Secure' } });
      if (url.endsWith('/api/session')) return new Response('{}', { status: 200 });
      if (url.endsWith('/api/messages')) return new Response('{}', { status: 202 });
      if (url.endsWith('/api/events?lastEventId=4')) {
        reconnected = true;
        return responseStream([
          'id: 4\nevent: chat\ndata: {"role":"assistant","text":"宝宝，我在～","clientMessageId":null}\n\n',
          'id: 5\nevent: chat\ndata: {"role":"assistant","text":"这是工具后的回复","clientMessageId":null}\n\n',
          'id: 6\nevent: chat\ndata: {"role":"user","text":"其他客户端发送的新消息","clientMessageId":"other"}\n\n',
          'id: 7\nevent: chat\ndata: {"role":"assistant","text":"其他轮回复","clientMessageId":null}\n\n',
        ].join(''));
      }
      if (url.includes('/api/events')) return responseStream([
        'id: 1\nevent: chat\ndata: {"role":"assistant","text":"更早的回复","status":"","clientMessageId":"","createdAt":"","media":[]}\n\n',
        'id: 2\nevent: chat\ndata: {"role":"user","text":"在吗？","status":"","clientMessageId":"client-stable","createdAt":"","media":[]}\n\n',
        'id: 3\nevent: chat\ndata: {"role":"status","text":"","status":"typing","clientMessageId":"","createdAt":"","media":[]}\n\n',
        'id: 4\nevent: chat\ndata: {"role":"assistant","text":"宝宝，我在～","status":"","clientMessageId":"","createdAt":"","media":[]}\n\n',
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
    expect(events.find((event) => event.type === 'text.delta')).toMatchObject({ text: '宝宝，我在～' });
    expect(events.some((event) => event.type === 'text.delta' && event.text === '更早的回复')).toBe(false);
    try {
      await vi.waitFor(() => expect(onReply).toHaveBeenCalledWith(command, threadId, expect.objectContaining({ id: '5', text: '这是工具后的回复' })));
      expect(reconnected).toBe(true);
      expect(onReply).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.dispose();
    }
    expect(adapter.capabilities.cancellation).toBe(false);
  });
});
