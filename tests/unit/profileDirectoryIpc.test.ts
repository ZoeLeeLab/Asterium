// @vitest-environment node
import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({
  userData: '',
  openPath: vi.fn<(directory: string) => Promise<string>>(),
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    whenReady: async () => undefined,
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: {},
  shell: { openPath: electron.openPath },
}));

const channel = 'asterium:agent:open-profile-directory';

async function withProfileDirectory(run: (fixture: {
  root: string;
  directory: string;
  invoke: (value?: unknown, caller?: object) => Promise<unknown>;
}) => Promise<void>) {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-profile-directory-ipc-'));
  const userData = path.join(root, 'selected-profile');
  const directory = path.join(userData, 'AsteriumData');
  electron.userData = userData;
  electron.openPath.mockReset().mockResolvedValue('');

  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value?: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (name: string, handler: Handler) => {
      if (handlers.has(name)) throw new Error(`Duplicate IPC channel: ${name}`);
      handlers.set(name, handler);
    },
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as IpcMain;
  const invoke = (value?: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return handler({ sender: caller }, value);
  };

  try {
    await mkdir(userData);
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: userData,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await run({ root, directory, invoke });
    } finally {
      await dispose();
    }
    expect(handlers.has(channel)).toBe(false);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
}

it('checks the sender, creates the configured profile directory and opens it on repeated calls', async () => {
  await withProfileDirectory(async ({ root, directory, invoke }) => {
    const otherDirectory = path.join(root, 'caller-supplied-path');
    await expect(invoke(otherDirectory, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(electron.openPath).not.toHaveBeenCalled();

    electron.openPath.mockImplementation(async opened => {
      expect(opened).toBe(directory);
      expect((await stat(opened)).isDirectory()).toBe(true);
      return '';
    });
    await expect(invoke()).resolves.toBeUndefined();
    const marker = path.join(directory, 'fixture.txt');
    await writeFile(marker, 'synthetic profile data');
    await expect(invoke(otherDirectory)).resolves.toBeUndefined();
    expect(electron.openPath.mock.calls).toEqual([[directory], [directory]]);
    await expect(readFile(marker, 'utf8')).resolves.toBe('synthetic profile data');
    await expect(stat(otherDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it('returns filesystem and shell errors and permits another attempt', async () => {
  await withProfileDirectory(async ({ directory, invoke }) => {
    await writeFile(directory, 'fixture blocking file');
    await expect(invoke()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(electron.openPath).not.toHaveBeenCalled();
    await expect(readFile(directory, 'utf8')).resolves.toBe('fixture blocking file');
    await unlink(directory);

    electron.openPath.mockResolvedValueOnce('Fixture shell could not open the directory');
    await expect(invoke()).rejects.toThrow('Fixture shell could not open the directory');
    await expect(invoke()).resolves.toBeUndefined();
    expect(electron.openPath.mock.calls).toEqual([[directory], [directory]]);
  });
});
