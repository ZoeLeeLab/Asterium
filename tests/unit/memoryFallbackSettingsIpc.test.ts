// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { SqliteMemoryCutover } from '../../src/main/memory/SqliteMemoryCutover';
import { MemoryFallbackInventory } from '../../src/main/memory/fallback/MemoryFallbackInventory';
import { MemoryFallbackScheduler } from '../../src/main/memory/fallback/MemoryFallbackScheduler';
import { MemoryFallbackSettingsStore } from '../../src/main/memory/fallback/MemoryFallbackSettingsStore';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.root, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => true },
  shell: {},
}));

const get = 'asterium:memory-fallback:get';
const configure = 'asterium:memory-fallback:configure';
const setPartner = 'asterium:memory-fallback:set-partner';
const config = { provider: 'openai', endpoint: 'https://service.fixture.invalid/v1', model: 'fixture-model', intervalMinutes: 30 };
const savedConfig = { ...config, endpoint: 'https://service.fixture.invalid/v1/chat/completions', credentialConfigured: false };
const partnerId = 'fixture-partner';
const partner = { partnerId, enabled: false };

async function withFallback(run: (invoke: (channel: string, value?: unknown, caller?: object) => Promise<unknown>) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-fallback-settings-ipc-'));
  electron.root = root;
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
  const invoke = async (channel: string, value?: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return await handler({ sender: caller }, value);
  };
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
    expect(handlers.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await testRm(root, { recursive: true, force: true });
  }
}

it('checks the sender and waits for SQLite readiness before reading or changing fallback settings', async () => {
  await withFallback(async invoke => {
    const ready = vi.spyOn(SqliteMemoryCutover.prototype, 'run');
    const snapshot = vi.spyOn(MemoryFallbackScheduler.prototype, 'snapshot');
    const updateSettings = vi.spyOn(MemoryFallbackSettingsStore.prototype, 'configure');
    const updatePartner = vi.spyOn(MemoryFallbackSettingsStore.prototype, 'setPartner');
    const requests = [[get, undefined], [configure, config], [setPartner, partner]] as const;
    for (const [channel, value] of requests) {
      await expect(invoke(channel, value, {})).rejects.toThrow('INVALID_IPC_SENDER');
    }
    expect(ready).not.toHaveBeenCalled();

    for (const [channel, value] of requests) {
      ready.mockRejectedValueOnce(new Error('fixture-cutover-failure'));
      await expect(invoke(channel, value)).rejects.toThrow('fixture-cutover-failure');
    }
    expect(ready).toHaveBeenCalledTimes(3);
    expect(snapshot).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(updatePartner).not.toHaveBeenCalled();
    await expect(invoke(get)).resolves.toMatchObject({
      settings: { provider: 'deepseek', intervalMinutes: 20, partners: {}, credentialConfigured: false }, jobs: [],
    });
  });
});

it('preserves global and per-partner updates, follow-up calls, and the returned snapshot', async () => {
  await withFallback(async invoke => {
    const ready = vi.spyOn(SqliteMemoryCutover.prototype, 'run');
    const updateSettings = vi.spyOn(MemoryFallbackSettingsStore.prototype, 'configure');
    const updatePartner = vi.spyOn(MemoryFallbackSettingsStore.prototype, 'setPartner');
    const cancel = vi.spyOn(MemoryFallbackScheduler.prototype, 'cancelCurrent');
    const reconfigure = vi.spyOn(MemoryFallbackScheduler.prototype, 'reconfigure');
    const refresh = vi.spyOn(MemoryFallbackInventory.prototype, 'refresh');
    const snapshot = vi.spyOn(MemoryFallbackScheduler.prototype, 'snapshot');

    await expect(invoke(configure, { ...config, intervalMinutes: 5 })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(invoke(setPartner, { ...partner, enabled: true })).rejects.toThrow('MEMORY_FALLBACK_PARTNER_NOT_ELIGIBLE');
    expect(cancel).not.toHaveBeenCalled();
    expect(reconfigure).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    vi.clearAllMocks();

    const global = await invoke(configure, config);
    expect(global).toEqual({ settings: { ...savedConfig, partners: {} }, jobs: [] });
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith(config);
    expect(ready).toHaveBeenCalledBefore(updateSettings);
    expect(updateSettings).toHaveBeenCalledBefore(cancel);
    expect(cancel).toHaveBeenCalledBefore(reconfigure);
    expect(reconfigure).toHaveBeenCalledBefore(snapshot);
    expect(refresh).not.toHaveBeenCalled();
    vi.clearAllMocks();

    const perPartner = await invoke(setPartner, partner);
    expect(perPartner).toEqual({
      settings: { ...savedConfig, partners: {
        [partnerId]: { enabled: false, history: 'from_now', enabledAt: expect.any(String) },
      } },
      jobs: [],
    });
    expect(updatePartner).toHaveBeenCalledExactlyOnceWith(partner);
    expect(ready).toHaveBeenCalledBefore(updatePartner);
    expect(updatePartner).toHaveBeenCalledBefore(cancel);
    expect(cancel).toHaveBeenCalledBefore(refresh);
    expect(refresh).toHaveBeenCalledBefore(snapshot);
    expect(reconfigure).not.toHaveBeenCalled();
    await expect(invoke(get)).resolves.toEqual(perPartner);
  });
});
