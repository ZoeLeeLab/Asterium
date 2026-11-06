import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AutomationRuntime } from '../../src/main/automation/AutomationRuntime';
import { AutomationStore } from '../../src/main/automation/AutomationStore';
import { automationInputSchema } from '../../src/shared/automations';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';
import { SingleChatMessageStore } from '../../src/main/conversation/SingleChatMessageStore';

const dirs: string[] = []; afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-auto-runtime-')); dirs.push(dir);
  const store = new AutomationStore(path.join(dir, 'jobs.json'));
  const d = await store.create(automationInputSchema.parse({ name: '测试任务', instructions: '检查目录。', target: { partnerId: 'p', conversationId: 'c', nativeThreadId: 'native', sourceMode: 'api_partner', bindingGeneration: 1 }, schedule: { type: 'daily', time: '10:00' }, timezone: 'Asia/Shanghai' }), 'first');
  const queued = await store.queueManual(d.id, 'click');
  const run = (await store.transition(queued.id, ['queued'], { state: 'running' }))!;
  const command: SendMessageCommand = { protocolVersion: AGENT_PROTOCOL_VERSION, commandId: 'command', clientMessageId: `automation:${run.id}`, type: 'message.send', partnerId: 'p', conversationId: 'c', connectionSource: 'api_partner', sessionId: 'native', content: { type: 'text', text: '任务' } };
  let sequence = 0;
  const event = (data: Record<string, unknown>) => ({ protocolVersion: AGENT_PROTOCOL_VERSION, eventId: `event-${++sequence}`, partnerId: 'p', conversationId: 'c', clientMessageId: command.clientMessageId, connectionSource: 'api_partner', sessionId: 'native', runId: 'native-run', sequence, occurredAt: new Date().toISOString(), ...data }) as PartnerEvent;
  return { store, run, command, event, dir };
}
it('resumes the exact thread, preserves text chunks and commits the result without a fake user message', async () => {
  const f = await fixture(), save = vi.fn(async () => undefined);
  const runtime = new AutomationRuntime(f.store, { check: async () => ({ available: true }), cancel: async () => undefined, saveResult: save,
    launch: async () => {
      runtime.attach(f.command);
      const first = f.event({ type: 'session.bound', isNew: false }); runtime.validateFirst(f.command, first); await runtime.observe(first);
      await runtime.bound(f.command, { runId: 'native-run', sessionId: 'native' });
      runtime.report(f.command, false); expect(runtime.eventRunFor(f.command)?.changed).toBe(false);
      for (const text of ['hello ', 'world']) { const e = f.event({ type: 'text.delta', text }); await runtime.observe(e); runtime.replaceEvent(e); }
      await runtime.observe(f.event({ type: 'run.completed', finishReason: 'completed' }));
    } });
  const result = await runtime.execute(f.run, new AbortController().signal);
  expect(result).toMatchObject({ state: 'succeeded', summary: 'hello world', changed: false }); expect(save).toHaveBeenCalledWith(f.run, 'hello world', `automation-result:${f.run.id}`, true);
  const events = (await f.store.snapshot()).runs[0].events;
  expect(events.filter(e => e.type === 'text.delta')).toHaveLength(1); expect(events.find(e => e.type === 'text.delta')).toMatchObject({ text: 'hello world' });
  expect(runtime.eventRunFor(f.command)?.id).toBe(f.run.id);
});
it('refuses a new or mismatched native thread and leaves ambiguous launch outcomes for review', async () => {
  const f = await fixture();
  const runtime = new AutomationRuntime(f.store, { check: async () => ({ available: true }), cancel: async () => undefined, saveResult: async () => undefined,
    launch: async () => { runtime.attach(f.command); runtime.validateFirst(f.command, f.event({ type: 'session.bound', isNew: true, sessionId: 'new-thread' })); } });
  expect(await runtime.execute(f.run, new AbortController().signal)).toMatchObject({ state: 'uncertain' });
});
it('persists an approval wait and cancels through the existing runtime without approving it', async () => {
  const f = await fixture(), controller = new AbortController(), cancel = vi.fn(async () => undefined);
  let launched!: () => void; const ready = new Promise<void>(r => { launched = r; });
  const runtime = new AutomationRuntime(f.store, { check: async () => ({ available: true }), cancel, saveResult: async () => undefined,
    launch: async () => { runtime.attach(f.command); await runtime.bound(f.command, { runId: 'native-run', sessionId: 'native' }); await runtime.observe(f.event({ type: 'authorization.requested', authorizationId: 'auth', summary: '确认移动', targets: [], action: 'write_file', risk: 'medium' })); launched(); } });
  const done = runtime.execute(f.run, controller.signal); await ready;
  expect((await f.store.snapshot()).runs[0].state).toBe('waiting_approval'); controller.abort();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  await runtime.observe(f.event({ type: 'run.cancelled', reason: 'cancelled' })); expect(await done).toMatchObject({ state: 'cancelled' });
});
it('keeps Main-owned background results across a stale renderer index sync', async () => {
  const f = await fixture(); const messages = new SingleChatMessageStore(path.join(f.dir, 'messages.json'));
  await messages.upsertMessage('c', 'p', { messageId: 'result', automationRunId: f.run.id, authorType: 'partner', authorId: 'p', content: '后台结果', createdAt: '10:00' });
  await messages.sync([{ conversationId: 'c', partnerId: 'p', messages: [] }]); expect((await messages.getConversation('c'))?.messages[0].content).toBe('后台结果');
  await messages.sync([{ conversationId: 'c', partnerId: 'p', messages: [{ messageId: 'result', authorType: 'user', authorId: 'user', content: 'stale', createdAt: '09:00' }] }]);
  expect((await messages.getConversation('c'))?.messages[0]).toMatchObject({ authorType: 'partner', content: '后台结果', automationRunId: f.run.id });
});
