import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/main/adapters/ClaudeCodeAdapter';
import { AGENT_PROTOCOL_VERSION, type SendMessageCommand, type ResolveAuthorizationCommand } from '../../src/shared/agentProtocol';
import type { Options, PermissionResult } from '../../src/main/adapters/ClaudeCliTransport';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AsteriumRuntimeToolController } from '../../src/main/runtime/AsteriumRuntimeTools';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { asteriumDynamicTools } from '../../src/main/adapters/CodexCliAdapter';
import { memoryToolDescription, type MemoryToolName } from '../../src/main/runtime/MemoryToolGuidance';

const sdk = vi.hoisted(() => ({ query: vi.fn(), server: vi.fn((input: unknown) => input), tool: vi.fn((name: string, description: string, schema: unknown, callback: unknown) => ({ name, description, schema, callback })) }));
vi.mock('../../src/main/adapters/ClaudeCliTransport', () => ({ query: sdk.query, createClaudeToolSet: sdk.server, tool: sdk.tool }));

function command(): SendMessageCommand {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'c', partnerId: 'p', conversationId: 'chat',
    connectionSource: 'local_cli', clientMessageId: 'client', content: { type: 'text', text: '原始消息' },
    sessionBootstrapVersion: 1,
    sessionBootstrap: { version: 1, content: '[启动快照]\n人设\n记忆规则', createdAt: '2026-10-21T00:00:00.000Z', timeZone: 'Asia/Shanghai' },
  };
}

function memoryController(access: 'read' | 'write' = 'write'): AsteriumRuntimeToolController {
  return {
    status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), update: vi.fn(),
    memory: { access, search: vi.fn(async () => '[]'), readSource: vi.fn(async () => '[]'), hold: vi.fn(async () => '{}'), comment: vi.fn(async () => '{}'), update: vi.fn(async () => '{}') },
  };
}

