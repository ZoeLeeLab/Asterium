// @vitest-environment node
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { MemoryFallbackSettingsStore } from '../../src/main/memory/fallback/MemoryFallbackSettingsStore';
import { CredentialStore } from '../../src/main/security/CredentialStore';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({
  userData: '',
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.userData,
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

const channel = 'asterium:memory-fallback:list-models';
const models = [{ id: 'fixture-model', ownedBy: 'fixture-owner' }];

async function withFallbackModels(run: (fixture: {
  invoke: (value: unknown, caller?: object) => Promise<unknown>;
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  settings: MemoryFallbackSettingsStore;
  settingsPath: string;
  credentialsPath: string;
}) => Promise<void>) {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-fallback-model-list-ipc-'));
  electron.userData = root;
  const settingsPath = path.join(root, 'memory-fallback-settings.v1.json');
  const credentialsPath = path.join(root, 'secure-credentials.v1.json');
  const credentials = new CredentialStore(credentialsPath, electron.safeStorage);
  const settings = new MemoryFallbackSettingsStore(settingsPath, credentials, () => false);
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (name: string, handler: Handler) => {
      if (handlers.has(name)) throw new Error(`Duplicate IPC channel: ${name}`);
      handlers.set(name, handler);
    },
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as IpcMain;
  const invoke = (value: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return handler({ sender: caller }, value);
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model', owned_by: 'fixture-owner' }] }));
  vi.stubGlobal('fetch', fetcher);

  try {
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await run({ invoke, fetcher, settings, settingsPath, credentialsPath });
    } finally {
      await dispose();
    }
    expect(handlers.has(channel)).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    await testRm(root, { recursive: true, force: true });
  }
}

it('only reuses the saved key for the configured service and keeps temporary keys out of storage', async () => {
  await withFallbackModels(async ({ invoke, fetcher, settings, settingsPath, credentialsPath }) => {
    const saved = { provider: 'openai', endpoint: 'https://saved.fixture.invalid/v1' };
    await settings.configure({ ...saved, model: 'fixture-model', intervalMinutes: 20, apiKey: 'synthetic-saved-value' });
    const snapshot = () => Promise.all([settingsPath, credentialsPath].map(async file => ({
      bytes: await readFile(file), mtime: (await stat(file, { bigint: true })).mtimeNs,
    })));
    const before = await snapshot();
    const differentEndpoint = { ...saved, endpoint: 'https://other.fixture.invalid/v1' };
    const differentProvider = { ...saved, provider: 'responses' };

    await expect(invoke(differentEndpoint)).rejects.toThrow('MEMORY_FALLBACK_NEW_CREDENTIAL_REQUIRED');
    await expect(invoke(differentProvider)).rejects.toThrow('MEMORY_FALLBACK_NEW_CREDENTIAL_REQUIRED');
    expect(fetcher).not.toHaveBeenCalled();

    await expect(invoke(saved)).resolves.toEqual(models);
    await expect(invoke({ ...saved, apiKey: '  synthetic-temporary-value  ' })).resolves.toEqual(models);
    await expect(invoke({ ...differentEndpoint, apiKey: 'synthetic-other-value' })).resolves.toEqual(models);
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.headers])).toEqual([
      ['https://saved.fixture.invalid/v1/models', { Authorization: 'Bearer synthetic-saved-value' }],
      ['https://saved.fixture.invalid/v1/models', { Authorization: 'Bearer synthetic-temporary-value' }],
      ['https://other.fixture.invalid/v1/models', { Authorization: 'Bearer synthetic-other-value' }],
    ]);
    expect(await snapshot()).toEqual(before);
  });
});

it('preserves caller and endpoint checks, default DeepSeek requests and provider errors', async () => {
  await withFallbackModels(async ({ invoke, fetcher, settingsPath, credentialsPath }) => {
    const request = { endpoint: 'https://api.deepseek.com/', apiKey: 'fixture-ds-key' };
    await expect(invoke(request, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke({ ...request, provider: 'unsupported' })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(invoke({ ...request, endpoint: 'https://other.fixture.invalid' })).rejects.toThrow('INVALID_DEEPSEEK_ENDPOINT');
    await expect(invoke({ endpoint: request.endpoint })).rejects.toThrow('MEMORY_FALLBACK_CREDENTIAL_REQUIRED');
    expect(fetcher).not.toHaveBeenCalled();

    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(invoke(request)).rejects.toThrow('DEEPSEEK_AUTH_FAILED');
    await expect(invoke(request)).resolves.toEqual(models);
    expect(fetcher.mock.calls).toEqual(Array.from({ length: 2 }, () => [
      'https://api.deepseek.com/models', { method: 'GET', headers: { Authorization: 'Bearer fixture-ds-key' } },
    ]));
    await expect(stat(settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(credentialsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
