// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { StudioMcpAccessStore } from '../../src/main/studio/StudioMcpAccessStore';
import { StudioMcpHost } from '../../src/main/studio/StudioMcpHost';
import { StudioWakeControlService } from '../../src/main/studio/StudioWakeControlService';
import { StudioWakeEvents } from '../../src/main/studio/StudioWakeEvents';
import type { StudioMcpConfiguration, StudioMcpStatus } from '../../src/shared/studioMcp';
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

const status = 'asterium:studio-mcp:status';
const configure = 'asterium:studio-mcp:configure';
const configuration: StudioMcpConfiguration = { enabled: true, port: 0, publicOrigin: '' };

function gate() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}

function connectToListener(port: number) {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('error', reject);
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
}

async function withStudioMcp(run: (fixture: {
  access: StudioMcpAccessStore;
  invoke: (channel: string, value?: unknown, caller?: object) => Promise<StudioMcpStatus>;
  close: () => Promise<void>;
}) => Promise<void>, savedConfiguration?: StudioMcpConfiguration) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-mcp-host-ipc-'));
  electron.userData = root;
  const access = new StudioMcpAccessStore(path.join(root, 'studio-mcp-access.v1.json'), 0, true);
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => Promise<StudioMcpStatus>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (name: string, handler: Handler) => {
      if (handlers.has(name)) throw new Error(`Duplicate IPC channel: ${name}`);
      handlers.set(name, handler);
    },
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as IpcMain;
  const invoke = async (channel: string, value?: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return await handler({ sender: caller }, value);
  };
  try {
    if (savedConfiguration) await access.configure(savedConfiguration);
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: Boolean(savedConfiguration), mcpPort: 0,
    } });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= dispose();
    try {
      await run({ access, invoke, close });
    } finally {
      await close();
    }
    expect(handlers.size).toBe(0);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
}

it('waits for the saved listener to finish restoring before answering a status request', async () => {
  const ready = gate();
  const restoring = gate();
  const originalRestore = StudioMcpHost.prototype.restore;
  const restore = vi.spyOn(StudioMcpHost.prototype, 'restore').mockImplementation(async function (this: StudioMcpHost) {
    restoring.release();
    await ready.pending;
    return originalRestore.call(this);
  });
  const readStatus = vi.spyOn(StudioMcpHost.prototype, 'status');
  const notifyWake = vi.spyOn(StudioWakeControlService.prototype, 'changed');
  try {
    await withStudioMcp(async ({ invoke }) => {
      let response: Promise<StudioMcpStatus>;
      try {
        await restoring.pending;
        await expect(invoke(status, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
        response = invoke(status);
        expect(restore).toHaveBeenCalledTimes(1);
        expect(readStatus).not.toHaveBeenCalled();
        expect(notifyWake).not.toHaveBeenCalled();
      } finally {
        ready.release();
      }
      await expect(response).resolves.toEqual({
        configuration: { ...configuration, port: expect.any(Number) }, credentials: [], running: true,
      });
      expect((await response).configuration.port).toBeGreaterThan(0);
      expect(notifyWake).toHaveBeenCalledTimes(1);
    }, configuration);
  } finally {
    vi.restoreAllMocks();
  }
});

it('notifies Wake only after configuration succeeds and closes the listener during IPC disposal', async () => {
  try {
    await withStudioMcp(async ({ access, invoke, close }) => {
      await expect(invoke(status)).resolves.toEqual({
        configuration: { ...configuration, enabled: false }, credentials: [], running: false,
      });
      const originalConfigure = StudioMcpHost.prototype.configure;
      const apply = vi.spyOn(StudioMcpHost.prototype, 'configure');
      const notifyWake = vi.spyOn(StudioWakeControlService.prototype, 'changed');
      await expect(invoke(configure, configuration, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(configure, [])).rejects.toThrow('STUDIO_MCP_CONFIGURATION_INVALID');
      expect(apply).not.toHaveBeenCalled();
      await expect(invoke(configure, { ...configuration, port: -1 })).rejects.toThrow('STUDIO_MCP_CONFIGURATION_INVALID');
      expect(notifyWake).not.toHaveBeenCalled();

      const allowConfiguration = gate();
      apply.mockImplementationOnce(async function (this: StudioMcpHost, value) {
        await allowConfiguration.pending;
        return originalConfigure.call(this, value);
      });
      const pending = invoke(configure, configuration);
      try {
        expect(apply).toHaveBeenLastCalledWith(configuration);
        expect(notifyWake).not.toHaveBeenCalled();
      } finally {
        allowConfiguration.release();
      }
      const listening = await pending;
      expect(listening).toMatchObject({ running: true, credentials: [] });
      const port = listening.configuration.port;
      await expect(connectToListener(port)).resolves.toBeUndefined();
      expect(notifyWake).toHaveBeenCalledTimes(1);
      await expect(access.snapshot()).resolves.toEqual({ configuration, credentials: [] });

      const wakeDispose = vi.spyOn(StudioWakeControlService.prototype, 'dispose');
      const hostDispose = vi.spyOn(StudioMcpHost.prototype, 'dispose');
      const eventsDispose = vi.spyOn(StudioWakeEvents.prototype, 'dispose');
      await close();
      expect(wakeDispose).toHaveBeenCalledTimes(1);
      expect(hostDispose).toHaveBeenCalledTimes(1);
      expect(eventsDispose).toHaveBeenCalledTimes(1);
      expect(wakeDispose).toHaveBeenCalledBefore(hostDispose);
      expect(hostDispose).toHaveBeenCalledBefore(eventsDispose);
      await expect(connectToListener(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      await expect(access.snapshot()).resolves.toEqual({ configuration, credentials: [] });
    });
  } finally {
    vi.restoreAllMocks();
  }
});
