import { testRm as rm } from '../helpers/autoTest.mjs';
import { PassThrough } from 'node:stream';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ClaudeCodeAdapter, claudeApprovalAllow, claudeAsteriumAllowedTools, claudeBootstrapContext, claudeCanonicalFileTarget, claudeInputReferencesProtected, claudeNativeAnswers, claudePermissionMode, type SpawnClaude } from '../../src/main/adapters/ClaudeCodeAdapter';
import { ClaudeStreamParser } from '../../src/main/adapters/ClaudeStreamParser';
import { PLAN_EXECUTION_QUESTION_ID, PLAN_EXECUTION_START, PLAN_EXECUTION_STOP, planExecutionQuestions, shouldExecutePlan } from '../../src/main/adapters/planExecutionDecision';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function command(): SendMessageCommand {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'message.send',
    commandId: 'command-1',
    partnerId: 'partner-1',
    conversationId: 'conversation-1',
    connectionSource: 'local_cli',
    clientMessageId: 'client-1',
    content: { type: 'text', text: '你好' },
  };
}

function fakeChild(pid = 7319) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    stdin, stdout, stderr, pid, exitCode: 0,
    once: vi.fn(), kill: vi.fn(() => true),
  } as unknown as ChildProcessWithoutNullStreams;
}

async function collect(stream: AsyncIterable<PartnerEvent>) {
  const events: PartnerEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('Claude stream mapping', () => {
  it('reports the model attached to the native Claude session', () => {
    const events = new ClaudeStreamParser().parseLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-current' }));
    expect(events).toEqual([
      { type: 'extension.event', namespace: 'asterium.runtime', name: 'model_observed', schemaVersion: 1, payload: { model: 'claude-sonnet-current', source: 'native_thread' } },
      { type: 'message.accepted' },
    ]);
  });
  it('captures a markdown image split across streamed chunks without exposing its source as text', () => {
    const parser = new ClaudeStreamParser();
    const first = parser.parseLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '交付如下 !' } } }));
    const second = parser.parseLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '[结果图](https://cdn.example.com/result.png) 完成' } } }));
    const events = [...first, ...second];
    expect(events.filter((event) => event.type === 'text.delta').map((event) => event.text).join('')).toBe('交付如下  完成');
    expect(events).toContainEqual(expect.objectContaining({ type: 'file.produced', name: 'result.png', registrationMethod: 'message_image', source: { kind: 'content', transport: 'https_url', value: 'https://cdn.example.com/result.png' } }));
  });

  it('maps streamed text, complete reasoning, tools, files, and completion', () => {
    const parser = new ClaudeStreamParser();
    const lines = [
      { type: 'system', subtype: 'init' },
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private reasoning' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '完成' } } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: 'K:\\qa\\result.md' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
      { type: 'result', subtype: 'success', is_error: false },
    ];
    const events = lines.flatMap((line) => parser.parseLine(JSON.stringify(line)));
    expect(events.some((event) => event.type === 'text.delta' && event.text === '完成')).toBe(true);
    expect(events.some((event) => event.type === 'tool.started')).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'file.produced', name: 'result.md', changeKind: 'create' }));
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events).toContainEqual(expect.objectContaining({ type: 'work.status', state: 'thinking', detail: 'private reasoning' }));
  });

  it('publishes the completed tool input when Claude streams it after tool start', () => {
    const parser = new ClaudeStreamParser();
    parser.parseLine(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'read-1', name: 'Read', input: {} } },
    }));
    const events = parser.parseLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'K:\\\\workspace\\\\notes.md' } }] },
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.progress',
      toolCallId: 'read-1',
      detail: expect.stringContaining('notes.md'),
    }));
  });

  it('maps a failed result to a readable protocol error', () => {
    const events = new ClaudeStreamParser().parseLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'permission denied' }));
    expect(events[0]).toMatchObject({ type: 'run.failed', error: { code: 'ERROR_DURING_EXECUTION', message: 'permission denied' } });
  });

  it('does not infer MCP failure from startup state and still reports a real MCP tool failure', () => {
    const parser = new ClaudeStreamParser();
    const init = parser.parseLine(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'memory', status: 'failed' }] }));
    const started = parser.parseLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'mcp-1', name: 'mcp__memory__search', input: {} }] } }));
    const failed = parser.parseLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'mcp-1', is_error: true, content: 'server disconnected' }] } }));

    expect(init).toEqual([{ type: 'message.accepted' }]);
    expect(started).toContainEqual(expect.objectContaining({ type: 'tool.started', toolName: 'mcp__memory__search' }));
    expect(failed).toContainEqual(expect.objectContaining({ type: 'tool.completed', outcome: 'failure', summary: expect.stringContaining('server disconnected') }));
  });

  it('does not show a warning merely because a partner has no MCP servers', () => {
    const events = new ClaudeStreamParser().parseLine(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [] }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'work.status', summary: expect.stringContaining('未发现 MCP') }));
  });
});

