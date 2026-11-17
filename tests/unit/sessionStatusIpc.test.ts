// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { SessionCommandService } from '../../src/main/runtime/SessionCommandService';
import type { SessionStatus } from '../../src/shared/sessionCommands';
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

it('checks the sender and target, and returns the status service result and error unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-session-status-ipc-'));
  electron.userData = root;
  const channel = 'asterium:agent:get-session-status';
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (name: string, handler: Handler) => {
      if (handlers.has(name)) throw new Error(`Duplicate IPC channel: ${name}`);
      handlers.set(name, handler);
    },
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as IpcMain;
  const invoke = (value: unknown, caller: object = sender) => handlers.get(channel)!({ sender: caller }, value);
  const target = { partnerId: 'fixture-partner', conversationId: 'fixture-chat', source: 'api_partner' } as const;
  const status: SessionStatus = {
    ...target, model: 'fixture-model', modelStatus: 'configured', state: 'waiting_authorization',
    appliedProfiles: { user: '未知', persona: '未知' },
    capabilities: {
      status: { available: true }, compact: { available: false, reason: '请等待当前任务结束' },
      'reload-user': { available: false }, 'reload-persona': { available: false },
    },
    observedAt: '2026-01-01T00:00:00.000Z',
  };
  const inspect = vi.spyOn(SessionCommandService.prototype, 'inspect').mockResolvedValue(status);
  const execute = vi.spyOn(SessionCommandService.prototype, 'execute');
  try {
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await expect(invoke(target, {})).rejects.toThrow('INVALID_IPC_SENDER');
      for (const invalid of [null, { ...target, partnerId: '' }, { ...target, source: 'fixture' },
        { ...target, sessionId: 'bad id' }, { ...target, command: 'compact' }]) {
        await expect(invoke(invalid)).rejects.toThrow('INVALID_SESSION_COMMAND');
      }
      expect(inspect).not.toHaveBeenCalled();

      await expect(invoke(target)).resolves.toBe(status);
      expect(inspect).toHaveBeenCalledExactlyOnceWith(target);
      const error = new Error('SESSION_COMMAND_THREAD_MISMATCH');
      inspect.mockRejectedValueOnce(error);
      await expect(invoke({ ...target, sessionId: 'fixture-session' })).rejects.toBe(error);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
    expect(handlers.has(channel)).toBe(false);
  } finally {
    inspect.mockRestore();
    execute.mockRestore();
    await testRm(root, { recursive: true, force: true });
  }
});
