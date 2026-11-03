export interface DeepSeekModelSummary {
  id: string;
  ownedBy?: string;
}

type Fetcher = typeof fetch;

export async function listDeepSeekModels(chatEndpoint: string, apiKey: string, fetcher: Fetcher = fetch): Promise<DeepSeekModelSummary[]> {
  const endpoint = deepSeekModelsEndpoint(chatEndpoint);
  const response = await fetcher(endpoint, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (response.status === 401 || response.status === 403) throw new Error('DEEPSEEK_AUTH_FAILED');
  if (response.status === 429) throw new Error('DEEPSEEK_RATE_LIMITED');
  if (!response.ok) throw new Error('DEEPSEEK_MODELS_UNAVAILABLE');
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('DEEPSEEK_MODELS_INVALID');
  }
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error('DEEPSEEK_MODELS_INVALID');
  const models = value.data.flatMap((item): DeepSeekModelSummary[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200) return [];
    return [{ id: item.id.trim(), ...(typeof item.owned_by === 'string' ? { ownedBy: item.owned_by.slice(0, 100) } : {}) }];
  });
  return [...new Map(models.map((model) => [model.id, model])).values()].slice(0, 200);
}

export function normalizeDeepSeekChatEndpoint(value: string) {
  const endpoint = parseOfficialDeepSeekEndpoint(value);
  if (endpoint.pathname === '/') endpoint.pathname = '/chat/completions';
  if (endpoint.pathname === '/v1' || endpoint.pathname === '/v1/') endpoint.pathname = '/v1/chat/completions';
  if (endpoint.pathname !== '/chat/completions' && endpoint.pathname !== '/v1/chat/completions') throw new Error('INVALID_DEEPSEEK_ENDPOINT');
  return endpoint.toString();
}

function deepSeekModelsEndpoint(chatEndpoint: string) {
  const endpoint = parseOfficialDeepSeekEndpoint(chatEndpoint);
  endpoint.pathname = endpoint.pathname.startsWith('/v1/') ? '/v1/models' : '/models';
  return endpoint.toString();
}

function parseOfficialDeepSeekEndpoint(value: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new Error('INVALID_DEEPSEEK_ENDPOINT');
  }
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'api.deepseek.com' || endpoint.username || endpoint.password || endpoint.port) throw new Error('INVALID_DEEPSEEK_ENDPOINT');
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
