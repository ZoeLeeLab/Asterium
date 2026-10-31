import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automationInputSchema, type AutomationInput } from '../../src/shared/automations';
import { AutomationStore } from '../../src/main/automation/AutomationStore';
import { automationRunExpired, automationWallTime, dueAutomation, nextAutomation } from '../../src/main/automation/AutomationSchedule';
import { AutomationScheduler, type AutomationExecutionPort } from '../../src/main/automation/AutomationScheduler';
import { AutomationService } from '../../src/main/automation/AutomationService';

const dirs: string[] = [], schedulers: AutomationScheduler[] = [];
afterEach(async () => { await Promise.all(schedulers.splice(0).map(s => s.dispose())); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const stamp = (day: number, hour: number) => Date.parse(`2026-10-${day}T${String(hour).padStart(2, '0')}:00:00+08:00`);
function input(): AutomationInput { return automationInputSchema.parse({ name: '整理资料', instructions: '整理工作区中的测试资料并汇报。', target: { partnerId: 'p', conversationId: 'c', sourceMode: 'local_cli', nativeThreadId: 't', bindingGeneration: 1 }, schedule: { type: 'daily', time: '10:00' }, timezone: 'Asia/Shanghai' }); }
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-automation-')); dirs.push(dir);
  let now = stamp(25, 9); const clock = () => now; const store = new AutomationStore(path.join(dir, 'automations.json'), clock);
  const definition = await store.create(input(), 'first');
  return { dir, store, definition, clock, time: (at: number) => { now = at; } };
}
async function until(check: () => Promise<boolean>) { for (let i = 0; i < 250; i++) { if (await check()) return; await delay(4); } throw Error('Automation did not settle'); }

describe('automation calendar', () => {
  it('waits before ten and catches only today after a late start, including multiple days offline', async () => {
    const { definition: d } = await fixture();
    expect(dueAutomation(d, stamp(25, 9))).toBeUndefined(); expect(nextAutomation(d, stamp(25, 9))).toBe(stamp(25, 10));
    expect(dueAutomation(d, stamp(25, 15))).toBe(stamp(25, 10)); expect(dueAutomation(d, stamp(29, 15))).toBe(stamp(29, 10));
    expect(dueAutomation(d, stamp(29, 9))).toBeUndefined();
  });
  it('starts a newly created afternoon daily schedule tomorrow, not at today’s past ten', async () => {
    const f = await fixture(); f.time(stamp(25, 15)); const d = await f.store.create(input(), 'afternoon');
    expect(dueAutomation(d, f.clock())).toBeUndefined(); expect(nextAutomation(d, f.clock())).toBe(stamp(26, 10));
  });
  it('honors weekdays, fixed timezone, skip policy and expired calendar queues', async () => {
    const { definition: d } = await fixture(); d.schedule = { type: 'weekly', time: '10:00', weekdays: [1] };
    expect(nextAutomation(d, stamp(25, 9))).toBe(stamp(26, 10)); expect(dueAutomation(d, stamp(25, 15))).toBeUndefined();
    expect(dueAutomation(d, stamp(26, 15))).toBe(stamp(26, 10)); d.catchUp = 'skip'; expect(dueAutomation(d, stamp(26, 15))).toBeUndefined();
    expect(automationRunExpired({ trigger: 'scheduled', scheduledAt: new Date(stamp(26, 10)).toISOString(), definition: d }, stamp(27, 1))).toBe(true);
  });
  it('coalesces interval misses and keeps one-time work due after a late restart', async () => {
    const { definition: d } = await fixture(); d.schedule = { type: 'interval', minutes: 60 };
    expect(dueAutomation(d, stamp(25, 15))).toBe(stamp(25, 15)); expect(nextAutomation(d, stamp(25, 15))).toBe(stamp(25, 16));
    d.schedule = { type: 'once', at: new Date(stamp(25, 10)).toISOString() };
    expect(dueAutomation(d, stamp(29, 15))).toBe(stamp(25, 10)); expect(nextAutomation(d, stamp(29, 15))).toBeUndefined();
  });
  it('handles DST gaps and repeated hours deterministically', () => {
    expect(automationWallTime('2026-03-08', '02:30', 'America/New_York')).toBe(Date.parse('2026-03-08T07:00:00Z'));
    expect(automationWallTime('2026-11-01', '01:30', 'America/New_York')).toBe(Date.parse('2026-11-01T05:30:00Z'));
    expect(automationWallTime('2026-10-25', '10:00', 'Asia/Kathmandu')).toBe(Date.parse('2026-10-25T04:15:00Z'));
  });
  it('validates schedule ranges and timezone without guessing', () => {
    expect(() => automationInputSchema.parse({ ...input(), timezone: 'unknown' })).toThrow();
    expect(() => automationInputSchema.parse({ ...input(), schedule: { type: 'interval', minutes: 0 } })).toThrow();
    expect(() => automationInputSchema.parse({ ...input(), schedule: { type: 'weekly', time: '25:00', weekdays: [0, 0] } })).toThrow();
  });
});
describe('durable automation ledger', () => {
  it('validates canonical targets and ownership through the common management service', async () => {
    const f = await fixture();
    const service = new AutomationService(f.store, { now: f.clock, runtimeReady: () => false, targets: async () => [{ target: input().target, label: '本地伙伴', available: true }] });
    await expect(service.mutate({ action: 'create', requestId: 'forged', input: { ...input(), target: { ...input().target, nativeThreadId: 'forged' } } })).rejects.toThrow('TARGET_STALE');
    await expect(service.mutate({ action: 'remove', id: f.definition.id, revision: 1 }, 'another')).rejects.toThrow('NOT_FOUND');
    await expect(service.mutate({ action: 'run_now', id: f.definition.id, requestId: 'manual' })).rejects.toThrow('NOT_READY');
    expect((await service.get()).nextRuns[f.definition.id]).toBe(new Date(stamp(25, 10)).toISOString());
    await service.mutate({ action: 'update', id: f.definition.id, revision: 1, input: { ...input(), enabled: false } }, 'p');
    expect((await service.get()).automations[0].enabled).toBe(false);
  });
  it('deduplicates creation and simultaneous same-occurrence claims across reloads and clock rollback', async () => {
    const f = await fixture(); expect((await f.store.create(input(), 'first')).id).toBe(f.definition.id);
    await expect(f.store.create({ ...input(), name: 'changed' }, 'first')).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    f.time(stamp(25, 15)); const claims = await Promise.all([f.store.queueScheduled(f.definition.id), f.store.queueScheduled(f.definition.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const run = claims.find(Boolean)!; await f.store.transition(run.id, ['queued'], { state: 'succeeded' });
    const reopened = new AutomationStore(path.join(f.dir, 'automations.json'), f.clock);
    expect(await reopened.queueScheduled(f.definition.id)).toBeUndefined(); f.time(stamp(25, 10)); expect(await reopened.queueScheduled(f.definition.id)).toBeUndefined();
  });
  it('recovers in-flight work as uncertain and never automatically replays it', async () => {
    const f = await fixture(); f.time(stamp(25, 15)); const r = (await f.store.queueScheduled(f.definition.id))!;
    await f.store.transition(r.id, ['queued'], { state: 'starting' }); await f.store.recover();
    expect((await f.store.snapshot()).runs[0].state).toBe('uncertain'); expect(await f.store.queueScheduled(f.definition.id)).toBeUndefined();
    await expect(f.store.retry(r.id)).rejects.toThrow('RETRY_REQUIRES_FAILED');
  });
  it('pauses queued work, resumes only future times, checks revisions and retains frozen running instructions', async () => {
    const f = await fixture(); f.time(stamp(25, 15)); const run = (await f.store.queueScheduled(f.definition.id))!;
    const paused = await f.store.update(f.definition.id, 1, { ...input(), enabled: false });
    expect((await f.store.snapshot()).runs[0].state).toBe('cancelled');
    await expect(f.store.update(f.definition.id, 1, input())).rejects.toThrow('REVISION_CONFLICT');
    const resumed = await f.store.update(f.definition.id, paused.revision, input()); expect(dueAutomation(resumed, f.clock())).toBeUndefined();
    expect(run.definition.instructions).toBe(input().instructions);
  });
  it('coalesces a waiting interval and expires yesterday’s queued work', async () => {
    const f = await fixture(); await f.store.update(f.definition.id, 1, { ...input(), schedule: { type: 'interval', minutes: 60 } });
    f.time(stamp(25, 11)); await f.store.queueScheduled(f.definition.id); f.time(stamp(25, 15)); await f.store.queueScheduled(f.definition.id);
    const runs = (await f.store.snapshot()).runs; expect(runs.map(r => r.state)).toEqual(['skipped', 'queued']); expect(runs[1].scheduledAt).toBe(new Date(stamp(25, 15)).toISOString());
  });
  it('keeps immediate runs independent of the scheduled occurrence and allows only explicit failed retries', async () => {
    const f = await fixture(); f.time(stamp(25, 15)); const manual = await f.store.queueManual(f.definition.id, 'click');
    expect((await f.store.queueManual(f.definition.id, 'click')).id).toBe(manual.id);
    await f.store.transition(manual.id, ['queued'], { state: 'failed' }); const retry = await f.store.retry(manual.id); expect(retry.attempt).toBe(2);
    await f.store.transition(retry.id, ['queued'], { state: 'succeeded' }); expect(await f.store.queueScheduled(f.definition.id)).toBeDefined();
  });
  it('fails closed on corrupt storage rather than silently forgetting prior runs', async () => {
    const f = await fixture(); await writeFile(path.join(f.dir, 'automations.json'), '{broken');
    await expect(f.store.snapshot()).rejects.toThrow(); await expect(f.store.queueScheduled(f.definition.id)).rejects.toThrow();
  });
});
describe('scheduler with no model polling', () => {
  it('limits concurrent launches, queues the same original thread and records shutdown as uncertain', async () => {
    const f = await fixture();
    await f.store.create({ ...input(), name: 'same thread' }, 'same');
    await f.store.create({ ...input(), target: { ...input().target, partnerId: 'p2', nativeThreadId: 't2' } }, 'other');
    await f.store.create({ ...input(), target: { ...input().target, partnerId: 'p3', nativeThreadId: 't3' } }, 'third');
    f.time(stamp(25, 15)); const execute = vi.fn(() => new Promise<never>(() => undefined));
    const s = new AutomationScheduler(f.store, { check: async () => ({ available: true }), execute }, f.clock); schedulers.push(s); await s.start();
    expect(execute).toHaveBeenCalledTimes(2); expect(execute.mock.calls).toHaveLength(2);
    expect((await f.store.snapshot()).runs.filter(r => r.state === 'queued')).toHaveLength(2);
    await s.dispose(); expect((await f.store.snapshot()).runs.filter(r => r.state === 'uncertain')).toHaveLength(2);
  });
  it('does not dispatch if durable storage is unreadable', async () => {
    const f = await fixture(); f.time(stamp(25, 15)); await writeFile(path.join(f.dir, 'automations.json'), 'broken');
    const execute = vi.fn(); const s = new AutomationScheduler(f.store, { check: async () => ({ available: true }), execute }, f.clock); schedulers.push(s);
    await expect(s.start()).rejects.toThrow(); expect(execute).not.toHaveBeenCalled();
  });
  it('catches on startup once, serializes ticks and does not run again on restart', async () => {
    const f = await fixture(); f.time(stamp(25, 15)); const execute = vi.fn(async () => ({ state: 'succeeded' as const }));
    const port: AutomationExecutionPort = { check: async () => ({ available: true }), execute };
    const s = new AutomationScheduler(f.store, port, f.clock); schedulers.push(s); await s.start(); await s.start(); await s.tick();
    await until(async () => (await f.store.snapshot()).runs[0]?.state === 'succeeded'); expect(execute).toHaveBeenCalledOnce();
    await s.dispose(); const other = new AutomationScheduler(f.store, port, f.clock); schedulers.push(other); await other.start(); expect(execute).toHaveBeenCalledOnce();
  });
  it('queues a busy target, skips an expired calendar run and lets other targets proceed despite check failure', async () => {
    const f = await fixture(); const other = await f.store.create({ ...input(), target: { ...input().target, partnerId: 'p2', nativeThreadId: 't2' } }, 'second'); f.time(stamp(25, 15));
    const execute = vi.fn(async () => ({ state: 'succeeded' as const }));
    const s = new AutomationScheduler(f.store, { check: async run => { if (run.automationId !== other.id) throw Error('offline'); return { available: true }; }, execute }, f.clock); schedulers.push(s); await s.start();
    await until(async () => (await f.store.snapshot()).runs.some(r => r.state === 'succeeded'));
    expect(execute).toHaveBeenCalledOnce(); f.time(stamp(26, 9)); await s.tick(); expect((await f.store.snapshot()).runs[0].state).toBe('skipped');
  });
  it('stops duplicate launches after ambiguous delivery without blocking a different task', async () => {
    const f = await fixture(); f.time(stamp(25, 15)); const execute = vi.fn(async () => { throw Error('timeout after acceptance'); });
    const s = new AutomationScheduler(f.store, { check: async () => ({ available: true }), execute }, f.clock); schedulers.push(s); await s.start();
    await until(async () => (await f.store.snapshot()).runs[0]?.state === 'uncertain'); await s.tick(); expect(execute).toHaveBeenCalledOnce();
  });
});
