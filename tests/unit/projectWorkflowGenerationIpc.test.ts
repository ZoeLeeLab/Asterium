// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { ProjectWorkflowGenerationRuntime } from '../../src/main/project/ProjectWorkflowGenerationRuntime';
import { ProjectWorkflowGenerationStore } from '../../src/main/project/ProjectWorkflowGenerationStore';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.root, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, safeStorage: {}, shell: {},
}));

const projectId = 'fixture-project';
const startRequest = { requestId: 'fixture-request', projectId, roomId: 'fixture-room', plannerPartnerId: 'fixture-planner', messageIds: ['fixture-message'] };
const cancelRequest = { projectId, generationId: 'fixture-generation' };
const retryRequest = { ...cancelRequest, requestId: 'fixture-retry' };
const sourceMessages = [{
  messageId: 'fixture-message', seq: 1, authorType: 'user' as const, authorId: 'fixture-user', content: '合成讨论',
  contentHash: 'a'.repeat(64), createdAt: '2026-01-18T10:00:00.000Z', status: 'completed' as const,
}];
const queries = [
  [DESKTOP_IPC.projectWorkflowGenerationList, null, 'INVALID_PROJECT_WORKFLOW_GENERATION_QUERY'],
  [DESKTOP_IPC.projectWorkflowGenerationStart, { ...startRequest, messageIds: null }, 'INVALID_PROJECT_WORKFLOW_GENERATION_START'],
  [DESKTOP_IPC.projectWorkflowGenerationCancel, { projectId }, 'INVALID_PROJECT_WORKFLOW_GENERATION_CANCEL'],
  [DESKTOP_IPC.projectWorkflowGenerationRetry, cancelRequest, 'INVALID_PROJECT_WORKFLOW_GENERATION_RETRY'],
] as const;
const commands = [
  [DESKTOP_IPC.projectWorkflowGenerationStart, startRequest],
  [DESKTOP_IPC.projectWorkflowGenerationCancel, cancelRequest],
  [DESKTOP_IPC.projectWorkflowGenerationRetry, retryRequest],
] as const;

async function withGenerationIpc(run: (fixture: {
  root: string;
  invoke: <T = unknown>(channel: string, value: unknown, caller?: object) => Promise<T>;
  earlyResults: Promise<unknown>[];
  changes: () => unknown[][];
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-generation-ipc-'));
  electron.root = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const earlyResults: Promise<unknown>[] = [];
  const removed: string[] = [];
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error('Duplicate IPC channel ' + channel);
      handlers.set(channel, handler);
      const command = commands.find(([name]) => name === channel);
      if (command) earlyResults.push(Promise.resolve(handler({ sender }, command[1])).catch((error: Error) => error.message));
    },
    removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); },
  } as unknown as IpcMain;
  const invoke = async <T,>(channel: string, value: unknown, caller: object = sender): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error('Unregistered IPC channel ' + channel);
    return await handler({ sender: caller }, value) as T;
  };
  vi.spyOn(ProjectWorkflowGenerationRuntime.prototype, 'recover').mockResolvedValue([]);
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root, projectsDirectory: path.join(root, 'projects'),
      temporaryDirectory: root, appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    expect([...handlers.keys()].filter(channel => channel.startsWith('asterium:project-workflow-generation:')))
      .toEqual(queries.map(([channel]) => channel));
    await run({ root, invoke, earlyResults, changes: () => sender.send.mock.calls.filter(([channel]) => channel === DESKTOP_IPC.projectWorkflowGenerationChanged) });
  } finally {
    try {
      await dispose?.();
      expect(handlers.size).toBe(0);
      for (const [channel] of queries) expect(removed.filter(item => item === channel)).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      await testRm(root, { recursive: true, force: true });
    }
  }
}

