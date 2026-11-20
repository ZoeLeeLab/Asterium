// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { GeneralSettingsStore } from '../../src/main/settings/GeneralSettingsStore';
import { PROFILE_MARKER, resolveRuntimeEnvironment } from '../../src/main/settings/runtimeEnvironment';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { RuntimeProfile } from '../../src/shared/runtimeEnvironment';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '', open: vi.fn(), confirm: vi.fn(), openPath: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: (key: string) => path.join(electron.root, key), getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, clipboard: {}, safeStorage: {},
  dialog: { showOpenDialog: electron.open, showMessageBox: electron.confirm }, shell: { openPath: electron.openPath },
}));
const channels: string[] = [DESKTOP_IPC.storageGet, DESKTOP_IPC.storageChooseUserDataDirectory, DESKTOP_IPC.storageChooseProjectRoot, DESKTOP_IPC.storageResetProjectRoot, DESKTOP_IPC.storageOpenProjectRoot];

async function withStorage(profile: RuntimeProfile, run: (fixture: {
  root: string; settings: GeneralSettingsStore; sender: object;
  invoke: <T = unknown>(channel: string, caller?: object) => Promise<T>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-storage-ipc-'));
  electron.root = root;
  electron.open.mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
  electron.confirm.mockReset().mockResolvedValue({ response: 0 });
  electron.openPath.mockReset().mockResolvedValue('');
  await Promise.all(['userData', 'appData', 'documents'].map(name => mkdir(path.join(root, name))));
  const settings = new GeneralSettingsStore(path.join(root, 'userData', 'general-settings.v1.json'));
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }) => unknown;
  const handlers = new Map<string, Handler>(), removed: string[] = [];
  const ipc = { handle: (channel: string, handler: Handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); }, removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); } } as unknown as IpcMain;
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = registerAgentIpc(ipc, () => window, { generalSettings: settings, environment: {
      profile, label: 'Fixture', userDataDirectory: path.join(root, 'userData'), projectsDirectory: path.join(root, 'projects'),
      temporaryDirectory: root, appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false, restoreBackgroundServices: false, mcpPort: 0,
    } });
    expect([...handlers.keys()].filter(channel => channels.includes(channel))).toEqual(channels);
    await run({ root, settings, sender, invoke: async <T,>(channel: string, caller: object = sender) => await handlers.get(channel)!({ sender: caller }) as T });
  } finally {
    try { await dispose?.(); expect(handlers.size).toBe(0); for (const channel of channels) expect(removed.filter(name => name === channel)).toHaveLength(1); }
    finally { vi.restoreAllMocks(); await testRm(root, { recursive: true, force: true }); }
  }
}

it('checks all five callers before dialogs or settings and keeps the daily-only boundary', async () => {
  await withStorage('autotest', async ({ invoke, settings }) => {
    const get = vi.spyOn(settings, 'get');
    for (const channel of channels) await expect(invoke(channel, {})).rejects.toThrow('INVALID_IPC_SENDER');
    expect(get).not.toHaveBeenCalled(); expect(electron.open).not.toHaveBeenCalled();
    await expect(invoke(DESKTOP_IPC.storageChooseUserDataDirectory)).rejects.toThrow('仅日常版可更改应用资料目录。');
    expect(electron.open).not.toHaveBeenCalled();
    expect(await invoke(DESKTOP_IPC.storageGet)).toMatchObject({ canChooseUserDataDirectory: false, customized: false });
  });
});

