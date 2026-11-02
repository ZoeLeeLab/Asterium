import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeCodexThreadLifecycle, CodexCliAdapter, codexTurnText, getCodexThreadLastTurnId, getCodexThreadLifecycles, getCodexThreadLifecyclesSafely, parseCodexLoginStatus, parseCodexThreads, rankCodexRuntimes, recommendedCodexRuntime, type CodexRuntimeInstallation } from '../../src/main/adapters/CodexCliAdapter';
import { PLAN_EXECUTION_QUESTION_ID, PLAN_EXECUTION_START, PLAN_EXECUTION_STOP } from '../../src/main/adapters/planExecutionDecision';
import type { CodexAppServerTransport, CodexRpcMessage, JsonRpcId } from '../../src/main/adapters/codexAppServerProtocol';
import { AGENT_PROTOCOL_VERSION, CODEX_NATIVE_TOOL_PROTOCOL_VERSION, type PartnerEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-codex-adapter-'));
  temporaryDirectories.push(directory);
  return directory;
}

function command(sessionId?: string, clientMessageId = 'client-1'): SendMessageCommand {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'message.send',
    commandId: 'command-' + clientMessageId,
    partnerId: 'partner-1',
    conversationId: 'conversation-1',
    connectionSource: 'local_cli',
    clientMessageId,
    ...(sessionId ? { sessionId } : {}),
    content: { type: 'text', text: '你好' },
  };
}

class FakeTransport implements CodexAppServerTransport {
  connected = true;
  readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly responses: Array<{ id: JsonRpcId; result: unknown }> = [];
  private readonly messageListeners = new Set<(message: CodexRpcMessage) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private turn = 0;

  constructor(private readonly autoComplete = true, private readonly extraMessages: CodexRpcMessage[] = []) {}

