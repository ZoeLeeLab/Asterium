import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { StudioMcpConfiguration, StudioMcpStatus } from '../../shared/studioMcp';
import { StudioMcpAccessStore, validateConfiguration } from './StudioMcpAccessStore';
import type { StudioMcpService } from './StudioMcpService';
import { createStudioMcpServer } from './StudioMcpTools';
import type { StudioWakeEvents } from './StudioWakeEvents';
import { StudioWakeStream } from './StudioWakeStream';

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_CONCURRENT_REQUESTS = 16;
const REQUESTS_PER_MINUTE = 120;

/** Loopback only. TLS and private network routing belong to the user's Tailscale Serve. */
export class StudioMcpHost {
  private server?: Server;
  private handler?: ReturnType<typeof createMcpHandler>;
  private mutation = Promise.resolve();
  private restoration?: Promise<StudioMcpStatus>;
  private active = 0;
  private lastAuthenticatedAt?: string;
  private error?: string;
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly wake?: StudioWakeStream;
  private readonly unsubscribe: () => void;

  constructor(private readonly access: StudioMcpAccessStore, private readonly service: StudioMcpService, events?: StudioWakeEvents) {
    if (events) this.wake = new StudioWakeStream(events, service);
    this.unsubscribe = access.subscribe(() => this.wake?.refresh());
  }

  async status(): Promise<StudioMcpStatus> {
    return { ...await this.access.snapshot(), running: Boolean(this.server?.listening),
      ...(this.lastAuthenticatedAt ? { lastAuthenticatedAt: this.lastAuthenticatedAt } : {}), ...(this.error ? { error: this.error } : {}) };
  }

  configure(configuration: StudioMcpConfiguration) {
    validateConfiguration(configuration);
    return this.mutate(() => this.apply(configuration));
  }

  /** Restore the user's saved choice once per app launch; a failed bind has no retry loop. */
  restore() {
    return this.restoration ??= this.mutate(async () => {
      const { configuration } = await this.access.snapshot();
      return configuration.enabled ? this.apply(configuration) : this.status();
    });
  }

  private async apply(configuration: StudioMcpConfiguration) {
    // This is the saved preference, independent from whether the socket can bind this time.
    await this.access.configure(configuration);
    await this.stop();
    this.error = undefined;
    if (!configuration.enabled) return this.status();
    const handler = createMcpHandler(({ requestInfo }) => createStudioMcpServer(this.service, bearer(requestInfo?.headers.get('authorization') ?? '')), { maxSubscriptions: 0 });
    const server = createServer((request, response) => { void this.handle(request, response, configuration, handler); });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    this.handler = handler;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(configuration.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
    } catch {
      await this.stop();
      this.error = 'STUDIO_MCP_LISTEN_FAILED';
      throw new Error(this.error);
    }
    return this.status();
  }

  private mutate(operation: () => Promise<StudioMcpStatus>) {
    const next = this.mutation.then(operation);
    this.mutation = next.then(() => undefined, () => undefined);
    return next;
  }

  async dispose() { this.unsubscribe(); await this.mutation; await this.stop(); }

  private async stop() {
    const server = this.server;
    this.server = undefined;
    this.wake?.close();
    await this.handler?.close();
    this.handler = undefined;
    if (server?.listening) await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    this.windows.clear();
    this.lastAuthenticatedAt = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse, configuration: StudioMcpConfiguration, handler: ReturnType<typeof createMcpHandler>) {
    let url: URL;
    try { url = new URL(request.url ?? '/', `http://127.0.0.1:${configuration.port}`); }
    catch { return reject(response, 400, 'INVALID_URL'); }
    const wakeRequest = url.pathname === '/wake/events' && Boolean(this.wake);
    if ((!wakeRequest && request.url !== '/mcp')) return reject(response, 404, 'NOT_FOUND');
    const hosts = new Set([`127.0.0.1:${configuration.port}`, `localhost:${configuration.port}`]);
    if (configuration.publicOrigin) hosts.add(new URL(configuration.publicOrigin).host);
    const origin = request.headers.origin;
    if (!hosts.has(request.headers.host ?? '') || (origin !== undefined && origin !== configuration.publicOrigin
      && origin !== `http://127.0.0.1:${configuration.port}` && origin !== `http://localhost:${configuration.port}`)) return reject(response, 403, 'ORIGIN_OR_HOST_REJECTED');
    if (request.method !== (wakeRequest ? 'GET' : 'POST')) {
      response.setHeader('Allow', wakeRequest ? 'GET' : 'POST');
      return reject(response, 405, 'METHOD_NOT_ALLOWED');
    }
    if (this.active >= MAX_CONCURRENT_REQUESTS) return reject(response, 429, 'TOO_MANY_REQUESTS');
    this.active += 1;
    try {
      const token = bearer(request.headers.authorization ?? '');
      let identity;
      try { identity = await this.service.authenticate(token); } catch (cause) {
        if (cause instanceof Error && cause.message === 'STUDIO_MCP_DISABLED') return reject(response, 503, 'STUDIO_MCP_DISABLED');
        // No unauthenticated token strings are retained as rate-limit keys.
        if (!this.consume('unauthenticated', 20)) return reject(response, 429, 'TOO_MANY_REQUESTS');
        return reject(response, 401, 'STUDIO_MCP_UNAUTHORIZED');
      }
      if (!this.consume(identity.credentialId, REQUESTS_PER_MINUTE)) return reject(response, 429, 'TOO_MANY_REQUESTS');
      this.lastAuthenticatedAt = new Date().toISOString();
      if (wakeRequest) {
        const rawCursor = url.searchParams.get('afterEventId') ?? request.headers['last-event-id'] ?? '0';
        if (typeof rawCursor !== 'string' || !/^\d+$/.test(rawCursor)) return reject(response, 400, 'STUDIO_WAKE_CURSOR_INVALID');
        return await this.wake!.open(response, token, Number(rawCursor));
      }
      if (!request.headers['content-type']?.startsWith('application/json')) return reject(response, 415, 'JSON_REQUIRED');
      if (Number(request.headers['content-length']) > MAX_REQUEST_BYTES) return reject(response, 413, 'REQUEST_TOO_LARGE');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_REQUEST_BYTES) return reject(response, 413, 'REQUEST_TOO_LARGE');
        chunks.push(buffer);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value);
      const input = new Request(`http://127.0.0.1:${configuration.port}/mcp`, { method: 'POST', headers, body: Buffer.concat(chunks).toString('utf8') });
      const output = await handler.fetch(input);
      response.writeHead(output.status, Object.fromEntries(output.headers));
      response.end(Buffer.from(await output.arrayBuffer()));
    } catch {
      if (!response.headersSent) reject(response, 500, 'STUDIO_MCP_REQUEST_FAILED');
      else response.end();
    } finally { this.active -= 1; }
  }

  private consume(key: string, maximum: number) {
    const now = Date.now();
    for (const [id, window] of this.windows) if (now - window.start >= 60_000) this.windows.delete(id);
    const window = this.windows.get(key) ?? { start: now, count: 0 };
    window.count += 1;
    this.windows.set(key, window);
    return window.count <= maximum;
  }
}

function bearer(value: string) { return /^Bearer (asterium_[A-Za-z0-9_-]{43})$/.exec(value)?.[1] ?? ''; }
function reject(response: ServerResponse, status: number, code: string) {
  response.setHeader('Cache-Control', 'no-store');
  if (status === 429) response.setHeader('Retry-After', '60');
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: code }));
}
