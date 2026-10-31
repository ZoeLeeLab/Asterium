import type { ApiProviderAdapterOptions } from './ApiProviderRegistry';
import type { ApiProtocol } from '../../shared/apiConnections';

export function apiHeaders(options: ApiProviderAdapterOptions, protocol: ApiProtocol) {
  const auth = options.requestSettings?.auth ?? 'default';
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(protocol === 'anthropic_messages' ? { 'anthropic-version': '2023-06-01' } : {}), ...options.headers };
  const effective = auth === 'default' ? protocol === 'anthropic_messages' ? 'x-api-key' : protocol === 'gemini' ? 'google-api-key' : 'bearer' : auth;
  if (effective === 'bearer') headers.Authorization = `Bearer ${options.apiKey}`;
  if (effective === 'x-api-key') headers['x-api-key'] = options.apiKey;
  if (effective === 'google-api-key') headers['x-goog-api-key'] = options.apiKey;
  if (effective === 'custom') headers[options.requestSettings!.authHeader!] = options.apiKey;
  return headers;
}
export function apiGeneration(options: ApiProviderAdapterOptions, protocol: ApiProtocol) {
  const value = options.modelSettings;
  const result: Record<string, unknown> = { ...value?.extra };
  if (value?.temperature !== undefined) result.temperature = value.temperature;
  if (value?.topP !== undefined) result[protocol === 'gemini' ? 'topP' : 'top_p'] = value.topP;
  if (value?.maxOutputTokens !== undefined) result[protocol === 'responses' ? 'max_output_tokens' : protocol === 'gemini' ? 'maxOutputTokens' : protocol === 'anthropic_messages' ? 'max_tokens' : value.chatOutputLimitField ?? 'max_completion_tokens'] = value.maxOutputTokens;
  if (value?.thinking) result[protocol === 'responses' ? 'reasoning' : protocol === 'gemini' ? 'thinkingConfig' : 'thinking'] = value.thinking;
  return result;
}
