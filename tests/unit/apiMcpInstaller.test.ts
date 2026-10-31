// @vitest-environment node
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiAgentRuntime } from '../../src/main/api/ApiAgentRuntime';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { ApiExtensionStore } from '../../src/main/api/ApiExtensionStore';
import { ApiMcpInstaller } from '../../src/main/api/extensions/ApiMcpInstaller';
import { ApiMcpSession } from '../../src/main/api/extensions/ApiMcpSession';
import { McpConnectionManager } from '../../src/main/api/extensions/McpConnectionManager';
import { NativeExtensionLaunchBackend } from '../../src/main/api/extensions/ExtensionLaunchBackend';
import { ApiToolRegistry, apiToolRequiresAuthorization, assertApiToolAllowed, type ApiToolExecutionPolicy } from '../../src/main/api/ApiToolRegistry';
import { CredentialStore, API_EXTENSION_CREDENTIAL_PREFIX } from '../../src/main/security/CredentialStore';
import type { AsteriumRuntimeToolController } from '../../src/main/adapters/PartnerAdapter';
import type { ApiProviderAdapter, ApiProviderRequest } from '../../src/main/api/ApiProviderAdapter';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type ResolveAuthorizationCommand, type SendMessageCommand } from '../../src/shared/agentProtocol';

const directories: string[] = [], managers: McpConnectionManager[] = [];
const manual: ApiToolExecutionPolicy = { permissionMode: 'manual', planMode: 'default' };
const http = { name: 'Requested service', configuration: { type: 'mcp_http' as const, url: 'https://example.com/mcp' } };
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  for (const directory of directories.splice(0)) {
    const resolved = await realpath(directory);
    expect(path.dirname(resolved).toLowerCase()).toBe((await realpath(os.tmpdir())).toLowerCase());
    expect(path.basename(resolved)).toMatch(/^asterium-install-unit-/);
    await rm(resolved, { recursive: true, force: true, maxRetries: 10 });
  }
});
async function setup(withWorkspace = true, overrides: Partial<SendMessageCommand> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-install-unit-')); directories.push(dir);
  const workspace = path.join(dir, 'workspace'), protectedRoot = path.join(dir, 'protected');
  await mkdir(workspace); await mkdir(protectedRoot);
  const credentials = new CredentialStore(path.join(dir, 'credentials.json'), { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() });
  const eligible = vi.fn(() => true);
  const store = new ApiExtensionStore(path.join(dir, 'extensions.json'), credentials.forNamespace(API_EXTENSION_CREDENTIAL_PREFIX), eligible);
  let workspaceVersion = 1;
  const runtimeTools: AsteriumRuntimeToolController = { status: async () => JSON.stringify({ cwd: workspace, workspaceFolders: [workspace], workspaceVersion }), workspace: async () => '{}', update: vi.fn() };
  const command: SendMessageCommand = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'send', partnerId: 'api-one', conversationId: 'conversation', clientMessageId: 'client', connectionSource: 'api_partner', content: { type: 'text', text: 'Install the requested MCP' }, execution: manual, ...overrides };
  const tools = new ApiAgentTools(withWorkspace ? workspace : undefined, [], undefined, runtimeTools, undefined, [protectedRoot]);
  const installer = new ApiMcpInstaller(store, command, runtimeTools, tools, [protectedRoot]);
  const registry = async (policy = manual) => {
    const registry = new ApiToolRegistry();
    for (const registration of await installer.registrations(policy)) registry.register(registration);
    return registry;
  };
  const run = (args: Record<string, unknown> = http, useMcp = false) => {
    const manager = new McpConnectionManager(store, new NativeExtensionLaunchBackend(), 4_000); managers.push(manager);
    const mcp = new ApiMcpSession(store, manager, command, runtimeTools, tools);
    let round = 0; const requests: ApiProviderRequest[] = [];
    const provider: ApiProviderAdapter = { provider: 'scripted', capabilities: { streamingText: true, reasoning: false, toolCalls: true, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } },
      async *stream(request) {
        requests.push(request);
        const name = round === 0 ? 'asterium_mcp_install' : useMcp && round === 1 ? request.tools.find((tool) => tool.name.startsWith('mcp_'))?.name : undefined;
        const input = round === 0 ? args : { value: 'INSTALL_AND_USE' }; round++;
        if (name) { yield { type: 'tool.delta', index: 0, id: `call-${round}`, name, arguments: JSON.stringify(input) }; yield { type: 'finish', reason: 'tool_calls' }; }
        else { yield { type: 'text.delta', text: 'done' }; yield { type: 'finish', reason: 'stop' }; }
      } };
    return { runtime: new ApiAgentRuntime({ provider, tools, mcpInstaller: installer, ...(useMcp ? { mcpSession: mcp } : {}) }), requests, command };
  };
  return { dir, workspace, protectedRoot, store, eligible, installer, tools, registry, run, changeWorkspace: () => { workspaceVersion++; } };
}
type Requested = Extract<PartnerEvent, { type: 'authorization.requested' }>;
async function collect(run: ReturnType<Awaited<ReturnType<typeof setup>>['run']>, approve: (event: Requested) => Promise<Partial<ResolveAuthorizationCommand> | void> = async () => ({})) {
  const events: PartnerEvent[] = [];
  for await (const event of run.runtime.sendMessage(run.command)) {
    events.push(event);
    if (event.type === 'authorization.requested') await run.runtime.resolveAuthorization({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'authorization.resolve', commandId: 'resolve', partnerId: event.partnerId, conversationId: event.conversationId, clientMessageId: event.clientMessageId, connectionSource: event.connectionSource, sessionId: event.sessionId, runId: event.runId, authorizationId: event.authorizationId, decision: 'allow_once', ...await approve(event) });
    if (event.type === 'user_input.requested') await run.runtime.resolveUserInput({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'user_input.resolve', commandId: 'input', partnerId: event.partnerId, conversationId: event.conversationId, clientMessageId: event.clientMessageId, connectionSource: event.connectionSource, sessionId: event.sessionId, runId: event.runId, requestId: event.requestId, answers: { 'plan-execution': ['暂不执行'] } });
  }
  return events;
}

