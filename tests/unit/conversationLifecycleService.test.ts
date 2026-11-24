// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { ConversationLifecycleService } from '../../src/main/conversation/ConversationLifecycleService';
import { WriterLeaseCoordinator } from '../../src/main/runtime/WriterLeaseCoordinator';

const request = { partnerId: 'fixture-partner', conversationId: 'fixture-chat', source: 'api_partner' as const };
const scope = { kind: 'conversation' as const, partnerId: request.partnerId, conversationId: request.conversationId };
function fixture() {
  const trace: string[] = [], writerLeases = new WriterLeaseCoordinator();
  const receipt = { conversationId: request.conversationId, cleanupPending: true };
  const options = {
    cancelDelegation: vi.fn<(conversationId: string) => Promise<boolean>>(async () => false), writerLeases,
    conversationDeletions: { delete: vi.fn(async () => { trace.push('delete'); expect(writerLeases.ownerFor(scope)).toBe('delete:' + request.conversationId); return receipt; }) },
    delegation: { remove: vi.fn(async () => { trace.push('delegation'); expect(writerLeases.ownerFor(scope)).toBe('delete:' + request.conversationId); }) },
    diarySettings: { reconcileSources: vi.fn(async () => { trace.push('diary'); expect(writerLeases.ownerFor(scope)).toBeUndefined(); }) },
    diaryScheduler: { changed: vi.fn(async () => { trace.push('schedule'); }) },
    memoryFallbackInventory: { refresh: vi.fn(async () => { trace.push('memory'); }) },
  };
  const service = new ConversationLifecycleService(options);
  return { service, options, trace, receipt };
}

it('awaits report cancellation before waiting for its writer and retains the lease through deletion and delegation only', async () => {
  const { service, options, trace, receipt } = fixture();
  let finishCancel!: () => void;
  options.cancelDelegation.mockImplementationOnce(async () => {
    trace.push('cancel'); await new Promise<void>(resolve => { finishCancel = resolve; }); return true;
  });
  const held = options.writerLeases.tryAcquire(scope, 'fixture-summary-owner')!;
  const acquire = vi.spyOn(options.writerLeases, 'acquire');
  const deletion = service.delete(request);
  expect(options.cancelDelegation).toHaveBeenCalledExactlyOnceWith(request.conversationId); expect(trace).toEqual(['cancel']);
  expect(acquire).not.toHaveBeenCalled();
  expect(options.conversationDeletions.delete).not.toHaveBeenCalled();
  expect(options.writerLeases.ownerFor(scope)).toBe('fixture-summary-owner');
  finishCancel(); await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1)); held.release();
  await expect(deletion).resolves.toBe(receipt);
  expect(acquire).toHaveBeenCalledExactlyOnceWith(scope, 'delete:' + request.conversationId);
  expect(trace).toEqual(['cancel', 'delete', 'delegation', 'diary', 'schedule', 'memory']);
  expect(options.writerLeases.ownerFor(scope)).toBeUndefined();
});

it('does not wait or touch any resource when another writer holds the scope without a summary', async () => {
  const { service, options, trace } = fixture(), held = options.writerLeases.tryAcquire(scope, 'fixture-other-writer')!;
  const acquire = vi.spyOn(options.writerLeases, 'acquire');
  try { await expect(service.delete(request)).rejects.toThrow('COMPACT_CONVERSATION_BUSY'); expect(acquire).not.toHaveBeenCalled(); expect(trace).toEqual([]); expect(options.writerLeases.ownerFor(scope)).toBe('fixture-other-writer'); }
  finally { held.release(); }
});

it('preserves acquire failures after cancellation without cleaning resources or releasing an unacquired lease', async () => {
  const { service, options, trace } = fixture(), failure = new Error('SYNTHETIC_ACQUIRE_FAILURE');
  options.cancelDelegation.mockResolvedValueOnce(true); vi.spyOn(options.writerLeases, 'acquire').mockRejectedValueOnce(failure);
  await expect(service.delete(request)).rejects.toBe(failure); expect(trace).toEqual([]); expect(options.writerLeases.ownerFor(scope)).toBeUndefined();
});

it('preserves a cancellation failure without deleting data or acquiring a writer', async () => {
  const { service, options, trace } = fixture(), failure = new Error('SYNTHETIC_CANCEL_FAILURE');
  options.cancelDelegation.mockRejectedValueOnce(failure);
  const acquire = vi.spyOn(options.writerLeases, 'acquire'), tryAcquire = vi.spyOn(options.writerLeases, 'tryAcquire');
  await expect(service.delete(request)).rejects.toBe(failure);
  expect(acquire).not.toHaveBeenCalled(); expect(tryAcquire).not.toHaveBeenCalled(); expect(trace).toEqual([]);
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
