import type { ApiProviderAdapter, ApiProviderMessage, ApiProviderRequest, ApiProviderStreamEvent } from '../api/ApiProviderAdapter';
import type { ApiProviderAdapterOptions } from '../api/ApiProviderRegistry';
import { apiFetch, apiSse } from '../api/ApiHttpTransport';
import { apiEndpoint, apiModelsEndpoint } from '../../shared/apiEndpoints';
import { apiGeneration, apiHeaders } from '../api/ApiRequestConfiguration';
import { abortable } from '../api/abortable';

export const GENERIC_API_ATTACHMENTS = { supportsImageInput: true, acceptedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], maxImageBytes: 20 * 1024 * 1024, attachmentTransport: 'native_multimodal' as const };
export class ChatCompletionsAdapter implements ApiProviderAdapter {
  readonly provider = 'openai';
  readonly capabilities = { streamingText: true, reasoning: true, toolCalls: true, attachments: GENERIC_API_ATTACHMENTS };
  constructor(private readonly options: ApiProviderAdapterOptions) {}
  async *stream(request: ApiProviderRequest): AsyncIterable<ApiProviderStreamEvent> {
    const streaming = (this.options.requestSettings?.stream ?? this.options.stream) !== false;
    const response = await apiFetch(apiEndpoint(this.options.endpoint, 'chat_completions', this.options.requestSettings?.path), {
      method: 'POST', headers: apiHeaders(this.options, 'chat_completions'), signal: request.signal,
      body: JSON.stringify({ ...apiGeneration(this.options, 'chat_completions'), model: this.options.model, messages: request.messages.map(chatMessage), stream: streaming, ...(streaming ? { stream_options: { include_usage: true } } : {}),
        ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function', function: tool })), tool_choice: 'auto' } : {}),
      }),
    }, this.options.fetcher, this.options.requestSettings?.headerTimeoutMs);
    if (!streaming) {
      const data = await abortable(response.json(), request.signal); const choice = data.choices?.[0];
      if (!choice?.message || typeof choice.finish_reason !== 'string') throw new Error('API_MALFORMED_RESPONSE');
      if (choice.message.content) yield { type: 'text.delta', text: choice.message.content };
      if (choice.message.reasoning_content) yield { type: 'reasoning.delta', text: choice.message.reasoning_content };
      for (const [index, tool] of (choice.message.tool_calls ?? []).entries()) yield { type: 'tool.delta', index, id: tool.id, name: tool.function?.name, arguments: tool.function?.arguments };
      if (data.usage) yield { type: 'usage', promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens };
      yield { type: 'finish', reason: choice.finish_reason }; return;
    }
    let finished = false;
    for await (const data of apiSse(response, request.signal)) {
      if (data.error) throw new Error('API_REMOTE_ERROR');
      if (data.usage) yield { type: 'usage', promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens };
      if (!Array.isArray(data.choices)) throw new Error('API_MALFORMED_SSE');
      for (const choice of data.choices) {
        if (choice.index !== undefined && choice.index !== 0) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string') yield { type: 'text.delta', text: delta.content };
        if (typeof delta.reasoning_content === 'string') yield { type: 'reasoning.delta', text: delta.reasoning_content };
        for (const tool of delta.tool_calls ?? []) {
          if (!Number.isSafeInteger(tool.index) || tool.index < 0) throw new Error('API_MALFORMED_TOOL');
          yield { type: 'tool.delta', index: tool.index, id: tool.id, name: tool.function?.name, arguments: tool.function?.arguments };
        }
        if (typeof choice.finish_reason === 'string') { finished = true; yield { type: 'finish', reason: choice.finish_reason }; }
      }
    }
    if (!finished) throw new Error('API_STREAM_INTERRUPTED');
  }
}
export function chatMessage(message: ApiProviderMessage) {
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  if (message.role === 'assistant') return { role: 'assistant', content: message.content || null,
    ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
  };
  if (message.role === 'user' && Array.isArray(message.content)) return { role: 'user', content: message.content.map(part => part.type === 'text' ? part : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } }) };
  return message;
}
export async function listChatModels(endpoint: string, key: string) {
  const response = await apiFetch(apiModelsEndpoint(endpoint, 'chat_completions'), { headers: { Authorization: `Bearer ${key}` }, signal: new AbortController().signal });
  const data = await response.json();
  if (!Array.isArray(data.data)) throw new Error('API_MODELS_INVALID');
  return data.data.filter((model: any) => typeof model.id === 'string').map((model: any) => ({ id: model.id, ...(typeof model.owned_by === 'string' ? { ownedBy: model.owned_by } : {}) }));
}
