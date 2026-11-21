import type { Conversation, PrototypeAction, PrototypeState } from '../types/domain';

export type NativeLifecycleUpdate = Extract<PrototypeAction, { type: 'syncNativeThreadLifecycle' }>;
export type NativeLifecycleChecks = ReadonlyMap<string, { sessionId?: string; checkedAt: string }>;

export function isCurrentNativeLifecycleUpdate(state: PrototypeState, checks: NativeLifecycleChecks, update: NativeLifecycleUpdate) {
  const conversation = state.conversations.find(item => item.id === update.conversationId);
  if (!conversation) return false;
  const check = checks.get(conversation.id);
  return (!conversation.nativeThreadStateCheckedAt || conversation.nativeThreadStateCheckedAt <= update.checkedAt)
    && (!check || check.sessionId !== conversation.sessionId || check.checkedAt <= update.checkedAt);
}

// Check times are ordering evidence, even when nothing visible changed. Keep those
// watermarks in the history frame instead of rewriting conversation metadata.
export function reduceNativeLifecycleUpdates(
  state: PrototypeState,
  checks: NativeLifecycleChecks,
  updates: NativeLifecycleUpdate[],
  reducer: (state: PrototypeState, action: PrototypeAction) => PrototypeState,
) {
  let next = state;
  let nextChecks = checks;
  for (const update of updates) {
    if (!isCurrentNativeLifecycleUpdate(next, nextChecks, update)) continue;
    const before = next.conversations.find(item => item.id === update.conversationId)!;
    const check = nextChecks.get(before.id);
    if (check?.sessionId !== before.sessionId || check?.checkedAt !== update.checkedAt) {
      nextChecks = new Map(nextChecks).set(before.id, { sessionId: before.sessionId, checkedAt: update.checkedAt });
    }
    const reduced = reducer(next, update);
    const after = reduced.conversations.find(item => item.id === before.id);
    if (reduced.activeConversationId === next.activeConversationId && reduced.activePartnerId === next.activePartnerId
      && after && sameLifecycleMetadata(before, after)) continue;
    next = reduced;
  }
  return { state: next, checks: nextChecks };
}

function sameLifecycleMetadata(before: Conversation, after: Conversation) {
  return before.nativeThreadState === after.nativeThreadState
    && before.nativeThreadNotice?.state === after.nativeThreadNotice?.state
    && before.nativeThreadNotice?.message === after.nativeThreadNotice?.message
    && before.isArchived === after.isArchived && before.isPinned === after.isPinned
    && before.archivedAt === after.archivedAt;
}
