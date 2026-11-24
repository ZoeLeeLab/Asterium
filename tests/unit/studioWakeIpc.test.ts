// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { StudioWakeControlService } from '../../src/main/studio/StudioWakeControlService';
import { DESKTOP_IPC, DESKTOP_INVOKE_CHANNELS } from '../../src/shared/desktopIpc';
import type { StudioWakeAction } from '../../src/shared/studioWakeControl';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, safeStorage: {}, shell: {},
}));

const channels = [DESKTOP_IPC.studioWakeStatus, DESKTOP_IPC.studioWakeConfigure, DESKTOP_IPC.studioWakeControl];
const binding = { partnerId: 'fixture-partner', connectionBindingId: 'fixture-binding', connectOnLaunch: false };
const reply = { entries: [{ ...binding, ready: false, state: 'waiting' as const }] };

async function withWake(run: (fixture: {
  invoke: (channel: string, value?: unknown, caller?: object) => Promise<unknown>;
  registered: string[];
  close: () => Promise<void>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-wake-ipc-'));
  electron.userData = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const registered: string[] = [];
  const removed: string[] = [];
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error('Duplicate IPC channel');
      registered.push(channel); handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); },
  } as unknown as IpcMain;
  try {
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= dispose();
    try {
      await run({ registered, close, invoke: async (channel, value, caller = sender) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error('Missing IPC channel');
        return handler({ sender: caller }, value);
      } });
    } finally { await close(); }
    expect(removed).toEqual([...DESKTOP_INVOKE_CHANNELS]);
    expect(handlers.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await testRm(root, { recursive: true, force: true });
  }
}

it('registers the three Wake channels once in their established position and uses shared cleanup', async () => {
  await withWake(async ({ registered, close }) => {
    expect(registered).toHaveLength(230);
    expect(new Set(registered).size).toBe(230);
    const start = registered.indexOf(channels[0]);
    expect(registered.slice(start - 1, start + 4)).toEqual([
      DESKTOP_IPC.studioCancelRound, ...channels, DESKTOP_IPC.studioMcpStatus,
    ]);
    const dispose = vi.spyOn(StudioWakeControlService.prototype, 'dispose');
    await close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

it('checks the sender before any Wake service call or parameter validation', async () => {
  await withWake(async ({ invoke }) => {
    const status = vi.spyOn(StudioWakeControlService.prototype, 'status');
    const configure = vi.spyOn(StudioWakeControlService.prototype, 'configure');
    const control = vi.spyOn(StudioWakeControlService.prototype, 'control');
    for (const channel of channels) await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
    expect(status).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
  });
});

it('returns the unchanged status object and propagates the original failure', async () => {
  await withWake(async ({ invoke }) => {
    const failure = new Error('FIXTURE_STATUS_FAILED');
    const status = vi.spyOn(StudioWakeControlService.prototype, 'status')
      .mockResolvedValueOnce(reply).mockRejectedValueOnce(failure);
    expect(await invoke(channels[0], { ignored: true })).toBe(reply);
    await expect(invoke(channels[0])).rejects.toBe(failure);
    expect(status.mock.calls).toEqual([[], []]);
  });
});

it('waits for the status service result without adding another startup gate', async () => {
  await withWake(async ({ invoke }) => {
    let release!: (value: typeof reply) => void;
    const pending = new Promise<typeof reply>(resolve => { release = resolve; });
    const status = vi.spyOn(StudioWakeControlService.prototype, 'status').mockReturnValueOnce(pending);
    let settled = false;
    const response = invoke(channels[0]).then(value => { settled = true; return value; });
    try {
      expect(status).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally { release(reply); }
    expect(await response).toBe(reply);
  });
});

it('passes configuration through by identity and leaves schema validation in the service', async () => {
  await withWake(async ({ invoke }) => {
    const configure = vi.spyOn(StudioWakeControlService.prototype, 'configure').mockResolvedValue(reply);
    expect(await invoke(channels[1], binding)).toBe(reply);
    expect(configure.mock.calls[0][0]).toBe(binding);
    const failure = new Error('STUDIO_WAKE_SETTINGS_INVALID');
    for (const value of [undefined, null, [], { ...binding, extra: true }]) {
      configure.mockRejectedValueOnce(failure);
      await expect(invoke(channels[1], value)).rejects.toBe(failure);
      expect(configure).toHaveBeenLastCalledWith(value);
    }
  });
});

it('rejects only the existing malformed control envelopes before calling the service', async () => {
  await withWake(async ({ invoke }) => {
    const control = vi.spyOn(StudioWakeControlService.prototype, 'control');
    for (const value of [undefined, null, [], '', {}, { partnerId: 1, action: 'status' },
      { partnerId: 'fixture-partner' }, { partnerId: 'fixture-partner', action: 1 },
      { partnerId: 'fixture-partner', action: 'status', triggerId: null },
      { partnerId: 'fixture-partner', action: 'status', triggerId: 1 }]) {
      await expect(invoke(channels[2], value)).rejects.toThrow('STUDIO_WAKE_CONTROL_INVALID');
    }
    expect(control).not.toHaveBeenCalled();
  });
});

it('preserves action and trigger arguments, extra fields, return values and service errors', async () => {
  await withWake(async ({ invoke }) => {
    const control = vi.spyOn(StudioWakeControlService.prototype, 'control').mockResolvedValue(reply);
    for (const action of ['connect_once', 'status', 'retry', 'ignore', 'resume']) {
      const triggerId = ['retry', 'ignore'].includes(action) ? '00000000-0000-7000-8000-000000000001' : undefined;
      expect(await invoke(channels[2], { partnerId: binding.partnerId, action, triggerId, ignored: true })).toBe(reply);
      expect(control).toHaveBeenLastCalledWith(binding.partnerId, action, triggerId);
    }
    const failure = new Error('STUDIO_WAKE_CONTROL_INVALID');
    control.mockRejectedValueOnce(failure);
    await expect(invoke(channels[2], { partnerId: '', action: '', triggerId: '' })).rejects.toBe(failure);
    expect(control).toHaveBeenLastCalledWith('', '' as StudioWakeAction, '');
    control.mockRejectedValueOnce(new Error('STUDIO_WAKE_MCP_NOT_READY'));
    await expect(invoke(channels[2], { partnerId: binding.partnerId, action: 'connect_once' }))
      .rejects.toThrow('STUDIO_WAKE_MCP_NOT_READY');
  });
});