it('checks the sender before fields and rejects commands until the runtime reference becomes ready', async () => {
  await withGenerationIpc(async ({ invoke, earlyResults, changes }) => {
    expect(await Promise.all(earlyResults)).toEqual(commands.map(() => 'PROJECT_WORKFLOW_GENERATION_RUNTIME_NOT_READY'));
    const start = vi.spyOn(ProjectWorkflowGenerationRuntime.prototype, 'start');
    const cancel = vi.spyOn(ProjectWorkflowGenerationRuntime.prototype, 'cancel');
    const retry = vi.spyOn(ProjectWorkflowGenerationRuntime.prototype, 'retry');
    for (const [channel, invalid, error] of queries) {
      await expect(invoke(channel, invalid, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(channel, invalid)).rejects.toThrow(error);
    }
    expect(start).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
    expect(changes()).toEqual([]);
  });
});

it('forwards list, start, cancel and retry values and errors without changing runtime results', async () => {
  await withGenerationIpc(async ({ root, invoke }) => {
    const store = new ProjectWorkflowGenerationStore(path.join(root, 'project-workflow-generations.v1.json'));
    const generation = await store.create({
      requestId: startRequest.requestId, requestFingerprint: 'fixture-fingerprint', projectId,
      roomId: startRequest.roomId, plannerPartnerId: startRequest.plannerPartnerId,
      sourceDigest: 'fixture-digest', sourceMessages,
    });
    await expect(invoke(DESKTOP_IPC.projectWorkflowGenerationList, projectId)).resolves.toEqual([generation]);
    await expect(invoke(DESKTOP_IPC.projectWorkflowGenerationList, 'fixture-other-project')).resolves.toEqual([]);
    await expect(invoke(DESKTOP_IPC.projectWorkflowGenerationList, '')).rejects.toThrow('INVALID_PROJECT_ID');
    const start = vi.spyOn(ProjectWorkflowGenerationRuntime.prototype, 'start').mockResolvedValue(generation);
    const cancel = vi.spyOn(ProjectWorkflowGenerationRuntime.prototype, 'cancel').mockResolvedValue({ ...generation, status: 'cancelled' });
    const retry = vi.spyOn(ProjectWorkflowGenerationRuntime.prototype, 'retry').mockResolvedValue({ ...generation, id: 'fixture-retried-generation' });
    const extended = { ...startRequest, messageIds: [7], fixtureExtra: true };
    await expect(invoke(DESKTOP_IPC.projectWorkflowGenerationStart, extended)).resolves.toBe(generation);
    expect(start).toHaveBeenCalledExactlyOnceWith(extended);
    await expect(invoke(DESKTOP_IPC.projectWorkflowGenerationCancel, cancelRequest)).resolves.toEqual({ ...generation, status: 'cancelled' });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(cancelRequest);
    await expect(invoke(DESKTOP_IPC.projectWorkflowGenerationRetry, retryRequest)).resolves.toEqual({ ...generation, id: 'fixture-retried-generation' });
    expect(retry).toHaveBeenCalledExactlyOnceWith(retryRequest);
    for (const [channel, request, method] of [
      [DESKTOP_IPC.projectWorkflowGenerationStart, startRequest, start],
      [DESKTOP_IPC.projectWorkflowGenerationCancel, cancelRequest, cancel],
      [DESKTOP_IPC.projectWorkflowGenerationRetry, retryRequest, retry],
    ] as const) {
      const error = new Error('SYNTHETIC_GENERATION_FAILURE');
      method.mockRejectedValueOnce(error);
      await expect(invoke(channel, request)).rejects.toBe(error);
      await expect(invoke(channel, request)).resolves.toBeDefined();
    }
  });
});

it('keeps generation-store notifications connected to the registered instance', async () => {
  const listing = vi.spyOn(ProjectWorkflowGenerationStore.prototype, 'listProject');
  await withGenerationIpc(async ({ invoke, changes }) => {
    await invoke(DESKTOP_IPC.projectWorkflowGenerationList, projectId);
    const registered = listing.mock.contexts.at(-1) as ProjectWorkflowGenerationStore;
    const generation = await registered.create({
      requestId: 'fixture-event-request', requestFingerprint: 'fixture-fingerprint', projectId,
      roomId: 'fixture-room', plannerPartnerId: 'fixture-planner', sourceDigest: 'fixture-digest', sourceMessages,
    });
    expect(changes()).toEqual([[DESKTOP_IPC.projectWorkflowGenerationChanged, { type: 'changed', generation }]]);
    expect(await invoke(DESKTOP_IPC.projectWorkflowGenerationList, projectId)).toEqual([generation]);
  });
});
