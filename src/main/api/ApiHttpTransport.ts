import { abortable } from './abortable';

export class ApiHttpError extends Error {
  constructor(readonly status: number) { super(`API_HTTP_${status}`); }
}
/** The timer ends at response headers. No body idle timeout or retry. */
export async function apiFetch(url: string, init: RequestInit & { signal: AbortSignal }, fetcher = fetch, headerTimeoutMs = 120_000) {
  const controller = new AbortController();
  const signal = AbortSignal.any([init.signal, controller.signal]);
  const timeout = setTimeout(() => controller.abort(new Error('API_HEADER_TIMEOUT')), headerTimeoutMs);
  try {
    const response = await abortable(fetcher(url, { ...init, signal, redirect: 'error' }), signal);
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new ApiHttpError(response.status); }
    return response;
  } finally { clearTimeout(timeout); }
}

export async function* apiSse(response: Response, signal: AbortSignal): AsyncIterable<Record<string, any>> {
  if (!response.body) throw new Error('API_EMPTY_STREAM');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const parse = (block: string) => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data === '[DONE]') { done = true; return undefined; }
    if (!data) return undefined;
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('API_MALFORMED_SSE');
    return value as Record<string, any>;
  };
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 16 * 1024 * 1024) throw new Error('API_STREAM_FRAME_TOO_LARGE');
      let match: RegExpMatchArray | null;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const offset = match.index!; const block = buffer.slice(0, offset); buffer = buffer.slice(offset + match[0].length);
        const value = parse(block); if (value) yield value;
        if (done) return;
      }
      if (chunk.done) break;
    }
    if (buffer.trim()) { const value = parse(buffer); if (value) yield value; }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
