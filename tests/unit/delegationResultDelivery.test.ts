// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { autoTestOutput } from '../helpers/autoTest.mjs';
import { PartnerDelegation, type DelegationBatch } from '../../src/main/runtime/PartnerDelegation';
import { DelegationResultDelivery } from '../../src/main/runtime/DelegationResultDelivery';
import { DelegationConversationRuntime, delegationReportTools } from '../../src/main/runtime/DelegationConversationRuntime';
import { WriterLeaseCoordinator } from '../../src/main/runtime/WriterLeaseCoordinator';
import { RunCoordinator } from '../../src/main/runtime/RunCoordinator';
import { AdapterHost } from '../../src/main/AdapterHost';
import type { PartnerAdapter } from '../../src/main/adapters/PartnerAdapter';
import type { StudioPartnerRecord } from '../../src/main/studio/StudioRuntimeCatalog';
import type { NativeThreadBinding } from '../../src/shared/studioRuntime';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';
import type { SingleChatConversationSnapshot } from '../../src/shared/singleChatMessages';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const owner = { conversationId: 'fixture-conversation', partnerId: 'fixture-parent', turnId: 'fixture-turn', messageId: 'fixture-message' };
const time = '2026-01-01T00:00:00.000Z';

async function fixture() {
  const file = path.join(autoTestOutput(), 'delegation.json');
  const binding: NativeThreadBinding = { bindingId: 'fixture-binding', generation: 1, state: 'active', source: 'local_cli', scope: 'single',
    partnerId: owner.partnerId, conversationId: owner.conversationId, nativeThreadId: 'fixture-native-session', createdAt: time, updatedAt: time };
  const source: SingleChatConversationSnapshot = { ...owner, sessionId: binding.nativeThreadId, messages: [], apiSessionHistoryEnabled: false };
  const partner: StudioPartnerRecord = { partnerId: owner.partnerId, sourceMode: 'local_cli', available: true,
    publicIdentity: { displayName: '示例伙伴', introduction: '', expertise: '', mentionName: 'example' },
    management: { personality: true, userProfile: true, memoryMode: 'asterium' }, runtime: { kind: 'local', adapterType: 'codex_cli', workspaceGrantIds: [] },
    runtimeContext: { source: 'local_cli' }, fallbackModel: 'fixture-model' };
  const leases = new WriterLeaseCoordinator();
  const save = vi.fn(async () => undefined);
  const state = { binding, source, deleted: false, workspace: 'fixture-workspace' };
  const runtime = new DelegationConversationRuntime({ binding: async () => state.binding, source: async () => state.source,
    deleted: async () => state.deleted, partner: () => partner, workspaceSignature: async () => state.workspace, leases, save });
  const captureCommand: SendMessageCommand = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'fixture-command',
    clientMessageId: owner.turnId, ...owner, connectionSource: 'local_cli', sessionId: binding.nativeThreadId, content: { type: 'text', text: 'Consult the example partner' } };
  const execute = vi.fn(async () => '合成复核结论');
  const store = new PartnerDelegation(file, execute);
  cleanups.push(async () => { store.close(); });
  const target = await runtime.capture(captureCommand);
  const batch = await store.submit(owner, 'fixture-call', { tasks: [{ targetPartnerId: 'fixture-child', instruction: 'Review synthetic material' }] }, undefined, target);
  await vi.waitFor(async () => expect(await store.pendingDeliveries()).toHaveLength(1));
  const start = vi.fn(async (command: SendMessageCommand) => ({ runId: 'fixture-run', sessionId: command.sessionId! }));
  const cancel = vi.fn(async () => undefined);
  const delivery = new DelegationResultDelivery(store, { prepare: (b, underLease) => runtime.prepare(b, underLease), start, cancel,
    saveReply: (b, e, text, completed) => runtime.saveReply(b, e, text, completed) });
  cleanups.push(() => delivery.close());
  const raw = async (): Promise<DelegationBatch> => JSON.parse(await readFile(file, 'utf8')).batches[0];
  return { file, binding, source, partner, leases, save, state, runtime, store, batch, start, cancel, delivery, raw, captureCommand, execute };
}

function event(command: SendMessageCommand, type: 'session.bound' | 'message.accepted' | 'text.delta' | 'run.completed' | 'run.cancelled', sequence = 1): PartnerEvent {
  const base = { protocolVersion: AGENT_PROTOCOL_VERSION, eventId: `fixture-event-${sequence}`, partnerId: command.partnerId,
    conversationId: command.conversationId, connectionSource: command.connectionSource, clientMessageId: command.clientMessageId,
    sessionId: command.sessionId!, runId: 'fixture-run', sequence, occurredAt: time };
  if (type === 'session.bound') return { ...base, type, isNew: false };
  if (type === 'text.delta') return { ...base, type, text: '合成主动汇报' };
  if (type === 'run.completed') return { ...base, type, finishReason: 'completed' };
  if (type === 'run.cancelled') return { ...base, type, reason: 'fixture-user-priority' };
  return { ...base, type: 'message.accepted' };
}