  async start() { this.connected = true; }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-test' } as T;
    if (method === 'thread/resume') return { thread: { id: String(params?.threadId) }, model: 'gpt-test' } as T;
    if (method === 'thread/fork') return { thread: { id: 'thread-forked' }, model: 'gpt-test' } as T;
    if (method === 'collaborationMode/list') return { data: [
      { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'high' },
      { name: 'Default', mode: 'default', model: null, reasoning_effort: 'medium' },
    ] } as T;
    if (method === 'turn/start') {
      const turnId = 'turn-' + ++this.turn;
      queueMicrotask(() => {
        this.emit({ method: 'turn/started', params: { threadId: String(params?.threadId), turn: { id: turnId } } });
        if (!this.autoComplete) return;
        for (const message of this.extraMessages) this.emit(message);
        this.emit({ method: 'item/agentMessage/delta', params: { threadId: String(params?.threadId), turnId, itemId: 'message-1', delta: '真实增量' } });
        this.emit({ method: 'item/started', params: { threadId: String(params?.threadId), turnId, item: { id: 'file-1', type: 'fileChange', status: 'inProgress', changes: [] } } });
        this.emit({ method: 'item/completed', params: { threadId: String(params?.threadId), turnId, item: { id: 'file-1', type: 'fileChange', status: 'completed', changes: [{ path: 'K:\\qa\\result.md' }] } } });
        this.emit({ method: 'turn/completed', params: { threadId: String(params?.threadId), turn: { id: turnId, status: 'completed' } } });
      });
      return { turn: { id: turnId } } as T;
    }
    if (method === 'turn/interrupt') {
      const turnId = String(params?.turnId);
      queueMicrotask(() => this.emit({ method: 'turn/completed', params: { threadId: String(params?.threadId), turn: { id: turnId, status: 'interrupted' } } }));
      return {} as T;
    }
    return {} as T;
  }

  respond(id: JsonRpcId, result: unknown) { this.responses.push({ id, result }); }
  onMessage(listener: (message: CodexRpcMessage) => void) { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onClose(listener: (error: Error) => void) { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  async close() { this.connected = false; }
  emit(message: CodexRpcMessage) { for (const listener of this.messageListeners) listener(message); }
  disconnect() { this.connected = false; for (const listener of this.closeListeners) listener(new Error('disconnected')); }
}

async function collect(stream: AsyncIterable<PartnerEvent>) {
  const events: PartnerEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('CodexCliAdapter', () => {
  it('forwards free-form answers to native Codex without leaking Asterium custom-choice metadata', async () => {
    const transport = new FakeTransport(true, [{ id: 7, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', questions: [{ id: 'format', question: '选择格式', options: [{ label: 'A' }] }] } }]);
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const iterator = adapter.sendMessage(command())[Symbol.asyncIterator](); let bound!: PartnerEvent;
    for (;;) {
      const next = await iterator.next(); if (next.done) throw new Error('missing native question');
      if (next.value.type === 'session.bound') bound = next.value;
      if (next.value.type === 'user_input.requested') {
        await adapter.resolveUserInput({ ...command(), type: 'user_input.resolve', runId: bound.runId, sessionId: bound.sessionId, requestId: next.value.requestId, answers: { format: ['自填 JSON\n保留 recommended.md'] }, customAnswers: { format: '自填 JSON\n保留 recommended.md' } });
        break;
      }
    }
    await collect({ [Symbol.asyncIterator]: () => iterator });
    expect(transport.responses).toContainEqual({ id: 7, result: { answers: { format: { answers: ['自填 JSON\n保留 recommended.md'] } } } });
  });

  it('cancels while preparing a plan revision without starting another native turn', async () => {
    const transport = new FakeTransport(), adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const iterator = adapter.sendMessage({ ...command(), execution: { permissionMode: 'manual', planMode: 'plan' } })[Symbol.asyncIterator](); let bound!: PartnerEvent;
    for (;;) {
      const next = await iterator.next(); if (next.done) throw new Error('missing plan question');
      if (next.value.type === 'session.bound') bound = next.value;
      if (next.value.type === 'user_input.requested') {
        const resolving = adapter.resolveUserInput({ ...command(), type: 'user_input.resolve', runId: bound.runId, sessionId: bound.sessionId, requestId: next.value.requestId, answers: { 'plan-execution': ['请修改'] }, customAnswers: { 'plan-execution': '请修改' } });
        await adapter.cancel({ ...command(), type: 'run.cancel', runId: bound.runId, sessionId: bound.sessionId });
        await resolving; break;
      }
    }
    const events = await collect({ [Symbol.asyncIterator]: () => iterator });
    expect(events.at(-1)?.type).toBe('run.cancelled');
    expect(events.filter((e) => ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type))).toHaveLength(1);
    expect(transport.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  });

  it('revises repeatedly in the same read-only Plan thread, separates custom start text, then executes only an explicit selection', async () => {
    const transport = new FakeTransport(), adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const iterator = adapter.sendMessage({ ...command(), execution: { permissionMode: 'full', planMode: 'plan' } })[Symbol.asyncIterator]();
    const events: PartnerEvent[] = [];
    let bound!: PartnerEvent;
    const ask = async () => {
      for (;;) { const next = await iterator.next(); if (next.done) throw new Error('missing question'); events.push(next.value); if (next.value.type === 'session.bound') bound = next.value; if (next.value.type === 'user_input.requested') return next.value; }
    };
    const answer = (requestId: string, text: string, custom = false) => ({ ...command(), type: 'user_input.resolve' as const, runId: bound.runId, sessionId: bound.sessionId, requestId, answers: { [PLAN_EXECUTION_QUESTION_ID]: [text] }, ...(custom ? { customAnswers: { [PLAN_EXECUTION_QUESTION_ID]: text } } : {}) });
    const first = await ask();
    await expect(adapter.resolveUserInput({ ...answer(first.requestId, PLAN_EXECUTION_START), sessionId: 'wrong' })).rejects.toThrow('USER_INPUT_ROUTE_MISMATCH');
    await expect(adapter.resolveUserInput({ ...answer(first.requestId, PLAN_EXECUTION_START), answers: { [PLAN_EXECUTION_QUESTION_ID]: [PLAN_EXECUTION_START, '先修改'] } })).rejects.toThrow('INVALID_USER_INPUT_ANSWERS');
    await adapter.resolveUserInput(answer(first.requestId, '请增加测试步骤', true));
    const second = await ask(); expect(second.requestId).not.toBe(first.requestId);
    await expect(adapter.resolveUserInput(answer(first.requestId, PLAN_EXECUTION_START))).rejects.toThrow('CODEX_USER_INPUT_NOT_FOUND');
    await adapter.resolveUserInput(answer(second.requestId, PLAN_EXECUTION_START, true));
    const third = await ask();
    expect(new Set([first.requestId, second.requestId, third.requestId]).size).toBe(3);
    const planning = transport.requests.filter((r) => r.method === 'turn/start');
    expect(planning).toHaveLength(3);
    expect(planning.every((r) => r.params?.threadId === bound.sessionId)).toBe(true);
    for (const turn of planning) expect(turn.params).toMatchObject({ sandboxPolicy: { type: 'readOnly' }, collaborationMode: { mode: 'plan' } });
    expect(JSON.stringify(planning[1].params?.input)).toContain('请增加测试步骤');
    expect(events.some((e) => e.type === 'run.cancelled' || (e.type === 'plan.updated' && e.planMode === 'default'))).toBe(false);
    await adapter.resolveUserInput(answer(third.requestId, PLAN_EXECUTION_START));
    for (;;) { const next = await iterator.next(); if (next.done) break; events.push(next.value); }
    expect(transport.requests.filter((r) => r.method === 'turn/start').at(-1)?.params).toMatchObject({ sandboxPolicy: { type: 'workspaceWrite' }, collaborationMode: { mode: 'default' } });
    expect(events.filter((e) => ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type))).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run.completed');
  });

  it('cancels a pending plan confirmation without starting a revision or execution', async () => {
    const transport = new FakeTransport(), adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const iterator = adapter.sendMessage({ ...command(), execution: { permissionMode: 'manual', planMode: 'plan' } })[Symbol.asyncIterator]();
    let bound!: PartnerEvent;
    for (;;) { const next = await iterator.next(); if (next.done) throw new Error('missing question'); if (next.value.type === 'session.bound') bound = next.value; if (next.value.type === 'user_input.requested') break; }
    await adapter.cancel({ ...command(), type: 'run.cancel', runId: bound.runId, sessionId: bound.sessionId });
    const events = await collect({ [Symbol.asyncIterator]: () => iterator });
    expect(events.filter((e) => ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type))).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run.cancelled');
    expect(transport.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  });

  it('sends the assembled snapshot as native thread instructions while every user turn stays clean', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const snapshot = { version: 1 as const, content: '[旧文本格式]', developerContent: '[带资料边界的完整启动快照]', createdAt: new Date().toISOString(), timeZone: 'Asia/Shanghai' };
    await collect(adapter.sendMessage({ ...command(), sessionBootstrap: snapshot, sessionBootstrapVersion: 1 }));
    await collect(adapter.sendMessage({ ...command('thread-1', 'client-2'), sessionBootstrap: snapshot, sessionBootstrapVersion: 1 }));
    const turns = transport.requests.filter((request) => request.method === 'turn/start');
    expect(turns[0].params?.input).toEqual([{ type: 'text', text: '你好' }]);
    expect(turns[1].params?.input).toEqual([{ type: 'text', text: '你好' }]);
    expect(transport.requests.filter((request) => request.method === 'thread/start')).toHaveLength(1);
    const start = transport.requests.find((request) => request.method === 'thread/start')!;
    expect(start.params?.developerInstructions).toBe(snapshot.developerContent);
    expect(start.params).not.toHaveProperty('baseInstructions');
    expect(start.params?.dynamicTools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'deliver_file' })]));
    expect(codexTurnText({ ...command('thread-1'), forkFromTurnId: 'turn-1', sessionBootstrap: snapshot })).toBe('你好');
    await adapter.dispose();
  });

  it('keeps legacy first-turn briefing support in thread instructions, never in the user bubble', async () => {
    const first = {
      ...command(),
      runtimeContext: {
        partner: { displayName: '测试助手', introduction: '', expertise: '', mentionName: '测试助手', avatarAvailable: false },
        runtime: { source: 'local_cli' as const, adapter: 'codex_cli' as const },
        memoryBriefing: '与用户的关系：长期协作',
      },
    };
    const transport = new FakeTransport(); const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    await collect(adapter.sendMessage(first));
    expect(transport.requests.find((request) => request.method === 'thread/start')?.params?.developerInstructions).toContain('与用户的关系：长期协作');
    expect(codexTurnText(first)).toBe('你好');
    expect(codexTurnText({ ...first, sessionId: 'thread-1' })).toBe('你好');
    await adapter.dispose();
  });

  it('injects persona updates as developer messages before the user turn without resuming a loaded writer', async () => {
    const transport = new FakeTransport(); const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    await collect(adapter.sendMessage(command()));
    await collect(adapter.sendMessage({ ...command('thread-1', 'updated'), managedPersonaUpdate: { version: 'enabled:two', content: '当前人设同步' } }));
    const methods = transport.requests.map((request) => request.method);
    expect(methods.slice(-2)).toEqual(['thread/inject_items', 'turn/start']);
    expect(methods).not.toContain('thread/resume');
    expect(transport.requests.find((request) => request.method === 'thread/inject_items')?.params).toEqual({ threadId: 'thread-1', items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '当前人设同步' }] }] });
    expect(transport.requests.filter((request) => request.method === 'turn/start').at(-1)?.params?.input).toEqual([{ type: 'text', text: '你好' }]);
    await adapter.dispose();
  });

  it('does not silently fall back to user text when native persona injection fails', async () => {
    const transport = new FakeTransport(); const original = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation((method, params) => method === 'thread/inject_items' ? Promise.reject(new Error('unsupported')) : original(method, params));
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    await expect(collect(adapter.sendMessage({ ...command('old-thread'), managedPersonaUpdate: { version: 'disabled', content: '停用人设' } }))).rejects.toThrow('unsupported');
    expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(false);
    await adapter.dispose();
  });

  it('resumes persisted instructions without replacing them with the stale startup persona, and updates a fork separately', async () => {
    const transport = new FakeTransport(); const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const snapshot = { version: 1 as const, content: '最初人设', developerContent: '最初指令', createdAt: '', timeZone: '' };
    await collect(adapter.sendMessage({ ...command('persisted-thread'), sessionBootstrap: snapshot }));
    const resume = transport.requests.find((request) => request.method === 'thread/resume')!;
    expect(resume.params).not.toHaveProperty('developerInstructions');
    await collect(adapter.sendMessage({ ...command('persisted-thread', 'fork'), forkFromTurnId: 'turn-1', sessionBootstrap: snapshot, managedPersonaUpdate: { version: 'enabled:current', content: '分支的当前人设' } }));
    const injection = transport.requests.find((request) => request.method === 'thread/inject_items')!;
    expect(injection.params?.threadId).toBe('thread-forked');
    expect(transport.requests.filter((request) => request.method === 'turn/start').every((request) => JSON.stringify(request.params?.input) === JSON.stringify([{ type: 'text', text: '你好' }]))).toBe(true);
    await adapter.dispose();
  });

  it('recognizes the Windows CLI login message when Codex writes it to stderr', () => {
    expect(parseCodexLoginStatus('', 'Logged in using ChatGPT')).toEqual({ checked: true, loggedIn: true, authMethod: 'using ChatGPT' });
    expect(parseCodexLoginStatus('', 'Not logged in')).toEqual({ checked: true, loggedIn: false, authMethod: undefined });
  });

  it('lists every runtime but recommends the global CLI without silently hiding alternatives', () => {
    const runtime = (runtimeId: string, environment: CodexRuntimeInstallation['environment'], loggedIn: boolean, version: string): CodexRuntimeInstallation => ({
      runtimeId,
      environment,
      environmentLabel: environment,
      executablePath: 'C:\\' + runtimeId + '\\codex.exe',
      executableLabel: 'codex.exe',
      codexHome: 'C:\\Users\\fixture-user\\.codex',
      installed: true,
      loggedIn,
      version,
    });
    const desktop = runtime('desktop', 'desktop_app', true, '0.153.4');
    const global = runtime('global', 'global_cli', false, '0.144.5');
    const vscode = runtime('vscode', 'vscode_extension', true, '0.150.0');
    const ranked = rankCodexRuntimes([vscode, desktop, global]);

    expect(ranked.map((item) => item.runtimeId)).toEqual(['global', 'desktop', 'vscode']);
    expect(recommendedCodexRuntime(ranked)?.runtimeId).toBe('global');
    expect(ranked).toHaveLength(3);
  });

  it('normalizes thread choices and limits imports to the authorized directory', () => {
    const threads = parseCodexThreads({ data: [
      { id: 'thread-1', name: '命名线程', preview: 'ignored', cwd: 'K:\\qa', updatedAt: 1_700_000_000 },
      { id: 'thread-2', name: null, preview: '第二条线程', cwd: 'K:\\qa', updatedAt: 1_600_000_000 },
      { id: 'thread-outside', preview: 'outside', cwd: 'D:\\other', updatedAt: 1_500_000_000 },
    ] }, 'K:\\qa');

    expect(threads).toHaveLength(2);
    expect(threads[0]).toMatchObject({ threadId: 'thread-1', title: '命名线程', cwd: 'K:\\qa' });
    expect(threads[1]).toMatchObject({ threadId: 'thread-2', title: '第二条线程' });
  });

  it('starts a thread and turn, then streams text, tools, files, and completion in order', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const events = await collect(adapter.sendMessage(command()));

    expect(transport.requests[0]).toMatchObject({ method: 'thread/start', params: { cwd: 'K:\\qa', dynamicTools: [expect.objectContaining({ name: 'deliver_file' })] } });
    expect(transport.requests[1]).toMatchObject({ method: 'turn/start', params: { threadId: 'thread-1', clientUserMessageId: 'client-1' } });
    expect(JSON.stringify(transport.requests[0].params?.dynamicTools)).toContain('do not guess whether Asterium detected');
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events).toContainEqual(expect.objectContaining({ type: 'text.delta', text: '真实增量' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.started', toolCallId: 'file-1' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'file.produced', name: 'result.md' }));
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.every((event) => event.sessionId === 'thread-1' && event.connectionSource === 'local_cli')).toBe(true);
  });

  it('ignores replayed or foreign assistant events without the active thread and turn identity', async () => {
    const transport = new FakeTransport(true, [
      { method: 'item/agentMessage/delta', params: { delta: '缺少身份的旧回复' } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-other', turnId: 'turn-1', delta: '其他线程回复' } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-other', delta: '其他回合回复' } },
    ]);
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const events = await collect(adapter.sendMessage(command()));
    const text = events.filter((event) => event.type === 'text.delta').map((event) => event.text).join('');

    expect(text).toBe('真实增量');
  });

  it('journals and resumes the same native thread separately for each Asterium conversation', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const firstCommand = command('thread-shared', 'client-a');
    const secondCommand = { ...command('thread-shared', 'client-b'), conversationId: 'conversation-b' };
    await collect(adapter.sendMessage(firstCommand));
    await collect(adapter.sendMessage(secondCommand));

    const resumedA = await collect(adapter.resumeSession({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'session.resume',
      commandId: 'resume-a',
      partnerId: 'partner-1',
      conversationId: 'conversation-1',
      connectionSource: 'local_cli',
      sessionId: 'thread-shared',
      afterSequence: 0,
    }));
    const resumedB = await collect(adapter.resumeSession({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'session.resume',
      commandId: 'resume-b',
      partnerId: 'partner-1',
      conversationId: 'conversation-b',
      connectionSource: 'local_cli',
      sessionId: 'thread-shared',
      afterSequence: 0,
    }));

    expect(resumedA.length).toBeGreaterThan(0);
    expect(resumedB.length).toBeGreaterThan(0);
    expect(resumedA.every((event) => event.conversationId === 'conversation-1' && event.clientMessageId === 'client-a')).toBe(true);
    expect(resumedB.every((event) => event.conversationId === 'conversation-b' && event.clientMessageId === 'client-b')).toBe(true);
    expect(resumedA[0].sequence).toBe(1);
    expect(resumedB[0].sequence).toBe(1);
  });

  it('reads and changes lifecycle through the selected Codex app-server', async () => {
    class LifecycleTransport implements CodexAppServerTransport {
      connected = true;
      requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
      async start() { this.connected = true; }
      async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
        this.requests.push({ method, params });
        if (method === 'thread/list') return (params?.archived
          ? { data: [{ id: 'thread-archived', cwd: 'K:\\qa' }], nextCursor: null }
          : { data: [{ id: 'thread-active', cwd: 'K:\\qa' }], nextCursor: null }) as T;
        if (method === 'thread/read' && params?.threadId === 'thread-existing-elsewhere') return { thread: { id: params.threadId } } as T;
        if (method === 'thread/read') throw new Error('thread not found');
        return {} as T;
      }
      respond() {}
      onMessage() { return () => undefined; }
      onClose() { return () => undefined; }
      async close() { this.connected = false; }
    }
    const statusTransport = new LifecycleTransport();
    const statuses = await getCodexThreadLifecycles('codex.exe', 'K:\\qa', ['thread-active', 'thread-archived', 'thread-existing-elsewhere', 'thread-deleted'], () => statusTransport);
    expect(statuses.map((item) => item.state)).toEqual(['active', 'archived', 'unavailable', 'deleted']);
    expect(statusTransport.requests.filter((item) => item.method === 'thread/list').every((item) => item.params?.sourceKinds)).toBe(true);

    for (const [action, method, state] of [
      ['archive', 'thread/archive', 'archived'],
      ['restore', 'thread/unarchive', 'active'],
      ['delete', 'thread/delete', 'deleted'],
    ] as const) {
      const changeTransport = new LifecycleTransport();
      const changed = await changeCodexThreadLifecycle('codex.exe', 'K:\\qa', 'thread-active', action, () => changeTransport);
      expect(changed.state).toBe(state);
      expect(changeTransport.requests).toContainEqual({ method, params: { threadId: 'thread-active' } });
    }
  });

  it('retries a transient Codex state-runtime initialization failure and returns a recoverable result', async () => {
    let starts = 0;
    class StateRuntimeFailureTransport implements CodexAppServerTransport {
      connected = false;
      async start() {
        starts += 1;
        throw new Error('Codex app-server exited (1): failed to initialize sqlite state runtime under C:\\Users\\fixture-user\\.codex');
      }
      async request<T = unknown>(): Promise<T> { return {} as T; }
      respond() {}
      onMessage() { return () => undefined; }
      onClose() { return () => undefined; }
      async close() { this.connected = false; }
    }

    const statuses = await getCodexThreadLifecyclesSafely('codex.exe', 'K:\\qa', ['thread-a', 'thread-a', 'thread-b'], {
      createTransport: () => new StateRuntimeFailureTransport(),
      retryDelayMs: 0,
    });

    expect(starts).toBe(2);
    expect(statuses).toHaveLength(2);
    expect(statuses.every((item) => item.state === 'unavailable' && item.reason === 'runtime_unavailable')).toBe(true);
    expect(statuses.every((item) => item.message?.includes('没有改动本地记录'))).toBe(true);
  });

  it('reads the last native turn id used to detect outside group-thread changes', async () => {
    class ThreadReadTransport implements CodexAppServerTransport {
      connected = true;
      async start() { this.connected = true; }
      async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
        expect(method).toBe('thread/read');
        expect(params).toEqual({ threadId: 'thread-group', includeTurns: true });
        return { thread: { id: 'thread-group', turns: [{ id: 'turn-1' }, { id: 'turn-2' }] } } as T;
      }
      respond() {}
      onMessage() { return () => undefined; }
      onClose() { return () => undefined; }
      async close() { this.connected = false; }
    }
    expect(await getCodexThreadLastTurnId('codex.exe', 'K:\\qa', 'thread-group', () => new ThreadReadTransport())).toBe('turn-2');
  });

  it('unarchives an archived Codex thread before retrying permanent deletion', async () => {
    class ArchivedDeleteTransport implements CodexAppServerTransport {
      connected = true;
      requests: string[] = [];
      deleteAttempts = 0;
      async start() { this.connected = true; }
      async request<T = unknown>(method: string): Promise<T> {
        this.requests.push(method);
        if (method === 'thread/delete' && this.deleteAttempts++ === 0) {
          throw new Error('CODEX_RPC_ERROR: Cannot delete an archived thread');
        }
        return {} as T;
      }
      respond() {}
      onMessage() { return () => undefined; }
      onClose() { return () => undefined; }
      async close() { this.connected = false; }
    }
    const transport = new ArchivedDeleteTransport();
    const changed = await changeCodexThreadLifecycle('codex.exe', 'K:\\qa', 'thread-archived', 'delete', () => transport);

    expect(changed.state).toBe('deleted');
    expect(transport.requests).toEqual(['thread/delete', 'thread/unarchive', 'thread/delete']);
  });

  it('treats an already deleted native Codex thread as an idempotent delete success', async () => {
    class MissingDeleteTransport implements CodexAppServerTransport {
      connected = true;
      requests: string[] = [];
      async start() { this.connected = true; }
      async request<T = unknown>(method: string): Promise<T> {
        this.requests.push(method);
        throw new Error('CODEX_RPC_ERROR: thread not found');
      }
      respond() {}
      onMessage() { return () => undefined; }
      onClose() { return () => undefined; }
      async close() { this.connected = false; }
    }
    const transport = new MissingDeleteTransport();
    const changed = await changeCodexThreadLifecycle('codex.exe', 'K:\\qa', 'thread-deleted', 'delete', () => transport);

    expect(changed).toMatchObject({ state: 'deleted', message: '原生线程已不存在，星丛已清理本地记录。' });
    expect(transport.requests).toEqual(['thread/delete']);
  });

  it('maps native Plan and permission modes while inheriting the thread model from null presets', async () => {
    const planTransport = new FakeTransport();
    const planAdapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => planTransport);
    const iterator = planAdapter.sendMessage({ ...command(), execution: { permissionMode: 'full', planMode: 'plan' } })[Symbol.asyncIterator]();
    const planEvents: PartnerEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error('Plan run ended before asking for execution confirmation.');
      planEvents.push(next.value);
      if (next.value.type === 'user_input.requested') break;
    }
    const bound = planEvents[0];
    expect(bound).toMatchObject({ type: 'session.bound', model: 'gpt-test', modelSource: 'native_thread' });
    const requested = planEvents.at(-1)!;
    expect(requested).toMatchObject({
      type: 'user_input.requested',
      questions: [expect.objectContaining({ id: PLAN_EXECUTION_QUESTION_ID, prompt: '计划已经完成，是否开始执行？' })],
    });
    await planAdapter.resolveUserInput({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'user_input.resolve',
      commandId: 'resolve-plan-start',
      partnerId: 'partner-1',
      conversationId: 'conversation-1',
      connectionSource: 'local_cli',
      clientMessageId: 'client-1',
      sessionId: bound.sessionId!,
      runId: bound.runId!,
      requestId: requested.type === 'user_input.requested' ? requested.requestId : '',
      answers: { [PLAN_EXECUTION_QUESTION_ID]: [PLAN_EXECUTION_START] },
    });
    for (;;) if ((await iterator.next()).done) break;

    const turns = planTransport.requests.filter((item) => item.method === 'turn/start');
    expect(turns[0]?.params).toMatchObject({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly' },
      collaborationMode: { mode: 'plan', settings: { model: 'gpt-test' } },
    });
    expect(turns[1]?.params).toMatchObject({
      input: [{ type: 'text', text: '请按照刚才已经确认的计划开始执行。' }],
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite' },
      collaborationMode: { mode: 'default', settings: { model: 'gpt-test' } },
    });

    const autoTransport = new FakeTransport();
    const autoAdapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => autoTransport);
    await collect(autoAdapter.sendMessage({ ...command(), execution: { permissionMode: 'automatic', planMode: 'default' } }));
    expect(autoTransport.requests.find((item) => item.method === 'turn/start')?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxPolicy: { type: 'workspaceWrite', excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      collaborationMode: { mode: 'default' },
    });
  });

  it('keeps the Codex plan and stops without starting an execution turn when declined', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const iterator = adapter.sendMessage({ ...command(), execution: { permissionMode: 'manual', planMode: 'plan' } })[Symbol.asyncIterator]();
    const seen: PartnerEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error('Plan run ended before asking for execution confirmation.');
      seen.push(next.value);
      if (next.value.type === 'user_input.requested') break;
    }
    const bound = seen[0];
    const requested = seen.at(-1)!;
    await adapter.resolveUserInput({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'user_input.resolve',
      commandId: 'resolve-plan-stop',
      partnerId: 'partner-1',
      conversationId: 'conversation-1',
      connectionSource: 'local_cli',
      clientMessageId: 'client-1',
      sessionId: bound.sessionId!,
      runId: bound.runId!,
      requestId: requested.type === 'user_input.requested' ? requested.requestId : '',
      answers: { [PLAN_EXECUTION_QUESTION_ID]: [PLAN_EXECUTION_STOP] },
    });
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      seen.push(next.value);
    }

    expect(transport.requests.filter((item) => item.method === 'turn/start')).toHaveLength(1);
    expect(seen.at(-1)).toMatchObject({ type: 'run.cancelled', reason: expect.stringContaining('计划已保留') });
  });

  it('keeps Asterium tool rules out of the user message and exposes them through tool descriptions', async () => {
    const transport = new FakeTransport();
    const runtimeTools = { status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), update: vi.fn() };
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport, [], undefined, runtimeTools);
    await collect(adapter.sendMessage(command()));
    const threadParams = transport.requests.find((item) => item.method === 'thread/start')?.params;
    const turnParams = transport.requests.find((item) => item.method === 'turn/start')?.params;
    expect(turnParams?.input).toEqual([{ type: 'text', text: '你好' }]);
    expect(JSON.stringify(turnParams?.input)).not.toContain('星丛提供 asterium_status');
    expect(turnParams).not.toHaveProperty('dynamicTools');
    expect(threadParams?.dynamicTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'asterium_status', description: expect.stringContaining('cwd') }),
      expect.objectContaining({ name: 'asterium_workspace', description: expect.stringContaining('action=add') }),
    ]));
  });

  it('executes asterium_status through the dynamic tool bridge', async () => {
    const transport = new FakeTransport(false);
    const runtimeTools = { status: vi.fn(async () => '{"permissionMode":"manual"}'), workspace: vi.fn(async () => '{}'), update: vi.fn() };
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport, [], undefined, runtimeTools);
    const iterator = adapter.sendMessage(command())[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    transport.emit({ id: 92, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'status-1', tool: 'asterium_status', arguments: { key: 'permissions' } } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    for (;;) if ((await iterator.next()).done) break;

    expect(runtimeTools.status).toHaveBeenCalledWith('permissions');
    expect(transport.responses).toContainEqual({ id: 92, result: { success: true, contentItems: [{ type: 'inputText', text: '{"permissionMode":"manual"}' }] } });
  });

  it('exposes only workflow submission and memory reads in a dedicated planning thread', async () => {
    const transport = new FakeTransport();
    const runtimeTools = {
      status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), workflowDraft: vi.fn(async () => '{"saved":true}'), update: vi.fn(),
      memory: { access: 'read' as const, search: vi.fn(async () => '[]'), readSource: vi.fn(async () => '{}') },
      projectNotebook: vi.fn(async () => '{}'),
    };
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport, [], undefined, runtimeTools);
    await collect(adapter.sendMessage(command()));
    const dynamicTools = transport.requests.find((item) => item.method === 'thread/start')?.params?.dynamicTools as Array<{ name: string }>;
    expect(dynamicTools.map((tool) => tool.name)).toEqual(['submit_workflow_draft', 'search_memory', 'read_memory_source']);
    expect(JSON.stringify(dynamicTools)).toContain('always take priority');
    expect(dynamicTools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(['hold_memory', 'comment_memory', 'update_memory', 'project_notebook']));
  });

  it('installs protocol v4 memory tools on a new Codex thread and executes writes without file approval', async () => {
    const transport = new FakeTransport(false);
    const memory = {
      access: 'write' as const,
      search: vi.fn(async () => '[]'), readSource: vi.fn(async () => '{}'),
      hold: vi.fn(async () => '{"held":true}'), comment: vi.fn(async () => '{}'), update: vi.fn(async () => '{}'),
    };
    const runtimeTools = { status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), update: vi.fn(), memory };
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport, [], undefined, runtimeTools);
    const iterator = adapter.sendMessage({ ...command(), execution: { permissionMode: 'read_only', planMode: 'default' } })[Symbol.asyncIterator]();
    const events: PartnerEvent[] = [(await iterator.next()).value!, (await iterator.next()).value!];
    const dynamicTools = transport.requests.find((item) => item.method === 'thread/start')?.params?.dynamicTools as Array<{ name: string }>;

    expect(events[0]).toMatchObject({ type: 'session.bound', isNew: true, toolProtocolVersion: CODEX_NATIVE_TOOL_PROTOCOL_VERSION });
    expect(CODEX_NATIVE_TOOL_PROTOCOL_VERSION).toBe(4);
    expect(dynamicTools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'hold_memory', 'search_memory', 'comment_memory', 'update_memory', 'read_memory_source',
    ]));

    transport.emit({ id: 98, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'memory-1', tool: 'hold_memory', arguments: { type: 'stable_fact', body: '用户喜欢确定性实现', weight: 4 } } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    expect(memory.hold).toHaveBeenCalledWith({ type: 'stable_fact', body: '用户喜欢确定性实现', weight: 4 });
    expect(transport.responses).toContainEqual({ id: 98, result: { success: true, contentItems: [{ type: 'inputText', text: '{"held":true}' }] } });
    expect(events.some((event) => event.type === 'authorization.requested')).toBe(false);
  });

  it('installs and executes the project notebook tool only on a brand-new protocol v4 thread', async () => {
    const transport = new FakeTransport(false);
    const projectNotebook = vi.fn(async () => '{"revision":4}');
    const runtimeTools = { status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), update: vi.fn(), projectNotebook };
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport, [], undefined, runtimeTools);
    const iterator = adapter.sendMessage(command())[Symbol.asyncIterator]();
    const bound = (await iterator.next()).value!;
    await iterator.next();
    const dynamicTools = transport.requests.find((item) => item.method === 'thread/start')?.params?.dynamicTools as Array<{ name: string }>;

    expect(bound).toMatchObject({ type: 'session.bound', isNew: true, toolProtocolVersion: 4 });
    expect(dynamicTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'project_notebook', description: expect.stringContaining('expected_revision') }),
    ]));

    transport.emit({ id: 99, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'notebook-1', tool: 'project_notebook', arguments: { action: 'replace', project_id: 'project-1', content: '# 进度', expected_revision: 3 } } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    for (;;) if ((await iterator.next()).done) break;

    expect(projectNotebook).toHaveBeenCalledWith({ action: 'replace', projectId: 'project-1', content: '# 进度', expectedRevision: 3 });
    expect(transport.responses).toContainEqual({ id: 99, result: { success: true, contentItems: [{ type: 'inputText', text: '{"revision":4}' }] } });
  });

  it('exposes and executes the structured workspace-task tool through the same dynamic bridge', async () => {
    const transport = new FakeTransport(false);
    const runtimeTools = { status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), task: vi.fn(async () => '{"accepted":true}'), update: vi.fn() };
    const retryTools = { status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), task: vi.fn(async () => '{"attempt":"retry"}'), update: vi.fn() };
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport, [], undefined, runtimeTools);
    const iterator = adapter.sendMessage(command())[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    expect(transport.requests.find((item) => item.method === 'thread/start')?.params?.dynamicTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'asterium_task', description: expect.stringContaining('frozen') }),
    ]));
    adapter.replaceRuntimeTools(retryTools);
    transport.emit({ id: 96, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'task-1', tool: 'asterium_task', arguments: { action: 'context' } } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    for (;;) if ((await iterator.next()).done) break;

    expect(runtimeTools.task).toHaveBeenCalledWith({ action: 'context' });
    expect(retryTools.task).not.toHaveBeenCalled();
    expect(transport.responses).toContainEqual({ id: 96, result: { success: true, contentItems: [{ type: 'inputText', text: '{"accepted":true}' }] } });

    const retryIterator = adapter.sendMessage(command('thread-1', 'client-2'))[Symbol.asyncIterator]();
    await retryIterator.next();
    await retryIterator.next();
    transport.emit({ id: 97, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-2', callId: 'task-2', tool: 'asterium_task', arguments: { action: 'context' } } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } } });
    for (;;) if ((await retryIterator.next()).done) break;
    expect(retryTools.task).toHaveBeenCalledWith({ action: 'context' });
    expect(transport.responses).toContainEqual({ id: 97, result: { success: true, contentItems: [{ type: 'inputText', text: '{"attempt":"retry"}' }] } });
  });

  it('keeps persistent workspace changes interactive in automatic mode', async () => {
    const transport = new FakeTransport(false);
    const runtimeTools = { status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{"change":{"committed":true}}'), update: vi.fn() };
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport, [], undefined, runtimeTools);
    const iterator = adapter.sendMessage({ ...command(), execution: { permissionMode: 'automatic', planMode: 'default' } })[Symbol.asyncIterator]();
    const bound = (await iterator.next()).value!;
    await iterator.next();
    transport.emit({ id: 93, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'workspace-1', tool: 'asterium_workspace', arguments: { action: 'add', path: 'K:\\shared' } } });
    await iterator.next();
    const requested = (await iterator.next()).value!;

    expect(requested).toMatchObject({ type: 'authorization.requested', purpose: 'workspace_add', targets: ['K:\\shared'] });
    expect(runtimeTools.workspace).not.toHaveBeenCalled();
    if (requested.type !== 'authorization.requested') throw new Error('missing workspace approval');
    await adapter.resolveAuthorization({
      protocolVersion: AGENT_PROTOCOL_VERSION, type: 'authorization.resolve', commandId: 'allow-workspace', partnerId: requested.partnerId,
      conversationId: requested.conversationId, connectionSource: 'local_cli', clientMessageId: requested.clientMessageId,
      sessionId: bound.sessionId, runId: bound.runId, authorizationId: requested.authorizationId, decision: 'allow_once',
    });
    await vi.waitFor(() => expect(runtimeTools.workspace).toHaveBeenCalledWith('add', 'K:\\shared'));
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    for (;;) if ((await iterator.next()).done) break;
  });

  it('keeps full-mode commands, workspace changes, and outside file changes uninterrupted', async () => {
    const transport = new FakeTransport(false);
    const protectedRoot = 'C:\\Users\\QA\\AppData\\Roaming\\Asterium\\AsteriumData';
    const runtimeTools = { status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{"change":{"committed":true}}'), update: vi.fn() };
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport, [], undefined, runtimeTools, [protectedRoot]);
    const iterator = adapter.sendMessage({ ...command(), execution: { permissionMode: 'full', planMode: 'default' } })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    const nextEvent = iterator.next();
    transport.emit({ id: 94, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'workspace-full', tool: 'asterium_workspace', arguments: { action: 'add', path: 'K:\\shared' } } });

    transport.emit({ id: 95, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-full', command: ['powershell', '-Command', 'Get-Content D:\\outside\\file.txt'] } });

    transport.emit({ id: 96, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-outside', reason: '写入 D:\\outside\\result.md' } });
    transport.emit({ id: 97, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-protected', reason: `写入 ${protectedRoot}\\partners\\one\\profile.md` } });
    transport.emit({ id: 98, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-protected', command: ['powershell', '-Command', `Get-Content '${protectedRoot}\\user\\user-profile.md'`] } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await nextEvent;
    await iterator.next();
    await vi.waitFor(() => expect(runtimeTools.workspace).toHaveBeenCalledWith('add', 'K:\\shared'));
    expect(transport.responses).toContainEqual({ id: 95, result: { decision: 'accept' } });
    expect(transport.responses).toContainEqual({ id: 96, result: { decision: 'accept' } });
    expect(transport.responses).toContainEqual({ id: 97, result: { decision: 'decline' } });
    expect(transport.responses).toContainEqual({ id: 98, result: { decision: 'decline' } });
    for (;;) if ((await iterator.next()).done) break;
  });

  it('returns the current app-server permission grant shape after user approval', async () => {
    const transport = new FakeTransport(false);
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const iterator = adapter.sendMessage({ ...command(), execution: { permissionMode: 'manual', planMode: 'default' } })[Symbol.asyncIterator]();
    const bound = (await iterator.next()).value!;
    await iterator.next();
    transport.emit({
      id: 77,
      method: 'item/permissions/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'permission-1', permissions: { network: null, fileSystem: { write: ['K:\\qa'] } } },
    });
    await iterator.next();
    const requested = (await iterator.next()).value!;
    expect(requested).toMatchObject({ type: 'authorization.requested', authorizationId: 'codex-auth-77' });

    await adapter.resolveAuthorization({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'authorization.resolve',
      commandId: 'resolve-77',
      partnerId: 'partner-1',
      conversationId: 'conversation-1',
      connectionSource: 'local_cli',
      clientMessageId: 'client-1',
      sessionId: bound.sessionId,
      runId: bound.runId,
      authorizationId: 'codex-auth-77',
      decision: 'allow_once',
    });
    expect(transport.responses).toContainEqual({ id: 77, result: { permissions: { fileSystem: { write: ['K:\\qa'] } }, scope: 'turn' } });

    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    for (;;) if ((await iterator.next()).done) break;
  });

  it('answers the experimental deliver_file request and emits an explicit delivery event', async () => {
    const outside = await tempDirectory();
    const report = path.join(outside, 'report.pdf');
    await writeFile(report, 'final report', 'utf8');
    const transport = new FakeTransport(false);
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const iterator = adapter.sendMessage(command())[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    transport.emit({ id: 91, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'delivery-1', tool: 'deliver_file', arguments: { path: report, name: '最终报告.pdf' } } });
    const delivered = (await iterator.next()).value!;
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await iterator.next();

    expect(transport.requests[0].params).toMatchObject({ dynamicTools: [expect.objectContaining({ name: 'deliver_file' })] });
    expect(transport.responses).toContainEqual(expect.objectContaining({ id: 91, result: expect.objectContaining({ success: true }) }));
    expect(delivered).toMatchObject({ type: 'file.produced', name: '最终报告.pdf', artifactRef: report, registrationMethod: 'deliver_tool' });
  });

  it('keeps project-group deliver_file on the original registration path without a separate approval', async () => {
    const outside = await tempDirectory();
    const report = path.join(outside, 'project-report.pdf');
    await writeFile(report, 'project report', 'utf8');
    const transport = new FakeTransport(false);
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const groupCommand: SendMessageCommand = {
      ...command(),
      conversationId: 'group:v3:room-1:partner-1',
      route: { scope: 'group', roomId: 'room-1', roundId: 'round-1', bindingGeneration: 1, inputThroughSeq: 2 },
      execution: { permissionMode: 'manual', planMode: 'default' },
    };
    const iterator = adapter.sendMessage(groupCommand)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    transport.emit({ id: 93, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'project-delivery-1', tool: 'deliver_file', arguments: { path: report } } });
    const delivered = (await iterator.next()).value!;
    expect(delivered).toMatchObject({ type: 'file.produced', registrationMethod: 'deliver_tool', artifactRef: report });
    expect(transport.responses).toContainEqual(expect.objectContaining({ id: 93, result: expect.objectContaining({ success: true }) }));

    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    for (;;) if ((await iterator.next()).done) break;
  });

  it('rejects a missing deliver_file path instead of claiming it was delivered', async () => {
    const outside = await tempDirectory();
    const missing = path.join(outside, 'missing.pdf');
    const transport = new FakeTransport(false);
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const iterator = adapter.sendMessage(command())[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const terminal = iterator.next();
    transport.emit({ id: 92, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'delivery-missing', tool: 'deliver_file', arguments: { path: missing } } });
    await vi.waitFor(() => expect(transport.responses).toContainEqual(expect.objectContaining({ id: 92, result: expect.objectContaining({ success: false }) })));
    transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    expect((await terminal).value).toMatchObject({ type: 'run.completed' });
  });

  it('resumes the same thread after an app-server disconnect', async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    let creation = 0;
    const runtimeTools = {
      status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), update: vi.fn(),
      projectNotebook: vi.fn(async () => '{}'),
    };
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => creation++ === 0 ? first : second, [], undefined, runtimeTools);
    const initial = await collect(adapter.sendMessage(command()));
    first.disconnect();
    const resumed = await collect(adapter.sendMessage(command('thread-1', 'client-2')));

    expect(initial[0]).toMatchObject({ type: 'session.bound', isNew: true, sessionId: 'thread-1', toolProtocolVersion: CODEX_NATIVE_TOOL_PROTOCOL_VERSION });
    expect(second.requests[0]).toEqual({ method: 'thread/resume', params: { threadId: 'thread-1', cwd: 'K:\\qa', runtimeWorkspaceRoots: ['K:\\qa'] } });
    expect(second.requests[0].params).not.toHaveProperty('dynamicTools');
    expect(resumed[0]).toMatchObject({ type: 'session.bound', isNew: false, sessionId: 'thread-1' });
    expect(resumed[0]).not.toHaveProperty('toolProtocolVersion');
    expect(second.requests.some((item) => item.method === 'thread/start')).toBe(false);
    expect(resumed[0].sequence).toBeGreaterThan(initial.at(-1)!.sequence);
  });

  it('keeps the native cwd while granting additional runtime workspace roots', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\native-partner', () => transport, ['D:\\shared-work', 'K:\\assets']);
    await collect(adapter.sendMessage(command()));

    expect(transport.requests[0]).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: 'K:\\native-partner',
        runtimeWorkspaceRoots: ['K:\\native-partner', 'D:\\shared-work', 'K:\\assets'],
        dynamicTools: [expect.objectContaining({ name: 'deliver_file' })],
      },
    });
    expect(transport.requests[1]).toMatchObject({
      method: 'turn/start',
      params: {
        runtimeWorkspaceRoots: ['K:\\native-partner', 'D:\\shared-work', 'K:\\assets'],
      },
    });
  });

  it('keeps one native writer while a project workspace is removed and restored', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexCliAdapter('codex.exe', 'D:\\fixture-workspace', () => transport, ['K:\\project-a']);

    const first = await collect(adapter.sendMessage(command()));
    adapter.replaceRuntimeWorkspaceRoots([]);
    const removed = await collect(adapter.sendMessage(command('thread-1', 'client-2')));
    adapter.replaceRuntimeWorkspaceRoots(['K:\\project-a']);
    const restored = await collect(adapter.sendMessage(command('thread-1', 'client-3')));

    expect(transport.requests.filter((item) => item.method === 'thread/start')).toHaveLength(1);
    expect(transport.requests.filter((item) => item.method === 'thread/resume')).toHaveLength(0);
    expect(transport.requests.filter((item) => item.method === 'turn/start').map((item) => item.params?.runtimeWorkspaceRoots)).toEqual([
      ['D:\\fixture-workspace', 'K:\\project-a'],
      ['D:\\fixture-workspace'],
      ['D:\\fixture-workspace', 'K:\\project-a'],
    ]);
    expect([first[0], removed[0], restored[0]]).toEqual([
      expect.objectContaining({ type: 'session.bound', sessionId: 'thread-1', isNew: true }),
      expect.objectContaining({ type: 'session.bound', sessionId: 'thread-1', isNew: false }),
      expect.objectContaining({ type: 'session.bound', sessionId: 'thread-1', isNew: false }),
    ]);
  });

  it('resolves attachment ids to a conversation copy for native Codex access', async () => {
    const transport = new FakeTransport();
    const savedPath = 'C:\\Users\\fixture-user\\AppData\\Roaming\\Asterium\\conversation-attachments\\v2\\conversation-1\\attachment-1\\content';
    const resolver = vi.fn(async () => savedPath);
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\native-partner', () => transport, [], resolver);
    const withAttachment = { ...command(), attachments: [{ id: 'attachment-1', name: 'photo.png', mediaType: 'image/png', sizeBytes: 12 }] };
    await collect(adapter.sendMessage(withAttachment));
    expect(resolver).toHaveBeenCalledWith('attachment-1', 'conversation-1');
    expect(transport.requests[1]).toMatchObject({ params: {
      runtimeWorkspaceRoots: ['K:\\native-partner', 'C:\\Users\\fixture-user\\AppData\\Roaming\\Asterium\\conversation-attachments\\v2\\conversation-1\\attachment-1'],
      input: [expect.objectContaining({ text: expect.stringContaining(savedPath) })],
    } });
  });

  it('forks from the selected prior turn when regenerating a Codex reply', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const regenerate = command('thread-1', 'client-fork');
    regenerate.forkFromTurnId = 'turn-prior';
    const events = await collect(adapter.sendMessage(regenerate));

    expect(transport.requests[0]).toEqual({
      method: 'thread/fork',
      params: { threadId: 'thread-1', lastTurnId: 'turn-prior', cwd: 'K:\\qa', excludeTurns: true, runtimeWorkspaceRoots: ['K:\\qa'] },
    });
    expect(transport.requests[1]).toMatchObject({ method: 'turn/start', params: { threadId: 'thread-forked' } });
    expect(events[0]).toMatchObject({ type: 'session.bound', isNew: true, sessionId: 'thread-forked' });
    expect(events.every((event) => event.sessionId === 'thread-forked')).toBe(true);
  });

  it('interrupts only an active turn and emits a cancelled terminal event', async () => {
    const transport = new FakeTransport(false);
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const iterator = adapter.sendMessage(command())[Symbol.asyncIterator]();
    const bound = (await iterator.next()).value!;
    await adapter.cancel({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'run.cancel',
      commandId: 'cancel-1',
      partnerId: 'partner-1',
      conversationId: 'conversation-1',
      connectionSource: 'local_cli',
      clientMessageId: 'client-1',
      sessionId: bound.sessionId,
      runId: bound.runId,
      reason: '测试停止',
    });
    const rest: PartnerEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }

    expect(transport.requests).toContainEqual({ method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } });
    expect(rest.at(-1)).toMatchObject({ type: 'run.cancelled', reason: '测试停止' });
  });

  it('adapts unified guidance to the native Codex turn/steer request', async () => {
    const transport = new FakeTransport(false);
    const adapter = new CodexCliAdapter('codex.exe', 'K:\\qa', () => transport);
    const iterator = adapter.sendMessage(command())[Symbol.asyncIterator]();
    const bound = (await iterator.next()).value!;
    await iterator.next();

    await expect(adapter.sendGuidance({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'guidance.send',
      commandId: 'guidance-1',
      partnerId: 'partner-1',
      conversationId: 'conversation-1',
      connectionSource: 'local_cli',
      clientMessageId: 'client-steer-1',
      sessionId: bound.sessionId,
      runId: bound.runId,
      content: { type: 'text', text: '先补充这一点' },
    })).resolves.toEqual({ disposition: 'accepted' });

    expect(transport.requests).toContainEqual({
      method: 'turn/steer',
      params: {
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        clientUserMessageId: 'client-steer-1',
        input: [{ type: 'text', text: '先补充这一点' }],
      },
    });

    await adapter.cancel({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'run.cancel',
      commandId: 'cancel-after-steer',
      partnerId: 'partner-1',
      conversationId: 'conversation-1',
      connectionSource: 'local_cli',
      clientMessageId: 'client-1',
      sessionId: bound.sessionId,
      runId: bound.runId,
    });
    for (;;) if ((await iterator.next()).done) break;
  });
});
