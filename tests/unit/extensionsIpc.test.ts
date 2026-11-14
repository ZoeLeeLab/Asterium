// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { ApiExtensionStore } from '../../src/main/api/ApiExtensionStore';
import { API_EXTENSION_CREDENTIAL_PREFIX, CredentialStore } from '../../src/main/security/CredentialStore';
import type { ApiExtensionsSnapshot, McpConnectionStatus } from '../../src/shared/apiExtensions';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({
  root: '',
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`fixture:${value}`),
    decryptString: (value: Buffer) => value.toString().slice('fixture:'.length),
  },
}));
vi.mock('electron', () => ({
  app: { getPath: () => electron.root, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: electron.safeStorage,
  shell: {},
}));

const channels = {
  get: 'asterium:extensions:get',
  upsert: 'asterium:extensions:upsert',
  remove: 'asterium:extensions:remove',
  binding: 'asterium:extensions:set-binding',
  trust: 'asterium:extensions:set-trust',
  connect: 'asterium:extensions:connect-mcp',
  disconnect: 'asterium:extensions:disconnect-mcp',
  status: 'asterium:extensions:mcp-status',
};
const authorization = 'Bearer fixture-mcp-value';

async function startMcpFixture() {
  const initialized = vi.fn();
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== authorization) { response.writeHead(401).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    if (message.method === 'initialize') initialized();
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'extensions-fixture', version: '1' } }
      : { tools: [{ name: 'inspect_fixture', inputSchema: { type: 'object' } }] };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    initialized,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

type RegisterAgentIpc = typeof import('../../src/main/agentIpc').registerAgentIpc;
function startMain(registerAgentIpc: RegisterAgentIpc) {
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: typeof sender }, value: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
    profile: 'autotest', label: 'Fixture', userDataDirectory: electron.root,
    projectsDirectory: path.join(electron.root, 'projects'), temporaryDirectory: electron.root,
    appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
    restoreBackgroundServices: false, mcpPort: 0,
  } });
  return {
    handlers,
    invoke: async <T = unknown>(channel: string, value?: unknown, caller = sender): Promise<T> => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
      return await handler({ sender: caller }, value) as T;
    },
    async close() { await dispose(); expect(handlers.size).toBe(0); },
  };
}

