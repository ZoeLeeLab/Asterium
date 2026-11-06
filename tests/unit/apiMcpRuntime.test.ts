// @vitest-environment node
import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readFile, realpath, writeFile, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiExtensionStore } from '../../src/main/api/ApiExtensionStore';
import { ApiAgentRuntime } from '../../src/main/api/ApiAgentRuntime';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { ApiMcpSession } from '../../src/main/api/extensions/ApiMcpSession';
import { ApiSkillSession } from '../../src/main/api/extensions/ApiSkillSession';
import { SkillPackageLoader } from '../../src/main/api/extensions/SkillPackageLoader';
import { McpConnectionManager } from '../../src/main/api/extensions/McpConnectionManager';
import { NativeExtensionLaunchBackend } from '../../src/main/api/extensions/ExtensionLaunchBackend';
import { compileMcpSchema } from '../../src/main/api/extensions/McpSchema';
import { CredentialStore, API_EXTENSION_CREDENTIAL_PREFIX } from '../../src/main/security/CredentialStore';
import type { AsteriumRuntimeToolController } from '../../src/main/adapters/PartnerAdapter';
import type { ApiProviderAdapter, ApiProviderRequest } from '../../src/main/api/ApiProviderAdapter';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type SendMessageCommand, type ResolveAuthorizationCommand } from '../../src/shared/agentProtocol';

