import { describe, expect, it, vi } from 'vitest';
import { AdapterHost } from '../../src/main/AdapterHost';
import type { PartnerAdapter } from '../../src/main/adapters/PartnerAdapter';
import { RunCoordinator } from '../../src/main/runtime/RunCoordinator';
import { conversationWriterScope, WriterLeaseCoordinator } from '../../src/main/runtime/WriterLeaseCoordinator';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type ResumeSessionCommand, type SendMessageCommand } from '../../src/shared/agentProtocol';

function command(conversationId: string, route?: SendMessageCommand['route'], partnerId = 'partner-one'): SendMessageCommand {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'message.send',
    commandId: `command-${partnerId}-${conversationId}`,
    partnerId,
    conversationId,
    connectionSource: 'local_cli',
    clientMessageId: `client-${partnerId}-${conversationId}`,
    content: { type: 'text', text: conversationId },
    ...(route ? { route } : {}),
  };
}

function event(command: SendMessageCommand, type: 'session.bound' | 'message.accepted' | 'run.completed', sequence: number): PartnerEvent {
  const base = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    eventId: `${type}-${command.partnerId}-${command.conversationId}`,
    partnerId: command.partnerId,
    conversationId: command.conversationId,
    connectionSource: command.connectionSource,
    clientMessageId: command.clientMessageId,
    sessionId: `session-${command.partnerId}-${command.conversationId}`,
    runId: `run-${command.partnerId}-${command.conversationId}`,
    sequence,
    occurredAt: '2026-10-13T00:00:00.000Z',
  } as const;
  if (type === 'session.bound') return { ...base, type, isNew: true };
  if (type === 'message.accepted') return { ...base, type };
  return { ...base, type, finishReason: 'completed' };
}

function adapterFor(command: SendMessageCommand): PartnerAdapter {
  return {
    connectionSource: 'local_cli',
    capabilities: { streamingText: true, cancellation: true, sessionResume: true, toolEvents: true, fileEvents: true, authorizationBridge: true, extensions: [] },
    async *sendMessage() {
      yield event(command, 'session.bound', 1);
      yield event(command, 'message.accepted', 2);
      yield event(command, 'run.completed', 3);
    },
    async *resumeSession() {
      yield event(command, 'message.accepted', 2);
    },
    resolveAuthorization: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  };
}

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

function gatedAdapter(command: SendMessageCommand, gate: Promise<void>, started = vi.fn()): PartnerAdapter {
  const adapter = adapterFor(command);
  adapter.sendMessage = async function* () {
    started();
    yield event(command, 'session.bound', 1);
    await gate;
    yield event(command, 'message.accepted', 2);
    yield event(command, 'run.completed', 3);
  };
  return adapter;
}

