// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { SessionCommandService } from '../../src/main/runtime/SessionCommandService';
import { SessionCompactionService } from '../../src/main/runtime/SessionCompactionService';
import type { SessionCommandResult, SessionStatus } from '../../src/shared/sessionCommands';
import type { SessionCompactResult } from '../../src/shared/sessionCompaction';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: {},
  shell: {},
}));

const execute = 'asterium:agent:execute-session-command';
const compact = 'asterium:agent:compact-session';
const target = { partnerId: 'fixture-partner', conversationId: 'fixture-chat', source: 'local_cli' } as const;
const sessionId = 'fixture-session';

async function withSessionMaintenance(run: (invoke: (channel: string, value: unknown, caller?: object) => Promise<unknown>) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-session-maintenance-ipc-'));
  electron.userData = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const invoke = async (channel: string, value: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return handler({ sender: caller }, value);
  };
  const disposeCompactions = vi.spyOn(SessionCompactionService.prototype, 'dispose');
  try {
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await run(invoke);
    } finally {
      await dispose();
    }
    expect(disposeCompactions).toHaveBeenCalledTimes(1);
    expect(handlers.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await testRm(root, { recursive: true, force: true });
  }
}

it('validates the caller and command fields before returning the execution service result or error', async () => {
  await withSessionMaintenance(async invoke => {
    const result: SessionCommandResult = { status: 'success', message: 'Fixture reload completed' };
    const execution = vi.spyOn(SessionCommandService.prototype, 'execute').mockResolvedValue(result);
    const commandId = 'fixture-command';
    const request = { ...target, commandId, command: 'reload-persona' };
    await expect(invoke(execute, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
    for (const invalid of [null, target, { ...request, command: 'unknown' }, { ...request, commandId: 'bad id' },
      { ...request, sessionId: 'bad id' }, { ...request, source: 'unknown' }, { ...request, extra: true }]) {
      await expect(invoke(execute, invalid)).rejects.toThrow('INVALID_SESSION_COMMAND');
    }
    expect(execution).not.toHaveBeenCalled();
    await expect(invoke(execute, request)).resolves.toBe(result);
    expect(execution).toHaveBeenCalledExactlyOnceWith(request);

    const upstream = { ...target, commandId, command: 'status', source: 'existing_thread', sessionId };
    const error = new Error('SESSION_COMMAND_THREAD_MISMATCH');
    execution.mockRejectedValueOnce(error);
    await expect(invoke(execute, upstream)).rejects.toBe(error);
    expect(execution).toHaveBeenLastCalledWith(upstream);
  });
});

it('keeps direct and command-based compaction connected to the same service with their original responses', async () => {
  await withSessionMaintenance(async invoke => {
    const request = { ...target, sessionId, commandId: 'fixture-compact' };
    const result: SessionCompactResult = { status: 'unchanged', message: 'Fixture context unchanged' };
    const compaction = vi.spyOn(SessionCompactionService.prototype, 'compact').mockResolvedValue(result);
    await expect(invoke(compact, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
    for (const invalid of [null, target, { ...request, source: 'existing_thread' }, { ...request, sessionId: 'bad id' },
      { ...request, commandId: '' }, { ...request, conversationId: '' }, { ...request, command: 'compact' }]) {
      await expect(invoke(compact, invalid)).rejects.toThrow('INVALID_COMPACT_REQUEST');
    }
    expect(compaction).not.toHaveBeenCalled();
    await expect(invoke(compact, request)).resolves.toBe(result);
    expect(compaction).toHaveBeenCalledExactlyOnceWith(request);
    const error = new Error('COMPACT_CONVERSATION_BUSY');
    compaction.mockRejectedValueOnce(error);
    await expect(invoke(compact, { ...request, source: 'api_partner' })).rejects.toBe(error);

    const status: SessionStatus = {
      ...target, sessionId, model: 'fixture-model', modelStatus: 'unknown', state: 'idle',
      capabilities: { status: { available: true }, compact: { available: true },
        'reload-user': { available: false }, 'reload-persona': { available: false } },
      observedAt: '2026-01-01T00:00:00.000Z',
    };
    const inspect = vi.spyOn(SessionCommandService.prototype, 'inspect').mockResolvedValue(status);
    const commandId = 'fixture-compact-command';
    await expect(invoke(execute, { ...target, commandId, command: 'compact' })).resolves.toEqual({
      status: 'info', message: result.message,
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(target);
    expect(compaction).toHaveBeenLastCalledWith({ ...target, commandId, sessionId });
    expect(compaction.mock.contexts[2]).toBe(compaction.mock.contexts[0]);
  });
});
