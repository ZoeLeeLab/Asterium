import type { ApiModelSummary } from '../../shared/agentProtocol';
import type { ApiProtocol } from '../../shared/apiConnections';
import { apiFetch } from './ApiHttpTransport';

/** Follow native pagination without trusting a server-supplied next URL with our credentials. */
export async function listApiSiteModels(endpoint: string, protocol: ApiProtocol, headers: Record<string, string>, headerTimeoutMs?: number, fetcher: typeof fetch = fetch): Promise<ApiModelSummary[]> {
  const url = new URL(endpoint), cursors = new Set<string>(), models = new Map<string, ApiModelSummary>();
  for (let page = 0; page < 100; page++) {
    const response = await apiFetch(url.toString(), { headers, signal: new AbortController().signal }, fetcher, headerTimeoutMs);
    const data = await response.json();
    const entries = data.data ?? data.models;
    if (!Array.isArray(entries)) throw new Error('API_MODELS_INVALID');
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const id = entry.id ?? entry.name;
      if (typeof id === 'string' && id) models.set(id, { id, ...(typeof entry.owned_by === 'string' ? { ownedBy: entry.owned_by } : {}) });
    }
    const cursor = protocol === 'gemini' ? data.nextPageToken : data.has_more ? data.last_id ?? entries.at(-1)?.id : undefined;
    if (!cursor && !data.has_more) return [...models.values()];
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('API_MODELS_INVALID_CURSOR');
    cursors.add(cursor); url.searchParams.set(protocol === 'gemini' ? 'pageToken' : 'after_id', cursor);
  }
  throw new Error('API_MODELS_PAGINATION_LIMIT');
}
