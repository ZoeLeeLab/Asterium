// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { DesktopNotifications } from '../../src/main/settings/DesktopNotifications';
import { AGENT_PROTOCOL_VERSION } from '../../src/shared/agentProtocol';
import { DEFAULT_GENERAL_SETTINGS } from '../../src/shared/generalSettings';
import type { RuntimeEnvironment } from '../../src/shared/runtimeEnvironment';
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

const navigationTake = 'asterium:desktop-navigation:take';
const environmentGet = 'asterium:environment:get';

async function withHandlers(
  configure: (root: string) => Parameters<typeof import('../../src/main/agentIpc').registerAgentIpc>[2],
  check: (invoke: (channel: string, foreign?: boolean) => unknown) => void,
) {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-desktop-navigation-ipc-'));
  electron.root = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = registerAgentIpc(ipcMain, () => window, configure(root));
    check((channel, foreign = false) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
      return handler({ sender: foreign ? {} : sender });
    });
  } finally {
    try {
      await dispose?.();
      expect(handlers.has(navigationTake)).toBe(false);
      expect(handlers.has(environmentGet)).toBe(false);
    } finally {
      await testRm(root, { recursive: true, force: true });
    }
  }
}

it('returns the supplied environment and consumes notification navigation only for the main window', async () => {
  const show = vi.fn<(message: { title: string; body: string }, click: () => void) => void>();
  const now = Date.parse('2026-01-01T00:00:00Z');
  const notifications = new DesktopNotifications({
    settings: () => DEFAULT_GENERAL_SETTINGS,
    background: () => true,
    supported: () => true,
    show,
    restore: vi.fn(),
    navigationReady: vi.fn(),
    now: () => now,
  });
  let environment: RuntimeEnvironment;
  await withHandlers((root) => {
    environment = {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    };
    return { environment, notifications };
  }, (invoke) => {
    expect(() => invoke(environmentGet, true)).toThrow('INVALID_IPC_SENDER');
    expect(invoke(environmentGet)).toEqual(environment);
    expect(invoke(navigationTake)).toBeUndefined();
    notifications.agent({
      type: 'run.completed', finishReason: 'completed', protocolVersion: AGENT_PROTOCOL_VERSION,
      eventId: 'fixture-event', partnerId: 'fixture-partner', conversationId: 'fixture-chat',
      connectionSource: 'local_cli', clientMessageId: 'fixture-message', sessionId: 'fixture-session',
      runId: 'fixture-run', sequence: 1, occurredAt: new Date(now).toISOString(),
    });
    expect(show).toHaveBeenCalledOnce();
    show.mock.calls[0][1]();
    expect(() => invoke(navigationTake, true)).toThrow('INVALID_IPC_SENDER');
    expect(invoke(navigationTake)).toEqual({ kind: 'conversation', conversationId: 'fixture-chat' });
    expect(invoke(navigationTake)).toBeUndefined();
  });
});

it('preserves the defaults when notifications and runtime environment are omitted', async () => {
  await withHandlers(() => undefined, (invoke) => {
    expect(invoke(navigationTake)).toBeUndefined();
    expect(() => invoke(environmentGet, true)).toThrow('INVALID_IPC_SENDER');
    expect(() => invoke(environmentGet)).toThrow('ENVIRONMENT_UNAVAILABLE');
  });
});
