// @vitest-environment node
import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatCompletionsAdapter } from '../../src/main/adapters/ChatCompletionsAdapter';
import { apiEndpoint, apiModelsEndpoint } from '../../src/shared/apiEndpoints';
import { apiFetch, ApiHttpError } from '../../src/main/api/ApiHttpTransport';
import type { ApiProviderStreamEvent } from '../../src/main/api/ApiProviderAdapter';
const servers: Server[] = [];
afterEach(async () => { vi.useRealTimers(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function server(handler: RequestListener) {
  const value = createServer(handler); servers.push(value);
  await new Promise<void>(resolve => value.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(value.address() as { port: number }).port}`;
}
const collect = async (iterable: AsyncIterable<ApiProviderStreamEvent>) => { const events = []; for await (const event of iterable) events.push(event); return events; };
describe('generic Chat Completions', () => {
  it('resolves base, versioned and complete endpoints without repeating a version', () => {
    for (const source of ['https://example.com', 'https://example.com/v1', 'https://example.com/v1/', 'https://example.com/v1/chat/completions']) expect(apiEndpoint(source, 'chat_completions')).toBe('https://example.com/v1/chat/completions');
    expect(apiEndpoint('https://example.com/custom/v2', 'chat_completions')).toBe('https://example.com/custom/v2/chat/completions');
    expect(apiEndpoint('https://example.com/v1', 'chat_completions', '/proxy/chat')).toBe('https://example.com/proxy/chat');
    expect(apiModelsEndpoint('https://example.com/v1/chat/completions', 'chat_completions')).toBe('https://example.com/v1/models');
    expect(() => apiEndpoint('https://example.com/v1/messages', 'chat_completions')).toThrow('CONFLICT');
    expect(() => apiEndpoint('https://user:secret@example.com', 'chat_completions')).toThrow('INVALID');
  });
  it('sends exact model and authentication to a real local HTTP server, handles fragmented UTF-8 and tools', async () => {
    let captured: any;
    const base = await server(async (req, res) => {
      let body = ''; for await (const part of req) body += part;
      captured = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = [ { choices: [{ index: 0, delta: { content: '你好' } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'read_file', arguments: '{"path":' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: 'tool_calls' }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } } ];
      const bytes = Buffer.from(chunks.map(data => `data: ${JSON.stringify(data)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
      for (let index = 0; index < bytes.length; index += 5) res.write(bytes.subarray(index, index + 5)); res.end();
    });
    const adapter = new ChatCompletionsAdapter({ endpoint: base, model: 'arbitrary-model-id', apiKey: 'fixture-key' });
    const events = await collect(adapter.stream({ signal: new AbortController().signal, messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }] }));
    expect(captured).toMatchObject({ path: '/v1/chat/completions', auth: 'Bearer fixture-key', body: { model: 'arbitrary-model-id', stream: true } });
    expect(captured.body).not.toHaveProperty('temperature'); expect(captured.body).not.toHaveProperty('thinking');
    expect(events).toContainEqual({ type: 'text.delta', text: '你好' });
    expect(events.filter(e => e.type === 'tool.delta')).toHaveLength(2);
    expect(events).toContainEqual({ type: 'finish', reason: 'tool_calls' });
  });
  it('supports non-streaming responses and never retries a failed model request', async () => {
    let count = 0;
    const base = await server(async (req, res) => { let body = ''; for await (const part of req) body += part; count++; const data = JSON.parse(body); expect(data.stream).toBe(false); res.writeHead(count === 1 ? 200 : 429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })); });
    const adapter = new ChatCompletionsAdapter({ endpoint: base, model: 'm', apiKey: 'fixture', stream: false });
    const request = { signal: new AbortController().signal, messages: [], tools: [] };
    expect(await collect(adapter.stream(request))).toContainEqual({ type: 'text.delta', text: 'OK' });
    await expect(collect(adapter.stream(request))).rejects.toBeInstanceOf(ApiHttpError); expect(count).toBe(2);
  });
  it('bounds only the header wait and honors cancellation after connection', async () => {
    vi.useFakeTimers();
    const pending = apiFetch('https://fixture.invalid', { signal: new AbortController().signal }, vi.fn(() => new Promise<Response>(() => undefined)), 100);
    const rejection = expect(pending).rejects.toThrow(); await vi.advanceTimersByTimeAsync(101); await rejection;
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')); } }));
    const adapter = new ChatCompletionsAdapter({ endpoint: 'https://fixture.invalid', model: 'm', apiKey: 'fixture', fetcher: vi.fn(async () => response) });
    const iterator = adapter.stream({ signal: controller.signal, messages: [], tools: [] })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'text.delta', text: 'x' });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(controller.signal.aborted).toBe(false);
    const next = iterator.next(); const canceled = expect(next).rejects.toThrow(); controller.abort(); await canceled;
  });
});
