// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { ProjectTaskOrchestrator } from '../../src/main/project/ProjectTaskOrchestrator';
import { ProjectTaskExecutionStore } from '../../src/main/project/ProjectTaskExecutionStore';
import { PartnerRuntimePort } from '../../src/main/runtime/PartnerRuntimePort';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.root, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, safeStorage: {}, shell: {},
}));
const channels = [DESKTOP_IPC.projectTaskExecutionGet, DESKTOP_IPC.projectTaskExecutionEnqueue,
  DESKTOP_IPC.projectTaskExecutionPause, DESKTOP_IPC.projectTaskExecutionResume, DESKTOP_IPC.projectTaskExecutionCancel,
  DESKTOP_IPC.projectTaskExecutionRetry, DESKTOP_IPC.projectTaskExecutionResolve];
const attemptRequest = { projectId: 'fixture-project', taskId: 'fixture-task' };
const gateRequest = { ...attemptRequest, action: 'accept' as const, feedback: ' 合成反馈 ', affectedCriteria: ['fixture-criterion'] };

async function withExecution(run: (fixture: {
  invoke: <T = unknown>(channel: string, value?: unknown, caller?: object) => Promise<T>;
  earlyEnqueue: Promise<unknown>; changes: () => unknown[][];
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-task-execution-ipc-')); electron.root = root;
  const sender = { send: vi.fn() }, window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  const handlers = new Map<string, (event: { sender: object }, value: unknown) => unknown>(), removed: string[] = [];
  let earlyEnqueue!: Promise<unknown>;
  const ipc = { handle: (channel: string, handler: (event: { sender: object }, value: unknown) => unknown) => {
    expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler);
    if (channel === DESKTOP_IPC.projectTaskExecutionEnqueue) earlyEnqueue = Promise.resolve(handler({ sender }, attemptRequest)).catch(error => error);
  }, removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); } } as unknown as IpcMain;
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = registerAgentIpc(ipc, () => window, { environment: { profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root, appUserModelId: 'Asterium.Test',
      allowStartup: false, allowUpdates: false, restoreBackgroundServices: false, mcpPort: 0 } });
    const invoke = async <T,>(channel: string, value?: unknown, caller: object = sender) => await handlers.get(channel)!({ sender: caller }, value) as T;
    await run({ invoke, earlyEnqueue, changes: () => sender.send.mock.calls.filter(([channel]) => channel === DESKTOP_IPC.projectTaskExecutionChanged) });
  } finally {
    try { await dispose?.(); expect(handlers.size).toBe(0); for (const channel of channels) expect(removed.filter(name => name === channel)).toHaveLength(1); }
    finally { vi.restoreAllMocks(); await testRm(root, { recursive: true, force: true }); }
  }
}

it('checks all seven callers before parameters and preserves the existing query, control and gate validation', async () => {
  await withExecution(async ({ invoke, earlyEnqueue }) => {
    expect(await earlyEnqueue).toBeInstanceOf(ReferenceError);
    for (const channel of channels) await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(channels[0], null)).rejects.toThrow('INVALID_PROJECT_TASK_EXECUTION_QUERY');
    for (const value of [null, {}, { projectId: 1, taskId: 'fixture' }, { projectId: 'fixture', taskId: null }]) await expect(invoke(channels[1], value)).rejects.toThrow('INVALID_TASK_ATTEMPT_REQUEST');
    for (const channel of channels.slice(2, 6)) {
      for (const value of [null, {}, { attemptId: 1 }, { attemptId: 'fixture', reason: null }]) await expect(invoke(channel, value)).rejects.toThrow('INVALID_TASK_ATTEMPT_CONTROL_REQUEST');
    }
    for (const value of [null, {}, { ...gateRequest, action: 'reject' }, { ...gateRequest, feedback: 1 }, { ...gateRequest, affectedCriteria: [1] }]) await expect(invoke(channels[6], value)).rejects.toThrow('INVALID_TASK_GATE_RESOLUTION_REQUEST');
  });
});

it('forwards optional query values unchanged, returns the same snapshot and propagates errors', async () => {
  await withExecution(async ({ invoke }) => {
    const snapshot = { version: 1 as const, attempts: [], events: [] };
    const read = vi.spyOn(ProjectTaskOrchestrator.prototype, 'snapshot').mockResolvedValue(snapshot);
    for (const value of [undefined, '', ' fixture-project ']) await expect(invoke(channels[0], value)).resolves.toBe(snapshot);
    expect(read.mock.calls).toEqual([[undefined], [''], [' fixture-project ']]);
    const error = new Error('SYNTHETIC_EXECUTION_READ_FAILURE'); read.mockRejectedValueOnce(error);
    await expect(invoke(channels[0])).rejects.toBe(error);
  });
});

