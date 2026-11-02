// @vitest-environment node
import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options, PermissionResult } from '../../src/main/adapters/ClaudeCliTransport';
import { ClaudeCodeAdapter } from '../../src/main/adapters/ClaudeCodeAdapter';
import { PLAN_EXECUTION_START, PLAN_EXECUTION_STOP } from '../../src/main/adapters/planExecutionDecision';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type ResolveUserInputCommand } from '../../src/shared/agentProtocol';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/main/adapters/ClaudeCliTransport', () => ({ query: sdk.query, tool: vi.fn(), createClaudeToolSet: vi.fn() }));
const roots: string[] = [], adapters: ClaudeCodeAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  for (const root of roots.splice(0)) {
    const resolved = await realpath(root);
    expect(path.dirname(resolved).toLowerCase()).toBe((await realpath(os.tmpdir())).toLowerCase());
    expect(path.basename(resolved)).toMatch(/^asterium-claude-plan-/);
    await rm(resolved, { recursive: true, force: true, maxRetries: 5 });
  }
  sdk.query.mockReset();
});

describe('Claude CLI question and Plan feedback bridge', () => {
  it.each(['stop', 'execute'] as const)('returns custom answers to native questions, revises without interrupting, then handles explicit %s', async (ending) => {
    const results: PermissionResult[] = []; let options!: Options;
    sdk.query.mockImplementation((params: { options: Options }) => {
      options = params.options;
      const stream = (async function* () {
        yield { type: 'system', subtype: 'init' };
        const clarification = await options.canUseTool!('AskUserQuestion', { questions: [{ id: 'format', question: '选择格式', options: [{ label: 'A' }, { label: 'B' }] }] }, { signal: options.abortController!.signal, toolUseID: 'question', requestId: 'question' });
        if (!clarification) throw new Error('missing clarification result');
        results.push(clarification);
        for (let round = 1; round <= 3; round += 1) {
          const result = await options.canUseTool!('ExitPlanMode', {}, { signal: options.abortController!.signal, toolUseID: `plan-${round}`, requestId: `plan-${round}` });
          if (!result) throw new Error('missing plan result');
          results.push(result);
          if (result.behavior === 'allow' || result.interrupt) break;
        }
        yield { type: 'result', subtype: 'success', is_error: false };
      })();
      return Object.assign(stream, { close: vi.fn() });
    });
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'asterium-claude-plan-')); roots.push(cwd);
    const adapter = new ClaudeCodeAdapter('claude.exe', cwd); adapters.push(adapter);
    const events: PartnerEvent[] = [], ids: string[] = [];
    for await (const event of adapter.sendMessage({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'send', partnerId: 'p', conversationId: 'c', clientMessageId: 'u', connectionSource: 'local_cli', content: { type: 'text', text: 'plan' }, execution: { permissionMode: 'manual', planMode: 'plan' } })) {
      events.push(event);
      if (event.type === 'user_input.requested') {
        const isPlan = event.questions[0].id === 'plan-execution';
        if (isPlan) ids.push(event.requestId);
        const text = !isPlan ? '自填 JSON' : ids.length === 1 ? '补充回滚步骤' : ids.length === 2 ? PLAN_EXECUTION_START : ending === 'stop' ? PLAN_EXECUTION_STOP : PLAN_EXECUTION_START;
        const id = event.questions[0].id;
        const answer: ResolveUserInputCommand = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'user_input.resolve', commandId: 'answer', partnerId: event.partnerId, conversationId: event.conversationId, connectionSource: event.connectionSource, clientMessageId: event.clientMessageId, sessionId: event.sessionId, runId: event.runId, requestId: event.requestId, answers: { [id]: [text] }, ...(!isPlan || ids.length < 3 ? { customAnswers: { [id]: text } } : {}) };
        await expect(adapter.resolveUserInput({ ...answer, conversationId: 'other' })).rejects.toThrow('USER_INPUT_ROUTE_MISMATCH');
        await adapter.resolveUserInput(answer);
        await expect(adapter.resolveUserInput(answer)).rejects.toThrow('CLAUDE_USER_INPUT_NOT_FOUND');
      }
    }
    expect(results[0]).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 选择格式: '自填 JSON' } } });
    expect(results[1]).toMatchObject({ behavior: 'deny', interrupt: false, message: expect.stringContaining('补充回滚步骤') });
    expect(results[2]).toMatchObject({ behavior: 'deny', interrupt: false, message: expect.stringContaining(PLAN_EXECUTION_START) });
    expect(results[3]).toMatchObject(ending === 'stop' ? { behavior: 'deny', interrupt: true } : { behavior: 'allow' });
    expect(new Set(ids).size).toBe(3);
    expect(options.permissionMode).toBe('plan');
    expect(events.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))).toHaveLength(1);
    expect(events.at(-1)?.type).toBe(ending === 'stop' ? 'run.cancelled' : 'run.completed');
    expect(events.filter((event) => event.type === 'plan.updated' && event.planMode === 'default')).toHaveLength(ending === 'stop' ? 0 : 1);
  });
});