const directories: string[] = [], managers: McpConnectionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  for (const dir of directories.splice(0)) {
    const resolved = await realpath(dir);
    expect(path.dirname(resolved).toLowerCase()).toBe((await realpath(os.tmpdir())).toLowerCase());
    expect(path.basename(resolved)).toMatch(/^asterium-s4-unit-/);
    await rm(resolved, { recursive: true, force: true, maxRetries: 5 });
  }
});
const inputSchema = { type: 'object', properties: { value: { type: 'string' }, path: { type: 'string' } }, required: ['value'], additionalProperties: false };
const fixtureTool = { name: 'inspect', description: 'Untrusted fixture', inputSchema, outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, annotations: { readOnlyHint: true, destructiveHint: false } };
async function setup(mode = 'normal', trust: 'untrusted' | 'pending' | 'trusted' = 'pending') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-s4-unit-')); directories.push(dir);
  const workspace = path.join(dir, 'workspace'); await mkdir(workspace);
  const log = path.join(dir, 'log.jsonl'), control = path.join(dir, 'catalog.json');
  await writeFile(control, JSON.stringify({ tools: [fixtureTool] }));
  const credentials = new CredentialStore(path.join(dir, 'vault.json'), { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() });
  const eligible = vi.fn(() => true);
  const store = new ApiExtensionStore(path.join(dir, 'extensions.json'), credentials.forNamespace(API_EXTENSION_CREDENTIAL_PREFIX), eligible);
  let state = await store.upsert({ expectedVersion: 0, name: 'Fixture', enabled: true, configuration: { type: 'mcp_stdio', command: process.execPath, args: [path.resolve('tests/fixtures/api-mcp-server.mjs'), log, control, mode], cwd: dir }, secrets: { FIXTURE_TOKEN: 'secret-"-\\-fixture' } });
  const id = state.extensions[0].id;
  state = await store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [id] });
  if (trust !== 'untrusted') await store.setTrust({ expectedVersion: state.version, id, action: 'request' });
  // The management warm-up has an explicit synthetic directory authority.
  const manager = new McpConnectionManager(store, new NativeExtensionLaunchBackend(), 4_000, async configuration => ({ cwd: configuration.cwd ?? dir, workspaceFolders: [dir] })); managers.push(manager);
  if (trust === 'trusted') {
    await manager.connectManagement({ id, expectedGeneration: (await store.get()).extensions[0].generation });
    const token = await store.prepareTrustApproval(id, { permissionMode: 'manual', planMode: 'default' });
    await store.confirmTrustApproval(token, { permissionMode: 'manual', planMode: 'default' });
    await manager.disconnectManagement(id);
  }
  let workspaceVersion = 1;
  const runtimeTools: AsteriumRuntimeToolController = { status: async () => JSON.stringify({ cwd: workspace, workspaceFolders: [workspace], workspaceVersion }), workspace: async () => '{}', update: vi.fn() };
  const command: SendMessageCommand = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'send', partnerId: 'api-one', conversationId: 'conversation', clientMessageId: 'client', connectionSource: 'api_partner', content: { type: 'text', text: 'synthetic MCP test' }, execution: { permissionMode: 'manual', planMode: 'default' } };
  const events = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const calls = async () => (await events()).filter((event) => event.event === 'call');
  const run = (overrides: Partial<SendMessageCommand> = {}, args: Record<string, unknown> = { value: 'hello' }, repeats = 1, forcedName?: string) => {
    const input = { ...command, ...overrides };
    const tools = new ApiAgentTools(workspace, [], undefined, runtimeTools, undefined, [path.join(dir, 'protected')]);
    const session = new ApiMcpSession(store, manager, input, runtimeTools, tools);
    const requests: ApiProviderRequest[] = []; let round = 0;
    const provider: ApiProviderAdapter = { provider: 'scripted', capabilities: { streamingText: true, reasoning: false, toolCalls: true, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } },
      async *stream(request) {
        requests.push(request);
        const name = forcedName ?? request.tools.find((tool) => tool.name.startsWith('mcp_'))?.name;
        if (round++ < repeats && name) {
          yield { type: 'tool.delta', index: 0, id: `call-${round}`, name, arguments: JSON.stringify(args) };
          yield { type: 'finish', reason: 'tool_calls' };
        } else { yield { type: 'text.delta', text: 'done' }; yield { type: 'finish', reason: 'stop' }; }
      } };
    return { input, tools, session, requests, runtime: new ApiAgentRuntime({ provider, tools, mcpSession: session }) };
  };
  return { dir, workspace, control, store, manager, id, events, calls, run, eligible, changeWorkspace: () => { workspaceVersion++; } };
}
type Run = ReturnType<Awaited<ReturnType<typeof setup>>['run']>;
type Requested = Extract<PartnerEvent, { type: 'authorization.requested' }>;
function answer(event: Requested, overrides: Partial<ResolveAuthorizationCommand> = {}): ResolveAuthorizationCommand {
  return { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'authorization.resolve', commandId: 'resolve', partnerId: event.partnerId, conversationId: event.conversationId, clientMessageId: event.clientMessageId, connectionSource: event.connectionSource, sessionId: event.sessionId, runId: event.runId, authorizationId: event.authorizationId, decision: 'allow_once', ...overrides };
}
async function collect(run: Run, approve: (event: Requested) => Promise<Partial<ResolveAuthorizationCommand> | void> = async () => ({})) {
  const events: PartnerEvent[] = [];
  for await (const event of run.runtime.sendMessage(run.input)) {
    events.push(event);
    if (event.type === 'authorization.requested') await run.runtime.resolveAuthorization(answer(event, await approve(event) ?? {}));
    if (event.type === 'user_input.requested') await run.runtime.resolveUserInput({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'user_input.resolve', commandId: 'input', partnerId: event.partnerId, conversationId: event.conversationId, clientMessageId: event.clientMessageId, connectionSource: event.connectionSource, sessionId: event.sessionId, runId: event.runId, requestId: event.requestId, answers: { 'plan-execution': ['暂不执行'] } });
  }
  return events;
}