it('keeps all eight extension channels and reconnects to MCP using the saved profile', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  electron.root = await mkdtemp(path.join(os.tmpdir(), 'asterium-extensions-ipc-'));
  const mcp = await startMcpFixture();
  let main: ReturnType<typeof startMain> | undefined;
  try {
    main = startMain(registerAgentIpc);
    expect([...main.handlers.keys()].filter((channel) => channel.startsWith('asterium:extensions:')).sort())
      .toEqual(Object.values(channels).sort());
    const foreignSender = { send: vi.fn() };
    for (const channel of Object.values(channels)) {
      await expect(main.invoke(channel, null, foreignSender)).rejects.toThrow('INVALID_IPC_SENDER');
    }
    for (const channel of [channels.upsert, channels.remove, channels.binding, channels.trust, channels.connect, channels.disconnect]) {
      await expect(main.invoke(channel, null)).rejects.toMatchObject({ name: 'ZodError' });
    }
    expect(mcp.initialized).toHaveBeenCalledTimes(0);
    await expect(main.invoke(channels.get)).resolves.toEqual({ version: 0, extensions: [], bindings: [] });
    await expect(main.invoke(channels.status)).resolves.toEqual([]);

    const partnerId = 'fixture-api-partner';
    await main.invoke(DESKTOP_IPC.savePartnerProfile, {
      partnerId, sourceMode: 'api_partner',
      publicIdentity: { displayName: partnerId, introduction: 'Synthetic profile', expertise: 'test', mentionName: partnerId },
      management: { userProfile: false, personality: false, memoryMode: 'none' },
      connectionSettings: { __studioRuntime: { persist: true, available: true, runtime: {
        kind: 'api', connection: { provider: 'deepseek', endpoint: 'https://example.invalid', model: 'fixture', credentialRef: 'fixture-unused' },
      } } },
    });
    const configuration = { type: 'mcp_http', url: mcp.url };
    const created = await main.invoke<ApiExtensionsSnapshot>(channels.upsert, {
      expectedVersion: 0, name: 'Fixture MCP', enabled: true, configuration, secrets: { Authorization: authorization },
    });
    const { id } = created.extensions[0];
    expect(created.extensions[0]).toMatchObject({ configuration, hasSecrets: true, secretNames: ['Authorization'], trust: 'untrusted' });
    expect(JSON.stringify(created)).not.toContain(authorization);
    expect(created.extensions[0]).not.toHaveProperty('credentialRef');
    const binding = { partnerId, extensionIds: [id] };
    const bound = await main.invoke<ApiExtensionsSnapshot>(channels.binding, { expectedVersion: created.version, ...binding });
    expect(bound.bindings).toEqual([binding]);
    const pending = await main.invoke<ApiExtensionsSnapshot>(channels.trust, { expectedVersion: bound.version, id, action: 'request' });
    expect(pending.extensions[0].trust).toBe('pending');
    const connected = await main.invoke<McpConnectionStatus>(channels.connect, { id, expectedGeneration: pending.extensions[0].generation });
    expect(connected).toMatchObject({ extensionId: id, state: 'ready', toolCount: 1 });
    await expect(main.invoke(channels.status)).resolves.toEqual([connected]);
    await expect(main.invoke(channels.disconnect, { id })).resolves.toBeUndefined();
    await expect(main.invoke(channels.status)).resolves.toEqual([expect.objectContaining({ extensionId: id, state: 'closed' })]);
    await main.close();
    main = undefined;

    // Established trust is granted by Main during approval, never by an extension management channel.
    const extensionFile = path.join(electron.root, 'api-extensions.v1.json');
    const credentialFile = path.join(electron.root, 'secure-credentials.v1.json');
    const vault = new CredentialStore(credentialFile, electron.safeStorage);
    const store = new ApiExtensionStore(extensionFile, vault.forNamespace(API_EXTENSION_CREDENTIAL_PREFIX), (id) => id === partnerId);
    const policy = { permissionMode: 'manual', planMode: 'default' } as const;
    const approval = await store.prepareTrustApproval(id, policy, partnerId);
    const saved = await store.confirmTrustApproval(approval, policy, partnerId);
    expect(saved.extensions[0].trust).toBe('trusted');
    const savedFiles = await Promise.all([readFile(extensionFile), readFile(credentialFile)]);

    main = startMain(registerAgentIpc);
    await expect(main.invoke(channels.get)).resolves.toEqual(saved);
    await expect(main.invoke(channels.status)).resolves.toEqual([]);
    const reconnected = await main.invoke<McpConnectionStatus>(channels.connect, { id, expectedGeneration: saved.extensions[0].generation });
    expect(reconnected).toMatchObject({ extensionId: id, state: 'ready', toolCount: 1 });
    expect(mcp.initialized).toHaveBeenCalledTimes(2);
    await expect(main.invoke(channels.get)).resolves.toEqual(saved);
    expect(await Promise.all([readFile(extensionFile), readFile(credentialFile)])).toEqual(savedFiles);

    const revoked = await main.invoke<ApiExtensionsSnapshot>(channels.trust, { expectedVersion: saved.version, id, action: 'revoke' });
    expect(revoked.extensions[0].trust).toBe('untrusted');
    await expect(main.invoke(channels.remove, { expectedVersion: saved.version, id })).rejects.toThrow('API_EXTENSIONS_VERSION_CONFLICT');
    await expect(main.invoke(channels.remove, { expectedVersion: revoked.version, id })).resolves.toMatchObject({ extensions: [], bindings: [] });
    expect(JSON.parse(await readFile(credentialFile, 'utf8')).credentials).toEqual({});
  } finally {
    try { await main?.close(); }
    finally {
      await mcp.close();
      await testRm(electron.root, { recursive: true, force: true });
    }
  }
});