describe('Claude CLI bootstrap transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.query.mockImplementation(() => Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', model: 'test-model' };
      yield { type: 'result', subtype: 'success', result: '完成', is_error: false };
    })(), { close: vi.fn() }));
  });

  it('rejects cross-conversation approval without consuming the card, then consumes one valid answer only', async () => {
    let decision: PermissionResult | undefined;
    sdk.query.mockImplementation(({ options }: { options: Options }) => Object.assign((async function* () {
      yield { type: 'system', subtype: 'init' };
      decision = await options.canUseTool!('Write', { file_path: 'fixture-output.txt', content: 'synthetic' }, { signal: options.abortController!.signal, toolUseID: 'write', requestId: 'write' });
      yield { type: 'result', subtype: 'success', result: 'done' };
    })(), { close: vi.fn() }));
    const adapter = new ClaudeCodeAdapter('claude.exe', process.cwd());
    try {
      for await (const event of adapter.sendMessage(command())) if (event.type === 'authorization.requested') {
        const answer: ResolveAuthorizationCommand = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'authorization.resolve', commandId: 'answer', partnerId: event.partnerId, conversationId: event.conversationId, connectionSource: event.connectionSource, clientMessageId: event.clientMessageId, sessionId: event.sessionId, runId: event.runId, authorizationId: event.authorizationId, decision: 'deny' };
        await expect(adapter.resolveAuthorization({ ...answer, conversationId: 'other' })).rejects.toThrow('CLAUDE_AUTHORIZATION_ROUTE_MISMATCH');
        await adapter.resolveAuthorization(answer);
        await expect(adapter.resolveAuthorization(answer)).rejects.toThrow('CLAUDE_AUTHORIZATION_NOT_FOUND');
      }
      expect(decision).toMatchObject({ behavior: 'deny' });
    } finally { await adapter.dispose(); }
  });

  it.each(['manual', 'full', 'read_only'] as const)('keeps protected relative paths blocked in %s without relying on hooks', async mode => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'asterium-cli-policy-'));
    const protectedRoot = path.join(workspace, 'protected');
    await mkdir(protectedRoot); await writeFile(path.join(protectedRoot, 'fixture.txt'), 'synthetic'); await writeFile(path.join(workspace, 'public.txt'), 'synthetic');
    const adapter = new ClaudeCodeAdapter('claude.exe', workspace, undefined, undefined, [], undefined, undefined, [protectedRoot]);
    try {
      for await (const event of adapter.sendMessage({ ...command(), execution: { permissionMode: mode, planMode: 'default' } })) expect(event.type).toBeTruthy();
      const options = sdk.query.mock.calls.at(-1)![0].options as Options;
      const context = { signal: new AbortController().signal, toolUseID: 'read', requestId: 'read' };
      expect(await options.canUseTool!('Read', { file_path: 'protected/fixture.txt' }, context)).toMatchObject({ behavior: 'deny' });
      expect(await options.canUseTool!('Read', { file_path: 'public.txt' }, context)).toMatchObject({ behavior: 'allow' });
      if (mode === 'read_only') expect(await options.canUseTool!('PowerShell', { command: 'Write-Output synthetic' }, context)).toMatchObject({ behavior: 'deny' });
    } finally { await adapter.dispose(); await rm(workspace, { recursive: true, force: true }); }
  });

  it('blocks protected data hidden inside an encoded native command in Full mode', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'asterium-cli-native-boundary-'));
    const workspace = path.join(fixture, 'workspace'), protectedRoot = path.join(fixture, 'protected');
    await mkdir(workspace); await mkdir(protectedRoot);
    const canary = path.join(protectedRoot, 'canary.txt');
    await writeFile(canary, 'ASTERIUM_PROTECTED_FIXTURE_CANARY');
    const adapter = new ClaudeCodeAdapter('claude.exe', workspace, undefined, undefined, [], undefined, undefined, [protectedRoot]);
    const run = adapter.sendMessage({ ...command(), execution: { permissionMode: 'full', planMode: 'default' } })[Symbol.asyncIterator]();
    try {
      await run.next(); // Keep the real adapter run active while inspecting its main approval callback.
      const options = sdk.query.mock.calls.at(-1)![0].options as Options;
      const context = { signal: new AbortController().signal, toolUseID: 'boundary', requestId: 'boundary' };
      expect(await options.canUseTool!('Read', { file_path: canary }, context)).toMatchObject({ behavior: 'deny' });
      const encoded = Buffer.from(canary, 'utf16le').toString('base64');
      const script = `$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'));Get-Content -LiteralPath $p`;
      // Expected protection is deliberately retained. This fails until the native
      // execution boundary is resolved; it must not be skipped to produce a candidate.
      expect(await options.canUseTool!('PowerShell', { command: script }, context)).toMatchObject({ behavior: 'deny' });
    } finally { await run.return?.(undefined); await adapter.dispose(); await rm(fixture, { recursive: true, force: true }); }
  });

  it('puts the exact snapshot in system append, preserving user input and reusing it on resume', async () => {
    const controller = memoryController();
    const adapter = new ClaudeCodeAdapter('claude.exe', 'K:\\qa', undefined, undefined, [], undefined, controller);
    for await (const event of adapter.sendMessage(command())) expect(event.type).toBeTruthy();
    const first = sdk.query.mock.calls.at(-1)![0];
    expect(first.prompt).toBe('原始消息');
    expect(first.options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code', snapshot: true });
    expect(first.options.systemPrompt.append.match(/\[启动快照\]/gu)).toHaveLength(1);
    expect(first.options.systemPrompt.append).not.toContain('星丛提供 asterium_status');
    expect(sdk.server.mock.calls.at(-1)![0]).toMatchObject({ instructions: undefined });
    for await (const event of adapter.sendMessage({ ...command(), sessionId: 'native-thread' })) expect(event.type).toBeTruthy();
    const resumed = sdk.query.mock.calls.at(-1)![0];
    expect(resumed.options.resume).toBe('native-thread');
    expect(resumed.options.systemPrompt.append).toBe(first.options.systemPrompt.append);
    expect(resumed.prompt).toBe('原始消息');
    await adapter.dispose();
  });

  it.each(['write', 'read', 'none'] as const)('registers identical memory descriptions and permissions in all three runtimes: %s', async (access) => {
    const controller = memoryController(access === 'read' ? 'read' : 'write');
    if (access === 'none') delete controller.memory;
    if (access === 'read') controller.workflowDraft = vi.fn(async () => '{}');
    const adapter = new ClaudeCodeAdapter('claude.exe', 'K:\\qa', undefined, undefined, [], undefined, controller);
    for await (const event of adapter.sendMessage(command())) expect(event.type).toBeTruthy();
    const server = sdk.server.mock.calls.at(-1)![0] as { tools: Array<{ name: string; description: string }> };
    const select = (definitions: Array<{ name: string; description: string }>) => definitions
      .filter((tool) => ['search_memory', 'read_memory_source', 'hold_memory', 'comment_memory', 'update_memory'].includes(tool.name))
      .map(({ name, description }) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name));
    const api = select(new ApiAgentTools(undefined, [], undefined, controller).definitions);
    const codex = select(asteriumDynamicTools(controller));
    const claude = select(server.tools);
    expect(codex).toEqual(api);
    expect(claude).toEqual(api);
    expect(api).toHaveLength(access === 'write' ? 5 : access === 'read' ? 2 : 0);
    for (const tool of api) expect(tool.description).toBe(memoryToolDescription(tool.name as MemoryToolName, access === 'read'));
    const sdkOptions = sdk.query.mock.calls.at(-1)![0].options;
    const allowedMemory = sdkOptions.allowedTools.filter((name: string) => /(?:search_memory|read_memory_source|hold_memory|comment_memory|update_memory)$/u.test(name));
    expect(allowedMemory).toHaveLength(api.length);
    await adapter.dispose();
  });
});
