import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/main/adapters/ClaudeCodeAdapter';
import { AGENT_PROTOCOL_VERSION, type SendMessageCommand } from '../../src/shared/agentProtocol';
import type { AsteriumRuntimeToolController } from '../../src/main/runtime/AsteriumRuntimeTools';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { asteriumDynamicTools } from '../../src/main/adapters/CodexCliAdapter';
import { memoryToolDescription, type MemoryToolName } from '../../src/main/runtime/MemoryToolGuidance';

const sdk = vi.hoisted(() => ({ query: vi.fn(), server: vi.fn((input: unknown) => input), tool: vi.fn((name: string, description: string, schema: unknown, callback: unknown) => ({ name, description, schema, callback })) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query, createSdkMcpServer: sdk.server, tool: sdk.tool }));

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

describe('Claude SDK bootstrap transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.query.mockImplementation(() => Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', model: 'test-model' };
      yield { type: 'result', subtype: 'success', result: '完成', is_error: false };
    })(), { close: vi.fn() }));
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
