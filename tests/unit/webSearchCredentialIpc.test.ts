// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { CredentialStore } from '../../src/main/security/CredentialStore';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({
  root: '',
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`fixture:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').slice('fixture:'.length),
  },
}));

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
  safeStorage: electron.safeStorage,
  shell: {},
}));

it('reuses the stored Brave credential, trims its replacement, and deletes it independently through IPC', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-web-search-credential-ipc-'));
  electron.root = root;
  const store = new CredentialStore(path.join(root, 'secure-credentials.v1.json'), electron.safeStorage);
  const braveRef = 'asterium-web-search-brave';
  const providerRef = 'fixture-provider-ref';
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
  const save = 'asterium:agent:save-web-search-credential';
  const status = 'asterium:agent:web-search-credential-status';
  const remove = 'asterium:agent:delete-web-search-credential';
  const invoke = async (channel: string, value?: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return handler({ sender: caller }, value);
  };

  try {
    await store.save('synthetic-brave-original', braveRef);
    await store.save('synthetic-provider-value', providerRef);
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      const configured = { configured: true, masked: '••••••••' };
      const replacement = { secret: ' \tsynthetic-brave-replacement\n ', credentialRef: providerRef };
      await expect(invoke(save, replacement, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(status, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(remove, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(status)).resolves.toEqual(configured);
      await expect(invoke(save, { secret: ' \t ' })).rejects.toThrow('INVALID_WEB_SEARCH_CREDENTIAL_REQUEST');
      await expect(store.get(braveRef)).resolves.toBe('synthetic-brave-original');

      await expect(invoke(save, replacement)).resolves.toEqual(configured);
      await expect(store.get(braveRef)).resolves.toBe('synthetic-brave-replacement');
      await expect(invoke(status)).resolves.toEqual(configured);
      await expect(invoke(remove, { credentialRef: providerRef })).resolves.toBeUndefined();
      await expect(invoke(status)).resolves.toEqual({ configured: false, masked: '' });
      await expect(store.get(braveRef)).resolves.toBeUndefined();
      await expect(store.get(providerRef)).resolves.toBe('synthetic-provider-value');
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
});
