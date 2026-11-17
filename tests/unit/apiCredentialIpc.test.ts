// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { ApiConnectionStore } from '../../src/main/api/ApiConnectionStore';
import { CredentialStore } from '../../src/main/security/CredentialStore';
import type { CredentialStatus } from '../../src/shared/contracts/connections';
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

it('reuses stored API credentials and protects both service and custom header references', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-api-credential-ipc-'));
  electron.root = root;
  const credentials = new CredentialStore(path.join(root, 'secure-credentials.v1.json'), electron.safeStorage);
  const connections = new ApiConnectionStore(path.join(root, 'api-connections.v1.json'));
  const serviceRef = 'fixture-service-ref';
  const headerRef = 'fixture-header-ref';
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
  const save = 'asterium:agent:save-api-credential';
  const status = 'asterium:agent:api-credential-status';
  const remove = 'asterium:agent:delete-api-credential';
  const invoke = async <T = unknown>(channel: string, value: unknown, caller: object = sender): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return await handler({ sender: caller }, value) as T;
  };

  try {
    await credentials.save('synthetic-service-value', serviceRef);
    await credentials.save('synthetic-header-value', headerRef);
    const configuration = await connections.mutate({
      action: 'service', expectedRevision: 0,
      value: {
        id: 'fixture-service', name: 'Fixture service', protocol: 'chat_completions',
        endpoint: 'https://example.invalid/v1', credentialRef: serviceRef,
        settings: { auth: 'bearer', headers: [{ name: 'X-Fixture-Header', credentialRef: headerRef }] },
      },
    });
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      for (const channel of [save, status, remove]) {
        await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
        await expect(invoke(channel, null)).rejects.toThrow('INVALID_CREDENTIAL_REQUEST');
      }
      for (const credentialRef of [serviceRef, headerRef]) {
        await expect(invoke(status, { credentialRef })).resolves.toEqual({ credentialRef, configured: true, masked: '••••••••' });
        await expect(invoke(remove, { credentialRef })).rejects.toThrow('API_CREDENTIAL_IN_USE');
      }
      await expect(credentials.get(serviceRef)).resolves.toBe('synthetic-service-value');
      await expect(credentials.get(headerRef)).resolves.toBe('synthetic-header-value');

      await expect(invoke(save, { credentialRef: serviceRef, secret: 'synthetic-rotated-value' })).resolves
        .toEqual({ credentialRef: serviceRef, configured: true, masked: '••••••••' });
      await expect(credentials.get(serviceRef)).resolves.toBe('synthetic-rotated-value');
      await expect(connections.snapshot()).resolves.toEqual(configuration);

      const created = await invoke<CredentialStatus>(save, { secret: 'synthetic-unused-value' });
      expect(created).toEqual({ credentialRef: expect.stringMatching(/^credential-/), configured: true, masked: '••••••••' });
      await expect(credentials.get(created.credentialRef)).resolves.toBe('synthetic-unused-value');
      await expect(invoke(remove, { credentialRef: created.credentialRef })).resolves.toBeUndefined();
      await expect(invoke(status, { credentialRef: created.credentialRef })).resolves
        .toEqual({ credentialRef: created.credentialRef, configured: false, masked: '' });
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
});
