// @vitest-environment node
import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiExtensionStore } from '../../src/main/api/ApiExtensionStore';
import { McpConnectionManager, type McpConnectionScope } from '../../src/main/api/extensions/McpConnectionManager';
import { NativeExtensionLaunchBackend, type ExtensionLaunchBackend } from '../../src/main/api/extensions/ExtensionLaunchBackend';
import { API_EXTENSION_CREDENTIAL_PREFIX, CredentialStore } from '../../src/main/security/CredentialStore';
import type { ExtensionUpsertRequest } from '../../src/shared/apiExtensions';

const directories: string[] = []; const managers: McpConnectionManager[] = []; const servers: Server[] = [];
const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'api-mcp-server.mjs');
const tool = (name: string) => ({ name, description: 'Local fixture', inputSchema: { type: 'object' as const, properties: {} } });
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  delete process.env.ASTERIUM_PRIVATE_CANARY;
  const temp = (await realpath(os.tmpdir())).toLowerCase();
  for (const dir of directories.splice(0)) {
    const resolved = await realpath(dir); expect(path.dirname(resolved).toLowerCase()).toBe(temp);
    expect(path.basename(resolved).startsWith('asterium-s3-unit-')).toBe(true);
    await rm(resolved, { recursive: true, force: true, maxRetries: 5 });
  }
});
async function setup(mode = 'normal', backend: ExtensionLaunchBackend = new NativeExtensionLaunchBackend(), timeout = 4_000) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-s3-unit-')); directories.push(dir);
  const log = path.join(dir, 'lifecycle.jsonl'); const control = path.join(dir, 'catalog.json');
  await writeFile(control, JSON.stringify({ tools: [tool('inspect'), tool('second')] }));
  const credentials = new CredentialStore(path.join(dir, 'credentials.json'), { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() });
  const eligible = vi.fn((id: string) => id === 'api-one');
  const store = new ApiExtensionStore(path.join(dir, 'extensions.json'), credentials.forNamespace(API_EXTENSION_CREDENTIAL_PREFIX), eligible);
  const manager = new McpConnectionManager(store, backend, timeout, async configuration => ({ cwd: configuration.cwd ?? dir, workspaceFolders: [dir] })); managers.push(manager);
  let state = await store.upsert({ expectedVersion: 0, name: 'Fixture', enabled: true, configuration: { type: 'mcp_stdio', command: process.execPath, args: [fixture, log, control, mode], cwd: dir }, secrets: { FIXTURE_TOKEN: 'fixture-test-token' } });
  const id = state.extensions[0].id;
  const connect = async () => manager.connectManagement({ id, expectedGeneration: (await store.get()).extensions[0].generation });
  const update = async (overrides: Partial<ExtensionUpsertRequest>) => {
    state = await store.get(); const entry = state.extensions[0];
    return store.upsert({ expectedVersion: state.version, id, name: entry.name, enabled: entry.enabled, configuration: entry.configuration, ...overrides });
  };
  const events = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { dir, log, control, store, manager, id, connect, update, events, eligible, backend };
}
async function eventually(check: () => boolean | Promise<boolean>) {
  await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 6_000, interval: 30 });
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

