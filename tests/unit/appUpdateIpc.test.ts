// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { UpdateSnapshot } from '../../src/shared/appUpdates';
import type { RuntimeEnvironment } from '../../src/shared/runtimeEnvironment';
import { testRm } from '../helpers/autoTest.mjs';

const fixture = vi.hoisted(() => ({
  environment: undefined as RuntimeEnvironment | undefined,
  appEvents: new Map<string, (...args: never[]) => void>(),
  handlers: new Map<string, (event: { sender: object }) => unknown>(),
  window: {
    webContents: { send: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn() },
    on: vi.fn(), once: vi.fn(), loadURL: vi.fn(), isDestroyed: vi.fn(() => false),
  },
  quit: vi.fn(),
  exit: vi.fn(),
  makeUpdates: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    commandLine: { getSwitchValue: () => '', hasSwitch: () => false },
    getPath: () => fixture.environment!.userDataDirectory,
    getAppPath: () => process.cwd(),
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    requestSingleInstanceLock: () => true,
    whenReady: async () => undefined,
    on: (event: string, listener: (...args: never[]) => void) => fixture.appEvents.set(event, listener),
    quit: fixture.quit,
    exit: fixture.exit,
  },
  BrowserWindow: class { constructor() { return fixture.window; } static getAllWindows() { return []; } },
  ipcMain: {
    handle: (channel: string, handler: (event: { sender: object }) => unknown) => {
      if (fixture.handlers.has(channel)) throw new Error('Duplicate channel ' + channel);
      fixture.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => fixture.handlers.delete(channel),
    on: vi.fn(),
  },
  clipboard: {},
  dialog: {},
  nativeImage: { createFromDataURL: vi.fn() },
  Menu: {},
  Notification: { isSupported: () => false },
  safeStorage: {},
  shell: {},
  Tray: class {},
}));
vi.mock('../../src/main/settings/runtimeEnvironment', () => ({
  activateRuntimeEnvironment: () => fixture.environment,
}));
vi.mock('../../src/main/settings/AppUpdateService', () => ({
  AppUpdateService: class { constructor() { return fixture.makeUpdates(); } },
}));

const channels = {
  get: 'asterium:updates:get',
  check: 'asterium:updates:check',
  download: 'asterium:updates:download',
  cancel: 'asterium:updates:cancel',
  install: 'asterium:updates:install',
  openReleases: 'asterium:updates:open-releases',
};
const changed = 'asterium:updates:changed';
const snapshot: UpdateSnapshot = { configured: true, currentVersion: '0.1.0', phase: 'idle' };

function invoke(channel: string, sender = fixture.window.webContents as object) {
  const handler = fixture.handlers.get(channel);
  if (!handler) throw new Error('Unregistered channel ' + channel);
  return handler({ sender });
}

function quitDesktop() {
  const preventDefault = vi.fn();
  fixture.appEvents.get('before-quit')?.({ preventDefault } as never);
  expect(preventDefault).toHaveBeenCalledOnce();
  return vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce());
}

async function withDesktop(
  allowUpdates: boolean,
  checkUpdatesAtStartup: boolean,
  verify: (updates: ReturnType<typeof createUpdates>) => void | Promise<void>,
) {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.appEvents.clear();
  fixture.handlers.clear();
  fixture.window.isDestroyed.mockReturnValue(false);
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://127.0.0.1:0');
  vi.stubEnv('ASTERIUM_STARTUP_SMOKE', '0');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-app-update-ipc-'));
  try {
    fixture.environment = {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates,
      restoreBackgroundServices: false, mcpPort: 0,
    };
    const { GeneralSettingsStore } = await import('../../src/main/settings/GeneralSettingsStore');
    await new GeneralSettingsStore(path.join(root, 'general-settings.v1.json')).update({ checkUpdatesAtStartup });
    const updates = createUpdates();
    fixture.makeUpdates.mockReturnValue(updates);
    await import('../../src/main/main');
    await vi.waitFor(() => expect(fixture.appEvents.has('activate')).toBe(true));
    await verify(updates);
  } finally {
    try {
      if (fixture.appEvents.has('before-quit') && !fixture.quit.mock.calls.length) await quitDesktop();
    } finally {
      await testRm(root, { recursive: true, force: true });
    }
  }
}

