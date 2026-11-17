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
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
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

const channel = 'asterium:agent:list-api-models';
const catalog = [{ id: 'fixture-model', ownedBy: 'fixture-owner' }];
const service = {
  id: 'fixture-service', name: 'Fixture service', protocol: 'anthropic_messages',
  endpoint: 'https://saved.fixture.invalid/v1', credentialRef: 'fixture-provider-ref',
  settings: {
    auth: 'custom', authHeader: 'X-Fixture-Auth',
    modelsPath: '/custom/catalog', headerTimeoutMs: 1_500,
    headers: [{ name: 'X-Fixture-Header', credentialRef: 'fixture-header-ref' }],
  },
} satisfies Extract<ApiConfigurationMutation, { action: 'service' }>['value'];
const temporary = { provider: 'gemini', endpoint: 'https://temporary.fixture.invalid/v1beta' };
const saved = { ...temporary, serviceId: service.id };

async function withModelList(run: (fixture: {
  invoke: (value: unknown, caller?: object) => Promise<unknown>;
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  credentials: CredentialStore;
  connections: ApiConnectionStore;
}) => Promise<void>) {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-api-model-list-ipc-'));
  electron.root = root;
  const credentials = new CredentialStore(path.join(root, 'secure-credentials.v1.json'), electron.safeStorage);
  const connections = new ApiConnectionStore(path.join(root, 'api-connections.v1.json'));
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, request: unknown) => Promise<unknown>;
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
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
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
      await run({ invoke, fetcher, credentials, connections });
    } finally {
      await dispose();
    }
    expect(handlers.has(channel)).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    await testRm(root, { recursive: true, force: true });
  }
}

it('uses the saved service protocol, custom models path and headers, with a temporary key override', async () => {
  await withModelList(async ({ invoke, fetcher, credentials, connections }) => {
    const config = await connections.mutate({ action: 'service', expectedRevision: 0, value: service });
    await credentials.save('synthetic-stored-value', service.credentialRef);
    await credentials.save('synthetic-header-value', service.settings.headers[0].credentialRef);

    await expect(invoke(saved)).resolves.toEqual(catalog);
    await expect(invoke({ ...saved, secret: 'synthetic-override-value' })).resolves.toEqual(catalog);
    await expect(invoke({ ...saved, secret: '' })).resolves.toEqual(catalog);
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.headers, init?.redirect])).toEqual(
      ['synthetic-stored-value', 'synthetic-override-value', 'synthetic-stored-value'].map(key => [
        'https://saved.fixture.invalid/custom/catalog',
        {
          'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
          'X-Fixture-Auth': key, 'X-Fixture-Header': 'synthetic-header-value',
        },
        'error',
      ]),
    );
    await expect(credentials.get(service.credentialRef)).resolves.toBe('synthetic-stored-value');
    await expect(connections.snapshot()).resolves.toEqual(config);
  });
});

it('uses the temporary endpoint and provider headers and prefers its temporary key over a credential reference', async () => {
  await withModelList(async ({ invoke, fetcher, credentials }) => {
    const credentialRef = await credentials.save('synthetic-reference-value', 'fixture-temporary-ref');
    const request = { ...temporary, credentialRef };
    const response = () => Response.json({ models: [{ name: 'models/fixture-model' }] });
    fetcher.mockResolvedValueOnce(response()).mockResolvedValueOnce(response());

    await expect(invoke(request)).resolves.toEqual([{ id: 'models/fixture-model' }]);
    await expect(invoke({ ...request, secret: 'synthetic-override-value' })).resolves.toEqual([{ id: 'models/fixture-model' }]);
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.headers])).toEqual(
      ['synthetic-reference-value', 'synthetic-override-value'].map(key => [
        'https://temporary.fixture.invalid/v1beta/models',
        { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      ]),
    );
  });
});

it('preserves sender, request, configuration and provider errors', async () => {
  await withModelList(async ({ invoke, fetcher, connections }) => {
    await expect(invoke(saved, {})).rejects.toThrow('INVALID_IPC_SENDER');
    for (const invalid of [null, { ...saved, provider: 'unsupported' }, { ...saved, endpoint: null },
      { ...saved, credentialRef: true }, { ...saved, secret: true }]) {
      await expect(invoke(invalid)).rejects.toThrow('INVALID_API_MODEL_LIST_REQUEST');
    }
    await expect(invoke(saved)).rejects.toThrow('API_SERVICE_NOT_FOUND');
    await connections.mutate({ action: 'service', expectedRevision: 0, value: service });
    await expect(invoke(saved)).rejects.toThrow('API_CREDENTIAL_REQUIRED');
    await expect(invoke(temporary)).rejects.toThrow('API_CREDENTIAL_REQUIRED');
    await expect(invoke({ ...saved, secret: 'synthetic-override-value' })).rejects.toThrow('API_HEADER_CREDENTIAL_REQUIRED');
    await expect(invoke({ ...temporary, endpoint: 'ftp://fixture.invalid' })).rejects.toThrow('API_INVALID_ENDPOINT');
    expect(fetcher).not.toHaveBeenCalled();

    const request = { ...temporary, secret: 'synthetic-temporary-value' };
    fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(invoke(request)).rejects.toMatchObject({ message: 'API_HTTP_403', status: 403 });
    fetcher.mockResolvedValueOnce(Response.json({ error: 'fixture invalid catalog' }));
    await expect(invoke(request)).rejects.toThrow('API_MODELS_INVALID');
    const offline = new Error('Fixture transport failure');
    fetcher.mockRejectedValueOnce(offline);
    await expect(invoke(request)).rejects.toBe(offline);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

it('uses the configured header timeout for saved services and the default for temporary endpoints', async () => {
  await withModelList(async ({ invoke, fetcher, credentials, connections }) => {
    await connections.mutate({ action: 'service', expectedRevision: 0, value: service });
    await credentials.save('synthetic-header-value', service.settings.headers[0].credentialRef);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const [request, timeout] of [[saved, 1_500], [temporary, 120_000]] as const) {
        let onRequest!: (signal: AbortSignal) => void;
        const started = new Promise<AbortSignal>(resolve => { onRequest = resolve; });
        fetcher.mockImplementationOnce((_url, init) => {
          onRequest(init?.signal as AbortSignal);
          return new Promise<Response>(() => {});
        });
        const failure = expect(invoke({ ...request, secret: 'synthetic-temporary-value' })).rejects.toThrow('API_HEADER_TIMEOUT');
        const signal = await started;
        await vi.advanceTimersByTimeAsync(timeout - 1);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal.aborted).toBe(true);
        await failure;
      }
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
