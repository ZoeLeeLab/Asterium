import type { ApiProviderAdapter, ApiProviderMessage, ApiProviderRequest, ApiProviderStreamEvent } from '../api/ApiProviderAdapter';
import type { ApiProviderAdapterOptions } from '../api/ApiProviderRegistry';
import { apiFetch, apiSse } from '../api/ApiHttpTransport';
import { apiGeneration, apiHeaders } from '../api/ApiRequestConfiguration';
import { apiEndpoint } from '../../shared/apiEndpoints';
import { GENERIC_API_ATTACHMENTS } from './ChatCompletionsAdapter';
import { abortable } from '../api/abortable';

export class ResponsesAdapter implements ApiProviderAdapter {
  readonly provider = 'responses';
  readonly capabilities = { streamingText: true, reasoning: true, toolCalls: true, attachments: GENERIC_API_ATTACHMENTS };
  constructor(private readonly options: ApiProviderAdapterOptions) {}
  async *stream(request: ApiProviderRequest): AsyncIterable<ApiProviderStreamEvent> {
    const streaming = this.options.requestSettings?.stream !== false;
    const response = await apiFetch(apiEndpoint(this.options.endpoint, 'responses', this.options.requestSettings?.path), {
      method: 'POST', signal: request.signal, headers: apiHeaders(this.options, 'responses'),
      body: JSON.stringify({ ...apiGeneration(this.options, 'responses'), model: this.options.model, store: false, stream: streaming,
        input: responsesInput(request.messages, this.options.bindingKey),
        ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function', ...tool, strict: false })), tool_choice: 'auto' } : {}),
      }),
    }, this.options.fetcher, this.options.requestSettings?.headerTimeoutMs);
    let output: any[] = [], streamedText = false, completed = false;
    const items = new Map<number, unknown>();
    if (!streaming) {
      const data = await abortable(response.json(), request.signal);
      if (data.status !== 'completed' || !Array.isArray(data.output)) throw new Error('API_RESPONSE_INCOMPLETE');
      output = data.output; completed = true;
      if (data.usage) yield { type: 'usage', promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens, totalTokens: data.usage.total_tokens };
    } else {
      for await (const data of apiSse(response, request.signal)) {
        if (data.type === 'error' || data.type === 'response.failed' || data.type === 'response.incomplete') throw new Error('API_RESPONSE_INCOMPLETE');
        if (data.type === 'response.output_text.delta') { streamedText = true; yield { type: 'text.delta', text: data.delta }; }
        if (data.type === 'response.reasoning_summary_text.delta') yield { type: 'reasoning.delta', text: data.delta };
        if (data.type === 'response.output_item.done') {
          if (!Number.isSafeInteger(data.output_index) || !data.item) throw new Error('API_RESPONSE_STATE_INVALID');
          items.set(data.output_index, data.item);
        }
        if (data.type === 'response.completed') {
          if (data.response?.status !== 'completed') throw new Error('API_RESPONSE_INCOMPLETE');
          output = data.response.output ?? [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
          if (!Array.isArray(output)) throw new Error('API_RESPONSE_STATE_INVALID');
          const usage = data.response.usage;
          if (usage) yield { type: 'usage', promptTokens: usage.input_tokens, completionTokens: usage.output_tokens, totalTokens: usage.total_tokens };
          completed = true; break;
        }
      }
    }
    if (!completed) throw new Error('API_STREAM_INTERRUPTED');
    let callIndex = 0;
    for (const item of output) {
      if (item.type === 'function_call') {
        if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new Error('API_RESPONSE_STATE_INVALID');
        yield { type: 'tool.delta', index: callIndex++, id: item.call_id, name: item.name, arguments: item.arguments };
      }
      if (!streamedText && item.type === 'message') for (const part of item.content ?? []) {
        if (part.type === 'output_text') yield { type: 'text.delta', text: part.text };
        if (part.type === 'refusal') yield { type: 'text.delta', text: part.refusal };
      }
    }
    yield { type: 'native.state', items: output };
    yield { type: 'finish', reason: callIndex ? 'tool_calls' : 'stop' };
  }
}
export function responsesInput(messages: ApiProviderMessage[], binding?: string): unknown[] {
  return messages.flatMap((message): unknown[] => {
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.toolCallId, output: message.content }];
    if (message.role === 'assistant') {
      if (binding && message.native?.binding === binding) {
        if (message.native.items.some(item => !item || typeof item !== 'object' || !('type' in item) || typeof item.type !== 'string')) throw new Error('API_RESPONSE_STATE_INVALID');
        return message.native.items;
      }
      return [...(message.content ? [{ role: 'assistant', content: [{ type: 'output_text', text: message.content }] }] : []), ...(message.toolCalls ?? []).map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }))];
    }
    return [{ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? { type: 'input_text', text: part.text } : { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}` }) }];
  });
}
