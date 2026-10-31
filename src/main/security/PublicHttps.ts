import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type HostLookup = typeof lookup;

export interface PublicHttpsRequestOptions {
  fetcher?: typeof fetch;
  lookupHost?: HostLookup;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  followRedirects?: boolean;
  errorPrefix?: string;
}

export interface PublicHttpsResponse {
  url: URL;
  status: number;
  headers: Headers;
  bytes: Buffer;
}

export function validatePublicHttpsUrl(value: string | URL, errorCode = 'REMOTE_URL_REJECTED') {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch {
    throw new Error(errorCode);
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(errorCode);
  return url;
}

export async function assertPublicHostname(hostname: string, errorCode = 'REMOTE_URL_REJECTED', lookupHost: HostLookup = lookup) {
  let addresses: Array<{ address: string }>;
  try {
    addresses = isIP(hostname) ? [{ address: hostname }] : await lookupHost(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(errorCode);
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error(errorCode);
}

export async function requestPublicHttps(source: string | URL, options: PublicHttpsRequestOptions): Promise<PublicHttpsResponse> {
  const prefix = options.errorPrefix ?? 'WEB';
  const fetcher = options.fetcher ?? fetch;
  const lookupHost = options.lookupHost ?? lookup;
  const maxRedirects = options.maxRedirects ?? 5;
  const followRedirects = options.followRedirects !== false;
  let current = validatePublicHttpsUrl(source, `${prefix}_URL_REJECTED`);

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    await assertPublicHostname(current.hostname, `${prefix}_URL_REJECTED`, lookupHost);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) throw abortError();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? 15_000);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    let response: Response;
    try {
      response = await fetcher(current, {
        redirect: 'manual',
        headers: options.headers,
        signal: controller.signal,
      });
    } catch (error) {
      cleanup();
      if (options.signal?.aborted) throw abortError();
      if (timedOut) throw new Error(`${prefix}_REQUEST_TIMEOUT`, { cause: error });
      throw error;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      cleanup();
      if (!followRedirects || !location || redirect === maxRedirects) throw new Error(`${prefix}_REDIRECT_REJECTED`);
      current = validatePublicHttpsUrl(new URL(location, current), `${prefix}_URL_REJECTED`);
      continue;
    }

    const declaredSize = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredSize) && declaredSize > options.maxBytes) {
      cleanup();
      throw new Error(`${prefix}_RESPONSE_TOO_LARGE`);
    }
    try {
      const bytes = await readLimitedBody(response, options.maxBytes, `${prefix}_RESPONSE_TOO_LARGE`, controller.signal);
      return { url: current, status: response.status, headers: response.headers, bytes };
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      if (timedOut) throw new Error(`${prefix}_REQUEST_TIMEOUT`, { cause: error });
      throw error;
    } finally {
      cleanup();
    }
  }

  throw new Error(`${prefix}_REDIRECT_REJECTED`);
}

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('fc')
    || normalized.startsWith('fd') || normalized.startsWith('ff')) return true;
  const mapped = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  const parts = mapped.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] >= 224;
}

async function readLimitedBody(response: Response, maxBytes: number, tooLargeCode: string, signal?: AbortSignal) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(tooLargeCode);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function abortError() {
  return Object.assign(new Error('ABORTED'), { name: 'AbortError' });
}
