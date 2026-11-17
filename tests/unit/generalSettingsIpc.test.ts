// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { GeneralSettingsStore } from '../../src/main/settings/GeneralSettingsStore';
import { DEFAULT_GENERAL_SETTINGS } from '../../src/shared/generalSettings';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.root,
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

it('reads and persists general settings through IPC and forwards updates until disposal', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-general-settings-ipc-'));
  electron.root = root;
  const file = path.join(root, 'general-settings.v1.json');
  const generalSettings = new GeneralSettingsStore(file);
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
  const get = 'asterium:general-settings:get';
  const update = 'asterium:general-settings:update';
  const changed = 'asterium:general-settings:changed';
  const refreshes = () => sender.send.mock.calls.filter(([channel]) => channel === changed);
  const invoke = async (channel: string, value?: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return handler({ sender: caller }, value);
  };

  try {
    const dispose = registerAgentIpc(ipcMain, () => window, { generalSettings, environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      const initial = { revision: 0, settings: DEFAULT_GENERAL_SETTINGS, startupSupported: false };
      const patch = { sendShortcut: 'ctrl_enter', notifications: { approval: false } };
      await expect(invoke(get, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(update, patch, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(get)).resolves.toEqual(initial);
      await expect(invoke(update, { sendShortcut: 'invalid' })).rejects.toThrow('sendShortcut');
      await expect(invoke(get)).resolves.toEqual(initial);
      expect(refreshes()).toEqual([]);

      const updated = {
        ...initial, revision: 1,
        settings: { ...DEFAULT_GENERAL_SETTINGS, ...patch, notifications: { ...DEFAULT_GENERAL_SETTINGS.notifications, ...patch.notifications } },
      };
      await expect(invoke(update, patch)).resolves.toEqual(updated);
      await expect(invoke(get)).resolves.toEqual(updated);
      await expect(new GeneralSettingsStore(file).get()).resolves.toEqual(updated);
      expect(refreshes()).toEqual([[changed, updated]]);
    } finally {
      await dispose();
    }
    expect(handlers.has(get)).toBe(false);
    expect(handlers.has(update)).toBe(false);
    sender.send.mockClear();
    await generalSettings.update({ sendShortcut: 'enter' });
    expect(refreshes()).toEqual([]);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
});