describe('Main MCP connection lifecycle (real SDK and local transports)', () => {
  it('refuses an ungranted management cwd before secrets or transport creation', async () => {
    const s = await setup();
    const create = vi.spyOn(s.backend, 'createMcpTransport'), secrets = vi.spyOn(s.store, 'connectionSecrets');
    const manager = new McpConnectionManager(s.store, s.backend); managers.push(manager);
    await expect(manager.connectManagement({ id: s.id, expectedGeneration: (await s.store.get()).extensions[0].generation })).rejects.toThrow('MCP_AUTHORIZED_WORKSPACE_REQUIRED');
    expect(create).not.toHaveBeenCalled(); expect(secrets).not.toHaveBeenCalled(); expect(await s.events()).toEqual([]);
  });
  it('uses explicit user management context without partner authority and cannot call tools', async () => {
    const s = await setup(), create = vi.spyOn(s.backend, 'createMcpTransport');
    const partners = vi.spyOn(s.store, 'enabledForPartner'), bindings = vi.spyOn(s.store, 'bindingRevision');
    const status = await s.connect();
    expect(status.state).toBe('ready');
    expect(create.mock.calls[0][0].context).toEqual({ kind: 'user_management', purpose: 'mcp_probe', workspace: { cwd: s.dir, workspaceFolders: [s.dir] } });
    expect(partners).not.toHaveBeenCalled(); expect(bindings).not.toHaveBeenCalled();
    await expect(s.manager.invoke({ kind: 'management' }, s.id, status.generation, 'echo', {}, new AbortController().signal)).rejects.toThrow('MCP_NOT_READY');
    expect((await s.events()).filter(e => e.event === 'request').some(e => e.method === 'tools/call')).toBe(false);
    expect((await s.store.get()).extensions[0].trust).toBe('untrusted');
  });
  it('rejects old startup binding revisions and rechecks authority immediately before creating a transport', async () => {
    const s = await setup(), create = vi.spyOn(s.backend, 'createMcpTransport');
    let state = await s.store.get();
    state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [s.id] });
    const oldRevision = await s.store.bindingRevision('api-one', s.id);
    state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [] });
    state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [s.id] });
    const scope = { kind: 'runtime' as const, partnerId: 'api-one', conversationId: 'startup', contextKey: 'work' };
    await expect(s.manager.connect(scope, s.id, state.extensions[0].generation, undefined, oldRevision)).rejects.toThrow('MCP_BINDING_CHANGED');
    const dispatch = s.store.dispatchForPartner.bind(s.store);
    vi.spyOn(s.store, 'dispatchForPartner').mockImplementationOnce(async (...args) => {
      let latest = await s.store.get();
      latest = await s.store.setBinding({ expectedVersion: latest.version, partnerId: 'api-one', extensionIds: [] });
      await s.store.setBinding({ expectedVersion: latest.version, partnerId: 'api-one', extensionIds: [s.id] });
      return dispatch(...args);
    });
    await expect(s.manager.connect(scope, s.id, state.extensions[0].generation)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled(); expect(await s.events()).toEqual([]);
  });
  it('handshakes, discovers every page, records inventory without activating trust, and protects environment/logs', async () => {
    process.env.ASTERIUM_PRIVATE_CANARY = 'must-not-inherit';
    const s = await setup('paginate'); const status = await s.connect();
    expect(status).toMatchObject({ state: 'ready', toolCount: 2, backend: 'native', sandboxed: false });
    expect((await s.store.get()).extensions[0]).toMatchObject({ inventoryKnown: true, trust: 'untrusted' });
    const events = await s.events(); const start = events.find((event) => event.event === 'start');
    expect(start.cwd).toBe(s.dir); expect(start.inheritedCanary).toBe(false);
    expect(start.secretHash).toBe(createHash('sha256').update('fixture-test-token').digest('hex'));
    expect(events.filter((event) => event.event === 'request').map((event) => event.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
    expect(JSON.stringify(status)).not.toMatch(/fixture-test-token|fixture-stderr-private-token|credentialRef/);
    const catalog = await s.manager.catalog({ kind: 'management' }, s.id);
    catalog.tools[0].name = 'changed-local-copy';
    expect((await s.manager.catalog({ kind: 'management' }, s.id)).tools[0].name).toBe('inspect');
    await s.manager.disconnectManagement(s.id); await eventually(() => !alive(start.pid));
    expect(s.manager.managementStatus()[0].state).toBe('closed');
  });

  it('coalesces simultaneous connects and keeps display renames on the existing connection', async () => {
    const s = await setup(); const create = vi.spyOn(s.backend, 'createMcpTransport');
    await Promise.all([s.connect(), s.connect()]); expect(create).toHaveBeenCalledOnce();
    await s.update({ name: 'Only display changed' }); await s.connect(); expect(create).toHaveBeenCalledOnce();
    expect(s.manager.managementStatus()[0].state).toBe('ready');
  });

  it('separates management, partner conversations and working contexts, and refuses unbound partners', async () => {
    const s = await setup(); let state = await s.store.get();
    await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [s.id] });
    const scope = (conversationId: string, contextKey = 'project-a'): Extract<McpConnectionScope, { kind: 'runtime' }> => ({ kind: 'runtime', partnerId: 'api-one', conversationId, contextKey });
    await s.connect();
    for (const context of [scope('a'), scope('b'), scope('b', 'project-b')]) await s.manager.connect(context, s.id, (await s.store.get()).extensions[0].generation);
    expect((await s.events()).filter((event) => event.event === 'start')).toHaveLength(4);
    await expect(s.manager.connect({ ...scope('a'), kind: 'runtime', partnerId: 'unknown' }, s.id, 1)).rejects.toThrow('UNAVAILABLE');
    await s.manager.releaseScope({ contextKey: 'project-a', conversationId: 'b', partnerId: 'api-one', kind: 'runtime' });
    await expect(s.manager.catalog(scope('b'), s.id)).rejects.toThrow('NOT_READY');
    expect((await s.manager.catalog(scope('a'), s.id)).tools).toHaveLength(2);
    await s.manager.reconcilePartners();
    expect((await s.manager.catalog(scope('a'), s.id)).tools).toHaveLength(2);
    state = await s.store.get(); await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [] });
    await expect(s.manager.catalog(scope('a'), s.id)).rejects.toThrow('NOT_READY');
    expect(s.manager.managementStatus()[0].state).toBe('ready');
  });

  it('closes runtime connections when partner eligibility changes, without closing management probes', async () => {
    const s = await setup(); const state = await s.store.get();
    await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [s.id] });
    await s.connect(); const scope: McpConnectionScope = { kind: 'runtime', partnerId: 'api-one', conversationId: 'a', contextKey: 'work' };
    await s.manager.connect(scope, s.id, (await s.store.get()).extensions[0].generation);
    s.eligible.mockReturnValue(false); await s.manager.reconcilePartners('api-one');
    await expect(s.manager.catalog(scope, s.id)).rejects.toThrow('NOT_READY');
    expect(s.manager.managementStatus()[0].state).toBe('ready');
  });

  it('refreshes on real list_changed, invalidates old trust and cannot revive an outstanding approval', async () => {
    const s = await setup(); await s.connect(); const state = await s.store.get();
    await s.store.setTrust({ expectedVersion: state.version, id: s.id, action: 'request' });
    await s.connect();
    const token = await s.store.prepareTrustApproval(s.id, { permissionMode: 'manual', planMode: 'default' });
    await writeFile(s.control, JSON.stringify({ tools: [tool('changed')] }));
    await eventually(() => s.manager.managementStatus()[0].state === 'ready' && s.manager.managementStatus()[0].toolCount === 1);
    await expect(s.store.confirmTrustApproval(token, { permissionMode: 'manual', planMode: 'default' })).rejects.toThrow('EXPIRED');
    expect((await s.store.get()).extensions[0].trust).toBe('pending');
    expect((await s.manager.catalog({ kind: 'management' }, s.id)).tools[0].name).toBe('changed');
  });

  it.each(['disabled', 'deleted', 'secret', 'revoked'] as const)('closes old resources after extension is %s', async (change) => {
    const s = await setup(); await s.connect(); const pid = (await s.events())[0].pid;
    const state = await s.store.get();
    if (change === 'disabled') await s.update({ enabled: false });
    if (change === 'secret') await s.update({ secrets: { FIXTURE_TOKEN: 'rotated' } });
    if (change === 'deleted') await s.store.remove({ expectedVersion: state.version, id: s.id });
    if (change === 'revoked') await s.store.setTrust({ expectedVersion: state.version, id: s.id, action: 'revoke' });
    await eventually(() => !alive(pid));
    await expect(s.manager.catalog({ kind: 'management' }, s.id)).rejects.toThrow('NOT_READY');
  });

  it('does not accept a discovery result from before configuration change', async () => {
    const s = await setup('hang-list'); const pending = s.connect(); const outcome = pending.catch((error) => error.message);
    await eventually(async () => (await s.events()).some((event) => event.method === 'tools/list'));
    await s.update({ secrets: { FIXTURE_TOKEN: 'replacement' } });
    expect(await outcome).toBe('MCP_CONFIGURATION_CHANGED');
    expect((await s.store.get()).extensions[0].inventoryKnown).toBe(false);
  });

  it.each(['hang', 'hang-list'])('bounds %s and cleans up a hung server', async (mode) => {
    const s = await setup(mode, undefined, 250);
    await expect(s.connect()).rejects.toThrow('MCP_CONNECTION_TIMEOUT');
    const pid = (await s.events())[0]?.pid; if (pid) await eventually(() => !alive(pid));
    expect(s.manager.managementStatus()[0]).toMatchObject({ state: 'failed', errorCode: 'MCP_CONNECTION_TIMEOUT' });
  });

  it('cancels a pending connection and supports a later explicit retry', async () => {
    const s = await setup('hang'); const controller = new AbortController(); const state = await s.store.get();
    const pending = s.manager.connectManagement({ id: s.id, expectedGeneration: state.extensions[0].generation }, controller.signal).catch((error) => error.message);
    await eventually(async () => (await s.events()).some((event) => event.event === 'start'));
    controller.abort('private-cancellation-text'); expect(await pending).toBe('MCP_CONNECTION_CANCELLED');
    await s.update({ configuration: { type: 'mcp_stdio', command: process.execPath, args: [fixture, s.log, s.control], cwd: s.dir } });
    expect((await s.connect()).state).toBe('ready');
  });

  it('does not launch a replacement if cancelled while waiting for the old transport to close', async () => {
    const backend = new NativeExtensionLaunchBackend(); const create = backend.createMcpTransport.bind(backend);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const start = vi.spyOn(backend, 'createMcpTransport').mockImplementation((request) => {
      const transport = create(request); const close = transport.close.bind(transport);
      transport.close = async () => { await gate; await close(); }; return transport;
    });
    const s = await setup('normal', backend); await s.connect();
    const snapshot = await s.store.get();
    const closing = s.manager.disconnectManagement(s.id);
    const abort = new AbortController();
    vi.spyOn(s.store, 'get').mockResolvedValueOnce(snapshot);
    const pending = s.manager.connectManagement({ id: s.id, expectedGeneration: snapshot.extensions[0].generation }, abort.signal).catch((error) => error.message);
    // Drain resolve()'s microtasks so cancellation occurs inside the awaited old close, not before validation.
    await new Promise<void>((resolve) => setImmediate(resolve));
    abort.abort(); release(); await closing;
    expect(await pending).toBe('MCP_CONNECTION_CANCELLED'); expect(start).toHaveBeenCalledOnce();
  });

  it('bounds an unresponsive backend cleanup and reports cleanup failure without selecting another backend', async () => {
    const backend: ExtensionLaunchBackend = {
      id: 'sandbox', sandboxed: true, launchSkillScript: vi.fn(),
      createMcpTransport: vi.fn(() => ({ start: () => new Promise<void>(() => {}), close: () => new Promise<void>(() => {}), send: async () => {} })),
    };
    const s = await setup('normal', backend, 40);
    await expect(s.connect()).rejects.toThrow('MCP_CONNECTION_TIMEOUT');
    expect(s.manager.managementStatus()[0]).toMatchObject({ state: 'failed', errorCode: 'MCP_CLOSE_FAILED', backend: 'sandbox' });
    await expect(s.connect()).rejects.toThrow('MCP_CLOSE_FAILED');
    await expect(s.manager.disconnectManagement(s.id)).rejects.toThrow('MCP_CLOSE_FAILED');
    expect(backend.createMcpTransport).toHaveBeenCalledOnce();
  });

  it('reports abnormal exit using fixed codes, with no automatic reconnect loop', async () => {
    const s = await setup('crash'); await expect(s.connect()).rejects.toThrow('MCP_');
    expect(s.manager.managementStatus()[0].state).toBe('failed');
    expect((await s.events()).filter((event) => event.event === 'start')).toHaveLength(1);
    expect(JSON.stringify(s.manager.managementStatus())).not.toContain('private-token');
  });

  it.each(['duplicate', 'cycle', 'excess', 'invalid'] as const)('rejects a %s catalog', async (mode) => {
    const s = await setup(mode === 'cycle' ? mode : 'normal');
    if (mode === 'duplicate') await writeFile(s.control, JSON.stringify({ tools: [tool('same'), tool('same')] }));
    if (mode === 'excess') await writeFile(s.control, JSON.stringify({ tools: Array.from({ length: 257 }, (_, i) => tool(`tool-${i}`)) }));
    if (mode === 'invalid') await writeFile(s.control, JSON.stringify({ tools: [{ name: 'bad', inputSchema: 'not-an-object' }] }));
    await expect(s.connect()).rejects.toThrow('MCP_');
    expect((await s.store.get()).extensions[0].inventoryKnown).toBe(false);
    expect(s.manager.managementStatus()[0].toolCount).toBe(0);
  });

  it('uses the selected sandbox backend for transport creation and never falls back when unavailable', async () => {
    const backend: ExtensionLaunchBackend = { id: 'sandbox', sandboxed: true,
      createMcpTransport: vi.fn(() => { throw new Error('private sandbox token'); }), launchSkillScript: vi.fn(),
    };
    const s = await setup('normal', backend);
    await expect(s.connect()).rejects.toThrow('MCP_CONNECTION_FAILED');
    expect(backend.createMcpTransport).toHaveBeenCalledOnce(); expect(await s.events()).toEqual([]);
    expect(s.manager.managementStatus()[0]).toMatchObject({ backend: 'sandbox', sandboxed: false });
  });

  it('enforces the connection limit even while transports are still starting', async () => {
    const backend: ExtensionLaunchBackend = { id: 'sandbox', sandboxed: true, launchSkillScript: vi.fn(),
      createMcpTransport: vi.fn(() => ({ start: () => new Promise<void>(() => {}), close: async () => {}, send: async () => {} })),
    };
    const s = await setup('normal', backend, 10_000); const state = await s.store.get();
    await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [s.id] });
    const failures: string[] = [];
    const tasks = Array.from({ length: 33 }, (_, i) => s.manager.connect({ kind: 'runtime', partnerId: 'api-one', conversationId: String(i), contextKey: 'same-workspace' }, s.id, state.extensions[0].generation).catch((error) => { failures.push(error.message); }));
    await eventually(() => failures.includes('MCP_CONNECTION_LIMIT'));
    await s.manager.dispose(); await Promise.all(tasks);
    expect(vi.mocked(backend.createMcpTransport).mock.calls.length).toBeLessThanOrEqual(32);
    expect(failures).toContain('MCP_CONNECTION_LIMIT');
  });

  it('disposes pending work and rejects new connections after disposal', async () => {
    const s = await setup('hang'); const pending = s.connect().catch((error) => error.message);
    await eventually(async () => (await s.events()).some((event) => event.event === 'start'));
    await s.manager.dispose(); expect(await pending).toBe('MCP_CONNECTION_CANCELLED');
    expect(s.manager.managementStatus()).toEqual([]);
    await expect(s.connect()).rejects.toThrow('MANAGER_DISPOSED');
  });

  it.skipIf(process.platform !== 'win32')('terminates a stdio launcher and its descendant on Windows', async () => {
    const s = await setup('descendant'); await s.connect();
    const events = await s.events(); const parent = events[0].pid; const child = events.find((event) => event.event === 'descendant').childPid;
    expect(alive(child)).toBe(true); await s.manager.disconnectManagement(s.id);
    await eventually(() => !alive(parent) && !alive(child));
  });
});