describe('ClaudeCodeAdapter lifecycle', () => {
  it('adds the managed briefing only to a new native Claude session bootstrap', () => {
    const first = {
      ...command(),
      runtimeContext: {
        partner: { displayName: '本地伙伴', introduction: '', expertise: '', mentionName: '本地伙伴', avatarAvailable: false },
        runtime: { source: 'local_cli' as const, adapter: 'claude_code' as const },
        memoryBriefing: '自我认知：重视连续性',
      },
    };
    expect(claudeBootstrapContext(first)).toContain('自我认知：重视连续性');
    expect(claudeBootstrapContext({ ...first, sessionId: 'session-1' })).toBe('');
  });

  it('keeps the permission callback active while full access is auto-approved by Asterium', () => {
    expect(claudePermissionMode('full')).toBe('default');
    expect(claudePermissionMode('plan')).toBe('plan');
  });

  it('recognizes protected paths in direct tools and literal shell commands', () => {
    const protectedRoot = 'C:\\Users\\QA\\AppData\\Roaming\\Asterium\\AsteriumData';
    expect(claudeInputReferencesProtected({ file_path: `${protectedRoot}\\partners\\one\\profile.md` }, 'K:\\qa', [protectedRoot])).toBe(true);
    expect(claudeInputReferencesProtected({ command: `Get-Content '${protectedRoot}\\user\\user-profile.md'` }, 'K:\\qa', [protectedRoot])).toBe(true);
    expect(claudeInputReferencesProtected({ file_path: 'D:\\outside\\result.md' }, 'K:\\qa', [protectedRoot])).toBe(false);
  });

  it('uses one localized execution decision for native Plan adapters', () => {
    expect(planExecutionQuestions()).toEqual([expect.objectContaining({
      id: PLAN_EXECUTION_QUESTION_ID,
      prompt: '计划已经完成，是否开始执行？',
      options: expect.arrayContaining([expect.objectContaining({ label: PLAN_EXECUTION_START }), expect.objectContaining({ label: PLAN_EXECUTION_STOP })]),
    })]);
    expect(shouldExecutePlan({ [PLAN_EXECUTION_QUESTION_ID]: [PLAN_EXECUTION_START] })).toBe(true);
    expect(shouldExecutePlan({ [PLAN_EXECUTION_QUESTION_ID]: [PLAN_EXECUTION_STOP] })).toBe(false);
  });

  it('allows all managed memory tools in daily Claude runs and only reads in workflow planning', () => {
    const memory = {
      access: 'write' as const,
      search: vi.fn(async () => '[]'), readSource: vi.fn(async () => '[]'), hold: vi.fn(async () => '{}'), comment: vi.fn(async () => '{}'), update: vi.fn(async () => '{}'),
    };
    const base = { status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), update: vi.fn(), memory };
    expect(claudeAsteriumAllowedTools(base)).toEqual(expect.arrayContaining([
      'mcp__asterium__hold_memory', 'mcp__asterium__search_memory', 'mcp__asterium__comment_memory', 'mcp__asterium__update_memory', 'mcp__asterium__read_memory_source',
    ]));

    const planning = claudeAsteriumAllowedTools({
      ...base,
      workflowDraft: vi.fn(async () => '{}'),
      memory: { access: 'read', search: memory.search, readSource: memory.readSource },
    });
    expect(planning).toEqual(['mcp__asterium__submit_workflow_draft', 'mcp__asterium__search_memory', 'mcp__asterium__read_memory_source']);
    expect(planning).not.toContain('mcp__asterium__hold_memory');
    expect(claudeAsteriumAllowedTools({ status: base.status, workspace: base.workspace, update: base.update, task: vi.fn(async () => '{}') }))
      .not.toEqual(expect.arrayContaining(['mcp__asterium__search_memory']));
  });

  it('allows project notebooks in daily Claude runs but never in workflow or workspace controllers', () => {
    const base = {
      status: vi.fn(async () => '{}'), workspace: vi.fn(async () => '{}'), update: vi.fn(), projectNotebook: vi.fn(async () => '{}'),
    };
    expect(claudeAsteriumAllowedTools(base)).toContain('mcp__asterium__project_notebook');
    expect(claudeAsteriumAllowedTools({ ...base, workflowDraft: vi.fn(async () => '{}') })).not.toContain('mcp__asterium__project_notebook');
    expect(claudeAsteriumAllowedTools({ status: base.status, workspace: base.workspace, update: base.update, task: vi.fn(async () => '{}') })).not.toContain('mcp__asterium__project_notebook');
  });

  it('maps Asterium question ids back to Claude question text', () => {
    expect(claudeNativeAnswers([
      { id: 'question-1', header: undefined, prompt: '要选择哪一个？', options: [{ label: '甲', description: undefined }, { label: '乙', description: undefined }], multiple: false },
      { id: 'custom-id', header: undefined, prompt: '还需要什么？', options: undefined, multiple: true },
    ], {
      'question-1': ['乙'],
      'custom-id': ['测试', '文档'],
    })).toEqual({ '要选择哪一个？': '乙', '还需要什么？': '测试, 文档' });
  });

  it('defers unified guidance until the current Claude turn ends', async () => {
    const adapter = new ClaudeCodeAdapter('claude.exe', 'K:\\qa', () => fakeChild());
    await expect(adapter.sendGuidance({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'guidance.send',
      commandId: 'guidance-1',
      partnerId: 'partner-1',
      conversationId: 'conversation-1',
      connectionSource: 'local_cli',
      clientMessageId: 'client-guidance-1',
      runId: 'run-1',
      sessionId: 'session-1',
      content: { type: 'text', text: '接着处理测试' },
    })).resolves.toEqual({ disposition: 'deferred' });
  });

  it('returns the original validated input when a native tool approval is allowed', () => {
    const input = { file_path: 'K:\\qa\\result.md', content: 'ok' };
    expect(claudeApprovalAllow(input)).toEqual({ behavior: 'allow', updatedInput: input });
  });

  it('uses stdin plus stream-json and emits an ordered terminal run', async () => {
    const child = fakeChild();
    let args: string[] = [];
    let prompt = '';
    child.stdin.on('data', (chunk) => { prompt += chunk.toString(); });
    const spawnClaude: SpawnClaude = (_executable, actualArgs) => {
      args = actualArgs;
      queueMicrotask(() => {
        (child.stdout as PassThrough).end([
          JSON.stringify({ type: 'system', subtype: 'init' }),
          JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好，用户' } } }),
          JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
        ].join('\n'));
      });
      return child;
    };
    const events = await collect(new ClaudeCodeAdapter('claude.exe', 'K:\\qa', spawnClaude).sendMessage(command()));
    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--include-partial-messages', '--session-id']));
    expect(args).not.toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--settings', '--mcp-config']));
    expect(args).toEqual(expect.arrayContaining(['--mcp-config', '--allowedTools', 'mcp__asterium_delivery__deliver_file']));
    expect(prompt).toContain('你好');
    expect(prompt).toContain('deliver_file(path, name?)');
    expect(prompt).toContain('当前工作区之外');
    expect(prompt).toContain('不要猜测星丛是否已自动捕获');
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.some((event) => event.type === 'text.delta' && event.text === '你好，用户')).toBe(true);
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.every((event) => event.connectionSource === 'local_cli')).toBe(true);
  });

  it('cancels only the registered child PID and ignores unknown runs', async () => {
    const child = fakeChild(4127);
    Object.defineProperty(child, 'exitCode', { value: null, writable: true });
    const stopClaude = vi.fn(async (target: ChildProcessWithoutNullStreams) => {
      Object.defineProperty(target, 'exitCode', { value: 1, writable: true });
      (target.stdout as PassThrough).end();
    });
    const adapter = new ClaudeCodeAdapter('claude.exe', 'K:\\qa', () => child, stopClaude);
    const iterator = adapter.sendMessage(command())[Symbol.asyncIterator]();
    const bound = (await iterator.next()).value!;
    await adapter.cancel({
      protocolVersion: AGENT_PROTOCOL_VERSION, type: 'run.cancel', commandId: 'cancel-unknown',
      partnerId: 'partner-1', conversationId: 'conversation-1', connectionSource: 'local_cli',
      clientMessageId: 'client-1', sessionId: bound.sessionId, runId: 'not-registered',
    });
    expect(stopClaude).not.toHaveBeenCalled();
    await adapter.cancel({
      protocolVersion: AGENT_PROTOCOL_VERSION, type: 'run.cancel', commandId: 'cancel-real',
      partnerId: 'partner-1', conversationId: 'conversation-1', connectionSource: 'local_cli',
      clientMessageId: 'client-1', sessionId: bound.sessionId, runId: bound.runId,
    });
    expect(stopClaude).toHaveBeenCalledTimes(1);
    expect(stopClaude.mock.calls[0][0].pid).toBe(4127);
    expect((await iterator.next()).value?.type).toBe('run.cancelled');
  });

  it('starts in the authorized primary directory and exposes every additional authorized region', async () => {
    const child = fakeChild();
    let args: string[] = [];
    let cwd = '';
    const spawnClaude: SpawnClaude = (_executable, actualArgs, options) => {
      args = actualArgs;
      cwd = options.cwd;
      queueMicrotask(() => (child.stdout as PassThrough).end([
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
      ].join('\n')));
      return child;
    };
    await collect(new ClaudeCodeAdapter('claude.exe', 'K:\\primary', spawnClaude, undefined, ['K:\\shared', 'D:\\assets']).sendMessage(command()));
    expect(cwd).toBe('K:\\primary');
    expect(args).toEqual(expect.arrayContaining(['--add-dir', 'K:\\shared', 'D:\\assets']));
    expect(args).not.toEqual(expect.arrayContaining(['--settings', '--mcp-config', '--strict-mcp-config']));
  });

  it('resolves attachment ids to the conversation copy and grants only its parent directory', async () => {
    const child = fakeChild();
    let args: string[] = [];
    let prompt = '';
    child.stdin.on('data', (chunk) => { prompt += chunk.toString(); });
    const spawnClaude: SpawnClaude = (_executable, actualArgs) => {
      args = actualArgs;
      queueMicrotask(() => (child.stdout as PassThrough).end([
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
      ].join('\n')));
      return child;
    };
    const savedPath = 'C:\\Users\\fixture-user\\AppData\\Roaming\\Asterium\\conversation-attachments\\v2\\conversation-1\\attachment-1\\content';
    const resolver = vi.fn(async () => savedPath);
    const withAttachment = { ...command(), attachments: [{ id: 'attachment-1', name: 'photo.png', mediaType: 'image/png', sizeBytes: 12 }] };
    await collect(new ClaudeCodeAdapter('claude.exe', 'K:\\primary', spawnClaude, undefined, [], resolver).sendMessage(withAttachment));
    expect(resolver).toHaveBeenCalledWith('attachment-1', 'conversation-1');
    expect(args).toEqual(expect.arrayContaining(['--add-dir', 'C:\\Users\\fixture-user\\AppData\\Roaming\\Asterium\\conversation-attachments\\v2\\conversation-1\\attachment-1']));
    expect(prompt).toContain(savedPath);
  });

  it('canonicalizes only an exact file for same-run outside-write verification', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'asterium-claude-cwd-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'asterium-claude-outside-'));
    temporaryDirectories.push(cwd, outside);
    const target = path.join(outside, 'created.md');
    const sibling = path.join(outside, 'sibling.md');
    await writeFile(target, 'verified', 'utf8');
    await writeFile(sibling, 'private', 'utf8');

    const approved = await claudeCanonicalFileTarget('Write', { file_path: target }, cwd);
    const reread = await claudeCanonicalFileTarget('Read', { file_path: target }, cwd);
    const other = await claudeCanonicalFileTarget('Read', { file_path: sibling }, cwd);

    expect(approved).toBe(await realpath(target));
    expect(reread).toBe(approved);
    expect(other).not.toBe(approved);
    expect(await claudeCanonicalFileTarget('Glob', { path: outside }, cwd)).toBeUndefined();
  });

  it('resumes a persisted Claude session after creating a fresh adapter process', async () => {
    const child = fakeChild();
    let args: string[] = [];
    const spawnClaude: SpawnClaude = (_executable, actualArgs) => {
      args = actualArgs;
      queueMicrotask(() => (child.stdout as PassThrough).end([
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
      ].join('\n')));
      return child;
    };
    const sessionId = '417878a2-0066-4471-b81f-67a37418b7c0';
    const events = await collect(new ClaudeCodeAdapter('claude.exe', 'K:\\qa', spawnClaude).sendMessage({ ...command(), sessionId }));

    expect(args).toEqual(expect.arrayContaining(['--resume', sessionId]));
    expect(args).not.toContain('--session-id');
    expect(events[0]).toMatchObject({ type: 'session.bound', sessionId, isNew: false });
    expect(events.at(-1)?.type).toBe('run.completed');
  });
});
