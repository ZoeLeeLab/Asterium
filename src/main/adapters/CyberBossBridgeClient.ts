import { CyberBossSseParser, type CyberBossSseEvent } from './cyberBossSseParser';
import { studioWakeControlReplySchema, studioWakeControlRequestSchema, type StudioWakeControlRequest } from '../../shared/studioWakeAdapter';

type Fetcher = typeof fetch;
const INITIAL_RECONNECT_MS = 2_000;
const MAX_RECONNECT_MS = 60_000;
const STABLE_STREAM_MS = 30_000;

export interface CyberBossSession {
  threadId?: string;
  workspaceRoot?: string;
}

export interface CyberBossBridgeClientOptions {
  serviceUrl: string;
  secret: string;
  fetcher?: Fetcher;
  reconnectDelay?: (milliseconds: number) => Promise<void>;
  initialLastEventId?: string;
  onLastEventId?: (eventId: string) => void;
}

export class CyberBossBridgeClient {
  private readonly baseUrl: URL;
  private readonly origin: string;
  private readonly fetcher: Fetcher;
  private cookie = '';
  private lastEventId = '';
  private readonly seenEventIds = new Set<string>();

  constructor(private readonly options: CyberBossBridgeClientOptions) {
    this.baseUrl = normalizeCyberBossServiceUrl(options.serviceUrl);
    this.origin = this.baseUrl.origin;
    this.fetcher = options.fetcher ?? fetch;
    this.lastEventId = options.initialLastEventId ?? '';
  }

  async authenticate(signal?: AbortSignal | null) {
    signal?.throwIfAborted();
    const response = await this.fetcher(new URL('/api/auth', this.baseUrl), {
      method: 'POST',
      headers: { Origin: this.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: this.options.secret }),
      ...(signal ? { signal } : {}),
    });
    try {
      if (response.status === 401 || response.status === 403) throw new Error('CYBERBOSS_AUTH_FAILED');
      if (!response.ok) throw new Error('CYBERBOSS_AUTH_UNAVAILABLE');
      this.captureCookie(response.headers);
      if (!this.cookie) throw new Error('CYBERBOSS_SESSION_COOKIE_MISSING');
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  }

  async checkSession() {
    const response = await this.authorizedFetch('/api/session', { method: 'GET' });
    if (!response.ok) throw new Error('CYBERBOSS_SESSION_UNAVAILABLE');
    this.captureCookie(response.headers);
    try {
      const value = await response.json() as unknown;
      if (!isRecord(value)) return {};
      return {
        ...(typeof value.threadId === 'string' && value.threadId ? { threadId: value.threadId } : {}),
        ...(typeof value.workspaceRoot === 'string' && value.workspaceRoot ? { workspaceRoot: value.workspaceRoot } : {}),
      } satisfies CyberBossSession;
    } catch {
      return {} satisfies CyberBossSession;
    }
  }