function createUpdates() {
  const listeners = new Set<(value: UpdateSnapshot) => void>();
  const unsubscribe = vi.fn();
  return {
    get: vi.fn(() => snapshot),
    check: vi.fn(async () => ({ ...snapshot, phase: 'available' })),
    download: vi.fn(async () => ({ ...snapshot, phase: 'downloaded' })),
    cancel: vi.fn(),
    install: vi.fn(async () => ({ ...snapshot, phase: 'installing' })),
    openReleases: vi.fn(async () => undefined),
    dispose: vi.fn(),
    subscribe: vi.fn((listener: (value: UpdateSnapshot) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); unsubscribe(); };
    }),
    unsubscribe,
    publish(value: UpdateSnapshot) { for (const listener of listeners) listener(value); },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('registers the six update commands and forwards progress until desktop exit', async () => {
  await withDesktop(true, true, async (updates) => {
    expect(updates.check).toHaveBeenCalledOnce();
    expect(updates.download).not.toHaveBeenCalled();
    expect(updates.install).not.toHaveBeenCalled();
    expect(updates.subscribe).toHaveBeenCalledOnce();
    expect([...fixture.handlers.keys()].filter((channel) => channel.startsWith('asterium:updates:')).sort())
      .toEqual(Object.values(channels).sort());
    for (const channel of Object.values(channels)) {
      expect(() => invoke(channel, {})).toThrow('INVALID_IPC_SENDER');
    }
    expect(updates.check).toHaveBeenCalledOnce();
    expect(updates.get).not.toHaveBeenCalled();
    expect(updates.download).not.toHaveBeenCalled();
    expect(updates.cancel).not.toHaveBeenCalled();
    expect(updates.install).not.toHaveBeenCalled();
    expect(updates.openReleases).not.toHaveBeenCalled();
    expect(invoke(channels.get)).toEqual(snapshot);
    await expect(invoke(channels.check)).resolves.toMatchObject({ phase: 'available' });
    await expect(invoke(channels.download)).resolves.toMatchObject({ phase: 'downloaded' });
    expect(invoke(channels.cancel)).toBeUndefined();
    expect(updates.cancel).toHaveBeenCalledOnce();
    await expect(invoke(channels.install)).resolves.toMatchObject({ phase: 'installing' });
    await expect(invoke(channels.openReleases)).resolves.toBeUndefined();
    expect(updates.openReleases).toHaveBeenCalledOnce();

    const progress: UpdateSnapshot = { ...snapshot, phase: 'downloading', receivedBytes: 2, totalBytes: 10 };
    updates.publish(progress);
    expect(fixture.window.webContents.send).toHaveBeenCalledWith(changed, progress);
    fixture.window.webContents.send.mockClear();
    fixture.window.isDestroyed.mockReturnValue(true);
    updates.publish(progress);
    expect(fixture.window.webContents.send).not.toHaveBeenCalled();
    fixture.window.isDestroyed.mockReturnValue(false);
    fixture.window.on.mock.calls.find(([event]) => event === 'closed')?.[1]();
    updates.publish(progress);
    expect(fixture.window.webContents.send).not.toHaveBeenCalled();
    fixture.appEvents.get('activate')?.();

    await quitDesktop();
    expect(updates.unsubscribe).toHaveBeenCalledOnce();
    expect(updates.dispose).toHaveBeenCalledOnce();
    expect(updates.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(updates.dispose.mock.invocationCallOrder[0]);
    for (const channel of Object.values(channels)) expect(fixture.handlers.has(channel)).toBe(false);
    updates.publish(progress);
    expect(fixture.window.webContents.send).not.toHaveBeenCalled();
  });
});

it.each([
  { allowUpdates: false, checkUpdatesAtStartup: true },
  { allowUpdates: true, checkUpdatesAtStartup: false },
])('skips automatic checks with allowUpdates=$allowUpdates and checkUpdatesAtStartup=$checkUpdatesAtStartup', async ({
  allowUpdates, checkUpdatesAtStartup,
}) => {
  await withDesktop(allowUpdates, checkUpdatesAtStartup, (updates) => {
    expect(updates.check).not.toHaveBeenCalled();
  });
});
