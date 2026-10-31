// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WakeSingleConnection } from '../../src/main/studio/WakeSingleConnection';
import { WakeDeliveryQueue } from '../../src/main/studio/WakeDeliveryQueue';
import { WakeDeliveryStore } from '../../src/main/studio/WakeDeliveryStore';
import { WakeBridgeSession } from '../../src/main/studio/WakeBridgeSession';
import { STUDIO_WAKE_LIMITS as limits, type StudioWakeHint, type StudioWakeTrigger } from '../../src/shared/studioWake';

const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) {
    expect(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
});
const hint = (eventId: number, roomId = 'A', cursor = eventId): StudioWakeHint => ({ roomId, cursor, latestEventId: eventId,
  membershipGeneration: 1, wakeEligible: true, wakeReason: 'user_message' });
const encode = (value: StudioWakeHint) => `id: ${value.latestEventId}\nevent: wake\ndata: ${JSON.stringify(value)}\n\n`;
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  return { response, controller, push: (value: string) => controller.enqueue(new TextEncoder().encode(value)) };
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-wake-minimal-')); temporary.push(directory);
  const file = path.join(directory, 'positions.json'), store = new WakeDeliveryStore(file);
  const enqueue = vi.fn(async (trigger: StudioWakeTrigger) => ({ accepted: true, triggerId: trigger.triggerId }));
  const queue = new WakeDeliveryQueue('fixed-adapter', { enqueue }, store); await queue.begin();
  return { file, store, enqueue, queue };
}

