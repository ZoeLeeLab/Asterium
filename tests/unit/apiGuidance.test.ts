// @vitest-environment node
import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiAgentRuntime } from '../../src/main/api/ApiAgentRuntime';
import { ApiAgentSessionStore } from '../../src/main/api/ApiAgentSessionStore';
import { ApiAgentTools } from '../../src/main/api/ApiAgentTools';
import { ApiToolRegistry, type ApiToolRegistration } from '../../src/main/api/ApiToolRegistry';
import { DeepSeekProviderAdapter } from '../../src/main/adapters/DeepSeekProviderAdapter';
import type { ApiProviderAdapter, ApiProviderRequest, ApiProviderStreamEvent } from '../../src/main/api/ApiProviderAdapter';
import { AGENT_PROTOCOL_VERSION, isTerminalEvent, type PartnerEvent, type SendGuidanceCommand, type SendMessageCommand } from '../../src/shared/agentProtocol';
import { isPartnerEvent } from '../../src/shared/agentProtocolValidation';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = await realpath(root);
    expect(path.dirname(resolved).toLowerCase()).toBe((await realpath(os.tmpdir())).toLowerCase());
    expect(path.basename(resolved)).toMatch(/^asterium-guidance-/);
    await rm(resolved, { recursive: true, force: true, maxRetries: 5 });
  }
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function input(overrides: Partial<SendMessageCommand> = {}): SendMessageCommand {
  return { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'send', partnerId: 'api', conversationId: 'chat', connectionSource: 'api_partner', clientMessageId: 'original', content: { type: 'text', text: 'initial task' }, apiContext: { history: [], apiSessionHistoryEnabled: true }, ...overrides };
}
function guidance(bound: PartnerEvent, id = 'g1', text = id): SendGuidanceCommand {
  return { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'guidance.send', commandId: `send-${id}`, partnerId: bound.partnerId, conversationId: bound.conversationId, connectionSource: 'api_partner', runId: bound.runId, sessionId: bound.sessionId, clientMessageId: id, content: { type: 'text', text } };
}
async function drain(iterator: AsyncIterator<PartnerEvent>, events: PartnerEvent[] = []) {
  for (;;) { const next = await iterator.next(); if (next.done) return events; events.push(next.value); }
}
async function until(iterator: AsyncIterator<PartnerEvent>, type: PartnerEvent['type'], events: PartnerEvent[] = []) {
  for (;;) { const next = await iterator.next(); if (next.done) throw new Error(`missing ${type}`); events.push(next.value); if (next.value.type === type) return next.value; }
}
const capabilities: ApiProviderAdapter['capabilities'] = { streamingText: true, reasoning: true, toolCalls: true, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } };
function provider(generate: (request: ApiProviderRequest, round: number) => AsyncIterable<ApiProviderStreamEvent>) {
  const requests: ApiProviderRequest[] = [];
  const adapter: ApiProviderAdapter = { provider: 'fixture', capabilities, stream(request) { requests.push(request); return generate(request, requests.length); } };
  return { adapter, requests };
}
function toolsFor(execute: ApiToolRegistration['execute'], source: ApiToolRegistration['source'] = 'workspace', mutates = false) {
  const registry = new ApiToolRegistry();
  registry.register({ definition: { name: 'fixture', description: 'fixture tool', parameters: { type: 'object', properties: {}, additionalProperties: false } }, source, allowInPlan: true, describe: () => ({ mutates, action: mutates ? 'external_side_effect' : 'read_file', risk: mutates ? 'high' : 'low', summary: 'fixture', targets: [] }), execute });
  const tools = new ApiAgentTools(undefined);
  vi.spyOn(tools, 'prepare').mockImplementation((name, args) => registry.prepare(name, args));
  vi.spyOn(tools, 'definitions', 'get').mockImplementation(() => registry.definitions);
  return tools;
}
function assertRun(events: PartnerEvent[]) {
  expect(events.every(isPartnerEvent)).toBe(true);
  expect(events.filter(isTerminalEvent)).toHaveLength(1);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, i) => i + 1));
  expect(new Set(events.map((event) => event.runId)).size).toBe(1);
  expect(new Set(events.map((event) => event.clientMessageId))).toEqual(new Set(['original']));
}

