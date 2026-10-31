import type { ApiModelSummary, ApiPartnerConnection, ProtocolError } from '../../shared/agentProtocol';
import { DeepSeekHttpError, DeepSeekProviderAdapter, type DeepSeekProviderAdapterOptions } from '../adapters/DeepSeekProviderAdapter';
import { listDeepSeekModels, normalizeDeepSeekChatEndpoint } from '../adapters/deepSeekModels';
import type { ApiProviderAdapter, ApiProviderRuntimePolicy } from './ApiProviderAdapter';
import { ChatCompletionsAdapter, listChatModels } from '../adapters/ChatCompletionsAdapter';
import { apiEndpoint } from '../../shared/apiEndpoints';
import { ApiHttpError } from './ApiHttpTransport';
import { ResponsesAdapter } from '../adapters/ResponsesAdapter';
import { AnthropicMessagesAdapter } from '../adapters/AnthropicMessagesAdapter';
import { GeminiAdapter } from '../adapters/GeminiAdapter';
import { apiModelsEndpoint } from '../../shared/apiEndpoints';

export type ApiProviderId = ApiPartnerConnection['provider'];

export interface ApiProviderAdapterOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  bindingKey?: string;
  thinkingMode?: ApiPartnerConnection['thinkingMode'];
  reasoningEffort?: ApiPartnerConnection['reasoningEffort'];
  fetcher?: typeof fetch;
  stream?: boolean;
  headers?: Record<string, string>;
  requestSettings?: import('../../shared/apiConnections').ApiRequestSettings;
  modelSettings?: import('../../shared/apiConnections').ApiModelSettings;
}

export interface ApiProviderDefinition {
  id: ApiProviderId;
  normalizeEndpoint(endpoint: string): string;
  listModels(endpoint: string, apiKey: string): Promise<ApiModelSummary[]>;
  createAdapter(options: ApiProviderAdapterOptions): ApiProviderAdapter;
  runtimePolicy: ApiProviderRuntimePolicy;
}

export interface NormalizedApiProviderConnection {
  definition: ApiProviderDefinition;
  endpoint: string;
  model: string;
}

export class ApiProviderRegistry {
  private readonly definitions = new Map<ApiProviderId, ApiProviderDefinition>();

  constructor(definitions: ApiProviderDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ApiProviderDefinition) {
    if (this.definitions.has(definition.id)) throw new Error('API_PROVIDER_ALREADY_REGISTERED');
    this.definitions.set(definition.id, definition);
    return this;
  }

  has(provider: unknown): provider is ApiProviderId {
    return typeof provider === 'string' && this.definitions.has(provider as ApiProviderId);
  }

  require(provider: ApiProviderId) {
    const definition = this.definitions.get(provider);
    if (!definition) throw new Error('API_PROVIDER_NOT_AVAILABLE');
    return definition;
  }

  normalizeConnection(connection: ApiPartnerConnection): NormalizedApiProviderConnection {
    const definition = this.require(connection.provider);
    const endpoint = definition.normalizeEndpoint(connection.endpoint);
    const model = connection.model.trim();
    if (!model) throw new Error('API_MODEL_REQUIRED');
    return { definition, endpoint, model };
  }

  async listModels(provider: ApiProviderId, endpoint: string, apiKey: string) {
    const definition = this.require(provider);
    const normalizedEndpoint = definition.normalizeEndpoint(endpoint);
    return definition.listModels(normalizedEndpoint, apiKey);
  }
}

export function createDefaultApiProviderRegistry() {
  return new ApiProviderRegistry([deepSeekProviderDefinition, chatCompletionsDefinition, responsesDefinition, anthropicDefinition, geminiDefinition]);
}

