// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { AutomationConfirmations } from '../../src/main/automation/AutomationConfirmations';
import { AutomationRuntime } from '../../src/main/automation/AutomationRuntime';
import { AutomationStore } from '../../src/main/automation/AutomationStore';
import { DesktopNotifications } from '../../src/main/settings/DesktopNotifications';
import { automationInputSchema, type AutomationConfirmation } from '../../src/shared/automations';
import { DEFAULT_GENERAL_SETTINGS } from '../../src/shared/generalSettings';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '', ready: Promise.resolve() }));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.root,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    whenReady: () => electron.ready,
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: {},
  shell: {},
}));

const channels = {
  get: 'asterium:automations:get',
  mutate: 'asterium:automations:mutate',
  confirmations: 'asterium:automations:confirmations:get',
  resolve: 'asterium:automations:confirmations:resolve',
};
const changed = 'asterium:automations:changed';
const confirmationsChanged = 'asterium:automations:confirmations:changed';

it('keeps automation IPC connected to startup recovery, scheduling, notifications, and shutdown', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-automation-ipc-'));
  electron.root = root;
  let markReady!: () => void;
  electron.ready = new Promise<void>(resolve => { markReady = resolve; });
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  const show = vi.fn();
  const notifications = new DesktopNotifications({
    settings: () => DEFAULT_GENERAL_SETTINGS, background: () => true, supported: () => true,
    show, restore: vi.fn(), navigationReady: vi.fn(),
  });
  type Handler = (event: { sender: object }, request: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const invoke = async <T = unknown>(channel: string, request?: unknown, caller: object = sender): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return await handler({ sender: caller }, request) as T;
  };

  const store = new AutomationStore(path.join(root, 'automations.v1.json'));
  const subscribe = vi.spyOn(AutomationStore.prototype, 'subscribe');
  const listConfirmations = vi.spyOn(AutomationConfirmations.prototype, 'list');
  vi.spyOn(AutomationRuntime.prototype, 'check').mockResolvedValue({ available: true });
  const execute = vi.spyOn(AutomationRuntime.prototype, 'execute').mockResolvedValue({ state: 'succeeded' });
  let dispose: (() => Promise<void>) | undefined;
  try {
    const { target, ...task } = automationInputSchema.parse({
      name: 'Fixture task', instructions: 'Process fixture data.',
      target: { partnerId: 'fixture-partner', conversationId: 'fixture-conversation', sourceMode: 'local_cli', nativeThreadId: 'fixture-thread', bindingGeneration: 1 },
      schedule: { type: 'daily', time: '10:00' }, timezone: 'UTC', enabled: false,
    });
    const definition = await store.create({ target, ...task }, 'fixture-create');
    const interrupted = await store.queueManual(definition.id, 'fixture-interrupted');
    await store.transition(interrupted.id, ['queued'], { state: 'running' });

    dispose = registerAgentIpc(ipcMain, () => window, { notifications, environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: true, mcpPort: 0,
    } });
    expect([...handlers.keys()].filter(channel => channel.startsWith('asterium:automations:')).sort())
      .toEqual(Object.values(channels).sort());
    for (const channel of Object.values(channels)) {
      await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
    }
    await expect(invoke(channels.get)).resolves.toMatchObject({
      automations: [definition], runs: [{ id: interrupted.id, state: 'running' }],
    });
    markReady();
    await vi.waitFor(async () => {
      await expect(invoke(channels.get)).resolves.toMatchObject({
        runtimeReady: true, runs: [{ id: interrupted.id, state: 'uncertain', reason: 'interrupted' }],
      });
    }, { timeout: 3000 });
    expect(execute).not.toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith(changed);

    await expect(invoke(channels.mutate, null)).rejects.toMatchObject({ name: 'ZodError' });
    await expect(invoke(channels.mutate, { action: 'resolve', runId: interrupted.id, outcome: 'cancelled' }))
      .resolves.toMatchObject({ runs: [{ id: interrupted.id, state: 'cancelled', reason: 'user_resolved' }] });
    sender.send.mockClear();
    await invoke(channels.mutate, { action: 'run_now', id: definition.id, requestId: 'fixture-run' });
    await vi.waitFor(() => {
      expect(show).toHaveBeenCalledWith(expect.objectContaining({ body: '自动化“Fixture task”已完成。' }), expect.any(Function));
    }, { timeout: 3000 });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ automationId: definition.id, state: 'running', trigger: 'manual' }), expect.any(AbortSignal),
    );
    expect(sender.send).toHaveBeenCalledWith(changed);

    await expect(invoke(channels.confirmations)).resolves.toEqual([]);
    const broker = listConfirmations.mock.contexts[0] as AutomationConfirmations;
    const proposal = { action: 'create', partnerName: 'Fixture partner', targetLabel: 'Fixture conversation', task } satisfies Omit<AutomationConfirmation, 'id'>;
    const decision = broker.request(proposal);
    const pending = await invoke<AutomationConfirmation[]>(channels.confirmations);
    expect(pending).toEqual([{ ...proposal, id: expect.any(String) }]);
    expect(sender.send).toHaveBeenCalledWith(confirmationsChanged);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ body: '自动化设置正在等待你的审批。' }), expect.any(Function));
    const reply = { id: pending[0].id, approved: true };
    await expect(invoke(channels.resolve, { ...reply, approved: 'true' })).rejects.toMatchObject({ name: 'ZodError' });
    sender.send.mockClear();
    await expect(invoke(channels.resolve, reply)).resolves.toBeUndefined();
    await expect(decision).resolves.toBe(true);
    await expect(invoke(channels.confirmations)).resolves.toEqual([]);
    await expect(invoke(channels.resolve, reply)).rejects.toThrow('AUTOMATION_CONFIRMATION_EXPIRED');
    expect(sender.send.mock.calls).toContainEqual([confirmationsChanged]);

    const pendingAtExit = broker.request(proposal);
    execute.mockImplementationOnce(async (_run, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ state: 'cancelled' }), { once: true });
    }));
    await invoke(channels.mutate, { action: 'run_now', id: definition.id, requestId: 'fixture-exit-run' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2), { timeout: 3000 });
    const [activeRun, signal] = execute.mock.calls[1];

    await dispose();
    dispose = undefined;
    await expect(pendingAtExit).resolves.toBe(false);
    expect(signal.aborted).toBe(true);
    expect((await store.snapshot()).runs.find(run => run.id === activeRun.id))
      .toMatchObject({ state: 'uncertain', reason: 'application_closed' });
    expect(handlers.size).toBe(0);

    const liveStore = subscribe.mock.contexts[0] as AutomationStore;
    sender.send.mockClear();
    await liveStore.create({ target, ...task }, 'fixture-after-exit');
    expect(sender.send).not.toHaveBeenCalledWith(changed);
  } finally {
    try {
      markReady();
      await dispose?.();
    } finally {
      vi.restoreAllMocks();
      await testRm(root, { recursive: true, force: true });
    }
  }
});
