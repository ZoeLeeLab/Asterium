import type { ApiProviderAdapter, ApiProviderMessage, ApiProviderRequest, ApiProviderStreamEvent } from '../api/ApiProviderAdapter';
import type { ApiProviderAdapterOptions } from '../api/ApiProviderRegistry';
import { apiFetch, apiSse } from '../api/ApiHttpTransport';
import { apiGeneration, apiHeaders } from '../api/ApiRequestConfiguration';
import { apiEndpoint } from '../../shared/apiEndpoints';
import { GENERIC_API_ATTACHMENTS } from './ChatCompletionsAdapter';
import { abortable } from '../api/abortable';

export class AnthropicMessagesAdapter implements ApiProviderAdapter {
  readonly provider = 'anthropic';
  readonly capabilities = { streamingText: true, reasoning: true, toolCalls: true, attachments: GENERIC_API_ATTACHMENTS };
  constructor(private readonly options: ApiProviderAdapterOptions) {}
  async *stream(request: ApiProviderRequest): AsyncIterable<ApiProviderStreamEvent> {
    if (!this.options.modelSettings?.maxOutputTokens) throw new Error('ANTHROPIC_MAX_OUTPUT_REQUIRED');
    const streaming = this.options.requestSettings?.stream !== false;
    const encoded = anthropicInput(request.messages, this.options.bindingKey);
    const response = await apiFetch(apiEndpoint(this.options.endpoint, 'anthropic_messages', this.options.requestSettings?.path), {
      method: 'POST', signal: request.signal, headers: apiHeaders(this.options, 'anthropic_messages'),
      body: JSON.stringify({ ...apiGeneration(this.options, 'anthropic_messages'), model: this.options.model, ...encoded, stream: streaming,
        ...(request.tools.length ? { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
      }),
    }, this.options.fetcher, this.options.requestSettings?.headerTimeoutMs);
    const blocks = new Map<number, any>(), pending = new Map<number, string>(), closed = new Set<number>();
    let output: any[], reason = '', stopped = false;
    if (!streaming) {
      const data = await abortable(response.json(), request.signal);
      output = data.content; reason = data.stop_reason; stopped = true;
      if (data.usage) yield { type: 'usage', promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens };
    } else {
      for await (const data of apiSse(response, request.signal)) {
        if (data.type === 'error') throw new Error('API_REMOTE_ERROR');
        if (data.type === 'message_start' && data.message?.usage) yield { type: 'usage', promptTokens: data.message.usage.input_tokens, completionTokens: data.message.usage.output_tokens };
        if (data.type === 'content_block_start') {
          if (!Number.isSafeInteger(data.index) || data.index < 0 || blocks.has(data.index) || !data.content_block) throw new Error('ANTHROPIC_BLOCK_INVALID');
          const block = structuredClone(data.content_block); blocks.set(data.index, block);
          if (block.type === 'text' && block.text) yield { type: 'text.delta', text: block.text };
          if (block.type === 'thinking' && block.thinking) yield { type: 'reasoning.delta', text: block.thinking };
        }
        if (data.type === 'content_block_delta') {
          const block = blocks.get(data.index), delta = data.delta;
          if (!block || !delta || closed.has(data.index)) throw new Error('ANTHROPIC_BLOCK_INVALID');
          if (delta.type === 'text_delta') { if (block.type !== 'text') throw new Error('ANTHROPIC_BLOCK_INVALID'); block.text += delta.text; yield { type: 'text.delta', text: delta.text }; }
          if (delta.type === 'thinking_delta') { if (block.type !== 'thinking') throw new Error('ANTHROPIC_BLOCK_INVALID'); block.thinking += delta.thinking; yield { type: 'reasoning.delta', text: delta.thinking }; }
          if (delta.type === 'signature_delta') { if (block.type !== 'thinking') throw new Error('ANTHROPIC_BLOCK_INVALID'); block.signature = (block.signature ?? '') + delta.signature; }
          if (delta.type === 'input_json_delta') { if (block.type !== 'tool_use') throw new Error('ANTHROPIC_BLOCK_INVALID'); pending.set(data.index, (pending.get(data.index) ?? '') + delta.partial_json); }
        }
        if (data.type === 'content_block_stop') {
          const block = blocks.get(data.index); if (!block || closed.has(data.index)) throw new Error('ANTHROPIC_BLOCK_INVALID');
          if (pending.has(data.index)) block.input = JSON.parse(pending.get(data.index)!);
          validateBlocks([block]); closed.add(data.index);
        }
        if (data.type === 'message_delta') { reason = data.delta?.stop_reason ?? reason; if (data.usage) yield { type: 'usage', completionTokens: data.usage.output_tokens }; }
        if (data.type === 'message_stop') { stopped = true; break; }
      }
      if (closed.size !== blocks.size) throw new Error('ANTHROPIC_BLOCK_INCOMPLETE');
      output = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
    }
    if (!stopped || !reason) throw new Error('API_STREAM_INTERRUPTED');
    validateBlocks(output);
    let callIndex = 0;
    for (const block of output) {
      if (!streaming && block.type === 'text') yield { type: 'text.delta', text: block.text };
      if (!streaming && block.type === 'thinking') yield { type: 'reasoning.delta', text: block.thinking };
      if (block.type === 'tool_use') yield { type: 'tool.delta', index: callIndex++, id: block.id, name: block.name, arguments: JSON.stringify(block.input) };
    }
    if ((callIndex > 0) !== (reason === 'tool_use')) throw new Error('ANTHROPIC_STOP_REASON_INVALID');
    yield { type: 'native.state', items: output }; yield { type: 'finish', reason };
  }
}
function validateBlocks(blocks: any[]) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('ANTHROPIC_BLOCK_INVALID');
  for (const block of blocks) {
    if (!block || !['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type)) throw new Error('ANTHROPIC_BLOCK_UNSUPPORTED');
    if (block.type === 'thinking' && (typeof block.thinking !== 'string' || typeof block.signature !== 'string' || !block.signature)) throw new Error('ANTHROPIC_SIGNATURE_MISSING');
    if (block.type === 'redacted_thinking' && typeof block.data !== 'string') throw new Error('ANTHROPIC_BLOCK_INVALID');
    if (block.type === 'text' && typeof block.text !== 'string') throw new Error('ANTHROPIC_BLOCK_INVALID');
    if (block.type === 'tool_use' && (typeof block.id !== 'string' || typeof block.name !== 'string' || !block.input || typeof block.input !== 'object' || Array.isArray(block.input))) throw new Error('ANTHROPIC_BLOCK_INVALID');
  }
}
export function anthropicInput(input: ApiProviderMessage[], binding?: string) {
  const system: string[] = [], messages: { role: 'user' | 'assistant'; content: any[] }[] = [];
  const append = (role: 'user' | 'assistant', content: any[]) => { if (!content.length) return; const previous = messages.at(-1); if (previous?.role === role) previous.content.push(...content); else messages.push({ role, content: [...content] }); };
  for (const message of input) {
    if (message.role === 'system') { system.push(message.content); continue; }
    if (message.role === 'tool') { append('user', [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]); continue; }
    if (message.role === 'assistant') {
      if (binding && message.native?.binding === binding) { validateBlocks(message.native.items); append('assistant', message.native.items); }
      else append('assistant', [...(message.content ? [{ type: 'text', text: message.content }] : []), ...(message.toolCalls ?? []).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) }))]);
      continue;
    }
    append('user', typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content.map(part => part.type === 'text' ? part : { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }));
  }
  return { ...(system.length ? { system: system.join('\n\n') } : {}), messages };
}
