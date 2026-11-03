import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as realTimeout } from 'node:timers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryFallbackSettings } from '../../src/shared/memoryFallback';
import { MemoryFallbackScheduler } from '../../src/main/memory/fallback/MemoryFallbackScheduler';
import { MemoryFallbackJobStore, fallbackHash, type FallbackInput } from '../../src/main/memory/fallback/MemoryFallbackJobStore';
import type { MemoryConsolidation } from '../../src/main/memory/fallback/MemoryConsolidation';
import { DeepSeekProviderAdapter } from '../../src/main/adapters/DeepSeekProviderAdapter';

const directories: string[] = [];
const schedulers: MemoryFallbackScheduler[] = [];
afterEach(async () => { await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.dispose())); vi.useRealTimers(); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(execute?: MemoryConsolidation['execute']) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-scheduler-')); directories.push(dir);
  const file = path.join(dir, 'jobs.json'); const jobs = new MemoryFallbackJobStore(file);
  const message = { messageId: 'm', content: 'durable', hash: fallbackHash('durable'), authorType: 'user' as const, authorId: 'u', occurredAt: new Date(Date.now() - 20 * 60_000).toISOString() };
  const input: FallbackInput = { partnerId: 'p', kind: 'single_chat', conversationId: 'c', busy: false, messages: [message] };
  await jobs.sync([input]);
  const config: MemoryFallbackSettings = { provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'fake', credentialConfigured: true, intervalMinutes: 15, partners: { p: { enabled: true, enabledAt: new Date(Date.now() - 60 * 60_000).toISOString(), history: 'unprocessed' } } };
  const work = vi.fn(execute ?? (async (job) => job.messages.map(({ messageId, hash }) => ({ messageId, hash }))));
  const recover = vi.fn<MemoryConsolidation['recover']>(async () => undefined);
  const inventory = { refresh: vi.fn(async () => undefined) };
  const factory = vi.fn(async () => new DeepSeekProviderAdapter({ endpoint: '', model: '', apiKey: '' }));
  const create = () => { const scheduler = new MemoryFallbackScheduler({ get: async () => structuredClone(config) }, jobs, inventory, { execute: work, recover }, factory, () => true); schedulers.push(scheduler); return scheduler; };
  return { jobs, file, input, config, work, recover, create, inventory, factory };
}
async function flushIO(predicate: () => Promise<boolean>) {
  for (let index = 0; index < 500; index++) { if (await predicate()) return; await new Promise<void>((resolve) => realTimeout(resolve, 2)); }
  throw new Error('test I/O did not settle');
}
describe('one global bounded fallback scheduler', () => {
  it('starts once, skips overlapping ticks, does not poll every minute, and serializes jobs', async () => {
    let release!: () => void;
    const fixtureData = await fixture(async (job) => { await new Promise<void>((resolve) => { release = resolve; }); return job.messages; });
    const { create, work, inventory } = fixtureData; const scheduler = create();
    await scheduler.start(); await scheduler.start();
    await flushIO(async () => work.mock.calls.length === 1);
    const pending = scheduler.tick(); await vi.advanceTimersByTimeAsync(60_000);
    expect(work).toHaveBeenCalledTimes(1); expect(inventory.refresh).toHaveBeenCalledTimes(1);
    release(); await pending;
    expect((await fixtureData.jobs.list())[0].dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(14 * 60_000); await scheduler.tick();
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('uses exactly three attempts at 0/30/150 seconds, then waits for the next fixed poll', async () => {
    const { create, work, jobs } = await fixture(async () => { throw new Error('failure'); }); const scheduler = create();
    const scan = scheduler.tick();
    await flushIO(async () => (await jobs.list())[0].round?.attempts === 1 && work.mock.calls.length === 1);
    await flushIO(async () => Date.parse((await jobs.list())[0].round!.nextAttemptAt) - Date.now() === 30_000 && (await scheduler.snapshot()).jobs[0].state === 'waiting_retry');
    await vi.advanceTimersByTimeAsync(30_000);
    await flushIO(async () => (await jobs.list())[0].round?.attempts === 2 && Date.parse((await jobs.list())[0].round!.nextAttemptAt) - Date.now() === 120_000 && (await scheduler.snapshot()).jobs[0].state === 'waiting_retry');
    await vi.advanceTimersByTimeAsync(120_000); await scan;
    expect(work).toHaveBeenCalledTimes(3); expect((await jobs.list())[0].dirty).toBe(true);
    await scheduler.tick(); expect(work).toHaveBeenCalledTimes(3);
  });
  it('restart preserves exhausted budgets and cooldowns rather than issuing another three requests', async () => {
    const { create, jobs, work } = await fixture(async () => { throw new Error('failure'); });
    const job = (await jobs.list())[0];
    await jobs.change(job.key, (current) => { current.round = { id: 'r', attempts: 3, operationId: 'op', nextAttemptAt: new Date(Date.now() + 30_000).toISOString(), blockedUntil: new Date(Date.now() + 15 * 60_000).toISOString() }; });
    const first = create(); await first.tick(); await first.dispose();
    const restarted = create(); await restarted.tick(); expect(work).not.toHaveBeenCalled();
    expect((await jobs.list())[0].round?.attempts).toBe(3);
  });
  it('resumes an unfinished round only after its persisted backoff, without resetting the attempt count', async () => {
    const { create, jobs, work } = await fixture(); const job = (await jobs.list())[0];
    await jobs.change(job.key, (current) => { current.round = { id: 'r', attempts: 1, operationId: 'op', nextAttemptAt: new Date(Date.now() + 30_000).toISOString(), blockedUntil: new Date(Date.now() + 15 * 60_000).toISOString() }; });
    const scheduler = create(); const scan = scheduler.tick();
    await flushIO(async () => (await scheduler.snapshot()).jobs[0].state === 'waiting_retry');
    await vi.advanceTimersByTimeAsync(15_000); expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000); await scan;
    expect(work).toHaveBeenCalledTimes(1); expect(work.mock.calls[0][0].round?.attempts).toBe(2);
  });
  it('honors a durable committed receipt before resetting an exhausted round', async () => {
    const { create, jobs, work, recover } = await fixture(); const job = (await jobs.list())[0];
    await jobs.change(job.key, (current) => { current.round = { id: 'r', attempts: 3, operationId: 'committed', nextAttemptAt: new Date(Date.now()).toISOString(), blockedUntil: new Date(Date.now()).toISOString() }; });
    recover.mockResolvedValue(job.messages); await create().tick();
    expect(work).not.toHaveBeenCalled(); expect((await jobs.list())[0].dirty).toBe(false);
  });
  it('ignores busy or disabled jobs and aborts an active job on opt-out', async () => {
    const { create, config, input, jobs, work } = await fixture(async (_, __, ___, signal) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); void resolve; }));
    const scheduler = create(); input.busy = true; await jobs.sync([input]); await scheduler.tick(); expect(work).not.toHaveBeenCalled();
    input.busy = false; await jobs.sync([input]); vi.setSystemTime(new Date(Date.now() + 20 * 60_000));
    const scan = scheduler.tick(); await flushIO(async () => work.mock.calls.length === 1);
    config.partners.p.enabled = false; await scheduler.revalidate(); await scan;
    expect((await jobs.list())[0].dirty).toBe(true); expect(work).toHaveBeenCalledTimes(1);
  });
  it('aborts an active job when only its API protocol changes', async () => {
    const { create, config, jobs, work } = await fixture(async (_, __, ___, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }));
    const scheduler = create(); const scan = scheduler.tick();
    await flushIO(async () => work.mock.calls.length === 1);
    config.provider = 'openai'; await scheduler.revalidate(); await scan;
    expect((await jobs.list())[0].dirty).toBe(true); expect(work).toHaveBeenCalledTimes(1);
  });
  it('bounds a hung attempt to 120 seconds and cancels cleanly on shutdown', async () => {
    const { create, work, jobs } = await fixture(async () => new Promise(() => undefined)); const scheduler = create();
    const scan = scheduler.tick(); await flushIO(async () => work.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(120_000);
    await flushIO(async () => Date.parse((await jobs.list())[0].round!.nextAttemptAt) - Date.now() === 30_000);
    await scheduler.dispose(); await scan;
    expect(work).toHaveBeenCalledTimes(1); expect((await jobs.list())[0].dirty).toBe(true);
  });
  it('handles multiple partner jobs serially and does not enqueue extra rounds on overlapping ticks', async () => {
    const order: string[] = []; let active = 0; let peak = 0;
    const { create, jobs, input, config } = await fixture(async (job) => {
      active++; peak = Math.max(peak, active); order.push(job.partnerId);
      await new Promise<void>((resolve) => realTimeout(resolve, 2)); active--; return job.messages;
    });
    config.partners.q = { ...config.partners.p };
    await jobs.sync([input, { ...input, partnerId: 'q', conversationId: 'd' }]);
    const scheduler = create(); const first = scheduler.tick(); const second = scheduler.tick();
    expect(first).toBe(second); await first;
    expect(peak).toBe(1); expect(new Set(order)).toEqual(new Set(['p', 'q']));
    expect((await jobs.list()).every((job) => !job.dirty)).toBe(true);
  });
});