  async sendMessage(text: string, clientMessageId: string) {
    const response = await this.authorizedFetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, clientMessageId }),
    });
    if (response.status === 409) throw new Error('CYBERBOSS_IDEMPOTENCY_CONFLICT');
    if (response.status !== 202 && !response.ok) throw new Error('CYBERBOSS_MESSAGE_REJECTED');
  }

  /** Dedicated control action; never publish a user message or run the chat events loop. */
  async wakeControl(input: StudioWakeControlRequest, signal?: AbortSignal) {
    if (!this.baseUrl.hostname.endsWith('.ts.net') || !studioWakeControlRequestSchema.safeParse(input).success) throw new Error('STUDIO_WAKE_CONTROL_INVALID');
    const response = await this.authorizedFetch('/api/asterium/wake/control', { method: 'POST',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    try {
      if (response.status === 404 || response.status === 405) throw new Error('STUDIO_WAKE_CONTROL_UNSUPPORTED');
      if (response.status === 401 || response.status === 403) throw new Error('STUDIO_WAKE_CONTROL_UNAUTHORIZED');
      if (!response.ok || !response.body) throw new Error('STUDIO_WAKE_CONTROL_UNAVAILABLE');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 64 * 1024) { await reader.cancel(); throw new Error('STUDIO_WAKE_CONTROL_REPLY_INVALID'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('STUDIO_WAKE_CONTROL_REPLY_INVALID'); }
      const parsed = studioWakeControlReplySchema.safeParse(value);
      if (!parsed.success || parsed.data.requestId !== input.requestId || parsed.data.connectionBindingId !== input.connectionBindingId) throw new Error('STUDIO_WAKE_CONTROL_REPLY_INVALID');
      return parsed.data;
    } finally { await response.body?.cancel().catch(() => undefined); }
  }

  async *events(signal: AbortSignal): AsyncIterable<CyberBossSseEvent> {
    let reconnectMilliseconds = INITIAL_RECONNECT_MS;
    while (!signal.aborted) {
      let connectedAt: number | undefined;
      let retryAfter = 0;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancelReader = () => { void reader?.cancel().catch(() => undefined); };
      try {
        const suffix = this.lastEventId ? `?lastEventId=${encodeURIComponent(this.lastEventId)}` : '';
        const response = await this.authorizedFetch(`/api/events${suffix}`, { method: 'GET', signal });
        if (!response.ok || !response.body) {
          if (response.status === 429 || response.status === 503) retryAfter = retryAfterMilliseconds(response.headers.get('Retry-After'));
          await response.body?.cancel().catch(() => undefined);
          throw new Error('CYBERBOSS_EVENTS_UNAVAILABLE');
        }
        connectedAt = Date.now();
        const parser = new CyberBossSseParser();
        reader = response.body.getReader();
        signal.addEventListener('abort', cancelReader, { once: true });
        if (signal.aborted) cancelReader();
        const decoder = new TextDecoder();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          for (const event of parser.push(decoder.decode(next.value, { stream: true }))) {
            if (this.acceptEvent(event.id)) yield event;
          }
        }
        for (const event of [...parser.push(decoder.decode()), ...parser.finish()]) {
          if (this.acceptEvent(event.id)) yield event;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        if (isFatalStreamError(error)) throw error;
      } finally {
        signal.removeEventListener('abort', cancelReader);
        if (reader) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      if (signal.aborted) return;
      // HTTP 200 (or a replayed event) alone does not make a short-lived stream healthy.
      if (connectedAt !== undefined && Date.now() - connectedAt >= STABLE_STREAM_MS) reconnectMilliseconds = INITIAL_RECONNECT_MS;
      const waitMilliseconds = Math.max(reconnectMilliseconds, retryAfter);
      await (this.options.reconnectDelay?.(waitMilliseconds) ?? delay(waitMilliseconds, signal));
      reconnectMilliseconds = Math.min(MAX_RECONNECT_MS, reconnectMilliseconds * 2);
    }
  }

  private async authorizedFetch(pathname: string, init: RequestInit) {
    init.signal?.throwIfAborted();
    if (!this.cookie) await this.authenticate(init.signal);
    init.signal?.throwIfAborted();
    let response = await this.fetcher(new URL(pathname, this.baseUrl), { ...init, headers: { Origin: this.origin, Cookie: this.cookie, ...init.headers } });
    if (response.status === 401) {
      this.cookie = '';
      await response.body?.cancel().catch(() => undefined);
      await this.authenticate(init.signal);
      init.signal?.throwIfAborted();
      response = await this.fetcher(new URL(pathname, this.baseUrl), { ...init, headers: { Origin: this.origin, Cookie: this.cookie, ...init.headers } });
    }
    this.captureCookie(response.headers);
    return response;
  }

  private captureCookie(headers: Headers) {
    const raw = headers.get('set-cookie') ?? '';
    const match = raw.match(/(?:^|,\s*)(cyberboss_web_session=[^;,\s]+)/i);
    if (match) this.cookie = match[1];
  }

  private acceptEvent(id: string) {
    if (this.seenEventIds.has(id)) return false;
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > 500) this.seenEventIds.delete(this.seenEventIds.values().next().value!);
    this.lastEventId = id;
    this.options.onLastEventId?.(id);
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFatalStreamError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return code === 'CYBERBOSS_AUTH_FAILED'
    || code === 'CYBERBOSS_SESSION_COOKIE_MISSING'
    || code === 'CYBERBOSS_MALFORMED_SSE';
}

export function normalizeCyberBossServiceUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('INVALID_CYBERBOSS_SERVICE_URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '')) throw new Error('INVALID_CYBERBOSS_SERVICE_URL');
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function delay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

function retryAfterMilliseconds(value: string | null) {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  // Avoid timer overflow turning a long server-requested wait into an immediate retry.
  return Number.isFinite(milliseconds) ? Math.min(2_147_483_647, Math.max(0, milliseconds)) : 0;
}
