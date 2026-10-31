// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioWakeControlService } from '../../src/main/studio/StudioWakeControlService';
import { CyberBossBridgeClient } from '../../src/main/adapters/CyberBossBridgeClient';
import type { StudioWakeControlRequest, StudioWakeControlReply } from '../../src/shared/studioWakeAdapter';

const temporary: string[] = [];
const serviceUrl = 'https://server.tail-test.ts.net';
const binding = { partnerId: 'chuan', connectionBindingId: 'server-binding', connectOnLaunch: true };
const request = (action: StudioWakeControlRequest['action'] = 'connect_once'): StudioWakeControlRequest => ({ protocolVersion: 2, source: 'asterium', action, requestId: randomUUID(), connectionBindingId: binding.connectionBindingId });
const reply = (input: StudioWakeControlRequest): StudioWakeControlReply => ({ protocolVersion: 2, requestId: input.requestId, connectionBindingId: input.connectionBindingId, connection: { phase: 'connected' }, duplicate: false, reviews: [] });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) {
    expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-wake-control-')); temporary.push(directory);
  const file = path.join(directory, 'settings.json');
  let ready = false;
  const wakeControl = vi.fn(async (input: StudioWakeControlRequest, signal?: AbortSignal) => { signal?.throwIfAborted(); return reply(input); });
  const options = { connection: (id: string) => id === 'chuan' ? { serviceUrl, credentialRef: 'credential-ref', threadId: 'original-thread' } : undefined,
    ready: async () => ready, secret: vi.fn(async () => 'not-persisted-secret'), client: vi.fn(() => ({ wakeControl })) };
  const service = new StudioWakeControlService(file, options);
  return { file, service, options, wakeControl, ready: (value: boolean) => { ready = value; } };
}

describe('one startup intent, with explicit manual control', () => {
  it('defers startup until ready, never restarts on repeated readiness changes, and stores only binding settings', async () => {
    const f = await fixture(); await f.service.configure(binding); await f.service.changed();
    expect(f.wakeControl).not.toHaveBeenCalled();
    f.ready(true); await Promise.all([f.service.changed(), f.service.changed(), f.service.changed()]);
    expect(f.wakeControl).toHaveBeenCalledTimes(1); expect(f.wakeControl.mock.calls[0][0].action).toBe('connect_once');
    f.ready(false); await f.service.changed(); f.ready(true); await f.service.changed();
    expect(f.wakeControl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(f.file, 'utf8'))).toEqual({ version: 1, bindings: [binding] });
    expect((await f.service.status()).entries[0]).toMatchObject({ ready: true, state: 'connected' });
    await f.service.dispose();
  });
  it('does not retry a failed startup; a manual connect and the next app instance each get one fresh attempt', async () => {
    const f = await fixture(); await f.service.configure(binding); await f.service.changed();
    f.wakeControl.mockRejectedValueOnce(new Error('network result unknown')); f.ready(true); await f.service.changed();
    await f.service.changed(); await f.service.changed(); expect(f.wakeControl).toHaveBeenCalledTimes(1);
    expect((await f.service.status()).entries[0]).toMatchObject({ state: 'unknown', error: 'STUDIO_WAKE_CONTROL_RESULT_UNKNOWN' });
    await f.service.control('chuan', 'connect_once'); expect(f.wakeControl).toHaveBeenCalledTimes(2);
    expect(f.wakeControl.mock.calls[0][0].requestId).not.toBe(f.wakeControl.mock.calls[1][0].requestId);
    await f.service.dispose();
    const next = new StudioWakeControlService(f.file, f.options); await next.changed(); await next.changed();
    expect(f.wakeControl).toHaveBeenCalledTimes(3); await next.dispose();
  });
  it('does not auto connect when disabled and forwards status, retry and ignore without publishing a message', async () => {
    const f = await fixture(); f.ready(true); await f.service.configure({ ...binding, connectOnLaunch: false }); await f.service.changed();
    expect(f.wakeControl).not.toHaveBeenCalled();
    const triggerId = randomUUID();
    await f.service.control('chuan', 'status'); await f.service.control('chuan', 'retry', triggerId); await f.service.control('chuan', 'ignore', triggerId);
    expect(f.wakeControl.mock.calls.map(([value]) => [value.action, value.triggerId])).toEqual([['status', undefined], ['retry', triggerId], ['ignore', triggerId]]);
    await expect(f.service.control('chuan', 'retry')).rejects.toThrow('STUDIO_WAKE_CONTROL_INVALID');
    await expect(f.service.control('chuan', 'connect_once', triggerId)).rejects.toThrow('STUDIO_WAKE_CONTROL_INVALID');
    f.ready(false); await expect(f.service.control('chuan', 'connect_once')).rejects.toThrow('STUDIO_WAKE_MCP_NOT_READY');
    await f.service.dispose();
  });
  it('coalesces double clicks and aborts an outstanding request on shutdown', async () => {
    const f = await fixture(); f.ready(true); await f.service.configure({ ...binding, connectOnLaunch: false }); await f.service.changed();
    f.wakeControl.mockImplementationOnce((_value, signal) => new Promise((_resolve, reject) => { signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true }); }));
    const first = f.service.control('chuan', 'connect_once');
    await vi.waitFor(() => expect(f.wakeControl).toHaveBeenCalledTimes(1));
    const second = f.service.control('chuan', 'connect_once'); await new Promise((resolve) => setImmediate(resolve));
    expect(f.wakeControl).toHaveBeenCalledTimes(1); await f.service.dispose(); await Promise.all([first, second]);
    await f.service.changed(); expect(f.wakeControl).toHaveBeenCalledTimes(1);
  });
  it('reports an unsupported server without fallback or automatic retries', async () => {
    const f = await fixture(); f.ready(true); f.wakeControl.mockRejectedValue(new Error('STUDIO_WAKE_CONTROL_UNSUPPORTED'));
    await f.service.configure(binding); await f.service.changed();
    expect((await f.service.status()).entries[0].state).toBe('unavailable');
    await f.service.changed(); expect(f.wakeControl).toHaveBeenCalledTimes(1); await f.service.dispose();
  });
  it('reuses the in-memory session but refreshes its client after credential repair', async () => {
    const f = await fixture(); f.ready(true); await f.service.configure({ ...binding, connectOnLaunch: false }); await f.service.changed();
    await f.service.control('chuan', 'status'); await f.service.control('chuan', 'status');
    expect(f.options.client).toHaveBeenCalledTimes(1);
    f.options.secret.mockResolvedValue('repaired-secret'); await f.service.control('chuan', 'connect_once');
    expect(f.options.client).toHaveBeenCalledTimes(2); await f.service.dispose();
  });
});

