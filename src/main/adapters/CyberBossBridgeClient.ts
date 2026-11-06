import { cyberBossChatFileCapabilitiesSchema, cyberBossChatFileSchema } from '../../shared/cyberBossChatAttachments';
import { CyberBossSseParser, type CyberBossSseEvent } from './cyberBossSseParser';
import { studioWakeControlReplySchema, studioWakeControlRequestSchema, type StudioWakeControlRequest } from '../../shared/studioWakeAdapter';
import { EXISTING_PARTNER_REVIEW_PATH, reviewCapabilitySchema, reviewReceiptSchema, reviewRequestSchema, type ExistingPartnerReviewRequest } from '../../shared/existingPartnerReview';

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

  async authenticate(signal?: AbortSignal | null, redirect?: RequestRedirect) {
    signal?.throwIfAborted();
    const response = await this.fetcher(new URL('/api/auth', this.baseUrl), {
      method: 'POST',
      headers: { Origin: this.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: this.options.secret }),
      ...(signal ? { signal } : {}),
      ...(redirect ? { redirect } : {}),
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

  async checkSession(forChatAttachment = false) {
    const response = await this.authorizedFetch('/api/session', {
      method: 'GET',
      ...(forChatAttachment ? { redirect: 'error' as const, signal: AbortSignal.timeout(10_000), cache: 'no-store' as const } : {}),
    });
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

  async uploadChatImage(image: { name: string; mediaType: string }, bytes: Uint8Array, mixed = false) {
    const errorCode = 'CYBERBOSS_CHAT_IMAGE_UPLOAD_FAILED';
    let response: Response | undefined;
    try {
      response = await this.authorizedFetch('/api/media', {
        method: 'POST',
        headers: { 'Content-Type': image.mediaType, 'X-File-Name-B64': Buffer.from(image.name, 'utf8').toString('base64url') },
        body: new Uint8Array(bytes),
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      }, !mixed);
      if (response.status === 401 && mixed) throw new Error('CYBERBOSS_AUTH_FAILED');
      if (response.status !== 201) throw new Error(errorCode);
      const reply = await readBoundedJson(response, 16 * 1024, errorCode);
      if (!isRecord(reply) || reply.ok !== true || !isRecord(reply.media) || typeof reply.media.mediaId !== 'string'
        || !reply.media.mediaId.trim() || reply.media.mediaId.length > 256) {
        throw new Error(errorCode);
      }
      return reply.media.mediaId;
    } catch (error) {
      if (error instanceof Error && error.message === 'CYBERBOSS_AUTH_FAILED') throw error;
      throw new Error(errorCode, { cause: error });
    } finally {
      await response?.body?.cancel().catch(() => undefined);
    }
  }

  async chatFileCapabilities() {
    const errorCode = 'CYBERBOSS_CHAT_FILE_UNAVAILABLE';
    const response = await this.authorizedFetch('/api/attachments/capabilities', {
      method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8_000),
    });
    try {
      if (response.status === 404 || response.status === 405) return undefined;
      if (response.status !== 200) throw await chatAttachmentResponseError(response, errorCode);
      const result = cyberBossChatFileCapabilitiesSchema.safeParse(await readBoundedJson(response, 32 * 1024, errorCode));
      return result.success ? result.data : undefined;
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  }

  async uploadChatFile(file: { name: string; mediaType: string; sizeBytes: number }, bytes: Uint8Array, threadId: string) {
    const errorCode = 'CYBERBOSS_CHAT_FILE_UPLOAD_FAILED';
    let response: Response | undefined;
    try {
      response = await this.authorizedFetch('/api/attachments', {
        method: 'POST',
        headers: {
          'Content-Type': file.mediaType,
          'X-File-Name-B64': Buffer.from(file.name, 'utf8').toString('base64url'),
          'X-Cyberboss-Thread-Id': threadId,
        },
        body: new Uint8Array(bytes),
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      }, false);
      if (response.status !== 201) throw await chatAttachmentResponseError(response, errorCode);
      const reply = await readBoundedJson(response, 16 * 1024, errorCode);
      if (!isRecord(reply) || reply.ok !== true) throw new Error(errorCode);
      if (reply.threadId !== threadId) throw new Error('CYBERBOSS_CHAT_THREAD_CHANGED');
      const result = cyberBossChatFileSchema.safeParse(reply.attachment);
      if (!result.success || result.data.sizeBytes !== file.sizeBytes || result.data.contentType !== file.mediaType) {
        throw new Error(errorCode);
      }
      return result.data.attachmentId;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CYBERBOSS_')) throw error;
      throw new Error(errorCode, { cause: error });
    } finally {
      await response?.body?.cancel().catch(() => undefined);
    }
  }

  async sendChatWithFiles(input: { text: string; clientMessageId: string; mediaIds: string[]; attachmentIds: string[]; threadId: string }) {
    const body = JSON.stringify(input);
    let uncertain = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response | undefined;
      try {
        response = await this.authorizedFetch('/api/messages', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
          redirect: 'error', signal: AbortSignal.timeout(30_000),
        }, false);
      } catch {
        uncertain = true;
        continue;
      }
      try {
        if (response.status === 202) {
          const reply = await readBoundedJson(response, 64 * 1024, 'CYBERBOSS_CHAT_MESSAGE_UNCERTAIN').catch(() => undefined);
          if (isRecord(reply) && reply.ok === true && reply.clientMessageId === input.clientMessageId
            && isRecord(reply.message) && reply.message.clientMessageId === input.clientMessageId) return;
          uncertain = true;
          continue;
        }
        if (response.status >= 500) {
          uncertain = true;
          continue;
        }
        if (uncertain) break;
        throw await chatAttachmentResponseError(response, 'CYBERBOSS_CHAT_MESSAGE_REJECTED');
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    }
    throw new Error('CYBERBOSS_CHAT_MESSAGE_UNCERTAIN');
  }

  async sendMessage(text: string, clientMessageId: string, mediaIds: string[] = []) {
    const response = await this.authorizedFetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, clientMessageId, ...(mediaIds.length ? { mediaIds } : {}) }),
      ...(mediaIds.length ? { redirect: 'error' as const, signal: AbortSignal.timeout(30_000) } : {}),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 409) throw new Error('CYBERBOSS_IDEMPOTENCY_CONFLICT');
    if (mediaIds.length ? response.status !== 202 : !response.ok) throw new Error('CYBERBOSS_MESSAGE_REJECTED');
  }

  async reviewCapability(signal: AbortSignal) {
    return reviewCapabilitySchema.parse(await this.reviewResponse(EXISTING_PARTNER_REVIEW_PATH, { method: 'GET', signal }));
  }

  async submitReview(request: ExistingPartnerReviewRequest, bytes: Uint8Array, signal: AbortSignal) {
    const metadata = reviewRequestSchema.parse(request);
    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'text/markdown' }), metadata.file.name);
    return reviewReceiptSchema.parse(await this.reviewResponse(EXISTING_PARTNER_REVIEW_PATH, { method: 'POST', body: form, signal }));
  }

  async reviewStatus(requestId: string, signal: AbortSignal) {
    const pathname = `${EXISTING_PARTNER_REVIEW_PATH}/${encodeURIComponent(requestId)}`;
    return reviewReceiptSchema.parse(await this.reviewResponse(pathname, { method: 'GET', signal }));
  }

  private async reviewResponse(pathname: string, init: RequestInit) {
    const timeout = AbortSignal.timeout(8_000);
    const response = await this.authorizedFetch(pathname, {
      ...init, redirect: 'error', cache: 'no-store',
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    }, init.method !== 'POST');
    try {
      if (!response.ok) throw new Error('CYBERBOSS_REVIEW_UNAVAILABLE');
      return await readBoundedJson(response, 128 * 1024, 'CYBERBOSS_REVIEW_REPLY_INVALID');
    } finally { await response.body?.cancel().catch(() => undefined); }
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
          if (signal.aborted) return;
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

  private async authorizedFetch(pathname: string, init: RequestInit, retryUnauthorized = true) {
    init.signal?.throwIfAborted();
    if (!this.cookie) await this.authenticate(init.signal, init.redirect);
    init.signal?.throwIfAborted();
    let response = await this.fetcher(new URL(pathname, this.baseUrl), { ...init, headers: { Origin: this.origin, Cookie: this.cookie, ...init.headers } });
    if (response.status === 401) this.cookie = '';
    if (response.status === 401 && retryUnauthorized) {
      await response.body?.cancel().catch(() => undefined);
      await this.authenticate(init.signal, init.redirect);
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

async function readBoundedJson(response: Response, maxBytes: number, errorCode: string): Promise<unknown> {
  if (!response.body) throw new Error(errorCode);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error(errorCode);
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error(errorCode); }
}

const CHAT_ATTACHMENT_ERRORS = new Map([
  ['unsafe_attachment_name', 'CYBERBOSS_CHAT_FILE_NAME'],
  ['attachment_signature_mismatch', 'CYBERBOSS_CHAT_FILE_SIGNATURE'],
  ['invalid_attachments', 'CYBERBOSS_CHAT_ATTACHMENT_INVALID'],
  ['too_many_attachments', 'CYBERBOSS_CHAT_TOO_MANY_ATTACHMENTS'],
  ['attachment_forbidden', 'CYBERBOSS_CHAT_ATTACHMENT_FORBIDDEN'],
  ['thread_changed', 'CYBERBOSS_CHAT_THREAD_CHANGED'],
  ['client_message_id_conflict', 'CYBERBOSS_IDEMPOTENCY_CONFLICT'],
  ['attachment_expired', 'CYBERBOSS_CHAT_ATTACHMENT_EXPIRED'],
  ['attachment_too_large', 'CYBERBOSS_CHAT_FILE_SIZE'],
  ['attachments_too_large', 'CYBERBOSS_CHAT_TOTAL_SIZE'],
  ['unsupported_attachment_type', 'CYBERBOSS_CHAT_FILE_TYPE'],
]);

async function chatAttachmentResponseError(response: Response, fallback: string) {
  if (response.status === 401) return new Error('CYBERBOSS_AUTH_FAILED');
  const reply = await readBoundedJson(response, 16 * 1024, fallback).catch(() => undefined);
  const code = isRecord(reply) && typeof reply.error === 'string' ? CHAT_ATTACHMENT_ERRORS.get(reply.error) : undefined;
  return new Error(code ?? fallback);
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
