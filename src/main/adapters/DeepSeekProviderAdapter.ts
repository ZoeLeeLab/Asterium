import type { ApiProviderAdapter, ApiProviderMessage, ApiProviderRequest, ApiProviderStreamEvent } from '../api/ApiProviderAdapter';
import { DeepSeekStreamParser } from './deepSeekStreamParser';
import { abortable } from '../api/abortable';
import type { ApiProviderAdapterOptions } from '../api/ApiProviderRegistry';
import { apiGeneration, apiHeaders } from '../api/ApiRequestConfiguration';
import { apiFetch, ApiHttpError } from '../api/ApiHttpTransport';
import { apiEndpoint } from '../../shared/apiEndpoints';
import { ChatCompletionsAdapter } from './ChatCompletionsAdapter';

export type DeepSeekProviderAdapterOptions = ApiProviderAdapterOptions;

export class DeepSeekProviderAdapter implements ApiProviderAdapter {
  readonly provider = 'deepseek';
  readonly capabilities = {
    streamingText: true,
    reasoning: true,
    toolCalls: true,
    attachments: {
      supportsImageInput: false,
      acceptedMimeTypes: [] as string[],
      maxImageBytes: 0,
      attachmentTransport: 'metadata_only' as const,
    },
  };

  constructor(private readonly options: DeepSeekProviderAdapterOptions) {}

  async *stream(request: ApiProviderRequest): AsyncIterable<ApiProviderStreamEvent> {
    if (this.options.requestSettings?.stream === false) {
      try {
        yield* new ChatCompletionsAdapter({ ...this.options, modelSettings: { autoCompact: false, chatOutputLimitField: 'max_tokens', ...(this.options.thinkingMode !== 'auto' && this.options.thinkingMode ? { thinking: { type: this.options.thinkingMode } } : {}), ...this.options.modelSettings,
          extra: { ...(this.options.thinkingMode === 'enabled' ? { reasoning_effort: this.options.reasoningEffort ?? 'high' } : {}), ...this.options.modelSettings?.extra },
        } }).stream(request);
      } catch (error) { if (error instanceof ApiHttpError) throw new DeepSeekHttpError(error.status); throw error; }
      return;
    }
    const response = await apiFetch(apiEndpoint(this.options.endpoint, 'chat_completions', this.options.requestSettings?.path), {
      method: 'POST',
      headers: apiHeaders(this.options, 'chat_completions'),
      body: JSON.stringify({
        ...apiGeneration({ ...this.options, modelSettings: { autoCompact: false, chatOutputLimitField: 'max_tokens', ...this.options.modelSettings } }, 'chat_completions'),
        model: this.options.model,
        messages: request.messages.map(toDeepSeekMessage),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.tools.length ? {
          tools: request.tools.map((tool) => ({ type: 'function', function: tool })),
          tool_choice: 'auto',
        } : {}),
        ...(this.options.modelSettings?.thinking ? {} : this.options.thinkingMode === 'enabled' ? {
          thinking: { type: 'enabled' },
          reasoning_effort: this.options.reasoningEffort ?? 'high',
        } : this.options.thinkingMode === 'disabled' ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: request.signal,
    }, this.options.fetcher, this.options.requestSettings?.headerTimeoutMs).catch(error => { if (error instanceof ApiHttpError) throw new DeepSeekHttpError(error.status); throw error; });
    if (!response.ok) throw new DeepSeekHttpError(response.status);
    if (!response.body) throw new Error('DEEPSEEK_EMPTY_STREAM');

    const parser = new DeepSeekStreamParser();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await abortable(reader.read(), request.signal);
        if (next.done) break;
        for (const parsed of parser.push(decoder.decode(next.value, { stream: true }))) {
          const mapped = mapEvent(parsed);
          if (mapped) yield mapped;
        }
      }
      for (const parsed of [...parser.push(decoder.decode()), ...parser.finish()]) {
        const mapped = mapEvent(parsed);
        if (mapped) yield mapped;
      }
      if (!parser.completed) throw new Error('DEEPSEEK_STREAM_INTERRUPTED');
    } finally {
      // Closing an interrupted iterator must release the body, including custom fetchers.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

export class DeepSeekHttpError extends Error {
  constructor(readonly status: number) {
    super(`DEEPSEEK_HTTP_${status}`);
  }
}

function toDeepSeekMessage(message: ApiProviderMessage) {
  if (message.role === 'assistant') return {
    role: 'assistant',
    content: message.content,
    reasoning_content: message.reasoningContent,
    ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })) } : {}),
  };
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  if (Array.isArray(message.content)) throw new Error('DEEPSEEK_NATIVE_MULTIMODAL_NOT_IMPLEMENTED');
  return message;
}

function mapEvent(event: ReturnType<DeepSeekStreamParser['push']>[number]): ApiProviderStreamEvent | undefined {
  if (event.type === 'reasoning') return { type: 'reasoning.delta', text: event.text };
  if (event.type === 'content') return { type: 'text.delta', text: event.text };
  if (event.type === 'tool_call_delta') return { type: 'tool.delta', index: event.index, ...(event.id ? { id: event.id } : {}), ...(event.name ? { name: event.name } : {}), ...(event.arguments !== undefined ? { arguments: event.arguments } : {}) };
  if (event.type === 'usage') return event;
  if (event.type === 'finish') return event;
  return undefined;
}
