// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ApiAgentRuntime } from '../../src/main/api/ApiAgentRuntime';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import type { ApiProviderAdapter, ApiProviderRequest } from '../../src/main/api/ApiProviderAdapter';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type ResolveUserInputCommand } from '../../src/shared/agentProtocol';
import { PLAN_EXECUTION_START, PLAN_EXECUTION_STOP } from '../../src/main/adapters/planExecutionDecision';

const questionId = 'plan-execution';
function response(event: PartnerEvent, text: string, custom = false): ResolveUserInputCommand {
  if (event.type !== 'user_input.requested') throw new Error('not a question');
  return { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'user_input.resolve', commandId: 'answer', partnerId: event.partnerId, conversationId: event.conversationId, connectionSource: event.connectionSource, clientMessageId: event.clientMessageId, sessionId: event.sessionId, runId: event.runId, route: event.route, requestId: event.requestId, answers: { [questionId]: [text] }, ...(custom ? { customAnswers: { [questionId]: text } } : {}) };
}

describe('API Plan revisions', () => {
  it('keeps full-mode planning read-only through custom feedback and a typed start label, then explicitly stops', async () => {
    const requests: ApiProviderRequest[] = [];
    const provider: ApiProviderAdapter = { provider: 'fixture', capabilities: { streamingText: true, reasoning: false, toolCalls: true, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } }, async *stream(request) { requests.push(request); yield { type: 'text.delta', text: `计划 ${requests.length}` }; } };
    const update = vi.fn();
    const runtime = new ApiAgentRuntime({ provider, tools: new ApiAgentTools(undefined, [], undefined, { update, status: async () => '', workspace: async () => '' }) });
    const events: PartnerEvent[] = [], ids: string[] = [];
    for await (const event of runtime.sendMessage({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'send', partnerId: 'p', conversationId: 'c', connectionSource: 'api_partner', clientMessageId: 'u', content: { type: 'text', text: 'make a plan' }, execution: { permissionMode: 'full', planMode: 'plan' } })) {
      events.push(event);
      if (event.type === 'user_input.requested') {
        ids.push(event.requestId);
        await expect(runtime.resolveUserInput({ ...response(event, PLAN_EXECUTION_START), clientMessageId: 'forged' })).rejects.toThrow('USER_INPUT_ROUTE_MISMATCH');
        await expect(runtime.resolveUserInput({ ...response(event, PLAN_EXECUTION_START), answers: { [questionId]: [PLAN_EXECUTION_START, '修改'] } })).rejects.toThrow('INVALID_USER_INPUT_ANSWERS');
        await expect(runtime.resolveUserInput({ ...response(event, PLAN_EXECUTION_START, true), customAnswers: { [questionId]: 'mismatch' } })).rejects.toThrow('INVALID_USER_INPUT_ANSWERS');
        await runtime.resolveUserInput(response(event, ids.length === 1 ? '增加测试步骤，保留 recommended 原文' : ids.length === 2 ? PLAN_EXECUTION_START : PLAN_EXECUTION_STOP, ids.length < 3));
      }
    }
    expect(ids).toHaveLength(3); expect(new Set(ids).size).toBe(3);
    expect(requests.every((r) => r.messages.some((m) => m.role === 'system' && m.content.includes('星丛 Plan 模式')))).toBe(true);
    expect(requests[1].messages).toContainEqual({ role: 'user', content: '增加测试步骤，保留 recommended 原文' });
    expect(requests[2].messages.at(-1)).toEqual({ role: 'user', content: PLAN_EXECUTION_START });
    expect(update).not.toHaveBeenCalled();
    expect(events.filter((e) => ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type))).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run.cancelled');
    expect(events.some((e) => e.type === 'plan.updated' && e.planMode === 'default')).toBe(false);
    expect(events.filter((e) => e.type === 'user_input.resolved').slice(0, 2).every((e) => Boolean(e.customAnswers?.[questionId]))).toBe(true);
  });
});