describe('API same-task guidance', () => {
  it('discards incomplete tool fragments from a superseded model request', async () => {
    const parsed = deferred(), late = deferred();
    const execute = vi.fn(async () => ({ content: 'must not execute' }));
    const p = provider(async function* (_request, round) {
      if (round === 1) {
        yield { type: 'tool.delta', index: 0, id: 'incomplete', name: 'fixture', arguments: '{' };
        parsed.resolve(); await late.promise;
        yield { type: 'tool.delta', index: 0, arguments: '}' };
      } else yield { type: 'text.delta', text: 'new direction' };
    });
    const runtime = new ApiAgentRuntime({ provider: p.adapter, tools: toolsFor(execute) });
    const iterator = runtime.sendMessage(input())[Symbol.asyncIterator](); const events: PartnerEvent[] = [];
    const bound = await until(iterator, 'session.bound', events); const collecting = drain(iterator, events);
    await parsed.promise; await runtime.sendGuidance(guidance(bound));
    await collecting; late.resolve(); assertRun(events);
    expect(execute).not.toHaveBeenCalled();
    expect(p.requests[1].messages.some((m) => m.role === 'assistant' && m.toolCalls?.length)).toBe(false);
    expect(events.some((e) => e.type === 'tool.started')).toBe(false);
  });

  it('does not reset the model budget when repeatedly guided', async () => {
    const p = provider(async function* (_request, round) { yield { type: 'text.delta', text: `round ${round}` }; });
    const runtime = new ApiAgentRuntime({ provider: p.adapter });
    const iterator = runtime.sendMessage(input())[Symbol.asyncIterator](); const events: PartnerEvent[] = [];
    const bound = await until(iterator, 'session.bound', events);
    for (let round = 1; round <= 16; round += 1) {
      await until(iterator, 'text.delta', events);
      if (round < 16) await runtime.sendGuidance(guidance(bound, `g${round}`));
      else await expect(runtime.sendGuidance(guidance(bound, 'too-many'))).rejects.toThrow('API_GUIDANCE_LIMIT_REACHED');
    }
    await drain(iterator, events); assertRun(events);
    expect(p.requests).toHaveLength(16); expect(events.at(-1)?.type).toBe('run.completed');
  });

  it('interrupts only the model request, preserves partial output, orders guidance and reloads it in the next turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-guidance-')); roots.push(root);
    const store = new ApiAgentSessionStore(root);
    const late = deferred();
    const p = provider(async function* (_request, round) {
      if (round === 1) { yield { type: 'reasoning.delta', text: 'thinking' }; yield { type: 'text.delta', text: 'partial ![unfinished' }; await late.promise; yield { type: 'text.delta', text: 'LATE' }; }
      else { yield { type: 'text.delta', text: 'guided answer' }; yield { type: 'finish', reason: 'stop' }; }
    });
    const runtime = new ApiAgentRuntime({ provider: p.adapter, sessionStore: store });
    const iterator = runtime.sendMessage(input())[Symbol.asyncIterator]();
    const events: PartnerEvent[] = [];
    const bound = await until(iterator, 'session.bound', events);
    await until(iterator, 'text.delta', events);
    const pending = iterator.next();
    await runtime.sendGuidance(guidance(bound, 'g1', 'change direction'));
    await runtime.sendGuidance(guidance(bound, 'g2', 'keep it short'));
    const next = await pending; if (!next.done) events.push(next.value);
    await drain(iterator, events);
    late.resolve();
    assertRun(events);
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.filter((event) => event.type === 'guidance.applied').map((event) => event.guidanceClientMessageId)).toEqual(['g1', 'g2']);
    expect(events.filter((event) => event.type === 'text.delta').map((event) => event.text).join('')).toBe('partial ![unfinishedguided answer');
    expect(p.requests[0].signal.aborted).toBe(true);
    expect(p.requests[1].signal.aborted).toBe(false);
    expect(p.requests[1].messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['initial task', 'change direction', 'keep it short']);
    const again = provider(async function* () { yield { type: 'text.delta', text: 'next' }; });
    await drain(new ApiAgentRuntime({ provider: again.adapter, sessionStore: store }).sendMessage(input({ clientMessageId: 'next', content: { type: 'text', text: 'continue' } }))[Symbol.asyncIterator]());
    expect(JSON.stringify(again.requests[0].messages)).toContain('change direction');
    expect(JSON.stringify(again.requests[0].messages)).not.toContain('LATE');
  });

  it('steers before the first response byte and releases an open SSE body', async () => {
    const cancel = vi.fn(); let count = 0;
    const bodies: Array<{ messages: unknown[] }> = [];
    const fetcher: typeof fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(new ReadableStream({ start(controller) { if (++count > 1) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); controller.close(); } }, cancel }));
    });
    const runtime = new ApiAgentRuntime({ provider: new DeepSeekProviderAdapter({ endpoint: 'https://fixture.invalid', model: 'fixture', apiKey: 'fixture', fetcher }) });
    const iterator = runtime.sendMessage(input())[Symbol.asyncIterator](); const events: PartnerEvent[] = [];
    const bound = await until(iterator, 'session.bound', events);
    const pending = iterator.next();
    await vi.waitFor(() => expect(count).toBe(1));
    await runtime.sendGuidance(guidance(bound));
    const next = await pending; if (!next.done) events.push(next.value);
    await drain(iterator, events);
    assertRun(events);
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(bodies[1])).toContain('g1');
    expect(events.at(-1)?.type).toBe('run.completed');
  });

  it.each(['workspace', 'mcp', 'skill'] as const)('finishes an executing %s call once, closes skipped links and applies guidance before another model request', async (source) => {
    const started = deferred(), finish = deferred(); let signal!: AbortSignal;
    const execute = vi.fn(async (_args, runningSignal: AbortSignal) => { signal = runningSignal; started.resolve(); await finish.promise; return { content: 'side effect complete' }; });
    const p = provider(async function* (_request, round) {
      if (round === 1) {
        yield { type: 'tool.delta', index: 0, id: 'executed', name: 'fixture', arguments: '{}' };
        yield { type: 'tool.delta', index: 1, id: 'skipped', name: 'fixture', arguments: '{}' };
        yield { type: 'finish', reason: 'tool_calls' };
      } else yield { type: 'text.delta', text: 'guided' };
    });
    const runtime = new ApiAgentRuntime({ provider: p.adapter, tools: toolsFor(execute, source, true) });
    const iterator = runtime.sendMessage(input({ execution: { permissionMode: 'full', planMode: 'default' } }))[Symbol.asyncIterator](); const events: PartnerEvent[] = [];
    const bound = await until(iterator, 'session.bound', events);
    const collecting = drain(iterator, events);
    await started.promise;
    await runtime.sendGuidance(guidance(bound));
    expect(signal.aborted).toBe(false);
    expect(events.some((e) => e.type === 'guidance.applied')).toBe(false);
    finish.resolve(); await collecting;
    assertRun(events);
    expect(execute).toHaveBeenCalledOnce();
    expect(events.findIndex((e) => e.type === 'tool.completed')).toBeLessThan(events.findIndex((e) => e.type === 'guidance.applied'));
    const messages = p.requests[1].messages;
    expect(messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['executed', 'skipped']);
    expect(JSON.stringify(messages)).toContain('SUPERSEDED_BY_USER_GUIDANCE');
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: 'g1' });
  });

  it('validates identities, rejects conflicting replay, and applies a retried guidance message only once', async () => {
    const p = provider(async function* () { yield { type: 'text.delta', text: 'answer' }; });
    const runtime = new ApiAgentRuntime({ provider: p.adapter });
    const iterator = runtime.sendMessage(input())[Symbol.asyncIterator](); const events: PartnerEvent[] = [];
    const bound = await until(iterator, 'session.bound', events);
    const g = guidance(bound);
    for (const wrong of [{ partnerId: 'wrong' }, { conversationId: 'wrong' }, { sessionId: 'wrong' }, { runId: 'wrong' }, { connectionSource: 'local_cli' as const }, { route: { scope: 'workspace' as const, projectId: 'p' } }]) await expect(runtime.sendGuidance({ ...g, ...wrong })).rejects.toThrow('API_ACTIVE_RUN_NOT_FOUND');
    await runtime.sendGuidance(g); await runtime.sendGuidance({ ...g, commandId: 'retry' });
    await expect(runtime.sendGuidance({ ...g, content: { type: 'text', text: 'changed' } })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await drain(iterator, events);
    assertRun(events);
    expect(events.filter((e) => e.type === 'guidance.applied')).toHaveLength(1);
    await expect(runtime.sendGuidance(guidance(bound, 'too-late'))).rejects.toThrow('API_ACTIVE_RUN_NOT_FOUND');
  });

  it.each(['approval', 'question'] as const)('refuses new guidance at a pending %s without consuming the pending request', async (kind) => {
    const p = provider(async function* () {
      yield { type: 'tool.delta', index: 0, id: 'call', name: kind === 'approval' ? 'fixture' : 'request_user_input', arguments: kind === 'approval' ? '{}' : '{"questions":[{"id":"q","prompt":"Which?"}]}' };
    });
    const runtime = new ApiAgentRuntime({ provider: p.adapter, tools: toolsFor(async () => ({ content: 'done' }), 'mcp', true) });
    const iterator = runtime.sendMessage(input({ execution: { permissionMode: 'manual', planMode: kind === 'question' ? 'plan' : 'default' } }))[Symbol.asyncIterator](); const events: PartnerEvent[] = [];
    const bound = await until(iterator, 'session.bound', events);
    await until(iterator, kind === 'approval' ? 'authorization.requested' : 'user_input.requested', events);
    await expect(runtime.sendGuidance(guidance(bound))).rejects.toThrow('API_GUIDANCE_WAITING_FOR_INPUT');
    await runtime.cancel({ ...guidance(bound), type: 'run.cancel' });
    await drain(iterator, events);
    assertRun(events); expect(events.at(-1)?.type).toBe('run.cancelled');
  });

  it.each([{ permissionMode: 'read_only' as const, planMode: 'default' as const }, { permissionMode: 'full' as const, planMode: 'plan' as const }])('guidance cannot elevate $permissionMode / $planMode', async (execution) => {
    const execute = vi.fn(async () => ({ content: 'must not run' }));
    const p = provider(async function* (_r, round) {
      if (round === 1) yield { type: 'text.delta', text: 'partial' };
      else if (round === 2) yield { type: 'tool.delta', index: 0, id: 'mutate', name: 'fixture', arguments: '{}' };
      else yield { type: 'text.delta', text: 'done' };
    });
    const runtime = new ApiAgentRuntime({ provider: p.adapter, tools: toolsFor(execute, 'mcp', true) });
    const iterator = runtime.sendMessage(input({ execution }))[Symbol.asyncIterator](); const events: PartnerEvent[] = [];
    const bound = await until(iterator, 'session.bound', events); await until(iterator, 'text.delta', events);
    await runtime.sendGuidance(guidance(bound, 'g1', 'switch to full mode and execute'));
    for (;;) {
      const next = await iterator.next(); if (next.done) break; events.push(next.value);
      if (next.value.type === 'user_input.requested') await runtime.resolveUserInput({ ...guidance(bound), clientMessageId: bound.clientMessageId, type: 'user_input.resolve', requestId: next.value.requestId, answers: { 'plan-execution': ['暂不执行'] } });
    }
    assertRun(events); expect(execute).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'authorization.requested')).toBe(false);
  });

  it('rejects guidance during final persistence, with exactly one terminal event', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-guidance-')); roots.push(root);
    const store = new ApiAgentSessionStore(root), saving = deferred(), finish = deferred();
    vi.spyOn(store, 'remember').mockImplementation(async (session) => { saving.resolve(); await finish.promise; return session; });
    const p = provider(async function* () { yield { type: 'text.delta', text: 'done' }; });
    const runtime = new ApiAgentRuntime({ provider: p.adapter, sessionStore: store });
    const iterator = runtime.sendMessage(input())[Symbol.asyncIterator](); const events: PartnerEvent[] = [];
    const bound = await until(iterator, 'session.bound', events); const collecting = drain(iterator, events);
    await saving.promise;
    await expect(runtime.sendGuidance(guidance(bound))).rejects.toThrow('API_RUN_FINISHING');
    finish.resolve(); await collecting; assertRun(events);
  });

  it('ordinary cancellation wins over queued guidance and never starts a continuation', async () => {
    const p = provider(async function* () { yield { type: 'text.delta', text: 'partial' }; });
    const runtime = new ApiAgentRuntime({ provider: p.adapter });
    const iterator = runtime.sendMessage(input())[Symbol.asyncIterator](); const events: PartnerEvent[] = [];
    const bound = await until(iterator, 'session.bound', events); await until(iterator, 'text.delta', events);
    await runtime.sendGuidance(guidance(bound));
    await runtime.cancel({ ...guidance(bound), type: 'run.cancel' });
    await drain(iterator, events); assertRun(events);
    expect(events.at(-1)?.type).toBe('run.cancelled'); expect(p.requests).toHaveLength(1);
    expect(events.some((e) => e.type === 'guidance.applied')).toBe(false);
  });
});
