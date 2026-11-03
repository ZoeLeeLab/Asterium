import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { testRm } from '../helpers/autoTest.mjs';
import { PartnerDelegation } from '../../src/main/runtime/PartnerDelegation';

const owner = { conversationId: 'c1', partnerId: 'origin', turnId: 'turn', messageId: 'message' };

it('persists before returning, bounds concurrency and stops foreground waiting without stopping the child', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delegation-test-'));
  const running = new Map<string, (result: string) => void>();
  const store = new PartnerDelegation(path.join(root, 'tasks.json'), (_batch, task, signal) => new Promise((resolve, reject) => {
    running.set(task.targetPartnerId, resolve);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  try {
    const input = { tasks: ['one', 'one', 'two'].map(targetPartnerId => ({ targetPartnerId, instruction: 'Review this text' })) };
    const batch = await store.submit(owner, 'call1', input);
    expect((await store.submit(owner, 'call1', input)).id).toBe(batch.id);
    await expect(store.submit(owner, 'call2', { tasks: [input.tasks[0]] })).rejects.toThrow('DELEGATION_TURN_LIMIT');
    const second = await store.submit({ ...owner, turnId: 'next' }, 'call1', {
      tasks: ['three', 'four'].map(targetPartnerId => ({ targetPartnerId, instruction: 'Another review' })),
    });
    await vi.waitFor(() => expect([...running.keys()].sort()).toEqual(['one', 'three', 'two']));
    const waiter = store.wait(owner, batch.id, new AbortController().signal);
    expect(store.interruptWait(owner.conversationId)).toBe(true);
    expect(await waiter).toMatchObject({ background: true, pending: true });
    running.get('two')?.('independent result');
    await vi.waitFor(() => expect(running.has('four')).toBe(true));
    expect((await store.list('c1'))[0].tasks[2]).toMatchObject({ status: 'succeeded', result: 'independent result' });
    await store.control('c1', second.tasks[1].id, 'cancel');
    expect((await store.list('c1'))[1].tasks[1].status).toBe('cancelled');
    await store.remove('c1');
    expect(await store.list('c1')).toEqual([]);
  } finally {
    store.close();
    await testRm(root, { recursive: true, force: true });
  }
});

it('uses one turn-wide wait budget and preserves completed results for background claiming', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delegation-deadline-'));
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  let complete!: (text: string) => void;
  const store = new PartnerDelegation(path.join(root, 'tasks.json'), () => new Promise(resolve => { complete = resolve; }));
  try {
    const batch = await store.submit(owner, 'call', { tasks: [{ targetPartnerId: 'one', instruction: 'Review' }] });
    await vi.waitFor(() => expect(complete).toBeDefined());
    clock.mockReturnValue(now + 120_001);
    expect(await store.wait(owner, batch.id, new AbortController().signal)).toMatchObject({ pending: true, background: true });
    complete('done');
    await vi.waitFor(async () => expect(await store.readySummaries()).toHaveLength(1));
    expect(await store.claimSummary(batch.id, 'running')).toBe(true);
    expect(await store.claimSummary(batch.id, 'foreground')).toBe(false);
    await store.finishSummary(batch.id, { text: 'summary' });
    expect((await store.list('c1'))[0]).toMatchObject({ summaryState: 'done', summary: 'summary' });
  } finally {
    clock.mockRestore();
    store.close();
    await testRm(root, { recursive: true, force: true });
  }
});
