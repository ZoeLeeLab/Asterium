import { STUDIO_WAKE_LIMITS as limits } from '../../shared/studioWake';
import { studioWakeHintSchema } from '../../shared/studioWakeAdapter';
import type { StudioWakeHint } from '../../shared/studioWake';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

export type WakeConnectionState = { phase: 'stopped' | 'connecting' | 'connected';
  reason?: 'eof' | 'network_error' | 'protocol_error' | 'connect_timeout' | 'unauthorized' | 'manual' };
export type WakeStreamEvent = { type: 'wake'; hint: StudioWakeHint }
  | { type: 'reset'; latestEventId: number } | { type: 'checkpoint'; latestEventId: number; caughtUp: boolean };

/** One explicit start = at most one SSE request. No idle timer, reconnect or model port. */
export class WakeSingleConnection {
  private state: WakeConnectionState = { phase: 'stopped' };
  private readonly starts = new Set<string>();
  private controller?: AbortController;
  private completion = Promise.resolve();
  private readonly endpoint: URL;
  constructor(origin: string, private readonly token: string, private readonly onEvent: (event: WakeStreamEvent) => Promise<void>,
    private readonly fetcher: typeof fetch = openSse, private readonly connectTimeoutMs: number = limits.connectTimeoutMs) {
    this.endpoint = new URL('/wake/events', privateOrigin(origin));
    if (!token || /[\r\n]/.test(token)) throw new Error('STUDIO_WAKE_CREDENTIAL_REQUIRED');
  }
  status(): WakeConnectionState { return { ...this.state }; }
  start(requestId: string, afterEventId: number) {
    if (!requestId || !Number.isSafeInteger(afterEventId) || afterEventId < 0) throw new Error('STUDIO_WAKE_START_INVALID');
    if (this.starts.has(requestId)) return { ...this.status(), duplicate: true };
    this.starts.add(requestId);
    if (this.starts.size > 128) this.starts.delete(this.starts.values().next().value!);
    if (this.state.phase !== 'stopped' || this.controller) return { ...this.status(), duplicate: true };
    this.state = { phase: 'connecting' }; this.controller = new AbortController();
    this.completion = this.run(afterEventId, this.controller);
    return { ...this.status(), duplicate: false };
  }
  async stop() { if (this.controller) this.controller.abort(); await this.completion; }
  async settled() { await this.completion; }

  private async run(afterEventId: number, controller: AbortController) {
    let timedOut = false, established = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.connectTimeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const url = new URL(this.endpoint); url.searchParams.set('afterEventId', String(afterEventId));
      const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
        redirect: 'error', signal: controller.signal });
      clearTimeout(timer); // Headers end the connect deadline; subsequent silence is valid.
      if (controller.signal.aborted) { await response.body?.cancel(); controller.signal.throwIfAborted(); }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); this.state = { phase: 'stopped', reason: 'unauthorized' }; return; }
      if (!response.ok) { await response.body?.cancel(); throw new Error('NETWORK'); }
      if (!response.body || response.headers.get('content-type')?.split(';')[0].trim() !== 'text/event-stream') {
        await response.body?.cancel(); throw new ProtocolError();
      }
      established = true; this.state = { phase: 'connected' }; reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '';
      const cancel = () => { void reader?.cancel().catch(() => undefined); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        for (;;) {
          controller.signal.throwIfAborted();
          const next = await reader.read();
          controller.signal.throwIfAborted();
          if (next.done) {
            buffer += decoder.decode(); if (buffer.trim()) throw new ProtocolError();
            this.state = { phase: 'stopped', reason: 'eof' }; return;
          }
          try { buffer += decoder.decode(next.value, { stream: true }); } catch { throw new ProtocolError(); }
          for (;;) {
            const boundary = /\r?\n\r?\n/.exec(buffer); if (!boundary) break;
            if (boundary.index > limits.maximumFrameCharacters) throw new ProtocolError();
            const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
            const event = decode(block);
            if (event) { try { await this.onEvent(event); } catch { throw new ProtocolError(); } }
          }
          if (buffer.length > limits.maximumFrameCharacters) throw new ProtocolError();
        }
      } finally { controller.signal.removeEventListener('abort', cancel); }
    } catch (error) {
      this.state = { phase: 'stopped', reason: timedOut && !established ? 'connect_timeout' : controller.signal.aborted ? 'manual'
        : error instanceof UnauthorizedError ? 'unauthorized' : error instanceof ProtocolError ? 'protocol_error' : 'network_error' };
    } finally {
      clearTimeout(timer); await reader?.cancel().catch(() => undefined); reader?.releaseLock(); this.controller = undefined;
    }
  }
}
class ProtocolError extends Error {}
class UnauthorizedError extends Error {}
function decode(block: string): WakeStreamEvent | undefined {
  let event = '', id = ''; const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const index = line.indexOf(':'), key = index < 0 ? line : line.slice(0, index), value = index < 0 ? '' : line.slice(index + 1).replace(/^ /, '');
    if (key === 'event') event = value; if (key === 'id') id = value; if (key === 'data') data.push(value);
  }
  if (!event && !data.length) return;
  let value: Record<string, unknown>;
  try { value = JSON.parse(data.join('\n')); } catch { throw new ProtocolError(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError();
  if (event === 'access_revoked') throw new UnauthorizedError();
  if (event === 'unavailable') throw new Error('NETWORK');
  if (event === 'wake') {
    const parsed = studioWakeHintSchema.safeParse(value);
    if (!parsed.success || id !== String(parsed.data.latestEventId)) throw new ProtocolError();
    return { type: 'wake', hint: parsed.data };
  }
  if (!Number.isSafeInteger(value.latestEventId) || Number(value.latestEventId) < 0) throw new ProtocolError();
  if (event === 'reset') return { type: 'reset', latestEventId: Number(value.latestEventId) };
  if (event === 'checkpoint' && id === String(value.latestEventId) && typeof value.caughtUp === 'boolean') return { type: 'checkpoint', latestEventId: Number(value.latestEventId), caughtUp: value.caughtUp };
  throw new ProtocolError();
}
function privateOrigin(origin: string) {
  const url = new URL(origin);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !(url.protocol === 'https:' && url.hostname.endsWith('.ts.net') || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('STUDIO_WAKE_PRIVATE_ORIGIN_REQUIRED');
  return url;
}

// Native HTTP avoids fetch implementations' implicit body-idle deadlines on long-lived SSE.
const openSse: typeof fetch = async (input, init) => new Promise<Response>((resolve, reject) => {
  const url = new URL(String(input));
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: 'GET', headers: Object.fromEntries(new Headers(init?.headers)), signal: init?.signal ?? undefined,
  }, (response) => {
    response.setTimeout(0);
    try {
      const status = response.statusCode ?? 500, headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers })); }
      else resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }));
    } catch (error) { response.destroy(); reject(error); }
  });
  request.setTimeout(0); request.once('error', reject); request.end();
});
