// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesAdapter, anthropicInput } from '../../src/main/adapters/AnthropicMessagesAdapter';
import type { ApiProviderStreamEvent } from '../../src/main/api/ApiProviderAdapter';
const options = { endpoint: 'https://fixture.invalid/v1', model: 'model-id', apiKey: 'fixture', bindingKey: 'b', modelSettings: { autoCompact: false, maxOutputTokens: 512 } };
const request = { messages: [], tools: [], signal: new AbortController().signal };
async function collect(stream: AsyncIterable<ApiProviderStreamEvent>) { const result = []; for await (const item of stream) result.push(item); return result; }
const sse = (events: unknown[]) => new Response(events.map(data => `data: ${JSON.stringify(data)}\n\n`).join(''));
describe('Anthropic Messages', () => {
  it('reassembles thinking signatures, redacted blocks and tool JSON without exposing signatures', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '公开思考' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-fixture' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'redacted-fixture' } }, { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } }, { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }, { type: 'message_stop' },
    ];
    const fetcher = vi.fn(async () => sse(events)); const adapter = new AnthropicMessagesAdapter({ ...options, fetcher });
    const result = await collect(adapter.stream(request));
    expect(result).toContainEqual({ type: 'reasoning.delta', text: '公开思考' });
    expect(result).toContainEqual({ type: 'tool.delta', index: 0, id: 'tool', name: 'read_file', arguments: '{"path":"a.txt"}' });
    const native = result.find(e => e.type === 'native.state')!;
    expect(native.type === 'native.state' && native.items).toEqual([{ type: 'thinking', thinking: '公开思考', signature: 'opaque-fixture' }, { type: 'redacted_thinking', data: 'redacted-fixture' }, { type: 'tool_use', id: 'tool', name: 'read_file', input: { path: 'a.txt' } }]);
    expect(JSON.stringify(result.filter(e => e.type !== 'native.state'))).not.toContain('opaque-fixture');
    const input = anthropicInput([{ role: 'assistant', content: '', reasoningContent: '', native: { binding: 'b', items: native.type === 'native.state' ? native.items : [] } }, { role: 'tool', toolCallId: 'tool', content: 'done' }], 'b');
    expect(input.messages[0].content).toEqual(native.type === 'native.state' ? native.items : []);
    expect(input.messages[1].content).toEqual([{ type: 'tool_result', tool_use_id: 'tool', content: 'done' }]);
  });
  it('encodes system, parallel tool results, images and completed portable tool calls', () => {
    const input = anthropicInput([{ role: 'system', content: 'rules' }, { role: 'assistant', content: '', reasoningContent: 'not-transferred', toolCalls: [{ id: 'one', name: 'a', arguments: '{}' }, { id: 'two', name: 'b', arguments: '{}' }] }, { role: 'tool', toolCallId: 'one', content: 'a' }, { role: 'tool', toolCallId: 'two', content: 'b' }, { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'fixture' }] }]);
    expect(input.system).toBe('rules'); expect(input.messages).toHaveLength(2); expect(input.messages[1].content).toHaveLength(3);
    expect(input.messages[1].content[2]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } });
    expect(JSON.stringify(input)).not.toContain('not-transferred');
  });
  it('requires an explicit output limit, supports non-streaming and rejects incomplete signatures', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' })));
    await expect(collect(new AnthropicMessagesAdapter({ ...options, modelSettings: undefined, fetcher }).stream(request))).rejects.toThrow('MAX_OUTPUT_REQUIRED'); expect(fetcher).not.toHaveBeenCalled();
    const result = await collect(new AnthropicMessagesAdapter({ ...options, requestSettings: { stream: false }, fetcher }).stream(request)); expect(result).toContainEqual({ type: 'text.delta', text: 'OK' });
    const bad = new AnthropicMessagesAdapter({ ...options, fetcher: vi.fn(async () => sse([{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'x' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }])) });
    await expect(collect(bad.stream(request))).rejects.toThrow('SIGNATURE');
  });
});
