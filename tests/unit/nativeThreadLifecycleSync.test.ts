import { expect, it } from 'vitest';
import { createTestState } from '../fixtures/applicationState';
import { prototypeReducer } from '../../src/renderer/app/PrototypeProvider';
import { collectHistoryChanges } from '../../src/renderer/app/useSingleChatHistory';
import { isCurrentNativeLifecycleUpdate, reduceNativeLifecycleUpdates, type NativeLifecycleChecks, type NativeLifecycleUpdate } from '../../src/renderer/app/nativeThreadLifecycleSync';

const timestamp = (minute: number) => `2026-11-21T00:${String(minute).padStart(2, '0')}:00.000Z`;
function seed() {
  const state = createTestState();
  state.conversations = state.conversations.slice(0, 2).map(conversation => ({
    ...conversation, sessionId: 'session:' + conversation.id, nativeThreadState: 'active', nativeThreadStateCheckedAt: timestamp(0),
  }));
  state.activeConversationId = state.conversations[0].id;
  return state;
}
function update(conversationId: string, minute: number, state: NativeLifecycleUpdate['state'] = 'active', message?: string): NativeLifecycleUpdate {
  return { type: 'syncNativeThreadLifecycle', conversationId, checkedAt: timestamp(minute), state, message };
}

it('keeps unchanged conversation, messages and state references without history writes while advancing check watermarks', () => {
  const state = seed();
  const updates = state.conversations.map(conversation => update(conversation.id, 2));
  const result = reduceNativeLifecycleUpdates(state, new Map(), updates, prototypeReducer);
  expect(result.state).toBe(state);
  expect(result.state.conversations).toBe(state.conversations);
  expect(result.checks.get(state.conversations[0].id)?.checkedAt).toBe(timestamp(2));
  expect(collectHistoryChanges(state, result.state, { type: 'syncNativeThreadLifecycles', updates })).toEqual([]);
  expect(state.conversations[0].nativeThreadStateCheckedAt).toBe(timestamp(0));
});

it('rejects stale archive and deletion results even after a newer unchanged check', () => {
  const state = seed(), id = state.conversations[0].id;
  const current = reduceNativeLifecycleUpdates(state, new Map(), [update(id, 4)], prototypeReducer);
  for (const kind of ['archived', 'deleted', 'unavailable'] as const) {
    const stale = update(id, 3, kind);
    expect(isCurrentNativeLifecycleUpdate(current.state, current.checks, stale)).toBe(false);
    expect(reduceNativeLifecycleUpdates(current.state, current.checks, [stale], prototypeReducer).state).toBe(state);
  }
  // A reducer replay must be deterministic and must not mutate the input map.
  const checks: NativeLifecycleChecks = new Map();
  const first = reduceNativeLifecycleUpdates(state, checks, [update(id, 4)], prototypeReducer);
  const replay = reduceNativeLifecycleUpdates(state, checks, [update(id, 4)], prototypeReducer);
  expect(first).toEqual(replay);
  expect(checks.size).toBe(0);
});

it('applies real batch changes once and keeps archive, restore, deletion and local archive semantics', () => {
  const state = seed(), [first, second] = state.conversations;
  const updates = state.conversations.map(conversation => update(conversation.id, 2, 'archived'));
  const archived = reduceNativeLifecycleUpdates(state, new Map(), updates, prototypeReducer);
  expect(archived.state.conversations.every(conversation => conversation.isArchived)).toBe(true);
  expect(archived.state.activeConversationId).toBe('');
  expect(collectHistoryChanges(state, archived.state, { type: 'syncNativeThreadLifecycles', updates })).toHaveLength(2);
  const restored = reduceNativeLifecycleUpdates(archived.state, archived.checks, [update(first.id, 3)], prototypeReducer);
  expect(restored.state.conversations[0]).toMatchObject({ nativeThreadState: 'active', isArchived: undefined, archivedAt: undefined });
  expect(restored.state.conversations[1]).toBe(archived.state.conversations[1]);
  const deleted = reduceNativeLifecycleUpdates(restored.state, restored.checks, [update(second.id, 4, 'deleted')], prototypeReducer);
  expect(deleted.state.conversations.map(conversation => conversation.id)).toEqual([first.id]);
  const localArchive = prototypeReducer(state, { type: 'archiveConversation', conversationId: first.id, archivedAt: timestamp(1) });
  expect(reduceNativeLifecycleUpdates(localArchive, new Map(), [update(first.id, 4)], prototypeReducer).state).toBe(localArchive);
});

it('preserves same notices, applies changed notices, and respects newer session.bound evidence', () => {
  const state = seed(), id = state.conversations[0].id;
  const failed = reduceNativeLifecycleUpdates(state, new Map(), [update(id, 2, 'unavailable', '合成错误')], prototypeReducer);
  const same = reduceNativeLifecycleUpdates(failed.state, failed.checks, [update(id, 3, 'unavailable', '合成错误')], prototypeReducer);
  expect(same.state).toBe(failed.state);
  const changed = reduceNativeLifecycleUpdates(same.state, same.checks, [update(id, 4, 'unavailable', '另一合成错误')], prototypeReducer);
  expect(changed.state.conversations[0].nativeThreadNotice?.message).toBe('另一合成错误');
  const bound = { ...state, conversations: state.conversations.map(conversation => ({ ...conversation, nativeThreadStateCheckedAt: timestamp(8) })) };
  expect(reduceNativeLifecycleUpdates(bound, changed.checks, [update(id, 7, 'archived')], prototypeReducer).state).toBe(bound);
  const rebound = { ...state, conversations: state.conversations.map(conversation => ({ ...conversation, sessionId: 'new-session' })) };
  expect(reduceNativeLifecycleUpdates(rebound, changed.checks, [update(id, 3, 'archived')], prototypeReducer).state.conversations[0].isArchived).toBe(true);
});