it('preserves project-root cancellation, protected paths, notifications, reset and shell errors', async () => {
  await withStorage('autotest', async ({ invoke, settings, root, sender }) => {
    const initial = { userDataDirectory: path.join(root, 'userData'), canChooseUserDataDirectory: false, defaultProjectRoot: path.join(root, 'projects'), customized: false };
    await expect(invoke(DESKTOP_IPC.storageGet)).resolves.toEqual(initial);
    const update = vi.spyOn(settings, 'update');
    await expect(invoke(DESKTOP_IPC.storageChooseProjectRoot)).resolves.toBeNull();
    electron.open.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    await expect(invoke(DESKTOP_IPC.storageChooseProjectRoot)).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
    const protectedPath = path.join(root, 'userData', 'AsteriumData'); await mkdir(protectedPath);
    electron.open.mockResolvedValueOnce({ canceled: false, filePaths: [protectedPath] });
    await expect(invoke(DESKTOP_IPC.storageChooseProjectRoot)).rejects.toThrow(); expect(update).not.toHaveBeenCalled();
    const custom = path.join(root, 'custom'); await mkdir(custom);
    electron.open.mockResolvedValueOnce({ canceled: false, filePaths: [custom] });
    await expect(invoke(DESKTOP_IPC.storageChooseProjectRoot)).resolves.toEqual({ ...initial, defaultProjectRoot: custom, customized: true });
    expect(update).toHaveBeenCalledExactlyOnceWith({ defaultProjectRoot: custom });
    expect((sender as { send: ReturnType<typeof vi.fn> }).send.mock.calls.some(([channel]) => channel === DESKTOP_IPC.generalSettingsChanged)).toBe(true);
    await expect(invoke(DESKTOP_IPC.storageOpenProjectRoot)).resolves.toBeUndefined(); expect(electron.openPath).toHaveBeenLastCalledWith(custom);
    electron.openPath.mockResolvedValueOnce('SYNTHETIC_SHELL_FAILURE');
    await expect(invoke(DESKTOP_IPC.storageOpenProjectRoot)).rejects.toThrow('SYNTHETIC_SHELL_FAILURE');
    await expect(invoke(DESKTOP_IPC.storageResetProjectRoot)).resolves.toEqual(initial);
    expect(update).toHaveBeenLastCalledWith({ defaultProjectRoot: null });
  });
});

it('only saves a chosen daily directory after confirmation and resolves it again after restart', async () => {
  await withStorage('daily', async ({ root, invoke }) => {
    const target = path.join(root, 'existing'); await mkdir(target);
    await writeFile(path.join(target, PROFILE_MARKER), JSON.stringify({ version: 1, profile: 'daily' }));
    await writeFile(path.join(target, 'fixture.txt'), 'SYNTHETIC_EXISTING_DATA');
    await expect(invoke(DESKTOP_IPC.storageChooseUserDataDirectory)).resolves.toBeNull();
    expect(electron.confirm).not.toHaveBeenCalled();
    electron.open.mockResolvedValue({ canceled: false, filePaths: [target] });
    await expect(invoke(DESKTOP_IPC.storageChooseUserDataDirectory)).resolves.toBeNull();
    expect(await readdir(path.join(root, 'appData'))).toEqual([]);
    expect(electron.confirm.mock.calls.at(-1)?.[1]).toMatchObject({ message: '重启后使用此目录中的已有资料？', defaultId: 0, cancelId: 0 });
    electron.confirm.mockResolvedValueOnce({ response: 1 });
    await expect(invoke(DESKTOP_IPC.storageChooseUserDataDirectory)).resolves.toBe(target);
    expect(await readFile(path.join(target, 'fixture.txt'), 'utf8')).toBe('SYNTHETIC_EXISTING_DATA');
    const restarted = resolveRuntimeEnvironment({ isPackaged: true, profile: 'daily', appData: path.join(root, 'appData'), localAppData: root, documents: path.join(root, 'documents'), temp: root });
    expect(restarted.userDataDirectory).toBe(target);
    expect(await invoke(DESKTOP_IPC.storageGet)).toMatchObject({ userDataDirectory: path.join(root, 'userData'), canChooseUserDataDirectory: true });
  });
});

it('distinguishes empty directories and revalidates the target after confirmation', async () => {
  await withStorage('daily', async ({ root, invoke }) => {
    const target = path.join(root, 'empty'); await mkdir(target);
    electron.open.mockResolvedValue({ canceled: false, filePaths: [target] });
    electron.confirm.mockImplementationOnce(async () => { await writeFile(path.join(target, 'unrelated.txt'), 'SYNTHETIC_CHANGED_DIRECTORY'); return { response: 1 }; });
    await expect(invoke(DESKTOP_IPC.storageChooseUserDataDirectory)).rejects.toThrow('请选择已有的星丛资料根目录，或选择一个空文件夹。');
    expect(electron.confirm.mock.calls.at(-1)?.[1]).toMatchObject({ message: '重启后在空目录中创建一套新资料？' });
    expect(await readdir(path.join(root, 'appData'))).toEqual([]);
  });
});
