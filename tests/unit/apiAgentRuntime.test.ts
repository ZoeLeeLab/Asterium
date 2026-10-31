import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiAgentSessionStore } from '../../src/main/api/ApiAgentSessionStore';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { ApiWebTools } from '../../src/main/api/ApiWebTools';
import { ApiAgentRuntime } from '../../src/main/api/ApiAgentRuntime';
import { ApiToolRegistry } from '../../src/main/api/ApiToolRegistry';
import { ApiPartnerAdapter } from '../../src/main/adapters/ApiPartnerAdapter';
import type { ApiProviderAdapter, ApiProviderRequest, ApiProviderStreamEvent } from '../../src/main/api/ApiProviderAdapter';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-api-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
}

function command(): SendMessageCommand {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'message.send',
    commandId: 'command-1',
    partnerId: 'partner-1',
    conversationId: 'conversation-1',
    connectionSource: 'api_partner',
    clientMessageId: 'client-1',
    content: { type: 'text', text: '读取文件后回答' },
    apiContext: { systemPrompt: '你是测试伙伴', history: [], apiSessionHistoryEnabled: true },
  };
}

async function collect(stream: AsyncIterable<PartnerEvent>) {
  const events: PartnerEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function collectDenyingPrompts(runtime: ApiAgentRuntime, input: SendMessageCommand) {
  const events: PartnerEvent[] = [];
  for await (const event of runtime.sendMessage(input)) {
    events.push(event);
    const context = { protocolVersion: AGENT_PROTOCOL_VERSION, commandId: `reject-${event.eventId}`, partnerId: event.partnerId, conversationId: event.conversationId, connectionSource: 'api_partner' as const, clientMessageId: event.clientMessageId, sessionId: event.sessionId, runId: event.runId };
    if (event.type === 'authorization.requested') await runtime.resolveAuthorization({ ...context, type: 'authorization.resolve', authorizationId: event.authorizationId, decision: 'deny' });
    if (event.type === 'user_input.requested') await runtime.resolveUserInput({ ...context, type: 'user_input.resolve', requestId: event.requestId, answers: { 'plan-execution': ['暂不执行'] } });
  }
  return events;
}

function response(events: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const value of events) controller.enqueue(encoder.encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), { status: 200 });
}

function scriptedProvider(rounds: ApiProviderStreamEvent[][], requests: ApiProviderRequest[] = []): ApiProviderAdapter {
  let round = 0;
  return {
    provider: 'scripted-api',
    capabilities: {
      streamingText: true,
      reasoning: true,
      toolCalls: true,
      attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' },
    },
    async *stream(request) {
      requests.push(request);
      for (const event of rounds[round++] ?? []) yield event;
    },
  };
}

function toolRound(id: string, name: string, args: Record<string, unknown>): ApiProviderStreamEvent[] {
  return [
    { type: 'tool.delta', index: 0, id, name, arguments: JSON.stringify(args) },
    { type: 'finish', reason: 'tool_calls' },
  ];
}

function textRound(text: string): ApiProviderStreamEvent[] {
  return [{ type: 'text.delta', text }, { type: 'finish', reason: 'stop' }];
}