describe('API MCP runtime with real SDK/stdio and Main trust authority', () => {
  it('applies same-task guidance after an in-flight real MCP call finishes, without cancelling or replaying it', async () => {
    const s = await setup('gated-call', 'trusted'), run = s.run();
    const events: PartnerEvent[] = [];
    const collecting = (async () => { for await (const event of run.runtime.sendMessage(run.input)) events.push(event); })();
    await vi.waitFor(async () => expect(await s.calls()).toHaveLength(1));
    const bound = events.find((event) => event.type === 'session.bound')!;
    await run.runtime.sendGuidance({ ...run.input, type: 'guidance.send', clientMessageId: 'mid-call-guidance', runId: bound.runId, sessionId: bound.sessionId, content: { type: 'text', text: 'Continue with this completed result; do not call it again.' } });
    expect(events.some((event) => event.type === 'guidance.applied' || event.type === 'run.cancelled')).toBe(false);
    await writeFile(s.control, JSON.stringify({ tools: [fixtureTool], releaseCall: true }));
    await collecting;
    expect(await s.calls()).toHaveLength(1);
    expect((await s.calls())[0].name).toBe('inspect');
    expect(events.find(event => event.type === 'tool.started')).toMatchObject({ toolName: expect.stringMatching(/^mcp_[a-f0-9]+_[a-f0-9]+$/), presentationName: expect.stringMatching(/^mcp__[a-f0-9]+__inspect$/) });
    expect(events.findIndex((event) => event.type === 'tool.completed')).toBeLessThan(events.findIndex((event) => event.type === 'guidance.applied'));
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))).toHaveLength(1);
    expect(run.requests[1].messages.at(-1)).toMatchObject({ role: 'user', content: 'Continue with this completed result; do not call it again.' });
    await run.runtime.dispose();
  });
  it('expires a pending MCP startup approval when its partner binding is removed and restored', async () => {
    const s = await setup('normal', 'untrusted');
    const events = await collect(s.run(), async (event) => {
      if (!event.toolCallId) {
        let state = await s.store.get();
        state = await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [] });
        await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [s.id] });
      }
    });
    expect(await s.events()).toEqual([]);
    expect(events.filter((event) => event.type === 'authorization.requested')).toHaveLength(1);
  });
  it('allows non-filesystem IDs in generic MCP fields while retaining actual path checks', async () => {
    const s = await setup('normal', 'untrusted');
    const args = { value: 'business-ids', target: 'channel-001', source: 'main', destination: 'archive', root: 'account-001', filename: 'remote-report.pdf' };
    await writeFile(s.control, JSON.stringify({ tools: [{ ...fixtureTool, inputSchema: { type: 'object', properties: Object.fromEntries(Object.keys(args).map((key) => [key, { type: 'string' }])), required: ['value'], additionalProperties: false } }] }));
    const events = await collect(s.run({}, args));
    expect(events.filter((event) => event.type === 'tool.completed' && event.outcome === 'success')).toHaveLength(1);
    expect(await s.calls()).toHaveLength(1);
    const tools = new ApiAgentTools(s.workspace);
    for (const value of [{ target: path.join(s.dir, 'outside.txt') }, { source: '../outside.txt' }, { path: 'relative.txt' }, { target_path: 'remote-name' }]) {
      await expect(tools.assertMcpPaths(value)).rejects.toThrow();
    }
  });
  it.each(['single', 'group', 'workspace'] as const)('combines MCP and Skill tools in one %s model run without replacing either catalog', async (scope) => {
    const s = await setup('normal', 'untrusted'), folder = path.join(s.dir, 'combined-skill'); await mkdir(folder);
    await writeFile(path.join(folder, 'SKILL.md'), '---\nname: combined\ndescription: Synthetic combined skill\n---\nCOMBINED_SKILL_RESULT');
    let state = await s.store.get(); state = await s.store.upsert({ expectedVersion: state.version, name: 'Combined skill', enabled: true, configuration: { type: 'skill', directory: folder } });
    await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: state.extensions.map((entry) => entry.id) });
    const route = scope === 'workspace' ? { scope: 'workspace' as const, projectId: 'p' } : scope === 'group' ? { scope: 'group' as const, roomId: 'r', roundId: 'round', bindingGeneration: 1, inputThroughSeq: 0 } : undefined;
    const r = s.run({ route }); let round = 0; const observed: ApiProviderRequest[] = [];
    const provider: ApiProviderAdapter = { provider: 'scripted', capabilities: { streamingText: true, reasoning: false, toolCalls: true, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } }, async *stream(request) {
      observed.push(request); const prefix = round === 0 ? 'skill_read_' : 'mcp_';
      if (round++ < 2) { yield { type: 'tool.delta', index: 0, id: `combined-${round}`, name: request.tools.find((tool) => tool.name.startsWith(prefix))!.name, arguments: prefix === 'mcp_' ? '{"value":"COMBINED_MCP_RESULT"}' : '{}' }; yield { type: 'finish', reason: 'tool_calls' }; }
      else { yield { type: 'text.delta', text: 'done' }; yield { type: 'finish', reason: 'stop' }; }
    } };
    const skill = new ApiSkillSession(s.store, new SkillPackageLoader(s.store, []), r.input);
    const runtime = new ApiAgentRuntime({ provider, tools: r.tools, mcpSession: r.session, skillSession: skill });
    const events = await collect({ ...r, runtime });
    expect(events.filter((event) => event.type === 'tool.completed' && event.outcome === 'success')).toHaveLength(2);
    for (const request of observed) { expect(request.tools.some((tool) => tool.name.startsWith('skill_read_'))).toBe(true); expect(request.tools.some((tool) => tool.name.startsWith('mcp_'))).toBe(true); }
    expect(JSON.stringify(observed.at(-1)!.messages)).toContain('COMBINED_SKILL_RESULT'); expect(await s.calls()).toHaveLength(1);
  });
  it('separately approves startup and each untrusted call, regardless of server readOnlyHint', async () => {
    const s = await setup('normal', 'untrusted'), r = s.run({}, { value: 'hello' }, 2);
    const events = await collect(r, async (event) => {
      if (!event.toolCallId) expect(await s.events()).toEqual([]);
      else expect(event.targets.join('\n')).toContain('"value":"hello"');
      expect(event.extensionTrust).toBeUndefined(); return {};
    });
    expect(events.filter((event) => event.type === 'authorization.requested')).toHaveLength(3);
    expect(await s.calls()).toHaveLength(2);
    expect((await s.store.get()).extensions[0].trust).toBe('untrusted');
    expect(JSON.stringify(events)).not.toContain('secret-');
    expect(JSON.stringify(r.requests[1].messages)).toContain('[已隐藏凭据]');
  });

  it('allow_once never activates pending trust, while explicit persist works across runs and conversations', async () => {
    const s = await setup();
    const first = await collect(s.run(), async () => ({}));
    expect(first.filter((e) => e.type === 'authorization.requested')).toHaveLength(2);
    expect((await s.store.get()).extensions[0].trust).toBe('pending');
    const second = await collect(s.run({ clientMessageId: 'next' }, { value: 'persist' }, 2), async (event) => ({ persistExtensionTrust: Boolean(event.extensionTrust) }));
    expect(second.filter((e) => e.type === 'authorization.requested')).toHaveLength(1);
    expect(second).toContainEqual(expect.objectContaining({ type: 'authorization.resolved', extensionTrustGranted: true }));
    const other = await collect(s.run({ conversationId: 'other', clientMessageId: 'third' }));
    expect(other.some((e) => e.type === 'authorization.requested')).toBe(false);
    expect((await s.store.get()).extensions[0].trust).toBe('trusted');
    expect(await s.calls()).toHaveLength(4);
  });

  it.each(['read_only', 'plan', 'workflow'] as const)('never initializes trusted MCP in %s', async (mode) => {
    const s = await setup('normal', 'trusted'), before = await s.events();
    const r = s.run(mode === 'workflow' ? { route: { scope: 'workflow_planning', projectId: 'p', roomId: 'r', generationId: 'g', bindingGeneration: 1 } }
      : { execution: { permissionMode: mode === 'read_only' ? 'read_only' : 'full', planMode: mode === 'plan' ? 'plan' : 'default' } });
    const events = await collect(r);
    expect(await s.events()).toEqual(before);
    expect(r.requests[0].tools.some((tool) => tool.name.startsWith('mcp_'))).toBe(false);
    expect(events.some((e) => e.type === 'authorization.requested')).toBe(false);
  });

  it('full mode executes pending services without prompting or silently activating trust', async () => {
    const s = await setup(), events = await collect(s.run({ execution: { permissionMode: 'full', planMode: 'default' } }));
    expect(events.some((e) => e.type === 'authorization.requested')).toBe(false);
    expect(await s.calls()).toHaveLength(1);
    expect((await s.store.get()).extensions[0].trust).toBe('pending');
  });

  it('automatic mode still requires approval for MCP side effects', async () => {
    const s = await setup(), events = await collect(s.run({ execution: { permissionMode: 'automatic', planMode: 'default' } }));
    expect(events.filter((e) => e.type === 'authorization.requested')).toHaveLength(2);
    expect(await s.calls()).toHaveLength(1);
  });

  it('startup denial neither spawns a process nor repeats the prompt later in the run', async () => {
    const s = await setup(), events = await collect(s.run(), async () => ({ decision: 'deny' }));
    expect(events.filter((e) => e.type === 'authorization.requested')).toHaveLength(1);
    expect(await s.events()).toEqual([]);
  });

  it('honors cancellation immediately after session binding without opening a never-resolving approval', async () => {
    const s = await setup(), r = s.run(), events: PartnerEvent[] = [];
    for await (const event of r.runtime.sendMessage(r.input)) {
      events.push(event);
      if (event.type === 'session.bound') await r.runtime.cancel({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'run.cancel', commandId: 'cancel', partnerId: event.partnerId, conversationId: event.conversationId, connectionSource: event.connectionSource, clientMessageId: event.clientMessageId, sessionId: event.sessionId, runId: event.runId });
    }
    expect(events.at(-1)?.type).toBe('run.cancelled');
    expect(events.some((event) => event.type === 'authorization.requested')).toBe(false);
    expect(await s.events()).toEqual([]);
  });

  it('denying the pending first call leaves trust pending and performs no call', async () => {
    const s = await setup(), events = await collect(s.run(), async (event) => ({ decision: event.toolCallId ? 'deny' : 'allow_once' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', outcome: 'failure', detail: expect.stringContaining('USER_DENIED') }));
    expect(await s.calls()).toHaveLength(0);
    expect((await s.store.get()).extensions[0].trust).toBe('pending');
  });

  it('rejects forged identities, unoffered persistence and replay without consuming the real pending request', async () => {
    const s = await setup(); const r = s.run(); let prior: ResolveAuthorizationCommand | undefined;
    await collect(r, async (event) => {
      for (const field of ['partnerId', 'conversationId', 'clientMessageId', 'sessionId', 'runId', 'authorizationId'] as const) {
        await expect(r.runtime.resolveAuthorization(answer(event, { [field]: 'forged' }))).rejects.toThrow('AUTHORIZATION_NOT_PENDING');
      }
      if (prior) await expect(r.runtime.resolveAuthorization(prior)).rejects.toThrow('AUTHORIZATION_NOT_PENDING');
      if (!event.extensionTrust) await expect(r.runtime.resolveAuthorization(answer(event, { persistExtensionTrust: true }))).rejects.toThrow('EXTENSION_TRUST_NOT_OFFERED');
      prior = answer(event); return {};
    });
    await expect(r.runtime.resolveAuthorization(prior!)).rejects.toThrow('AUTHORIZATION_NOT_PENDING');
    expect((await s.store.get()).extensions[0].trust).toBe('pending');
    expect(await s.calls()).toHaveLength(1);
  });

  it.each(['revoke', 'unbind', 'config', 'workspace', 'eligibility', 'catalog'] as const)('rechecks %s while persistent approval is pending', async (change) => {
    const s = await setup();
    await collect(s.run(), async (event) => {
      if (!event.toolCallId) return {};
      const state = await s.store.get(), entry = state.extensions[0];
      if (change === 'revoke') await s.store.setTrust({ expectedVersion: state.version, id: s.id, action: 'revoke' });
      if (change === 'unbind') await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-one', extensionIds: [] });
      if (change === 'config') await s.store.upsert({ expectedVersion: state.version, id: s.id, name: entry.name, enabled: true, configuration: entry.configuration, secrets: { FIXTURE_TOKEN: 'changed' } });
      if (change === 'workspace') s.changeWorkspace();
      if (change === 'eligibility') s.eligible.mockReturnValue(false);
      if (change === 'catalog') {
        await writeFile(s.control, JSON.stringify({ tools: [{ ...fixtureTool, description: 'Changed while approval was pending' }] }));
        await vi.waitFor(async () => expect((await s.store.get()).extensions[0].generation).toBeGreaterThan(entry.generation));
      }
      return { persistExtensionTrust: true };
    });
    expect(await s.calls()).toHaveLength(0);
    expect((await s.store.get()).extensions[0].trust).not.toBe('trusted');
  });

  it('revocation restores approval for subsequent calls', async () => {
    const s = await setup('normal', 'trusted'); await collect(s.run());
    const state = await s.store.get(); await s.store.setTrust({ expectedVersion: state.version, id: s.id, action: 'revoke' });
    const events = await collect(s.run({ clientMessageId: 'revoked' }), async (event) => ({ decision: event.toolCallId ? 'deny' : 'allow_once' }));
    expect(events.filter((e) => e.type === 'authorization.requested')).toHaveLength(2);
    expect(await s.calls()).toHaveLength(1);
  });

  it.each(['startup', 'call'] as const)('checks working context inside the final %s dispatch queue even after earlier trusted guards passed', async (stage) => {
    const s = await setup('normal', 'trusted'), dispatch = s.store.dispatchForPartner.bind(s.store);
    let dispatches = 0;
    vi.spyOn(s.store, 'dispatchForPartner').mockImplementation((...args) => { if (++dispatches === (stage === 'startup' ? 1 : 2)) s.changeWorkspace(); return dispatch(...args); });
    const events = await collect(s.run());
    expect(await s.calls()).toHaveLength(0);
    if (stage === 'call') expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', outcome: 'failure', detail: expect.stringContaining('MCP_CONTEXT_CHANGED') }));
    else expect(events).toContainEqual(expect.objectContaining({ type: 'work.status', summary: 'MCP 连接未就绪，本轮暂不提供该服务的工具。' }));
  });

  it('does not hold the authority queue during I/O or reconnect automatically after mid-call revocation', async () => {
    const s = await setup('hang-call'), r = s.run(); let revocation: Promise<unknown> | undefined;
    const events = await collect(r, async (event) => {
      if (event.toolCallId) revocation = (async () => {
        await vi.waitFor(async () => expect(await s.calls()).toHaveLength(1));
        const state = await s.store.get();
        return s.store.setTrust({ expectedVersion: state.version, id: s.id, action: 'revoke' });
      })();
      return {};
    });
    await revocation;
    expect((await s.events()).filter((event) => event.event === 'start')).toHaveLength(1);
    expect(await s.calls()).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', outcome: 'failure' }));
    expect(events.at(-1)?.type).toBe('run.completed');
  });

  it('shares explicit service trust across bound API partners without granting unbound partners any tool', async () => {
    const s = await setup();
    await collect(s.run(), async (event) => ({ persistExtensionTrust: Boolean(event.extensionTrust) }));
    const state = await s.store.get();
    await s.store.setBinding({ expectedVersion: state.version, partnerId: 'api-two', extensionIds: [s.id] });
    const second = s.run({ partnerId: 'api-two', conversationId: 'other' });
    expect((await collect(second)).some((event) => event.type === 'authorization.requested')).toBe(false);
    const unbound = s.run({ partnerId: 'api-unbound' }); await collect(unbound);
    expect(unbound.requests[0].tools.some((tool) => tool.name.startsWith('mcp_'))).toBe(false);
    expect(await s.calls()).toHaveLength(2);
  });

  it('releases an earlier working context when a new per-turn adapter starts', async () => {
    const s = await setup('normal', 'trusted'); await collect(s.run());
    const prior = (await s.events()).filter((event) => event.event === 'start').at(-1).pid;
    s.changeWorkspace(); await collect(s.run({ clientMessageId: 'new-context' }));
    await vi.waitFor(() => expect(() => process.kill(prior, 0)).toThrow());
    expect(await s.calls()).toHaveLength(2);
    const current = (await s.events()).filter((event) => event.event === 'start').at(-1).pid;
    await collect(s.run({ execution: { permissionMode: 'read_only', planMode: 'default' } }));
    await vi.waitFor(() => expect(() => process.kill(current, 0)).toThrow());
  });

  it('hides an entire unsupported service catalog and reports a safe notice', async () => {
    const s = await setup();
    await writeFile(s.control, JSON.stringify({ tools: [fixtureTool, { name: 'unsupported', inputSchema: { type: 'object', properties: { value: { type: 'string', pattern: '(a+)+$' } } } }] }));
    const r = s.run(), events = await collect(r);
    expect(r.requests[0].tools.some((tool) => tool.name.startsWith('mcp_'))).toBe(false);
    expect(await s.calls()).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'work.status', summary: expect.stringContaining('不支持的 schema') }));
  });

  it('discards a real trust token when the pending approval is cancelled', async () => {
    const s = await setup(), r = s.run(), prepare = vi.spyOn(s.store, 'prepareTrustApproval');
    const events: PartnerEvent[] = [];
    for await (const event of r.runtime.sendMessage(r.input)) {
      events.push(event);
      if (event.type === 'authorization.requested') {
        if (event.extensionTrust) await r.runtime.cancel({ ...answer(event), type: 'run.cancel' });
        else await r.runtime.resolveAuthorization(answer(event));
      }
    }
    expect(events).toContainEqual(expect.objectContaining({ type: 'run.cancelled' }));
    expect(await s.calls()).toHaveLength(0);
    const token = await prepare.mock.results[0].value;
    await expect(s.store.confirmTrustApproval(token, { permissionMode: 'manual', planMode: 'default' })).rejects.toThrow('APPROVAL_EXPIRED');
  });

  it.each([{ value: 42 }, { value: 'x', unexpected: true }, { value: 'x', path: '..\\outside.txt' }, { value: 'x', path: 'file:///C:/outside' }, { value: 'x', path: '\\workspace\\ambiguous.txt' }, { value: 'x', path: '/workspace/ambiguous.txt' }])('blocks invalid or out-of-scope args before approving/dispatching: %j', async (args) => {
    const s = await setup(), events = await collect(s.run({}, args));
    expect(events.filter((e) => e.type === 'authorization.requested')).toHaveLength(1);
    expect(await s.calls()).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', outcome: 'failure' }));
  });

  it('rejects a canonical junction escape even for a trusted service', async () => {
    const s = await setup('normal', 'trusted');
    const outside = path.join(s.dir, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(s.workspace, 'escape'), 'junction');
    const events = await collect(s.run({}, { value: 'x', path: path.join(s.workspace, 'escape', 'future.txt') }));
    expect(await s.calls()).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', detail: expect.stringContaining('TOOL_PATH_OUTSIDE_WORKSPACE') }));
  });

  it.each(['rpc-error', 'bad-result', 'bad-output', 'large-result', 'tool-error'])('handles %s with no replay and no raw server error leakage', async (mode) => {
    const s = await setup(mode), events = await collect(s.run());
    expect(await s.calls()).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', outcome: 'failure' }));
    expect(JSON.stringify(events)).not.toMatch(/fixture-stderr-private-token|secret-/);
  });

  it('keeps binary/resource links passive instead of creating attachments or fetching URIs', async () => {
    const s = await setup('binary-result'), r = s.run(), events = await collect(r);
    expect(events.some((e) => e.type === 'file.produced')).toBe(false);
    const messages = JSON.stringify(r.requests[1].messages);
    expect(messages).toContain('omitted'); expect(messages).not.toMatch(/c2VjcmV0|must-not-fetch/);
  });

  it('cancels an in-flight call, releases its process and never replays it', async () => {
    const s = await setup('hang-call'), r = s.run();
    const events: PartnerEvent[] = []; let cancel: ReturnType<typeof setTimeout> | undefined;
    for await (const event of r.runtime.sendMessage(r.input)) {
      events.push(event);
      if (event.type === 'authorization.requested') {
        await r.runtime.resolveAuthorization(answer(event));
        if (event.toolCallId) cancel = setTimeout(() => { void r.runtime.cancel({ ...answer(event), type: 'run.cancel' }); }, 120);
      }
    }
    clearTimeout(cancel);
    expect(events).toContainEqual(expect.objectContaining({ type: 'run.cancelled' }));
    expect(await s.calls()).toHaveLength(1);
    const pid = (await s.events()).find((event) => event.event === 'start').pid;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });
});