describe('dedicated small-gate control transport', () => {
  function transport(result: (input: StudioWakeControlRequest) => Response | Promise<Response>) {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname; calls.push({ path: pathname, init });
      if (pathname === '/api/auth') return new Response('{}', { headers: { 'Set-Cookie': 'cyberboss_web_session=fixture; HttpOnly; Secure; SameSite=Strict' } });
      expect(pathname).toBe('/api/asterium/wake/control'); return result(JSON.parse(String(init!.body)));
    });
    return { calls, fetcher, client: new CyberBossBridgeClient({ serviceUrl, secret: 'secret', fetcher }) };
  }
  it('reuses Cookie/Origin and never calls chat send, events or session endpoints', async () => {
    const t = transport((input) => Response.json(reply(input))); const input = request();
    await expect(t.client.wakeControl(input)).resolves.toEqual(reply(input));
    expect(t.calls.map((call) => call.path)).toEqual(['/api/auth', '/api/asterium/wake/control']);
    expect(t.calls[1].init?.headers).toMatchObject({ Origin: serviceUrl, Cookie: 'cyberboss_web_session=fixture' });
    expect(JSON.parse(String(t.calls[1].init?.body))).toEqual(input);
  });
  it('only reauthenticates a rejected session once, preserving the same idempotency ID', async () => {
    let count = 0; const t = transport((input) => ++count === 1 ? new Response('', { status: 401 }) : Response.json(reply(input)));
    const input = request(); await t.client.wakeControl(input);
    expect(t.calls.map((call) => call.path)).toEqual(['/api/auth', '/api/asterium/wake/control', '/api/auth', '/api/asterium/wake/control']);
    expect(t.calls[1].init!.body).toBe(t.calls[3].init!.body);
  });
  it.each([404, 405, 403, 500])('returns one failure on HTTP %i, without retries or chat fallback', async (status) => {
    const t = transport(() => new Response('', { status }));
    await expect(t.client.wakeControl(request())).rejects.toThrow(status === 404 || status === 405 ? 'STUDIO_WAKE_CONTROL_UNSUPPORTED' : status === 403 ? 'STUDIO_WAKE_CONTROL_UNAUTHORIZED' : 'STUDIO_WAKE_CONTROL_UNAVAILABLE');
    expect(t.calls).toHaveLength(2);
  });
  it('does not retry unknown network results or accept mismatched / oversized replies', async () => {
    const t = transport(async () => { throw new Error('lost reply'); });
    await expect(t.client.wakeControl(request())).rejects.toThrow('lost reply'); expect(t.calls).toHaveLength(2);
    const mismatch = transport((input) => Response.json({ ...reply(input), requestId: randomUUID() }));
    await expect(mismatch.client.wakeControl(request())).rejects.toThrow('STUDIO_WAKE_CONTROL_REPLY_INVALID');
    const large = transport(() => new Response('x'.repeat(65537)));
    await expect(large.client.wakeControl(request())).rejects.toThrow('STUDIO_WAKE_CONTROL_REPLY_INVALID');
  });
  it('rejects non-private control origins without changing ordinary single-chat URL support', async () => {
    const fetcher = vi.fn(); const client = new CyberBossBridgeClient({ serviceUrl: 'https://example.invalid', secret: 'secret', fetcher });
    await expect(client.wakeControl(request())).rejects.toThrow('STUDIO_WAKE_CONTROL_INVALID'); expect(fetcher).not.toHaveBeenCalled();
  });
});