describe('ApiAgentRuntime loop', () => {
  it('overrides stale tool claims when disabled, keeps XML as inert text, then discovers automation on the same session after opt-in', async () => {
    const store = new ApiAgentSessionStore(await tempDirectory());
    const requests: ApiProviderRequest[] = [];
    const status = vi.fn(async () => '{}'), automation = vi.fn(async () => '{"automations":[]}');
    const tools = new ApiAgentTools(undefined, [], undefined, { status, workspace: vi.fn(async () => '{}'), update: vi.fn(), automation });
    const snapshot = { version: 1 as const, content: '旧启动资料：星丛提供 asterium_status 和工作区；没有介绍自动化。', createdAt: new Date().toISOString(), timeZone: 'Asia/Shanghai' };
    const disabled = new ApiAgentRuntime({ provider: scriptedProvider([textRound('<asterium_status key="time" />')], requests), toolsEnabled: false, tools, sessionStore: store });
    const first = await collect(disabled.sendMessage({ ...command(), sessionBootstrap: snapshot }));
    expect(requests[0].tools).toEqual([]);
    expect(requests[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.stringContaining('本轮没有提供任何可调用工具') })]));
    expect(first.some(e => e.type === 'tool.started' || e.type === 'tool.completed')).toBe(false);
    expect(status).not.toHaveBeenCalled(); expect(automation).not.toHaveBeenCalled();
    const enabled = new ApiAgentRuntime({ provider: scriptedProvider([toolRound('auto-list', 'asterium_automation', { action: 'list' }), textRound('已找到自动化工具')], requests), toolsEnabled: true, tools, sessionStore: store });
    const second = await collect(enabled.sendMessage({ ...command(), sessionId: first[0].sessionId, clientMessageId: 'opted-in', content: { type: 'text', text: '查看自动化工具' } }));
    expect(requests[1].tools.some(t => t.name === 'asterium_automation')).toBe(true);
    expect(requests[1].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.stringContaining('本轮提供 asterium_automation') })]));
    expect(automation).toHaveBeenCalledWith({ action: 'list' }, expect.any(AbortSignal)); expect(status).not.toHaveBeenCalled();
    expect(second.at(-1)?.type).toBe('run.completed'); expect(second[0]).toMatchObject({ type: 'session.bound', isNew: false, sessionId: first[0].sessionId });
    expect((await store.load('partner-1', 'conversation-1'))?.bootstrapSystemPrompt).toBe(snapshot.content);
  });
  it('does not advertise automation when the adapter cannot call tools even with the model switch on', async () => {
    const requests: ApiProviderRequest[] = [], provider = scriptedProvider([textRound('工具不可用')], requests);
    provider.capabilities.toolCalls = false;
    const automation = vi.fn(async () => '{}');
    const tools = new ApiAgentTools(undefined, [], undefined, { status: async () => '{}', workspace: async () => '{}', update() {}, automation });
    await collect(new ApiAgentRuntime({ provider, toolsEnabled: true, tools }).sendMessage(command()));
    expect(requests[0].tools).toEqual([]);
    expect(requests[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.stringContaining('当前适配器或运行环境没有提供工具调用能力') })]));
    expect(automation).not.toHaveBeenCalled();
  });
  it.each([
    { permissionMode: 'read_only', planMode: 'default' },
    { permissionMode: 'manual', planMode: 'default' },
    { permissionMode: 'automatic', planMode: 'default' },
    { permissionMode: 'full', planMode: 'default' },
    { permissionMode: 'full', planMode: 'plan' },
  ] as const)('rejects unregistered and invalid calls before approval in $permissionMode / $planMode', async (execution) => {
    const workspacePath = await tempDirectory();
    const status = vi.fn(async () => '{}');
    const workspace = vi.fn(async () => '{}');
    const requests: ApiProviderRequest[] = [];
    const cases = [
      toolRound('unknown', 'mcp__missing__write', {}),
      toolRound('prototype', 'toString', {}),
      toolRound('unavailable', 'read_attachment_text', { attachment_id: 'not-attached' }),
      toolRound('bad-type', 'write_file', { path: 'blocked.md', content: 42 }),
      toolRound('empty-content', 'write_file', { path: 'blocked.md', content: '' }),
      toolRound('extra-argument', 'write_file', { path: 'blocked.md', content: 'no', extra: true }),
      toolRound('invalid-enum', 'asterium_status', { key: 'unknown' }),
      toolRound('invalid-workspace', 'asterium_workspace', { action: 'unknown' }),
      [{ type: 'tool.delta' as const, index: 0, id: 'bad-json', name: 'write_file', arguments: '{"path":' }, { type: 'finish' as const, reason: 'tool_calls' }],
    ];
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([...cases, textRound('没有执行无效请求。')], requests),
      tools: new ApiAgentTools(workspacePath, [], undefined, { status, workspace, update: vi.fn() }),
    });
    const events = await collectDenyingPrompts(runtime, { ...command(), execution });
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(cases.length);
    expect(events.filter((event) => event.type === 'tool.completed').every((event) => event.outcome === 'failure')).toBe(true);
    expect(events.some((event) => event.type === 'authorization.requested' || event.type === 'file.produced')).toBe(false);
    expect(events.filter((event) => event.type === 'tool.started').every((event) => event.mutatesExternalState)).toBe(true);
    expect(status).not.toHaveBeenCalled();
    expect(workspace).not.toHaveBeenCalled();
    await expect(readFile(path.join(workspacePath, 'blocked.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('TOOL_NOT_AVAILABLE');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('TOOL_ARGUMENTS_INVALID_JSON');
  });

  it('uses registered Plan policy for reads, managed memory, and blocked workspace operations', async () => {
    const workspacePath = await tempDirectory();
    await writeFile(path.join(workspacePath, 'reference.md'), 'reference');
    const hold = vi.fn(async () => '{}');
    const workspace = vi.fn(async () => '{}');
    const notebook = vi.fn(async () => '{}');
    const task = vi.fn(async () => '{}');
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([
        toolRound('list', 'list_directory', {}),
        toolRound('read', 'read_file', { path: 'reference.md' }),
        toolRound('memory', 'hold_memory', { type: 'stable_fact', body: '已有的 Main 记忆授权' }),
        toolRound('workspaces', 'asterium_workspace', { action: 'list' }),
        toolRound('write', 'write_file', { path: 'blocked.md', content: 'no' }),
        toolRound('command', 'run_command', { command: 'Write-Output unexpected' }),
        toolRound('workspace-add', 'asterium_workspace', { action: 'add', path: workspacePath }),
        toolRound('notebook', 'project_notebook', { action: 'append', project_id: 'p', content: 'no' }),
        toolRound('task', 'asterium_task', { action: 'context' }),
        toolRound('delivery', 'deliver_file', { path: 'reference.md' }),
        textRound('只完成调查。'),
      ]),
      tools: new ApiAgentTools(workspacePath, [], undefined, {
        status: vi.fn(async () => '{}'), workspace, update: vi.fn(), task, projectNotebook: notebook,
        memory: { access: 'write', hold, search: vi.fn(async () => '[]'), readSource: vi.fn(async () => '{}') },
      }),
    });
    const events = await collectDenyingPrompts(runtime, { ...command(), execution: { permissionMode: 'full', planMode: 'plan' } });
    for (const id of ['list', 'read', 'memory', 'workspaces']) expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool.completed', toolCallId: id, outcome: 'success' })]));
    for (const id of ['write', 'command', 'workspace-add', 'notebook', 'task', 'delivery']) expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool.completed', toolCallId: id, outcome: 'failure', detail: expect.stringContaining('ASTERIUM_PLAN_READ_ONLY') })]));
    expect(hold).toHaveBeenCalledOnce();
    expect(workspace).toHaveBeenCalledExactlyOnceWith('list', undefined);
    expect(notebook).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'authorization.requested' || event.type === 'file.produced')).toBe(false);
    await expect(readFile(path.join(workspacePath, 'blocked.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('can run a registered Plan read without adding its name to a runtime allowlist', async () => {
    const registry = new ApiToolRegistry();
    const execute = vi.fn(async () => ({ content: 'registered read result' }));
    registry.register({
      definition: { name: 'new_read_tool', description: 'New read capability', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      source: 'asterium', allowInPlan: true,
      describe: () => ({ mutates: false, action: 'read_file', risk: 'low', summary: 'Read', targets: [] }),
      execute,
    });
    const tools = new ApiAgentTools(undefined);
    vi.spyOn(tools, 'prepare').mockImplementation((name, args) => registry.prepare(name, args));
    vi.spyOn(tools, 'definitions', 'get').mockImplementation(() => registry.definitions);
    const runtime = new ApiAgentRuntime({ provider: scriptedProvider([toolRound('new-read', 'new_read_tool', {}), textRound('计划完成。')]), tools });
    const events = await collectDenyingPrompts(runtime, { ...command(), execution: { permissionMode: 'read_only', planMode: 'plan' } });
    expect(execute).toHaveBeenCalledOnce();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool.completed', toolCallId: 'new-read', outcome: 'success' })]));
    expect(events.some((event) => event.type === 'authorization.requested')).toBe(false);
  });

  it('persists one assembled system snapshot across tool continuations and fresh runtime instances', async () => {
    const directory = await tempDirectory();
    const store = new ApiAgentSessionStore(directory);
    const requests: ApiProviderRequest[] = [];
    const tools = new ApiAgentTools(undefined, [], undefined, {
      status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), update: vi.fn(),
    });
    const snapshot = { version: 1 as const, content: '平台\n用户\n人设\n规则\n简报\n启动时间', createdAt: new Date().toISOString(), timeZone: 'Asia/Shanghai' };
    const firstRuntime = new ApiAgentRuntime({ provider: scriptedProvider([toolRound('status', 'asterium_status', { key: 'time' }), textRound('第一轮')], requests), tools, sessionStore: store });
    const first = await collect(firstRuntime.sendMessage({ ...command(), sessionBootstrap: snapshot, sessionBootstrapVersion: 1 }));
    const restored = new ApiAgentRuntime({ provider: scriptedProvider([textRound('重启后')], requests), tools, sessionStore: new ApiAgentSessionStore(directory) });
    await collect(restored.sendMessage({ ...command(), sessionId: first[0].sessionId, clientMessageId: 'client-2', content: { type: 'text', text: '继续' }, apiContext: { history: [] } }));
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.messages.filter(message => message.role === 'system' && message.content === snapshot.content)).toHaveLength(1);
      expect(request.messages.filter(message => message.role === 'system' && typeof message.content === 'string' && message.content.startsWith('[本轮工具状态]'))).toHaveLength(1);
      expect(request.messages.filter((message) => message.role === 'user').some((message) => typeof message.content === 'string' && message.content.includes('平台'))).toBe(false);
    }
    expect(await store.load('partner-1', 'conversation-1')).toMatchObject({ bootstrapVersion: 1, bootstrapSystemPrompt: snapshot.content });
  });

  it('allows managed memory writes in read-only file mode without an authorization prompt', async () => {
    const hold = vi.fn(async () => '{"memoryId":"memory-1"}');
    const tools = new ApiAgentTools(undefined, [], undefined, {
      status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), update: vi.fn(),
      memory: {
        access: 'write', hold, search: vi.fn(async () => '[]'), readSource: vi.fn(async () => '[]'),
        comment: vi.fn(async () => '{}'), update: vi.fn(async () => '{}'),
      },
    });
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([toolRound('memory-hold', 'hold_memory', { type: 'stable_fact', body: '长期事实' }), textRound('记住了')]),
      tools,
    });
    const events = await collect(runtime.sendMessage({ ...command(), execution: { permissionMode: 'read_only', planMode: 'default' } }));
    expect(hold).toHaveBeenCalledWith(expect.objectContaining({ type: 'stable_fact', body: '长期事实' }));
    expect(events.some((event) => event.type === 'authorization.requested')).toBe(false);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run.completed' })]));
  });

  it('runs project notebook updates as Main-owned data without file authorization', async () => {
    const requests: ApiProviderRequest[] = [];
    const projectNotebook = vi.fn(async () => '{"projectId":"project-a","revision":2}');
    const tools = new ApiAgentTools(undefined, [], undefined, {
      status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), update: vi.fn(), projectNotebook,
    });
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([toolRound('notebook-append', 'project_notebook', { action: 'append', project_id: 'project-a', content: '新进展' }), textRound('已记录')], requests),
      tools,
    });
    const events = await collect(runtime.sendMessage({ ...command(), execution: { permissionMode: 'read_only', planMode: 'default' } }));

    expect(projectNotebook).toHaveBeenCalledWith({ action: 'append', projectId: 'project-a', content: '新进展' });
    expect(events.some((event) => event.type === 'authorization.requested')).toBe(false);
    expect(requests[0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'project_notebook' })]));
    expect(requests[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.stringContaining('不是长期记忆系统') })]));
  });

  it('does not turn partner public profiles or the global roster into an automatic system message', async () => {
    const requests: ApiProviderRequest[] = [];
    const adapter = new ApiAgentRuntime({ provider: scriptedProvider([textRound('好')], requests) });
    await collect(adapter.sendMessage({
      ...command(),
      runtimeContext: {
        partner: { displayName: '测试伙伴', introduction: '公开介绍不应注入', expertise: '公开擅长不应注入', mentionName: '鲸鱼', avatarAvailable: false, personality: '私人人设' },
        user: { displayName: '用户', introduction: '用户资料' },
        runtime: { source: 'api_partner', provider: 'deepseek', model: 'deepseek-current' },
        partners: [{ partnerId: 'partner-2', displayName: '其他伙伴', mentionName: '其他伙伴', expertise: '架构', model: 'model-x', modelStatus: 'current' }],
      },
    }));

    const serialized = JSON.stringify(requests[0].messages);
    expect(serialized).toContain('你是测试伙伴');
    expect(serialized).not.toContain('公开介绍不应注入');
    expect(serialized).not.toContain('公开擅长不应注入');
    expect(serialized).not.toContain('其他伙伴');
  });

  it('captures single-chat bootstrap context once and reuses the session copy on later turns', async () => {
    const sessions = await tempDirectory();
    const requests: ApiProviderRequest[] = [];
    const store = new ApiAgentSessionStore(sessions);
    const adapter = new ApiAgentRuntime({
      provider: scriptedProvider([textRound('第一轮'), textRound('第二轮')], requests),
      sessionStore: store,
    });
    const first = await collect(adapter.sendMessage({ ...command(), apiContext: { systemPrompt: '只在新窗口提供的启动资料', history: [], apiSessionHistoryEnabled: true } }));
    const sessionId = first.find((event) => event.type === 'session.bound')?.sessionId;
    await collect(adapter.sendMessage({
      ...command(),
      commandId: 'command-2',
      clientMessageId: 'client-2',
      sessionId,
      content: { type: 'text', text: '继续' },
      apiContext: { history: [], apiSessionHistoryEnabled: true },
    }));

    expect(requests).toHaveLength(2);
    expect(requests[0].messages[0]).toEqual({ role: 'system', content: '只在新窗口提供的启动资料' });
    expect(requests[1].messages[0]).toEqual({ role: 'system', content: '只在新窗口提供的启动资料' });
    expect(requests[1].messages).toEqual(expect.arrayContaining([
      { role: 'assistant', content: '第一轮', reasoningContent: '' },
    ]));
    expect((await store.load('partner-1', 'conversation-1'))?.bootstrapSystemPrompt).toBe('只在新窗口提供的启动资料');
  });

  it('uses the renamed API session-history flag and keeps the legacy alias compatible', async () => {
    const sessions = await tempDirectory();
    const requests: ApiProviderRequest[] = [];
    const store = new ApiAgentSessionStore(sessions);
    await store.remember({
      version: 1,
      partnerId: 'partner-1',
      conversationId: 'conversation-1',
      provider: 'scripted-api',
      turns: [{ clientMessageId: 'old-client', userContent: '不得载入的旧内容', messages: [{ role: 'assistant', content: '旧回答', reasoningContent: '' }], completedAt: '2026-10-01T00:00:00.000Z' }],
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    const runtime = new ApiAgentRuntime({ provider: scriptedProvider([textRound('无历史回答'), textRound('兼容回答')], requests), sessionStore: store });

    await collect(runtime.sendMessage({
      ...command(),
      apiContext: { history: [], apiSessionHistoryEnabled: false, memoryEnabled: true },
    }));
    expect(JSON.stringify(requests[0].messages)).not.toContain('不得载入的旧内容');
    expect((await store.load('partner-1', 'conversation-1'))?.turns).toHaveLength(1);

    await collect(runtime.sendMessage({
      ...command(),
      conversationId: 'legacy-conversation',
      clientMessageId: 'legacy-client',
      apiContext: { history: [], memoryEnabled: true },
    }));
    expect((await store.load('partner-1', 'legacy-conversation'))?.turns).toHaveLength(1);
  });

  it('binds the configured runtime model to this conversation', async () => {
    const provider = scriptedProvider([[{ type: 'text.delta', text: '好' }, { type: 'finish', reason: 'stop' }]]);
    const adapter = new ApiAgentRuntime({ provider });
    const events = await collect(adapter.sendMessage({ ...command(), runtimeContext: { partner: { displayName: '测试伙伴', introduction: '', expertise: '', mentionName: '测试伙伴', avatarAvailable: false }, runtime: { source: 'api_partner', provider: 'deepseek', model: 'deepseek-current' } } }));
    expect(events[0]).toMatchObject({ type: 'session.bound', model: 'deepseek-current', modelSource: 'runtime' });
  });
  it('replays complete reasoning, tool call and tool result into the continuation request', async () => {
    const workspace = await tempDirectory();
    const sessions = await tempDirectory();
    await writeFile(path.join(workspace, 'notes.txt'), 'hello whale', 'utf8');
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) return response([
        { choices: [{ delta: { reasoning_content: '需要先读取文件。' }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } }] }, finish_reason: 'tool_calls' }] },
      ]);
      return response([
        { choices: [{ delta: { reasoning_content: '已经获得文件内容。' }, finish_reason: null }] },
        { choices: [{ delta: { content: '文件里写着 hello whale' }, finish_reason: 'stop' }] },
      ]);
    });
    const store = new ApiAgentSessionStore(sessions);
    const adapter = new ApiPartnerAdapter({ endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', apiKey: 'secret', fetcher, sessionStore: store, tools: new ApiAgentTools(workspace) });
    const events: PartnerEvent[] = [];
    for await (const event of adapter.sendMessage(command())) events.push(event);

    expect(events.filter((event) => event.type === 'reasoning.delta').map((event) => event.text).join('')).toBe('需要先读取文件。已经获得文件内容。');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.started', toolCallId: 'call-read' }),
      expect.objectContaining({ type: 'tool.completed', toolCallId: 'call-read', outcome: 'success' }),
      expect.objectContaining({ type: 'run.completed' }),
    ]));
    const continuation = bodies[1].messages as Array<Record<string, unknown>>;
    expect(continuation).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', reasoning_content: '需要先读取文件。', tool_calls: [expect.objectContaining({ id: 'call-read' })] }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-read', content: expect.stringContaining('hello whale') }),
    ]));
    expect((await store.load('partner-1', 'conversation-1'))?.turns[0].messages).toHaveLength(3);
  });

  it('pauses mutating tools for allow-once authorization and emits the produced file', async () => {
    const workspace = await tempDirectory();
    let request = 0;
    const fetcher = vi.fn(async () => {
      request += 1;
      if (request === 1) return response([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-write', function: { name: 'write_file', arguments: '{"path":"result.md","content":"done"}' } }] }, finish_reason: 'tool_calls' }] }]);
      return response([{ choices: [{ delta: { content: '已经写好。' }, finish_reason: 'stop' }] }]);
    });
    const adapter = new ApiPartnerAdapter({ endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', apiKey: 'secret', fetcher, tools: new ApiAgentTools(workspace) });
    const events: PartnerEvent[] = [];
    for await (const event of adapter.sendMessage(command())) {
      events.push(event);
      if (event.type === 'authorization.requested') await adapter.resolveAuthorization({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        type: 'authorization.resolve',
        commandId: 'authorize-1',
        partnerId: event.partnerId,
        conversationId: event.conversationId,
        connectionSource: 'api_partner',
        clientMessageId: event.clientMessageId,
        sessionId: event.sessionId,
        runId: event.runId,
        authorizationId: event.authorizationId,
        decision: 'allow_once',
      });
    }
    expect(await readFile(path.join(workspace, 'result.md'), 'utf8')).toBe('done');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'authorization.resolved', decision: 'allow_once' }),
      expect.objectContaining({ type: 'file.produced', registrationMethod: 'automatic' }),
    ]));
  });

  it('enforces read-only, automatic and full permission boundaries', async () => {
    const workspace = await tempDirectory();

    const readOnly = new ApiAgentRuntime({
      provider: scriptedProvider([toolRound('read-only-write', 'write_file', { path: 'blocked.md', content: 'no' }), textRound('没有修改。')]),
      tools: new ApiAgentTools(workspace),
    });
    const readOnlyEvents = await collect(readOnly.sendMessage({ ...command(), execution: { permissionMode: 'read_only', planMode: 'default' } }));
    await expect(readFile(path.join(workspace, 'blocked.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readOnlyEvents).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'authorization.requested' })]));
    expect(readOnlyEvents).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool.completed', outcome: 'failure', detail: expect.stringContaining('ASTERIUM_READ_ONLY') })]));

    const automatic = new ApiAgentRuntime({
      provider: scriptedProvider([toolRound('automatic-write', 'write_file', { path: 'automatic.md', content: 'yes' }), textRound('完成。')]),
      tools: new ApiAgentTools(workspace),
    });
    const automaticEvents = await collect(automatic.sendMessage({ ...command(), execution: { permissionMode: 'automatic', planMode: 'default' } }));
    expect(await readFile(path.join(workspace, 'automatic.md'), 'utf8')).toBe('yes');
    expect(automaticEvents).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'authorization.requested' })]));

    const protectedFile = path.join(workspace, 'protected.md');
    await writeFile(protectedFile, 'keep', 'utf8');
    const automaticDelete = new ApiAgentRuntime({
      provider: scriptedProvider([toolRound('automatic-delete', 'delete_path', { path: 'protected.md' }), textRound('已保留。')]),
      tools: new ApiAgentTools(workspace),
    });
    const automaticDeleteEvents: PartnerEvent[] = [];
    for await (const event of automaticDelete.sendMessage({ ...command(), execution: { permissionMode: 'automatic', planMode: 'default' } })) {
      automaticDeleteEvents.push(event);
      if (event.type === 'authorization.requested') await automaticDelete.resolveAuthorization({
        protocolVersion: AGENT_PROTOCOL_VERSION, type: 'authorization.resolve', commandId: 'deny-delete', partnerId: event.partnerId,
        conversationId: event.conversationId, connectionSource: 'api_partner', clientMessageId: event.clientMessageId,
        sessionId: event.sessionId, runId: event.runId, authorizationId: event.authorizationId, decision: 'deny',
      });
    }
    expect(await readFile(protectedFile, 'utf8')).toBe('keep');
    expect(automaticDeleteEvents).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'authorization.resolved', decision: 'deny' })]));

    const full = new ApiAgentRuntime({
      provider: scriptedProvider([toolRound('full-delete', 'delete_path', { path: 'protected.md' }), textRound('已删除。')]),
      tools: new ApiAgentTools(workspace),
    });
    const fullEvents = await collect(full.sendMessage({ ...command(), execution: { permissionMode: 'full', planMode: 'default' } }));
    await expect(readFile(protectedFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fullEvents).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'authorization.requested' })]));
  });

  it('registers an exact outside-workspace delivery without changing approval behavior', async () => {
    const workspace = await tempDirectory();
    const outside = await tempDirectory();
    const report = path.join(outside, 'final-report.pdf');
    await writeFile(report, 'final report', 'utf8');
    const requests: ApiProviderRequest[] = [];
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([toolRound('outside-delivery', 'deliver_file', { path: report, name: '最终报告.pdf' }), textRound('已交付。')], requests),
      tools: new ApiAgentTools(workspace),
    });

    const events = await collect(runtime.sendMessage({ ...command(), execution: { permissionMode: 'manual', planMode: 'default' } }));

    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'file.produced', name: '最终报告.pdf', artifactRef: expect.stringMatching(/[\\/]final-report\.pdf$/), registrationMethod: 'deliver_tool',
    })]));
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'authorization.requested' })]));
    expect(requests[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.stringContaining('星丛交付协议') })]));
  });

  it('emits create and modify metadata for API file writes', async () => {
    const workspace = await tempDirectory();
    await writeFile(path.join(workspace, 'existing.md'), 'before', 'utf8');
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([
        toolRound('create-file', 'write_file', { path: 'new.md', content: 'new' }),
        toolRound('modify-file', 'write_file', { path: 'existing.md', content: 'after' }),
        textRound('完成。'),
      ]),
      tools: new ApiAgentTools(workspace),
    });

    const events = await collect(runtime.sendMessage({ ...command(), execution: { permissionMode: 'full', planMode: 'default' } }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'file.produced', name: 'new.md', changeKind: 'create' }),
      expect.objectContaining({ type: 'file.produced', name: 'existing.md', changeKind: 'modify' }),
    ]));
  });

  it('keeps request_user_input exclusive to Plan mode', async () => {
    const requests: ApiProviderRequest[] = [];
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([
        toolRound('default-question', 'request_user_input', { questions: [{ id: 'choice', prompt: '请选择。', options: [{ label: 'A' }] }] }),
        textRound('请直接告诉我你的选择。'),
      ], requests),
    });

    const events = await collect(runtime.sendMessage({ ...command(), execution: { permissionMode: 'manual', planMode: 'default' } }));

    expect(requests[0].tools).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'request_user_input' })]));
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'user_input.requested' })]));
    expect(requests[1].messages).toEqual(expect.arrayContaining([expect.objectContaining({
      role: 'tool',
      content: expect.stringContaining('REQUEST_USER_INPUT_UNAVAILABLE_IN_DEFAULT_MODE'),
    })]));
  });

  it.each(['read_only', 'manual', 'automatic', 'full'] as const)('runs web tools without approval in %s mode', async (permissionMode) => {
    const fetcher = vi.fn(async () => new Response("<a href='https://example.com/current' class='result-link'>Current source</a><td class='result-snippet'>Fresh information</td>", { headers: { 'content-type': 'text/html' } }));
    const webTools = new ApiWebTools({ fetcher, lookupHost: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }] as never) });
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([toolRound('web-search', 'web_search', { query: 'current information' }), textRound('已核对来源。')]),
      tools: new ApiAgentTools(undefined, [], undefined, undefined, webTools),
    });

    const events = await collect(runtime.sendMessage({ ...command(), execution: { permissionMode, planMode: 'default' } }));

    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool.completed', toolCallId: 'web-search', outcome: 'success' })]));
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'authorization.requested' })]));
  });

  it('runs web tools without a workspace and keeps them available in Plan', async () => {
    const requests: ApiProviderRequest[] = [];
    const fetcher = vi.fn(async () => new Response("<a href='https://example.com/current' class='result-link'>Current source</a><td class='result-snippet'>Fresh information</td>", { headers: { 'content-type': 'text/html' } }));
    const webTools = new ApiWebTools({ fetcher, lookupHost: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }] as never) });
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([toolRound('web-search', 'web_search', { query: 'current information' }), textRound('计划：根据公开来源整理答案。')], requests),
      tools: new ApiAgentTools(undefined, [], undefined, undefined, webTools),
    });
    const events: PartnerEvent[] = [];
    for await (const event of runtime.sendMessage({ ...command(), execution: { permissionMode: 'read_only', planMode: 'plan' } })) {
      events.push(event);
      if (event.type === 'user_input.requested') await runtime.resolveUserInput({
        protocolVersion: AGENT_PROTOCOL_VERSION, type: 'user_input.resolve', commandId: 'decline-web-plan', partnerId: event.partnerId,
        conversationId: event.conversationId, connectionSource: 'api_partner', clientMessageId: event.clientMessageId,
        sessionId: event.sessionId, runId: event.runId, requestId: event.requestId, answers: { 'plan-execution': ['暂不执行'] },
      });
    }

    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool.completed', toolCallId: 'web-search', outcome: 'success' })]));
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'authorization.requested' })]));
    expect(requests[0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'web_search' }), expect.objectContaining({ name: 'web_fetch' })]));
    expect(requests[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.stringContaining('星丛联网工具') })]));
    expect(JSON.stringify(requests[1].messages)).toContain('https://example.com/current');
  });

  it('suggests requesting a workspace when an API read tool needs directory-level outside access', async () => {
    const workspace = await tempDirectory();
    const outside = await tempDirectory();
    const outsideFile = path.join(outside, 'reference.txt');
    await writeFile(outsideFile, 'outside', 'utf8');
    const requests: ApiProviderRequest[] = [];
    const runtimeTools = {
      status: vi.fn(async () => '{}'),
      workspace: vi.fn(async () => '{}'),
      update: vi.fn(),
    };
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([
        toolRound('outside-read', 'read_file', { path: outsideFile }),
        textRound('我需要先申请加入这个目录。'),
      ], requests),
      tools: new ApiAgentTools(workspace, [], undefined, runtimeTools),
    });

    const events = await collect(runtime.sendMessage({ ...command(), execution: { permissionMode: 'manual', planMode: 'default' } }));

    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'tool.completed',
      outcome: 'failure',
      detail: expect.stringContaining('asterium_workspace'),
    })]));
    expect(requests[1].messages).toEqual(expect.arrayContaining([expect.objectContaining({
      role: 'tool',
      content: expect.stringContaining('下一轮'),
    })]));
    expect(requests[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('只有任务需要反复读取'),
    })]));
  });

  it('requests one-time approval for an exact outside write in manual mode without adding its directory to the workspace', async () => {
    const workspace = await tempDirectory();
    const outside = await tempDirectory();
    const target = path.join(outside, 'one-time.md');
    const tools = new ApiAgentTools(workspace);
    const requests: ApiProviderRequest[] = [];
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([
        toolRound('outside-write', 'write_file', { path: target, content: 'approved once' }),
        toolRound('outside-readback', 'read_file', { path: target }),
        textRound('写入并回读验证完成。'),
      ], requests),
      tools,
    });
    const events: PartnerEvent[] = [];
    for await (const event of runtime.sendMessage({ ...command(), execution: { permissionMode: 'manual', planMode: 'default' } })) {
      events.push(event);
      if (event.type === 'authorization.requested') {
        expect(event).toMatchObject({ purpose: 'operation', summary: expect.stringContaining('一次性写入工作区外'), targets: [expect.stringMatching(/[\\/]one-time\.md$/)] });
        await runtime.resolveAuthorization({
          protocolVersion: AGENT_PROTOCOL_VERSION, type: 'authorization.resolve', commandId: 'allow-outside', partnerId: event.partnerId,
          conversationId: event.conversationId, connectionSource: 'api_partner', clientMessageId: event.clientMessageId,
          sessionId: event.sessionId, runId: event.runId, authorizationId: event.authorizationId, decision: 'allow_once',
        });
      }
    }

    expect(await readFile(target, 'utf8')).toBe('approved once');
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'authorization.resolved', decision: 'allow_once' })]));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool.completed', toolCallId: 'outside-readback', outcome: 'success' })]));
    expect(requests[2].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', toolCallId: 'outside-readback', content: expect.stringContaining('approved once') })]));
    await expect(tools.execute('read_file', { path: target }, new AbortController().signal)).rejects.toThrow('TOOL_PATH_OUTSIDE_WORKSPACE');
  });

  it('allows an exact outside write without approval in full mode', async () => {
    const workspace = await tempDirectory();
    const outside = await tempDirectory();
    const target = path.join(outside, 'full-outside.md');
    const requests: ApiProviderRequest[] = [];
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([
        toolRound('outside-write', 'write_file', { path: target, content: 'full access' }),
        textRound('写入完成。'),
      ], requests),
      tools: new ApiAgentTools(workspace),
    });

    const events = await collect(runtime.sendMessage({ ...command(), execution: { permissionMode: 'full', planMode: 'default' } }));

    expect(await readFile(target, 'utf8')).toBe('full access');
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'authorization.requested' })]));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool.completed', toolCallId: 'outside-write', outcome: 'success' })]));
  });

  it('labels persistent workspace changes and keeps them interactive in automatic mode', async () => {
    const runtimeTools = { status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{"change":{"committed":true}}'), update: vi.fn() };
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([toolRound('workspace-add', 'asterium_workspace', { action: 'add', path: 'K:\\shared' }), textRound('已加入。')]),
      tools: new ApiAgentTools(undefined, [], undefined, runtimeTools),
    });
    const events: PartnerEvent[] = [];
    for await (const event of runtime.sendMessage({ ...command(), execution: { permissionMode: 'automatic', planMode: 'default' } })) {
      events.push(event);
      if (event.type === 'authorization.requested') {
        expect(event).toMatchObject({ purpose: 'workspace_add', targets: ['K:\\shared'] });
        await runtime.resolveAuthorization({
          protocolVersion: AGENT_PROTOCOL_VERSION, type: 'authorization.resolve', commandId: 'allow-workspace', partnerId: event.partnerId,
          conversationId: event.conversationId, connectionSource: 'api_partner', clientMessageId: event.clientMessageId,
          sessionId: event.sessionId, runId: event.runId, authorizationId: event.authorizationId, decision: 'allow_once',
        });
      }
    }

    expect(runtimeTools.workspace).toHaveBeenCalledWith('add', 'K:\\shared');
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run.completed' })]));
  });

  it('applies persistent workspace additions and removals without approval in full mode', async () => {
    const runtimeTools = { status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{"change":{"committed":true}}'), update: vi.fn() };
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([
        toolRound('workspace-add-full', 'asterium_workspace', { action: 'add', path: 'K:\\shared' }),
        toolRound('workspace-remove-full', 'asterium_workspace', { action: 'remove', path: 'K:\\shared' }),
        textRound('已更新。'),
      ]),
      tools: new ApiAgentTools(undefined, [], undefined, runtimeTools),
    });
    const events = await collect(runtime.sendMessage({ ...command(), execution: { permissionMode: 'full', planMode: 'default' } }));

    expect(runtimeTools.workspace).toHaveBeenNthCalledWith(1, 'add', 'K:\\shared');
    expect(runtimeTools.workspace).toHaveBeenNthCalledWith(2, 'remove', 'K:\\shared');
    expect(events.some((event) => event.type === 'authorization.requested')).toBe(false);
  });

  it('returns clarification answers to the provider and executes an approved plan with the selected permission mode', async () => {
    const workspace = await tempDirectory();
    const sessions = await tempDirectory();
    const requests: ApiProviderRequest[] = [];
    const updates: unknown[] = [];
    const provider = scriptedProvider([
      toolRound('clarify', 'request_user_input', { questions: [{ id: 'format', header: '格式', prompt: '使用哪种格式？', options: [{ label: 'Markdown' }, { label: '纯文本' }] }] }),
      textRound('计划：创建一个 Markdown 文件。'),
      toolRound('write-after-plan', 'write_file', { path: 'planned.md', content: '# done' }),
      textRound('已按计划完成。'),
    ], requests);
    const runtimeTools = {
      status: vi.fn(async () => '{}'),
      workspace: vi.fn(async () => '{}'),
      update: vi.fn((value: unknown) => updates.push(value)),
    };
    const store = new ApiAgentSessionStore(sessions);
    const runtime = new ApiAgentRuntime({ provider, sessionStore: store, tools: new ApiAgentTools(workspace, [], undefined, runtimeTools) });
    const events: PartnerEvent[] = [];
    for await (const event of runtime.sendMessage({ ...command(), execution: { permissionMode: 'automatic', planMode: 'plan' } })) {
      events.push(event);
      if (event.type === 'user_input.requested') {
        const planDecision = event.questions.some((question) => question.id === 'plan-execution');
        await runtime.resolveUserInput({
          protocolVersion: AGENT_PROTOCOL_VERSION, type: 'user_input.resolve', commandId: `answer-${event.requestId}`,
          partnerId: event.partnerId, conversationId: event.conversationId, connectionSource: 'api_partner',
          clientMessageId: event.clientMessageId, sessionId: event.sessionId, runId: event.runId, requestId: event.requestId,
          answers: planDecision ? { 'plan-execution': ['开始执行 (Recommended)'] } : { format: ['Markdown'] },
        });
      }
    }

    expect(await readFile(path.join(workspace, 'planned.md'), 'utf8')).toBe('# done');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'plan.updated', status: 'planning', planMode: 'plan' }),
      expect.objectContaining({ type: 'user_input.requested', questions: [expect.objectContaining({ id: 'format' })] }),
      expect.objectContaining({ type: 'plan.updated', status: 'ready', planMode: 'plan' }),
      expect.objectContaining({ type: 'plan.updated', status: 'executing', planMode: 'default' }),
      expect.objectContaining({ type: 'run.completed' }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'authorization.requested' })]));
    expect(JSON.stringify(requests[1].messages)).toContain('Markdown');
    expect(requests[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.stringContaining('星丛 Plan 模式') })]));
    expect(requests[0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'request_user_input' })]));
    expect(requests[2].messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.stringContaining('星丛 Plan 模式') })]));
    expect(requests[2].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: expect.stringContaining('已经确认开始执行') })]));
    expect(updates).toEqual([expect.objectContaining({ permissionMode: 'automatic', planMode: 'default' })]);
    expect((await store.load('partner-1', 'conversation-1'))?.turns[0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('已经确认开始执行') }),
    ]));
  });

  it('rejects mutations during Plan even with full permission and keeps the plan when execution is declined', async () => {
    const workspace = await tempDirectory();
    const sessions = await tempDirectory();
    const requests: ApiProviderRequest[] = [];
    const store = new ApiAgentSessionStore(sessions);
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([
        toolRound('blocked-plan-write', 'write_file', { path: 'must-not-exist.md', content: 'blocked' }),
        textRound('计划：确认后再创建文件。'),
      ], requests),
      sessionStore: store,
      tools: new ApiAgentTools(workspace),
    });
    const events: PartnerEvent[] = [];
    for await (const event of runtime.sendMessage({ ...command(), execution: { permissionMode: 'full', planMode: 'plan' } })) {
      events.push(event);
      if (event.type === 'user_input.requested') await runtime.resolveUserInput({
        protocolVersion: AGENT_PROTOCOL_VERSION, type: 'user_input.resolve', commandId: 'decline-plan', partnerId: event.partnerId,
        conversationId: event.conversationId, connectionSource: 'api_partner', clientMessageId: event.clientMessageId,
        sessionId: event.sessionId, runId: event.runId, requestId: event.requestId, answers: { 'plan-execution': ['暂不执行'] },
      });
    }

    await expect(readFile(path.join(workspace, 'must-not-exist.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'authorization.requested' })]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.completed', outcome: 'failure', detail: expect.stringContaining('ASTERIUM_PLAN_READ_ONLY') }),
      expect.objectContaining({ type: 'run.cancelled', reason: expect.stringContaining('计划已保留') }),
    ]));
    expect(JSON.stringify(requests[1].messages)).toContain('ASTERIUM_PLAN_READ_ONLY');
    expect((await store.load('partner-1', 'conversation-1'))?.turns[0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: '计划：确认后再创建文件。' }),
    ]));
  });

  it('cancels a pending API question with one terminal event', async () => {
    const runtime = new ApiAgentRuntime({
      provider: scriptedProvider([toolRound('pending-question', 'request_user_input', { questions: [{ id: 'choice', prompt: '请选择。', options: [{ label: 'A' }] }] })]),
    });
    const events: PartnerEvent[] = [];
    for await (const event of runtime.sendMessage({ ...command(), execution: { permissionMode: 'manual', planMode: 'plan' } })) {
      events.push(event);
      if (event.type === 'user_input.requested') await runtime.cancel({
        protocolVersion: AGENT_PROTOCOL_VERSION, type: 'run.cancel', commandId: 'cancel-question', partnerId: event.partnerId,
        conversationId: event.conversationId, connectionSource: 'api_partner', clientMessageId: event.clientMessageId,
        sessionId: event.sessionId, runId: event.runId,
      });
    }
    expect(events.filter((event) => event.type === 'run.cancelled')).toHaveLength(1);
    expect(events.some((event) => event.type === 'run.failed' || event.type === 'run.completed')).toBe(false);
  });

  it('sends unsupported images as metadata plus an explicit cannot-view warning without bytes or paths', async () => {
    const root = await tempDirectory();
    const imagePath = path.join(root, 'private-image.png');
    await writeFile(imagePath, 'secret-image-bytes', 'utf8');
    let body = '';
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body);
      return response([{ choices: [{ delta: { content: '我无法查看这张图片。' }, finish_reason: 'stop' }] }]);
    });
    const attachment = { id: 'attachment-image', name: 'photo.png', mediaType: 'image/png', sizeBytes: 18 };
    const attachmentReader = { conversationId: 'conversation-1', pathFor: vi.fn(async () => imagePath), inspect: vi.fn(async () => attachment) };
    const adapter = new ApiPartnerAdapter({ endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash', apiKey: 'secret', fetcher, attachmentReader });
    const withImage = { ...command(), attachments: [attachment] };
    await collect(adapter.sendMessage(withImage));

    expect(body).toContain('当前伙伴无法查看此图片');
    expect(body).toContain('attachment-image');
    expect(body).not.toContain('secret-image-bytes');
    expect(body).not.toContain(Buffer.from('secret-image-bytes').toString('base64'));
    expect(body).not.toContain(imagePath.replace(/\\/g, '\\\\'));
    expect(attachmentReader.pathFor).not.toHaveBeenCalled();
  });

  it('gives a visual provider a native image content part through the provider adapter boundary', async () => {
    const root = await tempDirectory();
    const imagePath = path.join(root, 'image.png');
    await writeFile(imagePath, 'native-image-content', 'utf8');
    const requests: ApiProviderRequest[] = [];
    const provider: ApiProviderAdapter = {
      provider: 'visual-test',
      capabilities: {
        streamingText: true, reasoning: false, toolCalls: false,
        attachments: { supportsImageInput: true, acceptedMimeTypes: ['image/png'], maxImageBytes: 1024, attachmentTransport: 'native_multimodal' },
      },
      async *stream(request) {
        requests.push(request);
        yield { type: 'text.delta', text: '看到了' };
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const attachment = { id: 'attachment-image', name: 'image.png', mediaType: 'image/png', sizeBytes: 20 };
    const attachmentReader = { conversationId: 'conversation-1', pathFor: vi.fn(async () => imagePath), inspect: vi.fn(async () => attachment) };
    const runtime = new ApiAgentRuntime({ provider, attachmentReader });
    await collect(runtime.sendMessage({ ...command(), attachments: [attachment] }));

    const user = requests[0].messages.find((message) => message.role === 'user');
    expect(user?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('已作为原生图片输入提供') }),
      { type: 'image', mediaType: 'image/png', data: Buffer.from('native-image-content').toString('base64') },
    ]));
  });
});