describe('Streamable HTTP MCP', () => {
  async function httpFixture(mode: 'normal' | 'redirect' | 'auth' | 'large' | 'sse' = 'normal') {
    const requests: { method?: string; auth?: string; session?: string; path?: string; rpc?: string }[] = [];
    const streams: ServerResponse[] = []; let currentTools = [tool('http-inspect')];
    const server = createServer(async (request, response) => {
      requests.push({ method: request.method, auth: request.headers.authorization, session: String(request.headers['mcp-session-id'] ?? ''), path: request.url });
      if (request.method === 'DELETE') { response.writeHead(204).end(); return; }
      if (mode === 'redirect') { response.writeHead(307, { location: '/must-not-follow' }).end(); return; }
      if (request.method === 'GET') {
        if (mode === 'sse') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': fixture\n\n'); streams.push(response); }
        else response.writeHead(405).end();
        return;
      }
      if (mode === 'auth') { response.writeHead(401).end('fixture-http-private-token'); return; }
      if (mode === 'large') { response.writeHead(200, { 'content-type': 'application/json' }).end('x'.repeat(2 * 1024 * 1024 + 1)); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      requests.at(-1)!.rpc = message.method;
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } }
        : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'HTTP_CALL_OK' }] } : { tools: currentTools };
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-session' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    return { url: `http://127.0.0.1:${address.port}/mcp`, requests, streams, change: () => {
      currentTools = [tool('http-inspect'), tool('http-new')];
      for (const stream of streams) stream.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\r\n\r\n');
    } };
  }

  it('supports local HTTP, header auth and protocol sessions without granting trust', async () => {
    const http = await httpFixture(); const s = await setup();
    await s.update({ configuration: { type: 'mcp_http', url: http.url }, secrets: { Authorization: 'Bearer fixture-http-token' } });
    expect((await s.connect()).toolCount).toBe(1);
    expect(http.requests.every((request) => request.auth === 'Bearer fixture-http-token')).toBe(true);
    expect(http.requests.some((request) => request.session === 'test-session')).toBe(true);
    expect((await s.store.get()).extensions[0].trust).toBe('untrusted');
    await s.manager.disconnectManagement(s.id);
    expect(http.requests.some((request) => request.method === 'DELETE' && request.session === 'test-session')).toBe(true);
  });

  it('dispatches a real HTTP tools/call only on the bound runtime scope and approved generation', async () => {
    const http = await httpFixture(), s = await setup();
    await s.update({ configuration: { type: 'mcp_http', url: http.url }, secrets: { Authorization: 'Bearer fixture-http-token' } });
    const state = await s.store.get(); await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [s.id] });
    const scope = { kind: 'runtime' as const, partnerId: 'api-one', conversationId: 'http-call', contextKey: 'workspace' };
    await s.manager.connect(scope, s.id, (await s.store.get()).extensions[0].generation);
    const generation = (await s.manager.catalog(scope, s.id)).generation, signal = new AbortController().signal;
    expect(await s.manager.invoke(scope, s.id, generation, 'http-inspect', {}, signal)).toMatchObject({ content: [{ text: 'HTTP_CALL_OK' }] });
    await expect(s.manager.invoke({ kind: 'management' }, s.id, generation, 'http-inspect', {}, signal)).rejects.toThrow('NOT_READY');
    await expect(s.manager.invoke(scope, s.id, generation - 1, 'http-inspect', {}, signal)).rejects.toThrow('NOT_READY');
    expect(http.requests.filter((request) => request.rpc === 'tools/call')).toHaveLength(1);
    expect(http.requests.every((request) => request.auth === 'Bearer fixture-http-token')).toBe(true);
  });

  it.each(['redirect', 'auth', 'large'] as const)('rejects %s responses without exposing secrets or following redirects', async (mode) => {
    const http = await httpFixture(mode); const s = await setup();
    await s.update({ configuration: { type: 'mcp_http', url: http.url }, secrets: { Authorization: 'Bearer fixture-http-token' } });
    await expect(s.connect()).rejects.toThrow('MCP_TRANSPORT_CLOSED');
    expect(JSON.stringify(s.manager.managementStatus())).not.toMatch(/fixture-http-token|fixture-http-private-token/);
    expect(http.requests.every((request) => request.path === '/mcp')).toBe(true);
  });

  it('receives real HTTP SSE list-change notifications and refreshes the catalog', async () => {
    const http = await httpFixture('sse'); const s = await setup();
    await s.update({ configuration: { type: 'mcp_http', url: http.url }, secrets: null });
    await s.connect(); await eventually(() => http.streams.length > 0);
    http.change();
    await eventually(() => s.manager.managementStatus()[0].state === 'ready' && s.manager.managementStatus()[0].toolCount === 2);
    expect((await s.manager.catalog({ kind: 'management' }, s.id)).tools.map((entry) => entry.name)).toContain('http-new');
  });
});
