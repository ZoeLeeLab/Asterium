import { useCallback, useEffect, useId, useRef, useSyncExternalStore } from 'react';
import type { PendingMessageAttachment } from '../../shared/agentProtocol';
import type { StudioMention } from '../../shared/studioRuntime';

interface AttachmentDraft {
  text: { value: string; mentions: StudioMention[] };
  attachments: PendingMessageAttachment[];
  operation?: { kind: 'stage' | 'send' };
}

const emptyText = { value: '', mentions: [] };
const emptyDraft: AttachmentDraft = { text: emptyText, attachments: [] };
const drafts = new Map<string, AttachmentDraft>();
const listeners = new Map<string, Set<() => void>>();

export function discardPendingAttachments(attachments: PendingMessageAttachment[]) {
  if (attachments.length) void window.asteriumAttachments?.discard(attachments.map(item => item.selectionId)).catch(() => undefined);
}

export function clearAttachmentDraft(draftKey: string) {
  const draft = drafts.get(draftKey);
  if (!draft) return;
  drafts.delete(draftKey);
  discardPendingAttachments(draft.attachments);
  listeners.get(draftKey)?.forEach(listener => listener());
}

export function useAttachmentDraft(draftKey?: string) {
  const instanceId = useId();
  const key = draftKey ?? `temporary:${instanceId}`;
  const mounted = useRef(false);
  const get = useCallback(() => drafts.get(key) ?? emptyDraft, [key]);
  const set = (draft: AttachmentDraft) => {
    if (draft.operation || draft.text.value || draft.attachments.length) drafts.set(key, draft);
    else drafts.delete(key);
    listeners.get(key)?.forEach(listener => listener());
  };
  const subscribe = useCallback((listener: () => void) => {
    const subscriptions = listeners.get(key) ?? new Set();
    subscriptions.add(listener);
    listeners.set(key, subscriptions);
    return () => {
      subscriptions.delete(listener);
      if (!subscriptions.size) listeners.delete(key);
    };
  }, [key]);
  const draft = useSyncExternalStore(subscribe, get);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!draftKey) clearAttachmentDraft(key);
    };
  }, [draftKey, key]);

  async function stage(task: (attachments: PendingMessageAttachment[]) => Promise<PendingMessageAttachment[]>) {
    const before = get();
    if (before.operation) return;
    const operation = { kind: 'stage' } as const;
    set({ ...before, operation });
    try {
      const added = await task(before.attachments);
      const current = get();
      if (current.operation === operation) set({ ...current, attachments: [...current.attachments, ...added], operation: undefined });
      else discardPendingAttachments(added);
    } finally {
      const current = get();
      if (current.operation === operation) set({ ...current, operation: undefined });
    }
  }

  async function send(task: () => Promise<void | boolean>) {
    const before = get();
    if (before.operation) return false;
    const operation = { kind: 'send' } as const;
    set({ ...before, operation });
    let sent = false;
    try {
      sent = (await task()) !== false;
      return sent;
    } finally {
      const current = get();
      if (current.operation === operation) set({
        text: sent && current.text === before.text ? emptyText : current.text,
        attachments: sent ? [] : current.attachments,
      });
    }
  }

  function remove(selectionId: string) {
    const current = get();
    if (current.operation) return;
    const removed = current.attachments.filter(item => item.selectionId === selectionId);
    set({ ...current, attachments: current.attachments.filter(item => item.selectionId !== selectionId) });
    discardPendingAttachments(removed);
  }

  return { ...draft, stage, send, remove, setText: (value: string, mentions: StudioMention[] = []) => set({ ...get(), text: { value, mentions } }), isMounted: () => mounted.current };
}
