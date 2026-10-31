import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { STUDIO_WAKE_LIMITS } from '../../shared/studioWake';
import type { StudioMcpService } from './StudioMcpService';
import type { StudioWakeEvents } from './StudioWakeEvents';

/** One authenticated lightweight notification stream per partner; never starts a model. */
export class StudioWakeStream {
  private readonly streams = new Map<string, { close: () => void; flush: () => void }>();
  constructor(private readonly events: StudioWakeEvents, private readonly mcp: StudioMcpService) {}

  refresh() { for (const stream of this.streams.values()) stream.flush(); }
  close() { for (const stream of [...this.streams.values()]) stream.close(); }

  async open(response: ServerResponse, token: string, afterEventId: number) {
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) return error(response, 400, 'STUDIO_WAKE_CURSOR_INVALID');
    let identity;
    try { identity = await this.mcp.authenticate(token); } catch { return error(response, 401, 'STUDIO_MCP_UNAUTHORIZED'); }
    if (response.destroyed) return;
    if (this.streams.has(identity.partnerId)) return error(response, 409, 'STUDIO_WAKE_ALREADY_CONNECTED');
    if (this.streams.size >= 16) return error(response, 429, 'STUDIO_WAKE_CONNECTION_LIMIT');
    let cursor = afterEventId, closed = false, pending = false, flushing = false;
    const ended = new AbortController();
    const close = () => {
      if (closed) return;
      closed = true; ended.abort(); clearInterval(heartbeat); unsubscribe(); this.streams.delete(identity.partnerId); response.end();
    };
    const send = async (frame: string) => {
      if (closed) return false;
      if (response.write(frame)) return true;
      try {
        await once(response, 'drain', { signal: AbortSignal.any([ended.signal, AbortSignal.timeout(8000)]) });
        return !closed;
      } catch { close(); return false; }
    };
    const flush = () => {
      pending = true;
      if (flushing || closed) return;
      flushing = true;
      void (async () => {
        try {
          batches: while (pending && !closed) {
            pending = false;
            const batch = await this.events.poll(token, cursor);
            if (closed) return;
            if (pending) continue;
            if (batch.resetRequired && !await send(`event: reset\ndata: ${JSON.stringify({ latestEventId: batch.latestEventId })}\n\n`)) return;
            for (const hint of batch.hints) {
              // A member/credential mutation while awaiting drain invalidates this entire batch.
              if (pending) continue batches;
              if (!await send(`id: ${hint.latestEventId}\nevent: wake\ndata: ${JSON.stringify(hint)}\n\n`)) return;
            }
            if (pending) continue;
            cursor = batch.scanCursor;
            if (!await send(`id: ${cursor}\nevent: checkpoint\ndata: ${JSON.stringify({ latestEventId: cursor, caughtUp: cursor >= batch.latestEventId })}\n\n`)) return;
            if (cursor < batch.latestEventId) pending = true;
          }
        } catch (cause) {
          const unauthorized = cause instanceof Error && cause.message === 'STUDIO_MCP_UNAUTHORIZED';
          if (!closed) response.write(`event: ${unauthorized ? 'access_revoked' : 'unavailable'}\ndata: {}\n\n`);
          close();
        } finally { flushing = false; }
      })();
    };
    const unsubscribe = this.events.subscribe(flush, () => { if (flushing) pending = true; });
    const heartbeat = setInterval(() => { if (!closed) { if (!response.write(': heartbeat\n\n')) close(); else flush(); } }, STUDIO_WAKE_LIMITS.heartbeatMs);
    heartbeat.unref();
    this.streams.set(identity.partnerId, { close, flush });
    response.once('close', close);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    response.flushHeaders();
    flush();
  }
}

function error(response: ServerResponse, status: number, code: string) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: code })); }
