// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { ApiConnectionStore } from '../../src/main/api/ApiConnectionStore';
import { CredentialStore } from '../../src/main/security/CredentialStore';
import type { ApiConfigurationMutation } from '../../src/shared/apiConnections';
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

it('reads stored API configuration and checks credential references and revision before saving', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-api-connections-ipc-'));
  electron.root = root;
  const credentials = new CredentialStore(path.join(root, 'secure-credentials.v1.json'), electron.safeStorage);
  const connections = new ApiConnectionStore(path.join(root, 'api-connections.v1.json'));
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, request: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const get = 'asterium:api-connections:get';
  const mutate = 'asterium:api-connections:mutate';
  const invoke = async (channel: string, request?: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return handler({ sender: caller }, request);
  };

  try {
    const serviceRef = 'fixture-service-ref';
    const headerRef = 'fixture-header-ref';
    const initial = await connections.mutate({
      action: 'service', expectedRevision: 0,
      value: {
        id: 'fixture-service', name: 'Fixture service', protocol: 'chat_completions',
        endpoint: 'https://example.invalid/v1', credentialRef: serviceRef, settings: { auth: 'none' },
      },
    });
    const request = {
      action: 'service', expectedRevision: initial.revision,
      value: {
        ...initial.services[0], name: 'Updated fixture service',
        settings: { auth: 'bearer', headers: [{ name: 'X-Fixture-Header', credentialRef: headerRef }] },
      },
    } satisfies ApiConfigurationMutation;
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await expect(invoke(get, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(mutate, request, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(mutate, null)).rejects.toMatchObject({ name: 'ZodError' });
      await expect(invoke(get)).resolves.toEqual(initial);
      await expect(invoke(mutate, request)).rejects.toThrow('API_CREDENTIAL_REQUIRED');
      await credentials.save('synthetic-service-value', serviceRef);
      await expect(invoke(mutate, request)).rejects.toThrow('API_HEADER_CREDENTIAL_REQUIRED');
      await credentials.save('synthetic-header-value', headerRef);
      await expect(invoke(mutate, { ...request, expectedRevision: 0 })).rejects.toThrow('API_CONFIGURATION_CHANGED');
      await expect(invoke(get)).resolves.toEqual(initial);

      const updated = { ...initial, revision: initial.revision + 1, services: [request.value] };
      await expect(invoke(mutate, request)).resolves.toEqual(updated);
      await expect(invoke(get)).resolves.toEqual(updated);
      await expect(connections.snapshot()).resolves.toEqual(updated);
    } finally {
      await dispose();
    }
    expect(handlers.has(get)).toBe(false);
    expect(handlers.has(mutate)).toBe(false);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
});