export const genericApiRuntimePolicy: ApiProviderRuntimePolicy = {
  reasoningSummary: round => round === 1 ? '伙伴正在思考…' : `伙伴第 ${round} 段思考…`,
  finishReasonError: reason => ['stop', 'end_turn', 'stop_sequence', 'tool_calls', 'tool_use', 'STOP'].includes(reason) ? undefined : protocolError('API_INCOMPLETE', '服务未完整完成回复，请检查输出上限与服务状态。', 'adapter', false),
  mapError: error => error instanceof ApiHttpError
    ? protocolError(`API_HTTP_${error.status}`, `API 请求失败（HTTP ${error.status}），请检查地址、凭据、额度与模型。`, [401, 403].includes(error.status) ? 'authorization' : 'transport', false)
    : protocolError('API_REQUEST_FAILED', 'API 请求失败或回复中断，请检查连接与配置后手动重试。', 'transport', false),
};
export const chatCompletionsDefinition: ApiProviderDefinition = { id: 'openai', normalizeEndpoint: endpoint => apiEndpoint(endpoint, 'chat_completions'), listModels: listChatModels, createAdapter: options => new ChatCompletionsAdapter(options), runtimePolicy: genericApiRuntimePolicy };
export const responsesDefinition: ApiProviderDefinition = { id: 'responses', normalizeEndpoint: endpoint => apiEndpoint(endpoint, 'responses'), listModels: (endpoint, key) => listChatModels(endpoint.replace(/\/responses\/?$/, ''), key), createAdapter: options => new ResponsesAdapter(options), runtimePolicy: genericApiRuntimePolicy };
export const anthropicDefinition: ApiProviderDefinition = { id: 'anthropic', normalizeEndpoint: endpoint => apiEndpoint(endpoint, 'anthropic_messages'), listModels: async (endpoint, key) => {
  const { apiFetch } = await import('./ApiHttpTransport');
  const response = await apiFetch(endpoint.replace(/\/messages\/?$/, '/models'), { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: new AbortController().signal });
  const data = await response.json(); if (!Array.isArray(data.data)) throw new Error('API_MODELS_INVALID'); return data.data.map((model: any) => ({ id: model.id }));
}, createAdapter: options => new AnthropicMessagesAdapter(options), runtimePolicy: genericApiRuntimePolicy };
export const geminiDefinition: ApiProviderDefinition = { id: 'gemini', normalizeEndpoint: endpoint => apiEndpoint(endpoint, 'gemini'), listModels: async (endpoint, key) => {
  const { apiFetch } = await import('./ApiHttpTransport');
  const response = await apiFetch(apiModelsEndpoint(endpoint, 'gemini'), { headers: { 'x-goog-api-key': key }, signal: new AbortController().signal });
  const data = await response.json(); if (!Array.isArray(data.models)) throw new Error('API_MODELS_INVALID'); return data.models.map((model: any) => ({ id: model.name }));
}, createAdapter: options => new GeminiAdapter(options), runtimePolicy: genericApiRuntimePolicy };

export const deepSeekProviderDefinition: ApiProviderDefinition = {
  id: 'deepseek',
  normalizeEndpoint: normalizeDeepSeekChatEndpoint,
  listModels: (endpoint, apiKey) => listDeepSeekModels(endpoint, apiKey),
  createAdapter: (options) => new DeepSeekProviderAdapter(options as DeepSeekProviderAdapterOptions),
  runtimePolicy: {
    reasoningSummary: (round) => round === 1 ? 'DeepSeek 正在思考…' : `DeepSeek 第 ${round} 段思考…`,
    finishReasonError: (reason) => {
      if (reason === 'content_filter') return protocolError('DEEPSEEK_CONTENT_FILTERED', 'DeepSeek 因内容安全策略停止了回复。', 'adapter', false);
      if (reason === 'insufficient_system_resource') return protocolError('DEEPSEEK_CAPACITY', 'DeepSeek 当前资源不足，请稍后重试。', 'transport', true);
      return undefined;
    },
    mapError: (error) => {
      if (error instanceof DeepSeekHttpError) {
        if (error.status === 401 || error.status === 403) return protocolError('DEEPSEEK_AUTH_FAILED', 'DeepSeek API Key 无效或没有访问权限。', 'authorization', false);
        if (error.status === 429) return protocolError('DEEPSEEK_RATE_LIMITED', 'DeepSeek 请求过于频繁或额度不足，请稍后重试。', 'transport', true);
        if (error.status >= 500) return protocolError('DEEPSEEK_UNAVAILABLE', 'DeepSeek 服务暂时不可用，请稍后重试。', 'transport', true);
        return protocolError('DEEPSEEK_HTTP_ERROR', `DeepSeek 请求失败（HTTP ${error.status}）。`, 'adapter', error.status >= 408);
      }
      const code = error instanceof Error && error.message ? error.message.slice(0, 160) : 'ERROR';
      if (code === 'DEEPSEEK_STREAM_INTERRUPTED') return protocolError(code, 'DeepSeek 的回复流意外中断，可以重试本条消息。', 'transport', true);
      if (code === 'DEEPSEEK_MALFORMED_SSE') return protocolError(code, 'DeepSeek 返回了无法解析的流式数据。', 'transport', true);
      if (code === 'DEEPSEEK_EMPTY_STREAM') return protocolError(code, 'DeepSeek 没有返回可读取的流。', 'transport', true);
      return protocolError('DEEPSEEK_NETWORK_ERROR', '无法连接 DeepSeek，请检查网络或代理后重试。', 'transport', true);
    },
  },
};

function protocolError(code: string, message: string, stage: ProtocolError['stage'], retryable: boolean): ProtocolError {
  return { code, message, stage, retryable };
}