describe('RunCoordinator', () => {
  it('rejects a forged API persistence flag targeted at a native adapter', async () => {
    const host = new AdapterHost(), native = adapterFor(command('single'));
    host.bindRun('native-run', native);
    const resolve = vi.spyOn(native, 'resolveAuthorization');
    const coordinator = new RunCoordinator(host, { deliver: vi.fn(), emit: vi.fn(), observe: async () => undefined });
    await expect(coordinator.resolveAuthorization({ ...command('single'), type: 'authorization.resolve', connectionSource: 'api_partner', runId: 'native-run', sessionId: 'native-session', authorizationId: 'native-auth', decision: 'allow_once', persistExtensionTrust: true })).rejects.toThrow('EXTENSION_TRUST_NOT_OFFERED');
    expect(resolve).not.toHaveBeenCalled();
  });
  it('runs same-partner single and group conversations concurrently without crossing event routes', async () => {
    const host = new AdapterHost();
    const emitted: PartnerEvent[] = [];
    const observed: PartnerEvent[] = [];
    const delivered: string[] = [];
    const leases = new WriterLeaseCoordinator();
    const coordinator = new RunCoordinator(host, {
      deliver: (current, state) => delivered.push(`${current.conversationId}:${state}`),
      emit: (current) => emitted.push(current),
      observe: async (current) => { observed.push(current); },
    }, leases);
    const single = command('single-chat');
    const group = command('group:v3:room:partner-one', { scope: 'group', roomId: 'room', roundId: 'round', bindingGeneration: 2, inputThroughSeq: 4 });
    const singleGate = barrier();
    const groupGate = barrier();
    const singleStarted = vi.fn();
    const groupStarted = vi.fn();

    await Promise.all([
      coordinator.start(gatedAdapter(single, singleGate.wait, singleStarted), single),
      coordinator.start(gatedAdapter(group, groupGate.wait, groupStarted), group),
    ]);
    expect(singleStarted).toHaveBeenCalledTimes(1);
    expect(groupStarted).toHaveBeenCalledTimes(1);
    expect(leases.ownerFor(conversationWriterScope(single))).toBe(`runtime:${single.commandId}`);
    expect(leases.ownerFor(conversationWriterScope(group))).toBe(`runtime:${group.commandId}`);

    singleGate.release();
    groupGate.release();
    await vi.waitFor(() => expect(emitted.filter((item) => item.type === 'run.completed')).toHaveLength(2));

    expect(emitted.filter((item) => item.conversationId === single.conversationId).every((item) => item.route === undefined)).toBe(true);
    expect(emitted.filter((item) => item.conversationId === group.conversationId).every((item) => item.route?.scope === 'group' && item.route.roomId === 'room')).toBe(true);
    expect(observed).toEqual(emitted);
    expect(delivered).toEqual(expect.arrayContaining([
      'single-chat:awaiting_confirmation',
      'group:v3:room:partner-one:awaiting_confirmation',
      'single-chat:delivered',
      'group:v3:room:partner-one:delivered',
    ]));
    expect(delivered).toHaveLength(4);
  });

  it('serializes duplicate writers for one logical conversation', async () => {
    const current = command('single-chat');
    const duplicate = {
      ...command('single-chat'),
      commandId: 'command-duplicate',
      clientMessageId: 'client-duplicate',
    };
    const firstGate = barrier();
    const duplicateGate = barrier();
    const duplicateStarted = vi.fn();
    const leases = new WriterLeaseCoordinator();
    const coordinator = new RunCoordinator(new AdapterHost(), {
      deliver: vi.fn(), emit: vi.fn(), observe: vi.fn(async () => undefined),
    }, leases);

    await coordinator.start(gatedAdapter(current, firstGate.wait), current);
    const duplicateReceipt = coordinator.start(gatedAdapter(duplicate, duplicateGate.wait, duplicateStarted), duplicate);
    await Promise.resolve();
    expect(duplicateStarted).not.toHaveBeenCalled();
    expect(leases.ownerFor(conversationWriterScope(current))).toBe(`runtime:${current.commandId}`);

    firstGate.release();
    await vi.waitFor(() => expect(duplicateStarted).toHaveBeenCalledTimes(1));
    await duplicateReceipt;
    expect(leases.ownerFor(conversationWriterScope(current))).toBe(`runtime:${duplicate.commandId}`);
    duplicateGate.release();
    await vi.waitFor(() => expect(leases.ownerFor(conversationWriterScope(current))).toBeUndefined());
  });

  it('makes session resume wait for the writer of the same logical conversation', async () => {
    const current = command('single-chat');
    const sendGate = barrier();
    const resumeStarted = vi.fn();
    const adapter = gatedAdapter(current, sendGate.wait);
    adapter.resumeSession = async function* () {
      resumeStarted();
      yield event(current, 'message.accepted', 4);
    };
    const leases = new WriterLeaseCoordinator();
    const coordinator = new RunCoordinator(new AdapterHost(), {
      deliver: vi.fn(), emit: vi.fn(), observe: vi.fn(async () => undefined),
    }, leases);
    const receipt = await coordinator.start(adapter, current);
    const resume: ResumeSessionCommand = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'session.resume',
      commandId: 'resume-single-chat',
      partnerId: current.partnerId,
      conversationId: current.conversationId,
      connectionSource: current.connectionSource,
      sessionId: receipt.sessionId,
      afterSequence: 3,
    };

    const resumed = coordinator.resume(resume);
    await Promise.resolve();
    expect(resumeStarted).not.toHaveBeenCalled();
    sendGate.release();
    await resumed;
    expect(resumeStarted).toHaveBeenCalledTimes(1);
    expect(leases.ownerFor(conversationWriterScope(current))).toBeUndefined();
  });

  it('runs different partners concurrently and keeps their events isolated', async () => {
    const first = command('shared-conversation-id', undefined, 'partner-one');
    const second = command('shared-conversation-id', undefined, 'partner-two');
    const firstGate = barrier();
    const secondGate = barrier();
    const firstStarted = vi.fn();
    const secondStarted = vi.fn();
    const emitted: PartnerEvent[] = [];
    const leases = new WriterLeaseCoordinator();
    const coordinator = new RunCoordinator(new AdapterHost(), {
      deliver: vi.fn(), emit: (current) => emitted.push(current), observe: vi.fn(async () => undefined),
    }, leases);

    await Promise.all([
      coordinator.start(gatedAdapter(first, firstGate.wait, firstStarted), first),
      coordinator.start(gatedAdapter(second, secondGate.wait, secondStarted), second),
    ]);
    expect(firstStarted).toHaveBeenCalledTimes(1);
    expect(secondStarted).toHaveBeenCalledTimes(1);
    expect(leases.ownerFor(conversationWriterScope(first))).toBe(`runtime:${first.commandId}`);
    expect(leases.ownerFor(conversationWriterScope(second))).toBe(`runtime:${second.commandId}`);

    firstGate.release();
    secondGate.release();
    await vi.waitFor(() => expect(emitted.filter((item) => item.type === 'run.completed')).toHaveLength(2));
    expect(emitted.filter((item) => item.partnerId === first.partnerId).every((item) => item.conversationId === first.conversationId && item.runId === `run-${first.partnerId}-${first.conversationId}`)).toBe(true);
    expect(emitted.filter((item) => item.partnerId === second.partnerId).every((item) => item.conversationId === second.conversationId && item.runId === `run-${second.partnerId}-${second.conversationId}`)).toBe(true);
  });

  it('keeps idempotency stable and rejects changed payloads without starting another run', async () => {
    const coordinator = new RunCoordinator(new AdapterHost(), { deliver: vi.fn(), emit: vi.fn(), observe: vi.fn(async () => undefined) });
    const start = vi.fn(async () => ({ runId: 'run-one', sessionId: 'session-one' }));
    const first = coordinator.runIdempotent('client-one', 'same', start);
    const replay = coordinator.runIdempotent('client-one', 'same', start);
    expect(replay).toBe(first);
    await expect(first).resolves.toEqual({ runId: 'run-one', sessionId: 'session-one' });
    expect(start).toHaveBeenCalledTimes(1);
    expect(() => coordinator.runIdempotent('client-one', 'changed', start)).toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('runs release hooks only after the completed writer is released', async () => {
    const host = new AdapterHost();
    const current = command('group:v3:room:partner-one', { scope: 'group', roomId: 'room', roundId: 'round', bindingGeneration: 1, inputThroughSeq: 1 });
    let adapterWriterReleased = false;
    const adapter = adapterFor(current);
    const send = adapter.sendMessage.bind(adapter);
    adapter.sendMessage = async function* (sent) {
      try {
        yield* send(sent);
      } finally {
        adapterWriterReleased = true;
      }
    };
    const released = vi.fn(async ({ receipt }: { receipt: { runId: string } }) => {
      expect(host.adapterForRun(receipt.runId)).toBeUndefined();
      expect(adapterWriterReleased).toBe(true);
    });
    const coordinator = new RunCoordinator(host, {
      deliver: vi.fn(), emit: vi.fn(), observe: vi.fn(async () => undefined), onReleased: released,
    });

    await coordinator.start(adapter, current);
    await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(1));
  });
});
