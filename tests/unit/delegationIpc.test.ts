// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import type { DelegationBatchView, PartnerDelegation } from '../../src/main/runtime/PartnerDelegation';
import { testRm } from '../helpers/autoTest.mjs';

const fixture = vi.hoisted(() => ({
  root: '',
  execute: vi.fn<ConstructorParameters<typeof PartnerDelegation>[1]>(),
  delegation: undefined as PartnerDelegation | undefined,
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => fixture.root,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    whenReady: async () => undefined,
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: {},
  shell: {},
}));
vi.mock('../../src/main/runtime/PartnerDelegation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/runtime/PartnerDelegation')>();
  return {
    ...actual,
    PartnerDelegation: class extends actual.PartnerDelegation {
      constructor(file: ConstructorParameters<typeof PartnerDelegation>[0], _execute: ConstructorParameters<typeof PartnerDelegation>[1], changed: () => void) {
        super(file, fixture.execute, changed);
        fixture.delegation = this;
      }
    },
  };
});

it('keeps delegation review lookup, foreground interruption, cancellation and retry on their IPC channels', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-delegation-ipc-'));
  fixture.root = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const list = 'asterium:delegation:list';
  const interrupt = 'asterium:delegation:interrupt-wait';
  const control = 'asterium:delegation:control';
  const invoke = async (channel: string, caller: object, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return await handler({ sender: caller }, ...args);
  };

  try {
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      const delegation = fixture.delegation!;
      const owner = { conversationId: 'fixture-conversation', partnerId: 'fixture-origin', turnId: 'fixture-turn', messageId: 'fixture-message' };
      const taskInput = { tasks: [{ targetPartnerId: 'fixture-target', instruction: 'Review fixture text.' }] };
      const readTasks = async () => (await invoke(list, sender, owner.conversationId) as DelegationBatchView[]).flatMap(batch => batch.tasks);
      for (const channel of [list, interrupt, control]) {
        await expect(invoke(channel, {}, owner.conversationId)).rejects.toThrow('INVALID_IPC_SENDER');
      }
      await expect(invoke(list, sender, '')).rejects.toThrow('DELEGATION_SOURCE_INVALID');
      await expect(invoke(interrupt, sender, null)).resolves.toBe(false);
      await expect(invoke(control, sender, owner.conversationId, 'fixture-task', 'invalid')).rejects.toThrow('DELEGATION_CONTROL_INVALID');
      await expect(invoke(list, sender, 'fixture-other-conversation')).resolves.toEqual([]);

      fixture.execute.mockImplementationOnce(async (_batch, _task, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      const running = await delegation.submit(owner, 'fixture-running', taskInput);
      await vi.waitFor(() => expect(fixture.execute).toHaveBeenCalledTimes(1), { timeout: 3000 });
      const signal = fixture.execute.mock.calls[0][2];
      const waiter = delegation.wait(owner, running.id, new AbortController().signal);
      await expect(invoke(interrupt, sender, owner.conversationId)).resolves.toBe(true);
      await expect(waiter).resolves.toMatchObject({ pending: true, background: true });
      expect(signal.aborted).toBe(false);
      expect(await readTasks()).toContainEqual(expect.objectContaining({ id: running.tasks[0].id, status: 'running' }));
      await expect(invoke(control, sender, owner.conversationId, running.tasks[0].id, 'cancel')).resolves.toBeUndefined();
      expect(signal.aborted).toBe(true);
      expect(await readTasks()).toContainEqual(expect.objectContaining({ id: running.tasks[0].id, status: 'cancelled' }));

      fixture.execute.mockRejectedValueOnce(new Error('DELEGATION_EXECUTION_FAILED')).mockResolvedValueOnce('Fixture retry result.');
      const failed = await delegation.submit(owner, 'fixture-failed', taskInput);
      await vi.waitFor(async () => {
        expect(await readTasks()).toContainEqual(expect.objectContaining({ id: failed.tasks[0].id, status: 'failed', attempt: 1 }));
      }, { timeout: 3000 });
      await expect(invoke(control, sender, owner.conversationId, failed.tasks[0].id, 'retry')).resolves.toBeUndefined();
      await vi.waitFor(async () => {
        expect(await readTasks()).toContainEqual(expect.objectContaining({ id: failed.tasks[0].id, status: 'succeeded', attempt: 2, result: 'Fixture retry result.' }));
      }, { timeout: 3000 });

      fixture.execute.mockRejectedValueOnce(new Error('DELEGATION_REVIEW_UNCERTAIN')).mockResolvedValueOnce('Fixture review result.');
      const review = await delegation.submit(owner, 'fixture-review', taskInput, async () => ({
        review: { threadId: 'fixture-thread', message: 'Review fixture text.' },
      }));
      const reviewId = review.tasks[0].id;
      await vi.waitFor(async () => {
        expect((await delegation.list(owner.conversationId)).flatMap(batch => batch.tasks))
          .toContainEqual(expect.objectContaining({ id: reviewId, status: 'uncertain' }));
      }, { timeout: 3000 });
      expect(await readTasks()).toContainEqual(expect.objectContaining({ id: reviewId, status: 'uncertain', externalReview: true }));
      await vi.waitFor(async () => {
        expect(await readTasks()).toContainEqual(expect.objectContaining({ id: reviewId, status: 'succeeded', result: 'Fixture review result.' }));
      }, { timeout: 3000 });
      const reviewCalls = fixture.execute.mock.calls.filter(([, task]) => task.id === reviewId);
      expect(reviewCalls.map(([, , , lookupOnly]) => lookupOnly)).toEqual([false, true]);
      expect(reviewCalls[1][1].review?.requestId).toBe(reviewCalls[0][1].review?.requestId);
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
});
