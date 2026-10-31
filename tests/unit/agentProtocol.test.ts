import { describe, expect, it } from 'vitest';
import { MockAdapter } from '../helpers/MockAdapter';
import {
  AGENT_PROTOCOL_VERSION,
  CODEX_NATIVE_TOOL_PROTOCOL_VERSION,
  isTerminalEvent,
  type PartnerEvent,
  type SendMessageCommand,
} from '../../src/shared/agentProtocol';
import { isAgentCommand, isPartnerEvent } from '../../src/shared/agentProtocolValidation';

function command(id = 'client-1'): SendMessageCommand {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'message.send',
    commandId: `command-${id}`,
    partnerId: 'partner-1',
    conversationId: 'conversation-1',
    connectionSource: 'local_cli',
    clientMessageId: id,
    content: { type: 'text', text: '你好' },
  };
}

async function collect(stream: AsyncIterable<PartnerEvent>) {
  const events: PartnerEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function expectOrdered(events: PartnerEvent[]) {
  expect(events.every(isPartnerEvent)).toBe(true);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
  expect(events.filter(isTerminalEvent)).toHaveLength(1);
}

describe('agent protocol v0.1', () => {
  it('accepts old tool events and bounds the optional presentation name', async () => {
    const bound = (await collect(new MockAdapter('normal').sendMessage(command())))[0];
    const event = { ...bound, type: 'tool.started', toolCallId: 'call', toolName: 'mcp_encoded', summary: 'call', mutatesExternalState: true };
    expect(isPartnerEvent(event)).toBe(true);
    expect(isPartnerEvent({ ...event, presentationName: 'mcp__fixture__inspect' })).toBe(true);
    for (const presentationName of ['', 4, 'x'.repeat(513)]) expect(isPartnerEvent({ ...event, presentationName })).toBe(false);
  });
  it('validates API guidance boundaries and rejects malformed or non-user source snapshots', async () => {
    const bound = (await collect(new MockAdapter('normal').sendMessage(command())))[0];
    const applied = { ...bound, connectionSource: 'api_partner', type: 'guidance.applied', guidanceClientMessageId: 'guidance-one' };
    expect(isPartnerEvent(applied)).toBe(true);
    expect(isPartnerEvent({ ...applied, guidanceClientMessageId: '' })).toBe(false);
    expect(isPartnerEvent({ ...applied, connectionSource: 'local_cli' })).toBe(false);
    const sourceMessage = { messageId: 'visible', authorType: 'user', authorId: 'asterium:user:local', content: 'correction', createdAt: '12:00' };
    const send = { ...command(), type: 'guidance.send', runId: 'r', sessionId: 's', sourceMessage };
    expect(isAgentCommand(send)).toBe(true);
    expect(isAgentCommand({ ...send, sourceMessage: { ...sourceMessage, authorType: 'partner' } })).toBe(false);
    expect(isPartnerEvent({ ...applied, sourceMessage })).toBe(true);
    expect(isPartnerEvent({ ...applied, sourceMessage: { ...sourceMessage, authorType: 'partner' } })).toBe(false);
  });
  it('keeps the approval enum unchanged and restricts persistent extension intent to API allow_once', () => {
    const request = { ...command(), type: 'authorization.resolve', runId: 'run', sessionId: 'session', authorizationId: 'auth', decision: 'allow_once', connectionSource: 'api_partner', persistExtensionTrust: true };
    expect(isAgentCommand(request)).toBe(true);
    expect(isAgentCommand({ ...request, decision: 'deny' })).toBe(false);
    expect(isAgentCommand({ ...request, decision: 'trust' })).toBe(false);
    expect(isAgentCommand({ ...request, connectionSource: 'local_cli' })).toBe(false);
    expect(isAgentCommand({ ...request, persistExtensionTrust: 'yes' })).toBe(false);
  });
  it('accepts a positive Codex tool protocol marker only on otherwise valid bound events', async () => {
    const bound = (await collect(new MockAdapter('normal').sendMessage(command())))[0];
    expect(isPartnerEvent({ ...bound, toolProtocolVersion: CODEX_NATIVE_TOOL_PROTOCOL_VERSION })).toBe(true);
    expect(isPartnerEvent({ ...bound, toolProtocolVersion: 0 })).toBe(false);
  });

  it('validates commands and rejects malformed payloads', () => {
    expect(isAgentCommand(command())).toBe(true);
    expect(isAgentCommand({ ...command(), protocolVersion: 99 })).toBe(false);
    expect(isAgentCommand({ ...command(), connectionSource: 'unknown' })).toBe(false);
    expect(isAgentCommand({ ...command(), content: { type: 'text', text: '  ' } })).toBe(false);
    expect(isAgentCommand({ ...command(), connectionSource: 'api_partner', apiContext: { systemPrompt: 'system', history: [{ role: 'user', content: 'prior' }] } })).toBe(true);
    expect(isAgentCommand({ ...command(), connectionSource: 'api_partner', apiContext: { history: [], apiSessionHistoryEnabled: false } })).toBe(true);
    expect(isAgentCommand({ ...command(), connectionSource: 'api_partner', apiContext: { history: [], apiSessionHistoryEnabled: 'false' } })).toBe(false);
    expect(isAgentCommand({ ...command(), connectionSource: 'api_partner', apiContext: { history: [{ role: 'tool', content: 'invalid' }] } })).toBe(false);
    expect(isAgentCommand({ ...command(), connectionSource: 'api_partner', apiContext: { history: Array.from({ length: 31 }, () => ({ role: 'user', content: 'too many' })) } })).toBe(false);
    expect(isAgentCommand({ ...command(), connectionSource: 'api_partner', apiContext: { systemPrompt: 's'.repeat(20_001), history: [] } })).toBe(false);
    expect(isAgentCommand({ ...command(), connectionSource: 'api_partner', apiContext: { systemPrompt: 'system', history: [{ role: 'user', content: 'h'.repeat(60_000) }] } })).toBe(true);
    expect(isAgentCommand({ ...command(), connectionSource: 'api_partner', apiContext: { history: [{ role: 'user', content: 'h'.repeat(60_001) }] } })).toBe(false);
    const runtimeContext = {
      partner: { displayName: '测试助手', introduction: '', expertise: '', mentionName: '测试助手', avatarAvailable: false },
      runtime: { source: 'local_cli' as const, adapter: 'codex_cli' as const },
      memoryBriefing: 'Main 注入的简报',
    };
    expect(isAgentCommand({ ...command(), runtimeContext })).toBe(true);
    expect(isAgentCommand({ ...command(), runtimeContext: { ...runtimeContext, memoryBriefing: 1 } })).toBe(false);
    expect(isAgentCommand({ ...command(), runtimeContext: { ...runtimeContext, memoryBriefing: 'm'.repeat(20_001) } })).toBe(false);
    const guidance = { ...command(), type: 'guidance.send' as const, runId: 'run-1', sessionId: 'session-1' };
    expect(isAgentCommand(guidance)).toBe(true);
    expect(isAgentCommand({ ...guidance, content: { type: 'text', text: '   ' } })).toBe(false);
  });

  it('streams a normal ordered run', async () => {
    const events = await collect(new MockAdapter('normal').sendMessage(command()));
    expectOrdered(events);
    expect(events.map((event) => event.type)).toEqual([
      'session.bound', 'message.accepted', 'work.status', 'text.delta', 'text.delta', 'run.completed',
    ]);
    expect(events.filter((event) => event.type === 'text.delta').map((event) => event.text).join('')).toBe('你好，星丛。');
  });

  it('supports a tool and authorization flow', async () => {
    const adapter = new MockAdapter('tool');
    const iterator = adapter.sendMessage(command())[Symbol.asyncIterator]();
    const events: PartnerEvent[] = [];
    for (let index = 0; index < 4; index += 1) events.push((await iterator.next()).value!);
    const request = events.at(-1)!;
    expect(request.type).toBe('authorization.requested');
    if (request.type !== 'authorization.requested') throw new Error('missing authorization request');
    await adapter.resolveAuthorization({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'authorization.resolve',
      commandId: 'authorize-1',
      partnerId: request.partnerId,
      conversationId: request.conversationId,
      connectionSource: request.connectionSource,
      clientMessageId: request.clientMessageId,
      runId: request.runId,
      sessionId: request.sessionId,
      authorizationId: request.authorizationId,
      decision: 'allow_once',
    });
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events.some((event) => event.type === 'file.produced')).toBe(true);
    expectOrdered(events);
  });

  it('keeps delivery acknowledgement separate from a failed run', async () => {
    const events = await collect(new MockAdapter('failure').sendMessage(command()));
    expect(events.some((event) => event.type === 'message.accepted')).toBe(true);
    expect(events.at(-1)?.type).toBe('run.failed');
    expectOrdered(events);
  });

  it('cancels idempotently and emits no completion afterward', async () => {
    const adapter = new MockAdapter('cancel');
    const iterator = adapter.sendMessage(command())[Symbol.asyncIterator]();
    const events: PartnerEvent[] = [];
    for (let index = 0; index < 3; index += 1) events.push((await iterator.next()).value!);
    const active = events.at(-1)!;
    const cancel = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'run.cancel' as const,
      commandId: 'cancel-1',
      partnerId: active.partnerId,
      conversationId: active.conversationId,
      connectionSource: active.connectionSource,
      clientMessageId: active.clientMessageId,
      runId: active.runId,
      sessionId: active.sessionId,
    };
    await adapter.cancel(cancel);
    await adapter.cancel(cancel);
    events.push((await iterator.next()).value!);
    expect((await iterator.next()).done).toBe(true);
    expect(events.at(-1)?.type).toBe('run.cancelled');
    expect(events.some((event) => event.type === 'run.completed')).toBe(false);
    expectOrdered(events);
  });

  it('deduplicates exact retries and rejects changed payloads', async () => {
    const adapter = new MockAdapter('normal');
    const first = await collect(adapter.sendMessage(command()));
    const replay = await collect(adapter.sendMessage(command()));
    expect(replay).toEqual(first);
    expect(adapter.executionCount.get('client-1')).toBe(1);
    expect(() => adapter.sendMessage({ ...command(), content: { type: 'text', text: '不同内容' } })).toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('replays only events after the last contiguous sequence', async () => {
    const adapter = new MockAdapter('normal');
    const original = await collect(adapter.sendMessage(command()));
    const resumed = await collect(adapter.resumeSession({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'session.resume',
      commandId: 'resume-1',
      partnerId: 'partner-1',
      conversationId: 'conversation-1',
      connectionSource: 'local_cli',
      sessionId: original[0].sessionId,
      afterSequence: 3,
    }));
    expect(resumed).toEqual(original.slice(3));
  });

  it('accepts open extension names with JSON-safe payloads', () => {
    const event: PartnerEvent = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'extension.event',
      eventId: 'event-extension',
      partnerId: 'partner-1',
      conversationId: 'conversation-1',
      connectionSource: 'existing_thread',
      clientMessageId: 'client-1',
      sessionId: 'session-1',
      runId: 'run-1',
      sequence: 1,
      occurredAt: new Date(0).toISOString(),
      namespace: 'future.workspace',
      name: 'anything.registered_later',
      schemaVersion: 1,
      payload: { nested: ['safe', 1, true, null] },
    };
    expect(isPartnerEvent(event)).toBe(true);
    expect(isPartnerEvent({ ...event, payload: { invalid: undefined } })).toBe(false);
    expect(isPartnerEvent({ ...event, schemaVersion: 0 })).toBe(false);
  });
});