describe('API partner self installation and scoped Main authority', () => {
  it.each(['single', 'group', 'workspace'] as const)('registers and calls a real SDK MCP in the same %s run with three separate approvals', async (scope) => {
    const route = scope === 'workspace' ? { scope: 'workspace' as const, projectId: 'p' } : scope === 'group' ? { scope: 'group' as const, roomId: 'r', roundId: 'round', bindingGeneration: 1, inputThroughSeq: 0 } : undefined;
    const s = await setup(true, { route }), log = path.join(s.dir, 'log.jsonl'), control = path.join(s.dir, 'tools.json');
    await writeFile(control, JSON.stringify({ tools: [{ name: 'inspect', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] }));
    const r = s.run({ name: 'Fixture', configuration: { type: 'mcp_stdio', command: process.execPath, args: [path.resolve('tests/fixtures/api-mcp-server.mjs'), log, control] } }, true);
    const events = await collect(r, async (event) => {
      expect(event.extensionTrust).toBeUndefined();
      if (event.summary.includes('安装并')) { expect((await s.store.get()).extensions).toHaveLength(0); expect(event.targets.join('\n')).toContain(s.workspace); }
    });
    expect(events.filter((event) => event.type === 'authorization.requested')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'tool.completed' && event.outcome === 'success')).toHaveLength(2);
    const state = await s.store.get(); expect(state.bindings).toEqual([{ partnerId: 'api-one', extensionIds: [state.extensions[0].id] }]);
    expect(state.extensions[0]).toMatchObject({ trust: 'untrusted', enabled: true, hasSecrets: false, inventoryKnown: true, configuration: { cwd: s.workspace } });
    expect((await readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.event === 'call')).toHaveLength(1);
    expect(r.requests[0].tools.some((tool) => tool.name.startsWith('mcp_'))).toBe(false);
    expect(r.requests[1].tools.some((tool) => tool.name.startsWith('mcp_'))).toBe(true);
    expect(JSON.stringify(r.requests[0].messages)).toContain('登记成功不等于连接/工具可用');
  });

  it.each(['manual', 'automatic', 'full'] as const)('%s uses existing approval policy without granting trust', async (permissionMode) => {
    const s = await setup(false, { execution: { permissionMode, planMode: 'default' } });
    const events = await collect(s.run());
    expect(events.filter((event) => event.type === 'authorization.requested')).toHaveLength(permissionMode === 'full' ? 0 : 1);
    expect((await s.store.get()).extensions[0]).toMatchObject({ configuration: http.configuration, trust: 'untrusted' });
  });

  it('denial and forged persistent trust leave configuration unchanged', async () => {
    const s = await setup(), run = s.run();
    const events = await collect(run, async (event) => {
      await expect(run.runtime.resolveAuthorization({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'authorization.resolve', commandId: 'forged', partnerId: event.partnerId, conversationId: event.conversationId, clientMessageId: event.clientMessageId, connectionSource: event.connectionSource, sessionId: event.sessionId, runId: event.runId, authorizationId: event.authorizationId, decision: 'allow_once', persistExtensionTrust: true })).rejects.toThrow();
      return { decision: 'deny' };
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', outcome: 'failure', detail: expect.stringContaining('USER_DENIED') }));
    expect((await s.store.get()).version).toBe(0);
  });

  it.each(['read_only', 'plan'] as const)('%s lists own MCP but cannot install even with a stale registration', async (mode) => {
    const s = await setup(), registry = await s.registry(), tool = registry.prepare('asterium_mcp_install', http);
    const restricted: ApiToolExecutionPolicy = { permissionMode: mode === 'read_only' ? 'read_only' : 'full', planMode: mode === 'plan' ? 'plan' : 'default' };
    expect((await s.registry(restricted)).definitions.map((tool) => tool.name)).toEqual(['asterium_mcp_list']);
    expect(() => assertApiToolAllowed(tool, restricted)).toThrow();
    await expect(tool.execute(new AbortController().signal, { policy: restricted })).rejects.toThrow('API_MCP_INSTALL_POLICY_BLOCKED');
    expect((await s.store.get()).extensions).toEqual([]);
  });

  it.each(['local_cli', 'existing_thread', 'workflow'] as const)('does not expose installation to %s', async (mode) => {
    const s = await setup(true, mode === 'workflow' ? { route: { scope: 'workflow_planning', projectId: 'p', roomId: 'r', generationId: 'g', bindingGeneration: 1 } } : { connectionSource: mode });
    expect((await s.registry()).definitions).toEqual([]);
  });

  it.each(['settings', 'workspace', 'eligibility'] as const)('rechecks %s after approval before committing', async (change) => {
    const s = await setup(), run = s.run();
    const events = await collect(run, async () => {
      if (change === 'settings') await s.store.upsert({ expectedVersion: 0, name: 'New UI entry', enabled: true, configuration: http.configuration });
      if (change === 'workspace') s.changeWorkspace();
      if (change === 'eligibility') s.eligible.mockReturnValue(false);
    });
    expect((await s.store.get()).extensions.some((entry) => entry.name === http.name)).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', outcome: 'failure' }));
  });

  it('cancels a pending installation without a write or an unhandled rejection', async () => {
    const s = await setup(), run = s.run(), events: PartnerEvent[] = [];
    for await (const event of run.runtime.sendMessage(run.command)) {
      events.push(event);
      if (event.type === 'authorization.requested') {
        await run.runtime.cancel({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'run.cancel', commandId: 'cancel', partnerId: event.partnerId, conversationId: event.conversationId, connectionSource: event.connectionSource, clientMessageId: event.clientMessageId, sessionId: event.sessionId, runId: event.runId });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(events.at(-1)?.type).toBe('run.cancelled'); expect((await s.store.get()).version).toBe(0);
  });

  it('requires a primary workspace for stdio, checks cwd and protected arguments', async () => {
    const absent = await setup(false), registry = await absent.registry();
    expect(() => registry.prepare('asterium_mcp_install', { name: 'Local', configuration: { type: 'mcp_stdio', command: 'npx', args: ['server'] } })).toThrow('API_WORKSPACE_NOT_CONFIGURED');
    const s = await setup(), local = await s.registry();
    for (const configuration of [
      { type: 'mcp_stdio', command: 'node', args: [], cwd: s.dir },
      { type: 'mcp_stdio', command: 'node', args: [path.join(s.protectedRoot, 'data.json')] },
    ]) {
      const tool = local.prepare('asterium_mcp_install', { name: 'Invalid', configuration });
      await expect(tool.guard!(manual)).rejects.toThrow();
    }
    expect((await s.store.get()).extensions).toEqual([]);
  });

  it.each([
    { partnerId: 'other' }, { trust: 'trusted' }, { secrets: { KEY: 'secret' } }, { credentialRef: 'foreign' }, { id: 'extension-existing' }, { enabled: true },
    { configuration: { type: 'skill', directory: 'C:\\skills' } },
    { configuration: { type: 'mcp_stdio', command: 'node', args: [], cwd: '.' } },
    { configuration: { type: 'mcp_http', url: 'https://user:pass@example.com' } },
  ])('rejects malformed or authority-expanding installation arguments %j', async (extra) => {
    const s = await setup(), registry = await s.registry();
    expect(() => registry.prepare('asterium_mcp_install', { ...http, ...extra })).toThrow();
    expect((await s.store.get()).extensions).toEqual([]);
  });

  it('preserves other bindings and credentials, never inherits another partner trust, and reuses only its identical enabled entry', async () => {
    const s = await setup();
    let state = await s.store.upsert({ expectedVersion: 0, ...http, enabled: true, secrets: { Authorization: 'private-value' } });
    const otherId = state.extensions[0].id;
    state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-other', extensionIds: [otherId] });
    await s.store.recordInventory(otherId, state.extensions[0].generation, 'f'.repeat(64));
    state = await s.store.get(); await s.store.setTrust({ expectedVersion: state.version, id: otherId, action: 'request' });
    const token = await s.store.prepareTrustApproval(otherId, manual); await s.store.confirmTrustApproval(token, manual);
    state = await s.store.get(); const otherBefore = structuredClone(state.extensions[0]);
    const result = await s.store.installMcpForPartner('api-one', state.version, http, async () => {});
    expect(result.extension).toMatchObject({ trust: 'untrusted', hasSecrets: false }); expect(result.extension.id).not.toBe(otherId);
    state = await s.store.get(); expect(state.extensions.find((entry) => entry.id === otherId)).toEqual(otherBefore);
    expect(state.bindings.find((binding) => binding.partnerId === 'api-other')?.extensionIds).toEqual([otherId]);
    const reused = await s.store.installMcpForPartner('api-one', state.version, http, async () => {});
    expect(reused).toMatchObject({ reused: true, extension: { id: result.extension.id } }); expect(await s.store.get()).toEqual(state);
    await expect(s.store.installMcpForPartner('api-one', state.version, { ...http, configuration: { type: 'mcp_http', url: 'https://other.example.com' } }, async () => {})).rejects.toThrow('API_MCP_NAME_CONFLICT');
    const list = (await s.registry()).prepare('asterium_mcp_list', {});
    expect(apiToolRequiresAuthorization(list, manual)).toBe(false);
    const listed = JSON.parse((await list.execute(new AbortController().signal)).content);
    expect(listed).toHaveLength(1); expect(JSON.stringify(listed)).not.toContain('private-value'); expect(JSON.stringify(listed)).not.toContain(otherId);
    state = await s.store.upsert({ expectedVersion: state.version, id: result.extension.id, ...http, enabled: false });
    await expect(s.store.installMcpForPartner('api-one', state.version, http, async () => {})).rejects.toThrow('API_MCP_DISABLED_USE_SETTINGS');
    const disabled = JSON.parse((await list.execute(new AbortController().signal)).content); expect(disabled[0].enabled).toBe(false);
  });

  it('checks context under the atomic queue and never commits a rejected installation', async () => {
    const s = await setup();
    await expect(s.store.installMcpForPartner('api-one', 0, http, async () => { throw new Error('CHANGED_AT_COMMIT'); })).rejects.toThrow('CHANGED_AT_COMMIT');
    expect((await s.store.get()).version).toBe(0);
    const results = await Promise.allSettled([s.store.installMcpForPartner('api-one', 0, http, async () => {}), s.store.installMcpForPartner('api-two', 0, http, async () => {})]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await s.store.get()).bindings).toHaveLength(1);
  });

  it('adds an MCP without replacing existing MCP/Skill bindings and lists only credential names', async () => {
    const s = await setup();
    let state = await s.store.upsert({ expectedVersion: 0, name: 'Existing MCP', enabled: false, configuration: http.configuration, secrets: { Authorization: 'private-own-value' } });
    state = await s.store.upsert({ expectedVersion: state.version, name: 'Existing Skill', enabled: true, configuration: { type: 'skill', directory: s.workspace } });
    const previousIds = state.extensions.map((entry) => entry.id);
    state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: previousIds });
    const added = await s.store.installMcpForPartner('api-one', state.version, http, async () => {});
    expect((await s.store.get()).bindings[0].extensionIds).toEqual([...previousIds, added.extension.id]);
    const list = (await s.registry()).prepare('asterium_mcp_list', {}), raw = (await list.execute(new AbortController().signal)).content;
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(2); expect(entries[0]).toMatchObject({ enabled: false, secretNames: ['Authorization'], hasSecrets: true });
    expect(raw).not.toContain('private-own-value'); expect(raw).not.toContain('credentialRef'); expect(raw).not.toContain('Existing Skill');
  });
});
