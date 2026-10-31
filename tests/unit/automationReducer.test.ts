import { expect, it } from 'vitest';
import { prototypeReducer } from '../../src/renderer/app/PrototypeProvider';
import { createTestState } from '../fixtures/applicationState';
import { automationInputSchema, type AutomationRun } from '../../src/shared/automations';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent } from '../../src/shared/agentProtocol';

function fixture(group = false) {
  const state = createTestState(), chat = state.conversations[0], room = state.groupChats[0];
  chat.sessionId = 'original'; chat.messages = []; chat.unreadCompletedAt = undefined; room.unreadCompletedAt = undefined;
  const input = automationInputSchema.parse({ name: '巡检', instructions: '检查变化', target: { partnerId: chat.partnerId, conversationId: chat.id, nativeThreadId: 'original', sourceMode: 'api_partner', bindingGeneration: 1, ...(group ? { roomId: room.id, projectId: room.projectId } : {}) }, schedule: { type: 'daily', time: '10:00' }, timezone: 'Asia/Shanghai', notifications: 'changes_or_failure' });
  const now = '2026-10-25T02:00:00Z';
  const run: AutomationRun = { id: 'run', automationId: 'a', occurrenceId: 'o', attempt: 1, trigger: 'scheduled', state: 'succeeded', scheduledAt: now, createdAt: now, updatedAt: now, finishedAt: now, summary: '没有变化', messageId: 'automation-result:run', changed: false, events: [], definition: { ...input, id: 'a', revision: 1, scheduleRevision: 1, createdAt: now, updatedAt: now, effectiveFrom: now, requestId: 'r', requestFingerprint: 'f' } };
  const event: PartnerEvent = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'run.completed', eventId: 'e', sequence: 3, partnerId: chat.partnerId, conversationId: chat.id, sessionId: 'original', clientMessageId: 'automation:run', connectionSource: 'api_partner', runId: 'native-run', occurredAt: now, finishReason: 'completed', ...(group ? { route: { scope: 'group', roomId: room.id, roundId: 'round', bindingGeneration: 1, inputThroughSeq: 1 } } : {}) };
  return { state, run, event, chat, room };
}
it('retains verified quiet results and hydrates them once without fabricating a user message', () => {
  const f = fixture(); const first = prototypeReducer(f.state, { type: 'automationHydrate', runs: [f.run] });
  const chat = first.conversations[0]; expect(chat.messages).toHaveLength(1); expect(chat.messages[0].authorId).toBe(f.chat.partnerId); expect(chat.unreadCompletedAt).toBeUndefined();
  expect(prototypeReducer(first, { type: 'automationHydrate', runs: [f.run] }).conversations[0].messages).toHaveLength(1);
});
it('respects group quiet results and signals changes or failure while rejecting a mismatched room', () => {
  const f = fixture(true);
  expect(prototypeReducer(f.state, { type: 'automationEvent', run: f.run, event: f.event }).groupChats[0].unreadCompletedAt).toBeUndefined();
  expect(prototypeReducer(f.state, { type: 'automationEvent', run: { ...f.run, changed: true }, event: f.event }).groupChats[0].unreadCompletedAt).toBe(f.event.occurredAt);
  const wrong = { ...f.event, route: { scope: 'group' as const, roomId: 'other', roundId: 'round', bindingGeneration: 1, inputThroughSeq: 1 } };
  expect(prototypeReducer(f.state, { type: 'automationEvent', run: { ...f.run, changed: true }, event: wrong })).toBe(f.state);
});
