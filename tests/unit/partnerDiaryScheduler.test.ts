import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as realTimeout } from 'node:timers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartnerDiaryScheduler, type DiaryGeneration } from '../../src/main/diary/PartnerDiaryScheduler';
import { PartnerDiaryStore } from '../../src/main/diary/PartnerDiaryStore';
import { WriterLeaseCoordinator } from '../../src/main/runtime/WriterLeaseCoordinator';
import type { PartnerDiaryConfig } from '../../src/shared/partnerDiary';
import type { SingleChatConversationSnapshot } from '../../src/shared/singleChatMessages';

const dirs: string[] = []; const schedulers: PartnerDiaryScheduler[] = [];
afterEach(async () => { await Promise.all(schedulers.splice(0).map((scheduler) => scheduler.dispose())); vi.useRealTimers(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function flush(predicate: () => Promise<boolean>) { for (let index = 0; index < 500; index++) { if (await predicate()) return; await new Promise<void>((resolve) => realTimeout(resolve, 2)); } throw new Error('Diary test did not settle'); }
async function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T09:59:00'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-diary-clock-')); dirs.push(dir);
  const store = new PartnerDiaryStore(dir, 'p');
  const config: PartnerDiaryConfig = { partnerId: 'p', conversationId: 'c', enabled: true, time: '10:00', revision: 1 };
  const source: SingleChatConversationSnapshot = { partnerId: 'p', conversationId: 'c', busy: false, messages: [
    { messageId: 'today', authorType: 'user', authorId: 'u', content: 'today only', createdAt: '09:00', occurredAt: new Date('2026-10-21T09:00:00').toISOString() },
    { messageId: 'yesterday', authorType: 'user', authorId: 'u', content: 'do not include yesterday', createdAt: '09:00', occurredAt: new Date('2026-10-20T09:00:00').toISOString() },
    { messageId: 'undated', authorType: 'user', authorId: 'u', content: 'unknown day', createdAt: '09:00' },
    { messageId: 'failed', authorType: 'partner', authorId: 'p', content: 'unstable', createdAt: '09:00', occurredAt: new Date('2026-10-21T09:01:00').toISOString(), fallbackEligible: false },
  ] };
  const generate = vi.fn(async (input: DiaryGeneration): Promise<string> => { expect(input.source).toContain('today only'); expect(input.source).not.toContain('yesterday'); expect(input.source).not.toContain('unknown day'); expect(input.source).not.toContain('unstable'); return '# 2026-10-21\n\n## 今天发生的事情\n今天我和用户读书。'; });
  const getSource = vi.fn(async (id: string) => id === 'c' ? source : undefined);
  const identity = vi.fn(() => ({ available: true }));
  const leases = new WriterLeaseCoordinator();
  const create = () => { const scheduler = new PartnerDiaryScheduler({ settings: { list: async () => [{ ...config }] }, store: async () => store, source: getSource, identity, generate, leases }); schedulers.push(scheduler); return scheduler; };
  return { config, source, generate, getSource, identity, create, store, leases };
}
describe('daily diary scheduling without catchup or retries', () => {
  it('generates once from only the selected window today and cannot repeat after rescheduling', async () => {
    const { create, config, generate, store, getSource } = await fixture(); const scheduler = create(); await scheduler.start(); await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush(async () => (await store.list())[0]?.state === 'completed');
    expect(generate).toHaveBeenCalledTimes(1); expect(generate.mock.calls[0]).toBeDefined();
    expect(getSource.mock.calls.every(([id]) => id === 'c')).toBe(true);
    const document = await store.read('2026-10-21'); expect(document?.content).toMatch(/^# 2026-10-21\n/u);
    config.time = '10:02'; config.revision++; await scheduler.changed(); await vi.advanceTimersByTimeAsync(120_000);
    await new Promise<void>((resolve) => realTimeout(resolve, 15)); expect(generate).toHaveBeenCalledTimes(1);
  });
  it('does not backfill on startup after the configured time or after a late wakeup', async () => {
    const { create, generate, store } = await fixture(); vi.setSystemTime(new Date('2026-10-21T10:01:00'));
    const scheduler = create(); await scheduler.start(); await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(generate).not.toHaveBeenCalled(); expect(await store.list()).toEqual([]); await scheduler.dispose();
    vi.setSystemTime(new Date('2026-10-22T09:59:00')); const next = create(); await next.start();
    vi.setSystemTime(new Date('2026-10-22T10:10:00')); await vi.advanceTimersByTimeAsync(60_000);
    await flush(async () => (await store.list())[0]?.reason === 'missed_time'); expect(generate).not.toHaveBeenCalled();
  });
  it.each(['busy', 'empty'] as const)('skips %s sources without a model request', async (mode) => {
    const { create, source, generate, store } = await fixture();
    if (mode === 'busy') source.busy = true; else source.messages = [];
    await create().start(); await vi.advanceTimersByTimeAsync(60_000);
    await flush(async () => (await store.list())[0]?.state === 'skipped');
    expect((await store.list())[0].reason).toBe(mode === 'busy' ? 'source_busy' : 'no_messages'); expect(generate).not.toHaveBeenCalled();
  });
  it('honors an existing writer lease and stops scheduling a removed partner', async () => {
    const { create, leases, store, identity, generate } = await fixture();
    const lease = leases.tryAcquire({ kind: 'conversation', partnerId: 'p', conversationId: 'c' }, 'real-chat')!;
    await create().start(); await vi.advanceTimersByTimeAsync(60_000); await flush(async () => (await store.list())[0]?.state === 'skipped'); lease.release();
    expect(generate).not.toHaveBeenCalled(); identity.mockReturnValue({ available: false }); await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(generate).not.toHaveBeenCalled();
  });
  it('times out once and never retries or repeats after restart', async () => {
    const { create, generate, store, config } = await fixture(); generate.mockImplementation(async () => new Promise(() => undefined));
    const scheduler = create(); await scheduler.start(); await vi.advanceTimersByTimeAsync(60_000); await flush(async () => generate.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(120_000); await flush(async () => (await store.list())[0]?.state === 'failed');
    await scheduler.dispose(); config.time = '10:04'; config.revision++; await create().start(); await vi.advanceTimersByTimeAsync(60_000);
    await new Promise<void>((resolve) => realTimeout(resolve, 15)); expect(generate).toHaveBeenCalledTimes(1);
  });
});
