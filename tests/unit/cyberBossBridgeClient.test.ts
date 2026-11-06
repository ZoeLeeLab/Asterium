import { afterEach, describe, expect, it, vi } from 'vitest';
import { CyberBossBridgeClient, normalizeCyberBossServiceUrl } from '../../src/main/adapters/CyberBossBridgeClient';

const serviceUrl = 'https://cyberboss.example.invalid';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function authResponse() {
  return new Response('{}', { headers: { 'Set-Cookie': 'cyberboss_web_session=s; Secure' } });
}

function sseResponse(text: string) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } }), {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('CyberBossBridgeClient', () => {
  it('uses the fixed Origin, keeps the session cookie in memory, and sends stable message IDs', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/auth')) return new Response('{}', { status: 200, headers: { 'Set-Cookie': 'cyberboss_web_session=session-test; HttpOnly; Secure; SameSite=Strict' } });
      if (url.endsWith('/api/session')) return new Response('{"ok":true}', { status: 200 });
      if (url.endsWith('/api/messages')) return new Response('{"accepted":true}', { status: 202 });
      throw new Error(`unexpected ${url}`);
    });
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'bridge-secret', fetcher });
    await client.checkSession();
    await client.sendMessage('你好，外部伙伴', 'stable-client-id');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ secret: 'bridge-secret' });
    expect(calls[0].init?.headers).toEqual(expect.objectContaining({ Origin: serviceUrl }));
    expect(calls[1].init?.headers).toEqual(expect.objectContaining({ Cookie: 'cyberboss_web_session=session-test' }));
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ text: '你好，外部伙伴', clientMessageId: 'stable-client-id' });
  });

  it('reconnects SSE with the last event ID and filters replay duplicates', async () => {
    const eventUrls: string[] = [];
    let eventRequest = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/auth')) return new Response('{}', { status: 200, headers: { 'Set-Cookie': 'cyberboss_web_session=s; Secure' } });
      if (url.includes('/api/events')) {
        eventUrls.push(url);
        eventRequest += 1;
        return eventRequest === 1
          ? sseResponse('id: 7\nevent: chat\ndata: {"role":"status","text":"","status":"typing","clientMessageId":"","createdAt":"","media":[]}\n\n')
          : sseResponse('id: 7\nevent: chat\ndata: {"role":"status","text":"","status":"typing","clientMessageId":"","createdAt":"","media":[]}\n\nid: 8\nevent: chat\ndata: {"role":"assistant","text":"收到","status":"","clientMessageId":"","createdAt":"","media":[]}\n\n');
      }
      throw new Error(`unexpected ${url}`);
    });
    const controller = new AbortController();
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'x', fetcher, reconnectDelay: async () => undefined });
    const iterator = client.events(controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.id).toBe('7');
    expect((await iterator.next()).value?.id).toBe('8');
    controller.abort();
    expect(eventUrls[1]).toContain('lastEventId=7');
  });

  it('reads dynamic session state and parses thread changes', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/auth')) return new Response('{}', { status: 200, headers: { 'Set-Cookie': 'cyberboss_web_session=s; Secure' } });
      if (url.endsWith('/api/session')) return new Response(JSON.stringify({ threadId: 'thread-current-123', workspaceRoot: '/workspace/example-project' }), { status: 200 });
      if (url.includes('/api/events')) return sseResponse('id: 9\nevent: thread_changed\ndata: {"threadId":"thread-new-789","previousThreadId":"thread-current-123","workspaceRoot":"/workspace/example-project","reason":"new"}\n\n');
      throw new Error(`unexpected ${url}`);
    });
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'x', fetcher });
    await expect(client.checkSession()).resolves.toEqual({ threadId: 'thread-current-123', workspaceRoot: '/workspace/example-project' });
    const controller = new AbortController();
    const iterator = client.events(controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { event: 'thread_changed', threadId: 'thread-new-789', previousThreadId: 'thread-current-123', reason: 'new' } });
    controller.abort();
  });

  it('accepts a user-provided HTTPS host and rejects unsafe or non-root URLs', () => {
    expect(normalizeCyberBossServiceUrl('https://example.com').origin).toBe('https://example.com');
    expect(() => normalizeCyberBossServiceUrl('http://example.com')).toThrow('INVALID_CYBERBOSS_SERVICE_URL');
    expect(() => normalizeCyberBossServiceUrl('https://user:pass@example.com')).toThrow('INVALID_CYBERBOSS_SERVICE_URL');
    expect(() => normalizeCyberBossServiceUrl('https://example.com:8443')).toThrow('INVALID_CYBERBOSS_SERVICE_URL');
    expect(() => normalizeCyberBossServiceUrl(`${serviceUrl}/api`)).toThrow('INVALID_CYBERBOSS_SERVICE_URL');
  });

  it('surfaces malformed SSE instead of reconnecting forever', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/auth')) return new Response('{}', { status: 200, headers: { 'Set-Cookie': 'cyberboss_web_session=s; Secure' } });
      if (url.includes('/api/events')) return sseResponse('id: 1\nevent: chat\ndata: not-json\n\n');
      throw new Error(`unexpected ${url}`);
    });
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'x', fetcher, reconnectDelay: async () => undefined });
    const iterator = client.events(new AbortController().signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow('CYBERBOSS_MALFORMED_SSE');
  });

  it('backs off repeated connection failures', async () => {
    const delays: number[] = [];
    const controller = new AbortController();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/auth')) return new Response('{}', { status: 200, headers: { 'Set-Cookie': 'cyberboss_web_session=s; Secure' } });
      if (url.includes('/api/events')) throw new Error('network unavailable');
      throw new Error(`unexpected ${url}`);
    });
    const client = new CyberBossBridgeClient({
      serviceUrl,
      secret: 'x',
      fetcher,
      reconnectDelay: async (milliseconds) => {
        delays.push(milliseconds);
        if (delays.length === 4) controller.abort();
      },
    });

    const iterator = client.events(controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it.each(['closed', 'errored'])('backs off HTTP 200 streams that immediately become $0 and caps the delay at one minute', async (outcome) => {
    const delays: number[] = [];
    const controller = new AbortController();
    let eventRequests = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/api/auth')) return authResponse();
      eventRequests += 1;
      return outcome === 'closed' ? sseResponse('') : new Response(new ReadableStream({
        start(controller) { controller.error(new Error('connection lost')); },
      }));
    });
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'x', fetcher, reconnectDelay: async (ms) => {
      delays.push(ms);
      if (delays.length === 8) controller.abort();
    } });
    await expect(client.events(controller.signal)[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    expect(eventRequests).toBe(8);
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/api/auth'))).toHaveLength(1);
  });

  it('does not reset backoff just because a short stream replays or delivers an event', async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    let eventId = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/api/auth')) return authResponse();
      eventId += 1;
      return sseResponse(`id: ${Math.max(1, eventId - 1)}\nevent: chat\ndata: {"role":"status","status":"typing"}\n\n`);
    });
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'x', fetcher, reconnectDelay: async (ms) => {
      delays.push(ms);
      if (delays.length === 4) controller.abort();
    } });
    const received: string[] = [];
    for await (const event of client.events(controller.signal)) received.push(event.id);
    expect(received).toEqual(['1', '2', '3']);
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it('resets backoff after a stream has stayed connected for thirty seconds', async () => {
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const controller = new AbortController();
    const delays: number[] = [];
    let eventRequests = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/api/auth')) return authResponse();
      eventRequests += 1;
      return sseResponse(eventRequests === 3 ? 'id: 7\nevent: chat\ndata: {"role":"status","status":"typing"}\n\n' : '');
    });
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'x', fetcher, reconnectDelay: async (ms) => {
      delays.push(ms);
      if (delays.length === 4) controller.abort();
    } });
    const iterator = client.events(controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.id).toBe('7');
    now += 30_000;
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(delays).toEqual([2_000, 4_000, 2_000, 4_000]);
  });

  it.each([
    { status: 429, retryAfter: '120', expected: 120_000 },
    { status: 503, retryAfter: new Date(190_000).toUTCString(), expected: 90_000 },
    { status: 503, retryAfter: 'invalid', expected: 2_000 },
  ])('honors Retry-After on HTTP $status ($retryAfter)', async ({ status, retryAfter, expected }) => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const controller = new AbortController();
    const delays: number[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/api/auth')
      ? authResponse() : new Response('', { status, headers: { 'Retry-After': retryAfter } }));
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'x', fetcher, reconnectDelay: async (ms) => {
      delays.push(ms);
      controller.abort();
    } });
    await expect(client.events(controller.signal)[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
    expect(delays).toEqual([expected]);
  });

  it('cancels an idle response body when stopped without scheduling another connection', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const reconnectDelay = vi.fn(async () => undefined);
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/api/auth')
      ? authResponse() : new Response(new ReadableStream({ cancel })));
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'x', fetcher, reconnectDelay });
    const next = client.events(controller.signal)[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true }));
    controller.abort();
    await expect(next).resolves.toMatchObject({ done: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reconnectDelay).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops the authentication request before it can open a late events connection', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    }));
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'x', fetcher });
    const next = client.events(controller.signal)[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][1]?.signal).toBe(controller.signal);
    controller.abort();
    await expect(next).resolves.toMatchObject({ done: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending backoff timer and never reconnects after being stopped', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/api/auth') ? authResponse() : sseResponse(''));
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'x', fetcher });
    const next = client.events(controller.signal)[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    controller.abort();
    await expect(next).resolves.toMatchObject({ done: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the response body when the event consumer finishes early', async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/api/auth') ? authResponse()
      : new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('id: 7\nevent: chat\ndata: {"role":"status","status":"typing"}\n\n'));
      }, cancel })));
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'x', fetcher });
    const iterator = client.events(new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.id).toBe('7');
    await iterator.return?.(undefined);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('removes the completed backoff abort listener before waiting again', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/api/auth') ? authResponse() : sseResponse(''));
    const client = new CyberBossBridgeClient({ serviceUrl, secret: 'x', fetcher });
    const next = client.events(controller.signal)[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    const waitingListener = addListener.mock.calls.at(-1)![1];
    await vi.advanceTimersByTimeAsync(2_000);
    expect(removeListener).toHaveBeenCalledWith('abort', waitingListener);
    controller.abort();
    await expect(next).resolves.toMatchObject({ done: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
