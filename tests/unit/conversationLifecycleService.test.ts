// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { ConversationLifecycleService } from '../../src/main/conversation/ConversationLifecycleService';
import { WriterLeaseCoordinator } from '../../src/main/runtime/WriterLeaseCoordinator';

const request = { partnerId: 'fixture-partner', conversationId: 'fixture-chat', source: 'api_partner' as const };
const scope = { kind: 'conversation' as const, partnerId: request.partnerId, conversationId: request.conversationId };
function fixture() {
  const trace: string[] = [], summaryRuns = new Map<string, AbortController>(), writerLeases = new WriterLeaseCoordinator();
  const receipt = { conversationId: request.conversationId, cleanupPending: true };
  const options = {
    summaryRuns, writerLeases,
    conversationDeletions: { delete: vi.fn(async () => { trace.push('delete'); expect(writerLeases.ownerFor(scope)).toBe('delete:' + request.conversationId); return receipt; }) },
    delegation: { remove: vi.fn(async () => { trace.push('delegation'); expect(writerLeases.ownerFor(scope)).toBe('delete:' + request.conversationId); }) },
    diarySettings: { reconcileSources: vi.fn(async () => { trace.push('diary'); expect(writerLeases.ownerFor(scope)).toBeUndefined(); }) },
    diaryScheduler: { changed: vi.fn(async () => { trace.push('schedule'); }) },
    memoryFallbackInventory: { refresh: vi.fn(async () => { trace.push('memory'); }) },
  };
  const service = new ConversationLifecycleService(options);
  return { service, options, trace, receipt };
}

it('uses the live summary map, aborts before waiting, and retains the lease through deletion and delegation only', async () => {
  const { service, options, trace, receipt } = fixture(), summary = new AbortController();
  options.summaryRuns.set(request.conversationId, summary);
  summary.signal.addEventListener('abort', () => trace.push('abort'));
  const held = options.writerLeases.tryAcquire(scope, 'fixture-summary-owner')!;
  const acquire = vi.spyOn(options.writerLeases, 'acquire');
  const deletion = service.delete(request);
  expect(summary.signal.aborted).toBe(true); expect(trace).toEqual(['abort']);
  expect(options.conversationDeletions.delete).not.toHaveBeenCalled();
  expect(options.writerLeases.ownerFor(scope)).toBe('fixture-summary-owner');
  held.release();
  await expect(deletion).resolves.toBe(receipt);
  expect(acquire).toHaveBeenCalledExactlyOnceWith(scope, 'delete:' + request.conversationId);
  expect(trace).toEqual(['abort', 'delete', 'delegation', 'diary', 'schedule', 'memory']);
  expect(options.writerLeases.ownerFor(scope)).toBeUndefined();
});

it('does not wait or touch any resource when another writer holds the scope without a summary', async () => {
  const { service, options, trace } = fixture(), held = options.writerLeases.tryAcquire(scope, 'fixture-other-writer')!;
  const acquire = vi.spyOn(options.writerLeases, 'acquire');
  try { await expect(service.delete(request)).rejects.toThrow('COMPACT_CONVERSATION_BUSY'); expect(acquire).not.toHaveBeenCalled(); expect(trace).toEqual([]); expect(options.writerLeases.ownerFor(scope)).toBe('fixture-other-writer'); }
  finally { held.release(); }
});

it('preserves acquire failures after abort without cleaning resources or releasing an unacquired lease', async () => {
  const { service, options, trace } = fixture(), summary = new AbortController(), failure = new Error('SYNTHETIC_ACQUIRE_FAILURE');
  options.summaryRuns.set(request.conversationId, summary); vi.spyOn(options.writerLeases, 'acquire').mockRejectedValueOnce(failure);
  await expect(service.delete(request)).rejects.toBe(failure); expect(summary.signal.aborted).toBe(true); expect(trace).toEqual([]); expect(options.writerLeases.ownerFor(scope)).toBeUndefined();
});

it.each(['delete', 'delegation', 'diary', 'schedule', 'memory'] as const)('releases once and preserves failure propagation at %s', async stage => {
  const { service, options } = fixture(), failure = new Error('SYNTHETIC_LIFECYCLE_FAILURE');
  const original = options.writerLeases.tryAcquire.bind(options.writerLeases), releases = vi.fn();
  vi.spyOn(options.writerLeases, 'tryAcquire').mockImplementation((...args) => { const lease = original(...args); return lease ? { ...lease, release: () => { releases(); lease.release(); } } : undefined; });
  const operations = [options.conversationDeletions.delete, options.delegation.remove, options.diarySettings.reconcileSources, options.diaryScheduler.changed, options.memoryFallbackInventory.refresh];
  const index = ['delete', 'delegation', 'diary', 'schedule', 'memory'].indexOf(stage);
  operations[index].mockRejectedValueOnce(failure);
  await expect(service.delete(request)).rejects.toBe(failure); expect(releases).toHaveBeenCalledTimes(1); expect(options.writerLeases.ownerFor(scope)).toBeUndefined();
  for (let i = index + 1; i < operations.length; i++) expect(operations[i]).not.toHaveBeenCalled();
});