it('resolves the live runtime only at invocation and awaits activation before enqueue on every request', async () => {
  await withExecution(async ({ invoke, earlyEnqueue }) => {
    expect(await earlyEnqueue).toBeInstanceOf(ReferenceError);
    const trace: string[] = []; let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const activate = vi.spyOn(ProjectTaskOrchestrator.prototype, 'activate').mockImplementationOnce(async () => { trace.push('activate'); await pending; trace.push('activated'); }).mockResolvedValue(undefined);
    const enqueue = vi.spyOn(ProjectTaskOrchestrator.prototype, 'enqueue').mockImplementation(async () => { trace.push('enqueue'); return undefined as never; });
    const first = invoke(channels[1], attemptRequest);
    expect(trace).toEqual(['activate']); expect(enqueue).not.toHaveBeenCalled(); finish(); await first;
    expect(trace).toEqual(['activate', 'activated', 'enqueue']); expect(activate.mock.calls[0][0]).toBeInstanceOf(PartnerRuntimePort);
    await invoke(channels[1], { projectId: '', taskId: '' });
    expect(activate.mock.calls[1][0]).toBe(activate.mock.calls[0][0]); expect(enqueue.mock.calls).toEqual([[attemptRequest.projectId, attemptRequest.taskId], ['', '']]);
    const error = new Error('SYNTHETIC_ACTIVATION_FAILURE'); activate.mockRejectedValueOnce(error);
    await expect(invoke(channels[1], attemptRequest)).rejects.toBe(error); expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

it('keeps control routing, untrimmed reasons, retry argument count, return identity and gate payload identity', async () => {
  await withExecution(async ({ invoke }) => {
    const receipt = { id: 'fixture-attempt' } as never;
    const controls = ['pause', 'resume', 'cancel', 'retry'] as const;
    for (const [index, method] of controls.entries()) {
      const call = vi.spyOn(ProjectTaskOrchestrator.prototype, method).mockResolvedValue(receipt);
      await expect(invoke(channels[index + 2], { attemptId: ' fixture-attempt ', reason: ' 合成原因 ', extra: true })).resolves.toBe(receipt);
      expect(call.mock.calls).toEqual([method === 'retry' ? [' fixture-attempt '] : [' fixture-attempt ', ' 合成原因 ']]);
      const error = new Error('SYNTHETIC_CONTROL_FAILURE'); call.mockRejectedValueOnce(error);
      await expect(invoke(channels[index + 2], { attemptId: '' })).rejects.toBe(error);
      await expect(invoke(channels[index + 2], { attemptId: '' })).resolves.toBe(receipt);
    }
    const gate = vi.spyOn(ProjectTaskOrchestrator.prototype, 'resolveGate').mockResolvedValue(receipt);
    const request = { ...gateRequest, extra: true }; await expect(invoke(channels[6], request)).resolves.toBe(receipt);
    expect(gate.mock.calls[0][0]).toBe(request);
    const error = new Error('SYNTHETIC_GATE_FAILURE'); gate.mockRejectedValueOnce(error); await expect(invoke(channels[6], gateRequest)).rejects.toBe(error);
  });
});

it('keeps real execution-store snapshot notifications attached to the original root subscription', async () => {
  await withExecution(async ({ invoke, changes }) => {
    const snapshots = vi.spyOn(ProjectTaskExecutionStore.prototype, 'snapshot');
    await invoke(channels[0]);
    const store = snapshots.mock.contexts[0] as ProjectTaskExecutionStore;
    const attempt = await store.createAttempt({ ...attemptRequest, taskRevision: 1, assigneeId: 'fixture-partner', permissionMode: 'manual', blockedByTaskIds: [] });
    expect(changes().at(-1)).toEqual([DESKTOP_IPC.projectTaskExecutionChanged, { type: 'snapshot', snapshot: await store.snapshot() }]);
    expect((await invoke<{ attempts: { id: string }[] }>(channels[0], attemptRequest.projectId)).attempts.map(item => item.id)).toEqual([attempt.id]);
  });
});
