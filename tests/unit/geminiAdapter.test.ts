// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GeminiAdapter, geminiInput } from '../../src/main/adapters/GeminiAdapter';
import { geminiEndpoint } from '../../src/shared/apiEndpoints';
import type { ApiProviderStreamEvent } from '../../src/main/api/ApiProviderAdapter';
const options = { endpoint: 'https://fixture.invalid', model: 'models/model-id', apiKey: 'fixture', bindingKey: 'b' };
async function collect(stream: AsyncIterable<ApiProviderStreamEvent>) { const result = []; for await (const item of stream) result.push(item); return result; }
const request = { messages: [], tools: [], signal: new AbortController().signal };
describe('Gemini native Generate Content', () => {
  it('encodes model IDs and versioned/full paths and detects conflicting endpoint model IDs', () => {
    expect(geminiEndpoint(options.endpoint, 'models/model-id', true)).toBe('https://fixture.invalid/v1beta/models/model-id:streamGenerateContent?alt=sse');
    expect(geminiEndpoint('https://fixture.invalid/v1beta/models/model-id:streamGenerateContent?alt=sse', 'model-id', false)).toBe('https://fixture.invalid/v1beta/models/model-id:generateContent');
    expect(geminiEndpoint('https://fixture.invalid/v1', 'name/with/slash', false)).toBe('https://fixture.invalid/v1/models/name%2Fwith%2Fslash:generateContent');
    expect(geminiEndpoint('https://fixture.invalid', 'model-id', false, '/proxy/{model}:{method}')).toBe('https://fixture.invalid/proxy/model-id:generateContent');
    expect(() => geminiEndpoint('https://fixture.invalid/v1beta/models/other:generateContent', 'model-id', false)).toThrow('MODEL_ENDPOINT_CONFLICT');
  });
  it('keeps original signature-bearing parts, maps native tool IDs and leaves opaque data out of public output', async () => {
    const parts = [{ text: '公开思考', thought: true }, { functionCall: { id: 'native-call', name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'opaque-fixture' }, { text: '', thoughtSignature: 'final-fixture' }];
    const fetcher = vi.fn(async () => new Response(parts.map((part, index) => `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [part] }, ...(index === 2 ? { finishReason: 'STOP' } : {}) }] })}\n\n`).join('')));
    const result = await collect(new GeminiAdapter({ ...options, fetcher }).stream(request));
    expect(result).toContainEqual({ type: 'tool.delta', index: 0, id: 'native-call', name: 'read_file', arguments: '{"path":"a"}' });
    expect(JSON.stringify(result.filter(e => e.type !== 'native.state'))).not.toContain('opaque-fixture');
    const native = result.find(e => e.type === 'native.state')!;
    const encoded = geminiInput([{ role: 'assistant', content: '', reasoningContent: '公开思考', toolCalls: [{ id: 'native-call', name: 'read_file', arguments: '{"path":"a"}' }], native: { binding: 'b', items: native.type === 'native.state' ? native.items : [] } }, { role: 'tool', toolCallId: 'native-call', content: '{"ok":true}' }], 'b');
    expect(encoded.contents[0]).toEqual({ role: 'model', parts });
    expect(encoded.contents[1].parts).toEqual([{ functionResponse: { id: 'native-call', name: 'read_file', response: { ok: true } } }]);
  });
  it('rebuilds cross-binding completed tool facts without fabricating signatures or new calls and maps images', () => {
    const encoded = geminiInput([{ role: 'system', content: 'rules' }, { role: 'assistant', content: 'done', reasoningContent: 'private', toolCalls: [{ id: 'old', name: 'write_file', arguments: '{}' }] }, { role: 'tool', toolCallId: 'old', content: 'already done' }, { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'fixture' }] }], 'b');
    expect(encoded.systemInstruction).toEqual({ parts: [{ text: 'rules' }] });
    expect(JSON.stringify(encoded)).not.toContain('functionCall'); expect(JSON.stringify(encoded)).not.toContain('thoughtSignature');
    expect(JSON.stringify(encoded)).not.toContain('private'); expect(JSON.stringify(encoded)).toContain('already done');
    expect(encoded.contents.at(-1)?.parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: 'fixture' } });
  });
  it('supports non-streaming, explicit generation fields and refuses streams without a final reason', async () => {
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(url).toBe('https://fixture.invalid/v1beta/models/model-id:generateContent');
      expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'fixture' });
      return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }));
    });
    expect(await collect(new GeminiAdapter({ ...options, fetcher, requestSettings: { stream: false }, modelSettings: { autoCompact: false, maxOutputTokens: 100, topP: 0.8, thinking: { thinkingBudget: 10 } } }).stream(request))).toContainEqual({ type: 'text.delta', text: 'OK' });
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 100, topP: 0.8, thinkingConfig: { thinkingBudget: 10 } });
    expect(body).not.toHaveProperty('model');
    const adapter = new GeminiAdapter({ ...options, fetcher: vi.fn(async () => new Response('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n')) });
    await expect(collect(adapter.stream(request))).rejects.toThrow('INTERRUPTED');
  });
});