it('continues the exact original thread, separates acceptance from completion, persists one normal reply, and never redispatches the child', async () => {
  const f = await fixture();
  const emitted: PartnerEvent[] = [];
  const adapter: PartnerAdapter = { connectionSource: 'local_cli', capabilities: { streamingText: true, cancellation: true, sessionResume: true, toolEvents: true, fileEvents: true, authorizationBridge: true, extensions: [] },
    async *sendMessage(command) {
      yield event(command, 'session.bound');
      yield event(command, 'message.accepted', 2);
      expect((await f.raw()).delivery?.state).toBe('accepted');
      yield event(command, 'text.delta', 3);
      yield event(command, 'run.completed', 4);
    }, async *resumeSession() {}, cancel: vi.fn(), resolveAuthorization: vi.fn() };
  const coordinator = new RunCoordinator(new AdapterHost(), {
    deliver: vi.fn(), emit: e => emitted.push(e), observe: async () => undefined,
    prepare: c => f.delivery.validateBeforeStart(c), validateFirstEvent: async (e, c) => f.delivery.validateFirst(c, e),
    onBound: (e) => f.delivery.observe(e), onEvent: e => f.delivery.observe(e), onReleased: ({ command }) => f.delivery.released(command),
  }, f.leases);
  f.start.mockImplementation(c => coordinator.start(adapter, c, { waitForWriter: false }));
  await f.delivery.tick();
  await vi.waitFor(async () => expect((await f.raw()).delivery?.state).toBe('completed'));
  const command = f.start.mock.calls[0][0];
  expect(command).toMatchObject({ sessionId: 'fixture-native-session', conversationId: owner.conversationId, execution: { permissionMode: 'read_only' }, apiContext: { apiSessionHistoryEnabled: false } });
  expect(command.sourceMessage).toBeUndefined();
  expect(command.content.text).toContain('合成复核结论');
  expect(command.content.text).toContain('不是用户的新指令');
  expect(f.save).toHaveBeenCalledWith(owner.conversationId, owner.partnerId, expect.objectContaining({ messageId: 'assistant-fixture-run', delegationBatchId: f.batch.id, content: '合成主动汇报', fallbackEligible: true }));
  expect(emitted.map(e => e.type)).toEqual(['session.bound', 'message.accepted', 'text.delta', 'run.completed']);
  await f.delivery.tick();
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it('queues while the parent is busy and retries only before submission when the writer is taken in a race', async () => {
  const f = await fixture();
  const lease = f.leases.tryAcquire({ kind: 'conversation', partnerId: owner.partnerId, conversationId: owner.conversationId }, 'fixture-user')!;
  await f.delivery.tick(); expect(f.start).not.toHaveBeenCalled();
  lease.release();
  f.start.mockRejectedValueOnce(new Error('RUNTIME_WRITER_BUSY'));
  await f.delivery.tick(); expect((await f.raw()).delivery?.state).toBe('pending');
  await f.delivery.tick(); expect(f.start).toHaveBeenCalledTimes(2);
  expect((await f.raw()).delivery?.state).toBe('starting');
});

it('records hidden history provenance at native binding and scopes it to the original partner and thread after restart', async () => {
  const f = await fixture(); await f.delivery.tick();
  const command = f.start.mock.calls[0][0];
  await f.delivery.observe(event(command, 'session.bound'));
  expect((await f.raw()).delivery).toMatchObject({ state: 'starting', runId: 'fixture-run' });
  await f.delivery.close(); f.store.close();
  const recovered = new PartnerDelegation(f.file, vi.fn());
  cleanups.push(async () => { recovered.close(); });
  const hidden = await recovered.hiddenHistoryInputs(owner.conversationId, owner.partnerId, 'fixture-native-session');
  expect([...hidden.turnIds]).toEqual(['fixture-run']); expect([...hidden.userMessageIds]).toEqual([command.clientMessageId]);
  for (const [chat, partner, session] of [
    ['fixture-other', owner.partnerId, 'fixture-native-session'], [owner.conversationId, 'fixture-other', 'fixture-native-session'], [owner.conversationId, owner.partnerId, 'fixture-other'],
  ]) expect([...(await recovered.hiddenHistoryInputs(chat, partner, session)).turnIds]).toEqual([]);
});

it('retains internal message identities from older delivery attempts when the user retries a failed child task', async () => {
  const f = await fixture(); await f.delivery.close(); f.store.close();
  const record = await f.raw(); record.delivery!.state = 'completed'; record.delivery!.runId = 'fixture-old-report'; record.summaryState = 'done';
  record.tasks[0].status = 'failed'; delete record.tasks[0].result;
  await writeFile(f.file, JSON.stringify({ version: 1, batches: [record] }));
  const recovered = new PartnerDelegation(f.file, async () => '合成重试结果');
  cleanups.push(async () => { recovered.close(); });
  await recovered.control(owner.conversationId, record.tasks[0].id, 'retry');
  const hidden = await recovered.hiddenHistoryInputs(owner.conversationId, owner.partnerId, 'fixture-native-session');
  expect(hidden.turnIds.has('fixture-old-report')).toBe(true);
  expect(hidden.userMessageIds.has(record.delivery!.clientMessageId)).toBe(true);
});

it('lets a real user cancel a report without resending already accepted feedback', async () => {
  const f = await fixture(); await f.delivery.tick();
  const command = f.start.mock.calls[0][0];
  await f.delivery.observe(event(command, 'message.accepted'));
  await f.delivery.withUserPriority(owner.conversationId, async () => {
    await f.delivery.observe(event(command, 'run.cancelled', 2));
    await f.delivery.released(command);
    await f.delivery.tick();
  });
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect((await f.raw()).delivery?.state).toBe('interrupted');
  await f.delivery.tick(); expect(f.start).toHaveBeenCalledTimes(1);
});

it.each(['archive', 'disable', 'delete', 'thread', 'generation', 'workspace'] as const)('blocks delivery after source %s changes', async kind => {
  const f = await fixture();
  if (kind === 'archive') f.source.isArchived = true;
  if (kind === 'disable') f.source.isDisabled = true;
  if (kind === 'delete') f.state.deleted = true;
  if (kind === 'thread') f.binding.nativeThreadId = 'fixture-other-session';
  if (kind === 'generation') f.binding.generation++;
  if (kind === 'workspace') f.state.workspace = 'fixture-other-workspace';
  await f.delivery.tick();
  expect(f.start).not.toHaveBeenCalled(); expect((await f.raw()).delivery?.state).toBe('blocked');
});

it('revalidates under the writer lease and rejects an adapter that silently creates another thread', async () => {
  const f = await fixture(); await f.delivery.tick();
  const command = f.start.mock.calls[0][0];
  f.binding.generation++;
  await expect(f.delivery.validateBeforeStart(command)).rejects.toThrow('DELEGATION_SOURCE_CHANGED');
  expect(() => f.delivery.validateFirst(command, { ...event(command, 'session.bound'), type: 'session.bound', isNew: true })).toThrow('DELEGATION_ORIGINAL_THREAD_REQUIRED');
});

it('waits for the runtime catalog to restore on cold start instead of blocking the pending report', async () => {
  const f = await fixture(); f.partner.available = false;
  await f.delivery.tick();
  expect((await f.raw()).delivery?.state).toBe('pending'); expect(f.start).not.toHaveBeenCalled();
  f.partner.available = true;
  await f.delivery.tick(); expect(f.start).toHaveBeenCalledTimes(1);
});

it('does not acknowledge task completion alone, and leaves unknown native submission outcomes for review', async () => {
  const f = await fixture();
  expect((await f.raw()).delivery?.state).toBe('pending');
  f.start.mockRejectedValue(new Error('fixture-transport-disconnected'));
  await f.delivery.tick(); await f.delivery.tick();
  expect((await f.raw()).delivery?.state).toBe('uncertain'); expect(f.start).toHaveBeenCalledTimes(1);
});

it('does not race a foreground tool result into a duplicate automatic report', async () => {
  const f = await fixture();
  await f.store.wait(owner, f.batch.id, new AbortController().signal);
  await f.delivery.tick(); expect(f.start).not.toHaveBeenCalled();
  await f.store.releaseTurn(owner.turnId, false);
  await f.delivery.tick(); expect(f.start).toHaveBeenCalledTimes(1);
});

it.each(['pending', 'starting', 'accepted', 'completed'] as const)('recovers %s delivery without blindly repeating native input or child execution', async state => {
  const f = await fixture();
  await f.delivery.close(); f.store.close();
  const record = await f.raw(); record.delivery!.state = state;
  await writeFile(f.file, JSON.stringify({ version: 1, batches: [record] }));
  const execute = vi.fn(async () => 'must not redispatch');
  const recovered = new PartnerDelegation(f.file, execute);
  cleanups.push(async () => { recovered.close(); });
  const available = await recovered.pendingDeliveries();
  expect(available).toHaveLength(state === 'pending' ? 1 : 0);
  expect(execute).not.toHaveBeenCalled();
  const stored = JSON.parse(await readFile(f.file, 'utf8')).batches[0];
  expect(stored.delivery.state).toBe(state === 'starting' ? 'uncertain' : state === 'accepted' ? 'interrupted' : state);
});

it('recovers an unfinished external review by querying its existing request and delivers the result in the original conversation', async () => {
  const f = await fixture(); await f.delivery.close(); f.store.close();
  const record = await f.raw();
  const requestId = randomUUID();
  record.tasks[0].review = { threadId: 'fixture-external-thread', requestId, message: '合成复核请求' };
  record.tasks[0].status = 'running'; delete record.tasks[0].result;
  await writeFile(f.file, JSON.stringify({ version: 1, batches: [record] }));
  const execute = vi.fn<ConstructorParameters<typeof PartnerDelegation>[1]>(async (batch, task, signal, lookupOnly) => {
    expect(batch.conversationId).toBe(owner.conversationId); expect(signal.aborted).toBe(false);
    expect(lookupOnly).toBe(true); expect(task.review?.requestId).toBe(requestId); return '合成恢复查询结果';
  });
  const recovered = new PartnerDelegation(f.file, execute);
  cleanups.push(async () => { recovered.close(); });
  await recovered.recoverReviews();
  await vi.waitFor(async () => expect(await recovered.pendingDeliveries()).toHaveLength(1));
  const delivery = new DelegationResultDelivery(recovered, { prepare: (b, underLease) => f.runtime.prepare(b, underLease), start: f.start, cancel: f.cancel, saveReply: vi.fn() });
  cleanups.push(() => delivery.close());
  await delivery.tick();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(f.start.mock.calls[0][0].content.text).toContain('合成恢复查询结果');
});

it('does not replay legacy task-card summaries, and recovers a pending report interrupted during foreground consumption', async () => {
  const f = await fixture(); await f.delivery.close(); f.store.close();
  const record = await f.raw(); record.summaryState = 'foreground'; record.summaryTurnId = 'fixture-consumer';
  const legacy = { ...record, id: randomUUID(), delivery: undefined, summaryState: 'done', summary: '合成旧版汇总' };
  await writeFile(f.file, JSON.stringify({ version: 1, batches: [record, legacy] }));
  const recovered = new PartnerDelegation(f.file, vi.fn());
  cleanups.push(async () => { recovered.close(); });
  expect((await recovered.pendingDeliveries()).map(b => b.id)).toEqual([record.id]);
});

it('keeps completed results readable across turns and after two minutes, restricted to the same partner and conversation', async () => {
  const f = await fixture();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 180_000);
  try {
    const next = { ...owner, turnId: 'fixture-followup-turn' };
    const result = await f.store.wait(next, f.batch.id, new AbortController().signal);
    expect(result.tasks[0]).toMatchObject({ result: '合成复核结论', status: 'succeeded' });
    expect(result).not.toHaveProperty('delivery');
    await f.store.releaseTurn(next.turnId, true);
    expect(await f.store.pendingDeliveries()).toEqual([]);
    expect((await f.store.wait(next, f.batch.id, new AbortController().signal)).tasks[0]).toHaveProperty('result');
    await expect(f.store.wait({ ...next, partnerId: 'fixture-other' }, f.batch.id, new AbortController().signal)).rejects.toThrow('DELEGATION_BATCH_NOT_FOUND');
    await expect(f.store.wait({ ...next, conversationId: 'fixture-other' }, f.batch.id, new AbortController().signal)).rejects.toThrow('DELEGATION_BATCH_NOT_FOUND');
  } finally { clock.mockRestore(); }
});

it('does not inherit mutating tools advertised by an existing native thread', async () => {
  const workspace = vi.fn(async () => '[]');
  const tools = delegationReportTools({ status: async () => '{}', workspace, update: vi.fn(), delegation: vi.fn(),
    automation: vi.fn(), projectNotebook: vi.fn(), memory: { access: 'write', search: vi.fn(), readSource: vi.fn(), hold: vi.fn() } });
  expect(tools.delegation).toBeUndefined(); expect(tools.automation).toBeUndefined(); expect(tools.memory).toBeUndefined(); expect(tools.projectNotebook).toBeUndefined();
  await expect(tools.workspace('add', 'fixture')).rejects.toThrow('DELEGATION_REPORT_READ_ONLY');
  expect(workspace).not.toHaveBeenCalled();
  expect(await tools.workspace('list')).toBe('[]');
});
