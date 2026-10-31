import { describe, expect, it, vi } from 'vitest';
import { ApiPartnerAdapter } from '../../src/main/adapters/ApiPartnerAdapter';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';

function command(): SendMessageCommand {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'message.send',
    commandId: 'command-api',
    partnerId: 'partner-api',
    conversationId: 'conversation-api',
    connectionSource: 'api_partner',
    clientMessageId: 'client-api',
    content: { type: 'text', text: '现在的问题' },
    apiContext: { systemPrompt: '保持简洁', history: [{ role: 'user', content: '之前的问题' }, { role: 'assistant', content: '之前的回答' }] },
  };
}

function streamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(adapter: ApiPartnerAdapter) {
  const events: PartnerEvent[] = [];
  for await (const event of adapter.sendMessage(command())) events.push(event);
  return events;
}

describe('ApiPartnerAdapter', () => {
  it('seeds legacy text safely and streams reasoning separately from answer text', async () => {
    let requestInit: RequestInit | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      requestInit = init;
      return streamResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"private"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"，用户"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
      ]);
    });
    const adapter = new ApiPartnerAdapter({ endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', apiKey: 'test-secret', fetcher });
    const events = await collect(adapter);

    const request = requestInit!;
    expect(request.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer test-secret' }));
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: 'deepseek-v4-flash', stream: true,
      messages: [
        { role: 'system', content: '保持简洁' },
        { role: 'system', content: expect.stringContaining('用户：之前的问题') },
        { role: 'system', content: expect.stringContaining('[本轮工具状态]') },
        { role: 'user', content: '现在的问题' },
      ],
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning.started', summary: 'DeepSeek 正在思考…' }),
      expect.objectContaining({ type: 'reasoning.delta', text: 'private' }),
      expect.objectContaining({ type: 'reasoning.completed', outcome: 'completed' }),
    ]));
    expect(events.filter((event) => event.type === 'text.delta').map((event) => event.text).join('')).toBe('你好，用户');
    expect(events.some((event) => event.type.startsWith('tool.') || event.type === 'file.produced')).toBe(false);
    expect(events.at(-1)?.type).toBe('run.completed');
  });

  it.each([
    [401, 'DEEPSEEK_AUTH_FAILED'],
    [429, 'DEEPSEEK_RATE_LIMITED'],
    [503, 'DEEPSEEK_UNAVAILABLE'],
  ])('maps HTTP %s to %s', async (status, code) => {
    const adapter = new ApiPartnerAdapter({ endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', apiKey: 'test-secret', fetcher: vi.fn(async () => new Response(JSON.stringify({ error: { message: 'upstream echoed test-secret' } }), { status })) });
    const events = await collect(adapter);
    expect(events.at(-1)).toMatchObject({ type: 'run.failed', error: { code } });
    expect(JSON.stringify(events.at(-1))).not.toContain('test-secret');
  });

  it('reports malformed and interrupted SSE streams', async () => {
    const malformed = new ApiPartnerAdapter({ endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', apiKey: 'x', fetcher: vi.fn(async () => streamResponse(['data: {oops}\n\n'])) });
    expect((await collect(malformed)).at(-1)).toMatchObject({ type: 'run.failed', error: { code: 'DEEPSEEK_MALFORMED_SSE' } });
    const interrupted = new ApiPartnerAdapter({ endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', apiKey: 'x', fetcher: vi.fn(async () => streamResponse(['data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'])) });
    expect((await collect(interrupted)).at(-1)).toMatchObject({ type: 'run.failed', error: { code: 'DEEPSEEK_STREAM_INTERRUPTED' } });
  });

  it.each([
    ['content_filter', 'DEEPSEEK_CONTENT_FILTERED'],
    ['insufficient_system_resource', 'DEEPSEEK_CAPACITY'],
  ])('maps finish reason %s through the provider policy', async (finishReason, code) => {
    const adapter = new ApiPartnerAdapter({
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-flash',
      apiKey: 'x',
      fetcher: vi.fn(async () => streamResponse([
        `data: {"choices":[{"delta":{},"finish_reason":"${finishReason}"}]}\n\n`,
        'data: [DONE]\n\n',
      ])),
    });
    expect((await collect(adapter)).at(-1)).toMatchObject({ type: 'run.failed', error: { code } });
  });

  it('reports a network failure without exposing fetch details', async () => {
    const adapter = new ApiPartnerAdapter({
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-flash',
      apiKey: 'x',
      fetcher: vi.fn(async () => { throw new Error('proxy included a sensitive URL'); }),
    });
    const event = (await collect(adapter)).at(-1);
    expect(event).toMatchObject({ type: 'run.failed', error: { code: 'DEEPSEEK_NETWORK_ERROR' } });
    expect(JSON.stringify(event)).not.toContain('sensitive URL');
  });

  it('aborts the active request and emits cancellation', async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const adapter = new ApiPartnerAdapter({ endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', apiKey: 'x', fetcher });
    const iterator = adapter.sendMessage(command())[Symbol.asyncIterator]();
    const bound = (await iterator.next()).value!;
    const pending = iterator.next();
    await adapter.cancel({
      protocolVersion: AGENT_PROTOCOL_VERSION, type: 'run.cancel', commandId: 'cancel-api', partnerId: bound.partnerId,
      conversationId: bound.conversationId, connectionSource: 'api_partner', clientMessageId: bound.clientMessageId,
      runId: bound.runId, sessionId: bound.sessionId,
    });
    expect((await pending).value).toMatchObject({ type: 'run.cancelled' });
  });
});
