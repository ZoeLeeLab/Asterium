import type { ApiProtocol } from './apiConnections';

const suffixes = { chat_completions: '/chat/completions', responses: '/responses', anthropic_messages: '/messages', gemini: '/models' } as const;
/** A version supplied by the user is never appended a second time. */
export function apiEndpoint(endpoint: string, protocol: ApiProtocol, override?: string) {
  const url = new URL(endpoint);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /^(key|api_key|token|access_token)$/i.test(key))) throw new Error('API_INVALID_ENDPOINT');
  if (override) { url.pathname = override.startsWith('/') ? override : `${url.pathname.replace(/\/$/, '')}/${override}`; return url.toString(); }
  const suffix = suffixes[protocol];
  const current = url.pathname.replace(/\/+$/, '');
  if (protocol === 'gemini' && /\/models(?:\/[^/]+:(?:streamGenerateContent|generateContent))?$/.test(current)) return url.toString();
  if (current.endsWith(suffix)) return url.toString();
  if (/\/(?:chat\/completions|responses|messages)$/.test(current)) throw new Error('API_ENDPOINT_PROTOCOL_CONFLICT');
  url.pathname = (current || (protocol === 'gemini' ? '/v1beta' : '/v1')) + suffix;
  return url.toString();
}
export function apiModelsEndpoint(endpoint: string, protocol: ApiProtocol) {
  const url = new URL(apiEndpoint(endpoint, protocol));
  url.pathname = protocol === 'gemini' ? url.pathname.replace(/\/models.*$/, '/models') : url.pathname.replace(/\/(chat\/completions|responses|messages)\/?$/, '/models');
  return url.toString();
}
export function geminiEndpoint(endpoint: string, model: string, streaming: boolean, override?: string) {
  const id = model.trim().replace(/^models\//, '');
  if (!id) throw new Error('API_MODEL_REQUIRED');
  const method = streaming ? 'streamGenerateContent' : 'generateContent';
  const url = new URL(apiEndpoint(endpoint, 'gemini', override?.replaceAll('{model}', encodeURIComponent(id)).replaceAll('{method}', method)));
  if (!override) {
    const existing = /\/models\/([^/]+):(?:streamGenerateContent|generateContent)\/?$/.exec(url.pathname);
    if (existing && decodeURIComponent(existing[1]) !== id) throw new Error('API_MODEL_ENDPOINT_CONFLICT');
    url.pathname = existing ? url.pathname.replace(/:(?:streamGenerateContent|generateContent)\/?$/, `:${method}`) : `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(id)}:${method}`;
  }
  if (streaming) url.searchParams.set('alt', 'sse'); else if (url.searchParams.get('alt') === 'sse') url.searchParams.delete('alt');
  return url.toString();
}