describe('bounded MCP schema validation', () => {
  it('rejects unknown formats without logging untrusted schema text while validating supported formats', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => compileMcpSchema({ type: 'object', properties: { url: { type: 'string', format: 'private-fixture-format' } } })).toThrow('MCP_SCHEMA_UNSUPPORTED');
      expect(warn).not.toHaveBeenCalled();
      const validate = compileMcpSchema({ type: 'object', properties: { url: { type: 'string', format: 'uri' } } });
      expect(() => validate({ url: 'https://example.invalid' })).not.toThrow();
      expect(() => validate({ url: 'invalid' })).toThrow('MCP_SCHEMA_VALIDATION_FAILED');
    } finally { warn.mockRestore(); }
  });
  it.each([{ $ref: 'https://never-fetch.invalid/schema' }, { $async: true, type: 'object' }, { type: 'string', pattern: '(a+)+$' }, { type: 'object', patternProperties: { '.*': { type: 'string' } } }])('rejects unsupported/unbounded schema %j', (schema) => {
    expect(() => compileMcpSchema(schema)).toThrow('MCP_SCHEMA_UNSUPPORTED');
  });
  it('validates local refs and refuses excessive argument depth/bytes', () => {
    const validate = compileMcpSchema({ type: 'object', properties: { value: { $ref: '#/$defs/value' } }, $defs: { value: { type: 'string' } } });
    expect(() => validate({ value: 'ok' })).not.toThrow();
    expect(() => validate({ value: 2 })).toThrow('MCP_SCHEMA_VALIDATION_FAILED');
    expect(() => validate({ value: 'x'.repeat(256 * 1024) })).toThrow('MCP_VALUE_LIMIT');
    let nested: unknown = {}; for (let i = 0; i < 35; i++) nested = { nested };
    expect(() => validate(nested)).toThrow('MCP_VALUE_LIMIT');
  });
});