describe('one SSE attempt, with only a connection establishment deadline', () => {
  it('keeps a successful silent connection alive for a day, accepts heartbeats, and ignores duplicate starts', async () => {
    vi.useFakeTimers(); const s = stream(), event = vi.fn(async () => undefined), fetcher = vi.fn(async () => s.response);
    const client = new WakeSingleConnection('http://127.0.0.1:17361', 'test-token', event, fetcher);
    expect(client.start('startup', 0).duplicate).toBe(false); await vi.advanceTimersByTimeAsync(0);
    expect(client.status().phase).toBe('connected');
    client.start('second-startup', 0); client.start('startup', 0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(client.status().phase).toBe('connected'); expect(fetcher).toHaveBeenCalledTimes(1);
    s.push(': heartbeat\n\n'); await vi.advanceTimersByTimeAsync(0); expect(event).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await client.stop(); expect(client.status()).toEqual({ phase: 'stopped', reason: 'manual' });
  });

  it('times out only the initial fetch, never retries, and requires a fresh explicit request after failure', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
    }));
    const client = new WakeSingleConnection('http://127.0.0.1:17361', 'token', async () => undefined, fetcher);
    client.start('once', 7); await vi.advanceTimersByTimeAsync(limits.connectTimeoutMs);
    expect(client.status()).toEqual({ phase: 'stopped', reason: 'connect_timeout' });
    await vi.advanceTimersByTimeAsync(3600000); client.start('once', 7); expect(fetcher).toHaveBeenCalledTimes(1);
    client.start('manual-new', 7); expect(fetcher).toHaveBeenCalledTimes(2); await client.stop();
  });

  it.each(['eof', 'network_error', 'protocol_error'] as const)('stops once on %s and ignores SSE retry directives', async (cause) => {
    const s = stream(), fetcher = vi.fn(async () => s.response);
    const client = new WakeSingleConnection('http://127.0.0.1:17361', 'token', async () => undefined, fetcher);
    client.start('once', 0); await Promise.resolve(); s.push('retry: 1\n\n');
    if (cause === 'eof') s.controller.close();
    else if (cause === 'network_error') s.controller.error(new Error('socket closed'));
    else s.push('event: wake\nid: 1\ndata: {"invalid":true}\n\n');
    await client.settled(); expect(client.status()).toEqual({ phase: 'stopped', reason: cause }); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('parses fragmented multibyte frames and distinguishes authority revocation from ordinary silence', async () => {
    const s = stream(), event = vi.fn(async () => undefined);
    const client = new WakeSingleConnection('http://127.0.0.1:17361', 'token', event, async () => s.response);
    client.start('once', 0); await Promise.resolve();
    const bytes = new TextEncoder().encode(encode(hint(1, '群聊')));
    for (const byte of bytes) s.controller.enqueue(new Uint8Array([byte]));
    s.push('event: access_revoked\ndata: {}\n\n'); await client.settled();
    expect(event).toHaveBeenCalledExactlyOnceWith({ type: 'wake', hint: hint(1, '群聊') });
    expect(client.status().reason).toBe('unauthorized');
  });

  it.each([401, 403, 500])('makes a single rejected handshake for HTTP %s', async (status) => {
    const fetcher = vi.fn(async () => new Response('{}', { status }));
    const client = new WakeSingleConnection('http://127.0.0.1:17361', 'token', async () => undefined, fetcher);
    client.start('once', 0); await client.settled(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(client.status().reason).toBe(status === 500 ? 'network_error' : 'unauthorized');
  });
});

describe('minimal notification positions and group-isolated manual review', () => {
  it('merges for two seconds and releases delivery immediately on host acceptance, without waiting for model completion or MCP ack', async () => {
    const h = await fixture(); await h.queue.offer(hint(1), 0); await h.queue.offer(hint(2), 1000);
    await h.queue.pump(1999); expect(h.enqueue).not.toHaveBeenCalled();
    await h.queue.pump(2000); expect(h.enqueue).toHaveBeenCalledTimes(1); expect(h.enqueue.mock.calls[0][0].cursor).toBe(2);
    await h.queue.offer(hint(3), 2100); await h.queue.pump(4100); expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect(h.queue.status().reviews).toEqual([]);
    const data = await readFile(h.file, 'utf8'); expect(data).not.toMatch(/active|pending|state|token|content|starts/);
    expect(JSON.parse(data)).toMatchObject({ scanCursor: 3, rooms: [{ notificationCursor: 3, lastDelivered: { eventId: 3 } }] });
  });

  it('never automatically repeats an uncertain delivery; another group proceeds and retry keeps the same trigger ID', async () => {
    const h = await fixture(); h.enqueue.mockRejectedValueOnce(new Error('lost receipt'));
    await h.queue.offer(hint(1, 'A'), 0); await h.queue.offer(hint(2, 'B'), 0); await h.queue.pump(2000);
    expect(h.enqueue).toHaveBeenCalledTimes(2); expect(h.queue.status().reviews).toMatchObject([{ roomId: 'A', reason: 'uncertain' }]);
    await h.queue.offer(hint(3, 'A'), 3000); await h.queue.offer(hint(4, 'B'), 3000); await h.queue.pump(5000);
    expect(h.enqueue).toHaveBeenCalledTimes(3); expect(h.enqueue.mock.calls[2][0].roomId).toBe('B');
    const id = h.queue.status().reviews[0].triggerId; await h.queue.decide(id, 'retry', 6000);
    expect(h.enqueue.mock.calls[3][0].triggerId).toBe(h.enqueue.mock.calls[0][0].triggerId);
    await h.queue.pump(6001); expect(h.enqueue.mock.calls[4][0].cursor).toBe(3);
  });

  it('times out only an unknown delivery receipt and continues another group; no transport reconnect or model retry', async () => {
    const h = await fixture(); h.enqueue.mockImplementationOnce(() => new Promise(() => undefined));
    await h.queue.offer(hint(1), 0); await h.queue.offer(hint(2, 'B'), 0);
    vi.useFakeTimers(); const pump = h.queue.pump(2000);
    await vi.waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1)); await vi.advanceTimersByTimeAsync(limits.deliveryReceiptMs); await pump;
    expect(h.enqueue).toHaveBeenCalledTimes(2); expect(h.queue.status().reviews[0].reason).toBe('uncertain');
    await h.queue.pump(1e6); expect(h.enqueue).toHaveBeenCalledTimes(2);
  });

  it('recovers old unresolved events conservatively after restart, persists ignore as a notification cursor and never overwrites another group', async () => {
    const h = await fixture(); h.enqueue.mockRejectedValueOnce(new Error('unknown'));
    await h.queue.offer(hint(1), 0); await h.queue.offer(hint(2, 'B'), 0); await h.queue.pump(2000);
    expect(await h.store.replayCursor()).toBe(0);
    const recovered = new WakeDeliveryQueue('fixed-adapter', { enqueue: h.enqueue }, new WakeDeliveryStore(h.file)); await recovered.begin();
    await recovered.offer(hint(1), 3000); await recovered.offer(hint(2, 'B'), 3000); await recovered.pump(5000);
    expect(h.enqueue).toHaveBeenCalledTimes(2); expect(recovered.status().reviews).toMatchObject([{ roomId: 'A', reason: 'replay' }]);
    await recovered.decide(recovered.status().reviews[0].triggerId, 'ignore', 5000);
    const again = new WakeDeliveryQueue('fixed-adapter', { enqueue: h.enqueue }, new WakeDeliveryStore(h.file)); await again.begin();
    await again.offer(hint(1), 6000); await again.offer(hint(2, 'B'), 6000);
    expect(again.status().reviews).toEqual([]); expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect((await h.store.read()).rooms.find((room) => room.roomId === 'A')?.lastDelivered).toBeUndefined();
  });

  it('drops revoked generations, preserves the six-start budget, and refuses automatic retry after persistence failure', async () => {
    const h = await fixture();
    for (let i = 1; i <= 7; i++) await h.queue.offer(hint(i, `group-${i}`), 0);
    await h.queue.pump(2000); expect(h.enqueue).toHaveBeenCalledTimes(6); expect(h.queue.status().paused).toBe('quota');
    await h.queue.resume(3000); await h.queue.pump(3000); expect(h.enqueue).toHaveBeenCalledTimes(6);
    await h.queue.resume(63000); await h.queue.pump(63000); expect(h.enqueue).toHaveBeenCalledTimes(7);
    await h.queue.offer(hint(8, 'new'), 64000); await h.queue.offer({ ...hint(9, 'new'), wakeEligible: false, wakeReason: 'room_changed' }, 64000);
    await h.queue.pump(67000); expect(h.enqueue).toHaveBeenCalledTimes(7);
    await h.queue.offer({ ...hint(10, 'new'), membershipGeneration: 3 }, 68000); await h.queue.offer(hint(11, 'new'), 68000);
    vi.spyOn(h.store, 'checkpoint').mockRejectedValueOnce(new Error('disk full')); await h.queue.pump(71000);
    expect(h.enqueue).toHaveBeenCalledTimes(7); expect(h.queue.status().reviews[0]).toMatchObject({ membershipGeneration: 3, reason: 'rejected' });
  });

  it('rejects old full task-state files instead of silently replaying them', async () => {
    const h = await fixture(); await writeFile(h.file, JSON.stringify({ version: 1, scanCursor: 0, rooms: [], active: { triggerId: 'old' } }));
    await expect(new WakeDeliveryStore(h.file).read()).rejects.toThrow('STUDIO_WAKE_CHECKPOINT_INVALID');
  });

  it('deduplicates connect controls, never auto-starts a session, and pumps only a fully caught-up live connection', async () => {
    const h = await fixture(), s = stream(), fetcher = vi.fn(async () => s.response);
    const session = new WakeBridgeSession('binding', 'http://127.0.0.1:17361', 'token', { enqueue: h.enqueue }, h.store, fetcher);
    const request = { protocolVersion: 2 as const, source: 'asterium' as const, action: 'connect_once' as const, connectionBindingId: 'binding', requestId: randomUUID() };
    expect(fetcher).not.toHaveBeenCalled();
    await Promise.all([session.control(request), session.control({ ...request, requestId: randomUUID() })]); expect(fetcher).toHaveBeenCalledTimes(1);
    s.push(encode(hint(1))); s.push('id: 1\nevent: checkpoint\ndata: {"latestEventId":1,"caughtUp":false}\n\n');
    await h.store.read(); await session.tick(Date.now() + 10000); expect(h.enqueue).not.toHaveBeenCalled();
    await session.dispose(); expect(fetcher).toHaveBeenCalledTimes(1);
    const duplicate = await session.control(request); expect(duplicate.duplicate).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
