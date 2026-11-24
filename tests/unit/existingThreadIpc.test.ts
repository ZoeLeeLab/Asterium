// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { CyberBossBridgeClient } from '../../src/main/adapters/CyberBossBridgeClient';
import { DESKTOP_IPC, DESKTOP_INVOKE_CHANNELS } from '../../src/shared/desktopIpc';
import { AGENT_PROTOCOL_VERSION } from '../../src/shared/agentProtocol';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, safeStorage: { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (bytes: Buffer) => bytes.toString() }, shell: {},
}));

const { saveBridgeCredential, bridgeCredentialStatus, deleteBridgeCredential, testExistingThread, watchExistingThread,
  stopExistingThreadWatch, getExistingThreadFileCapabilities, sendExistingThreadMessage } = DESKTOP_IPC;
const channels = [saveBridgeCredential, bridgeCredentialStatus, deleteBridgeCredential, testExistingThread,
  watchExistingThread, stopExistingThreadWatch, getExistingThreadFileCapabilities, sendExistingThreadMessage];
const connection = { serviceUrl: 'https://fixture.example.invalid', threadId: 'fixture-thread', credentialRef: 'fixture-ref' };

async function withBridge(run: (fixture: {
  invoke: (channel: string, value?: unknown, caller?: object) => Promise<unknown>;
  registered: string[];
  close: () => Promise<void>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-bridge-ipc-'));
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

it('retains the bridge registration order and rejects other windows before examining any request', async () => {
  await withBridge(async ({ invoke, registered }) => {
    const start = registered.indexOf(saveBridgeCredential);
    expect(registered.slice(start - 1, start + 9)).toEqual([DESKTOP_IPC.listApiModels, ...channels, DESKTOP_IPC.sendMessage]);
    for (const channel of channels) await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
  });
});

it('rejects malformed envelopes and distinguishes missing credentials from an invalid thread', async () => {
  await withBridge(async ({ invoke }) => {
    const errors = ['INVALID_CREDENTIAL_REQUEST', 'INVALID_CREDENTIAL_REQUEST', 'INVALID_CREDENTIAL_REQUEST',
      'INVALID_EXISTING_THREAD_CONNECTION', 'INVALID_EXISTING_THREAD_WATCH_REQUEST', 'INVALID_EXISTING_THREAD_WATCH_REQUEST',
      'INVALID_EXISTING_THREAD_CONNECTION', 'INVALID_EXISTING_THREAD_SEND_REQUEST'];
    for (const [i, channel] of channels.entries()) await expect(invoke(channel, null)).rejects.toThrow(errors[i]);
    await expect(invoke(testExistingThread, { ...connection, threadId: '' })).rejects.toThrow('CYBERBOSS_CREDENTIAL_REQUIRED');
    await expect(invoke(getExistingThreadFileCapabilities, { ...connection, threadId: '' })).rejects.toThrow('INVALID_CYBERBOSS_THREAD_ID');
    await expect(invoke(watchExistingThread, { partnerId: 'fixture', connection })).rejects.toThrow('CYBERBOSS_CREDENTIAL_REQUIRED');
    await expect(invoke(sendExistingThreadMessage, { connection, command: { protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'message.send', commandId: 'fixture-command', clientMessageId: 'fixture-client', partnerId: 'fixture', conversationId: 'fixture-chat',
      connectionSource: 'local_cli', content: { type: 'text', text: 'fixture' } } })).rejects.toThrow('INVALID_EXISTING_THREAD_SEND_COMMAND');
  });
});

it('uses the same saved reference for status, test, capabilities and watch, and deletes only the requested credential', async () => {
  await withBridge(async ({ invoke }) => {
    const saved = await invoke(saveBridgeCredential, { secret: 'fixture-secret' }) as { credentialRef: string };
    const other = await invoke(saveBridgeCredential, { secret: 'fixture-other' }) as { credentialRef: string };
    const reference = { credentialRef: saved.credentialRef };
    const target = { ...connection, ...reference };
    expect(saved).toEqual({ ...reference, configured: true, masked: '••••••••' });
    expect(await invoke(bridgeCredentialStatus, reference)).toEqual(saved);
    const session = vi.spyOn(CyberBossBridgeClient.prototype, 'checkSession').mockResolvedValue({ threadId: target.threadId });
    const caps = vi.spyOn(CyberBossBridgeClient.prototype, 'chatFileCapabilities').mockResolvedValue(undefined);
    const status = await invoke(testExistingThread, { ...target, threadId: '' });
    expect(status).toMatchObject({ ...saved, authenticated: true, threadId: target.threadId });
    await expect(invoke(getExistingThreadFileCapabilities, target)).resolves.toBeUndefined();
    expect(caps).toHaveBeenCalledTimes(1);
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const events = vi.spyOn(CyberBossBridgeClient.prototype, 'events').mockImplementation(async function* (signal) {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      finish();
      yield* [];
    });
    const watch = { partnerId: 'fixture', connection: target };
    await expect(Promise.all([invoke(watchExistingThread, watch), invoke(watchExistingThread, watch)])).resolves.toEqual([status, status]);
    expect(session).toHaveBeenCalledTimes(2);
    expect(events).toHaveBeenCalledTimes(1);
    await invoke(stopExistingThreadWatch, watch);
    await done;
    await invoke(deleteBridgeCredential, reference);
    expect(await invoke(bridgeCredentialStatus, reference)).toEqual({ ...reference, configured: false, masked: '' });
    expect(await invoke(bridgeCredentialStatus, other)).toEqual(other);
  });
});
