import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SINGLE_CHAT_PAGE_SIZE, type SingleChatHistoryPage, type SingleChatPageBounds, type SingleChatPageRequest } from '../../shared/singleChatHistory';
import { isAsteriumUser } from '../../shared/identity';
import type { Conversation, Message } from '../types/domain';
import { restoreSingleChatPageMessages } from './persistence';

type TimelineWindow = SingleChatPageBounds & { id: string; messages: Message[]; detached: boolean; recentStartId?: string };
const MAX_WINDOW_MESSAGES = SINGLE_CHAT_PAGE_SIZE * 3;

export function useSingleChatTimeline(conversation: Conversation | undefined, recentPage: SingleChatPageBounds | undefined) {
  const id = conversation?.id;
  const partnerId = conversation?.partnerId;
  const [timeline, setWindow] = useState<TimelineWindow>();
  const [busyId, setBusyId] = useState<string>();
  const [failedId, setFailedId] = useState<string>();
  const activeId = useRef(id);
  const requestNumber = useRef(0);
  const pending = useRef(false);
  useLayoutEffect(() => {
    activeId.current = id;
    requestNumber.current++;
    pending.current = false;
    setWindow(undefined);
    setBusyId(undefined);
    setFailedId(undefined);
  }, [id]);

  const current = timeline?.id === id ? timeline : undefined;
  const tail = useMemo(() => {
    if (!conversation || !recentPage) return conversation?.messages;
    const first = current?.recentStartId ? conversation.messages.findIndex(message => message.id === current.recentStartId) : -1;
    return conversation.messages.slice(first >= 0 ? first : -SINGLE_CHAT_PAGE_SIZE);
  }, [conversation?.messages, current?.recentStartId, recentPage]);
  const displayed = useMemo(() => {
    if (!conversation || !tail) return conversation;
    if (!current) return recentPage ? { ...conversation, messages: tail } : conversation;
    if (current.detached) return { ...conversation, messages: current.messages };
    return { ...conversation, messages: combine(current.messages, tail) };
  }, [conversation, current, recentPage, tail]);

  const request = useCallback(async (anchor: Omit<SingleChatPageRequest, 'conversationId'>, apply: (page: SingleChatHistoryPage) => boolean, priority = false) => {
    const read = window.asteriumConversations?.readHistoryPage;
    if (!id || !read || (pending.current && !priority)) return false;
    const token = ++requestNumber.current;
    pending.current = true;
    setBusyId(id);
    setFailedId(undefined);
    try {
      const page = await read({ conversationId: id, ...anchor });
      if (activeId.current !== id || requestNumber.current !== token) return false;
      if (!page || !apply(page)) return false;
      return true;
    } catch {
      if (activeId.current === id && requestNumber.current === token) setFailedId(id);
      return false;
    } finally {
      if (activeId.current === id && requestNumber.current === token) {
        pending.current = false;
        setBusyId(undefined);
      }
    }
  }, [id]);

  const localHidden = (conversation?.messages.length ?? 0) - (tail?.length ?? 0);
  const hasOlder = Boolean(current?.hasOlder ?? (recentPage?.hasOlder || localHidden > 0));
  const hasNewer = Boolean(current?.detached && current.hasNewer);
  const first = current?.messages[0]?.id ?? tail?.[0]?.id;
  const last = current?.messages.at(-1)?.id;
  const detached = Boolean(current?.detached);
  const pageMessages = useCallback((page: SingleChatHistoryPage) => restoreSingleChatPageMessages(partnerId ?? '', page.messages, false), [partnerId]);

  const loadOlder = useCallback((beforeApply?: () => void) => {
    if (!hasOlder || !first || !id) return Promise.resolve(false);
    return request({ before: first }, page => {
      beforeApply?.();
      const messages = pageMessages(page);
      setWindow(previous => {
        const older = combine(messages, previous?.id === id ? previous.messages : []);
        const visible = detached ? older : combine(older, tail ?? []);
        const bounded = visible.length > MAX_WINDOW_MESSAGES;
        return {
          id, detached: detached || bounded, hasOlder: page.hasOlder, hasNewer: hasNewer || bounded, turnOffset: page.turnOffset,
          recentStartId: detached || bounded ? undefined : tail?.[0]?.id,
          messages: bounded ? visible.slice(0, MAX_WINDOW_MESSAGES) : older,
        };
      });
      return true;
    });
  }, [detached, first, hasNewer, hasOlder, id, pageMessages, request, tail]);

  const loadNewer = useCallback((beforeApply?: () => void) => {
    if (!hasNewer || !last || !id) return Promise.resolve(false);
    return request({ after: last }, page => {
      beforeApply?.();
      const messages = pageMessages(page);
      setWindow(previous => {
        const visible = combine(previous?.id === id ? previous.messages : [], messages);
        const skipped = Math.max(0, visible.length - MAX_WINDOW_MESSAGES);
        const priorOffset = previous?.id === id ? previous.turnOffset : undefined;
        return {
          id, detached: true, hasOlder: hasOlder || skipped > 0, hasNewer: page.hasNewer,
          turnOffset: (priorOffset ?? 0) + visible.slice(0, skipped).filter(message => isAsteriumUser(message.authorId)).length,
          messages: visible.slice(skipped),
        };
      });
      return true;
    });
  }, [hasNewer, hasOlder, id, last, pageMessages, request]);

  const showAround = useCallback((messageId: string, beforeApply?: () => void) => {
    if (!id) return Promise.resolve(false);
    return request({ around: messageId }, page => {
      if (!page.messages.some(message => message.id === messageId)) return false;
      beforeApply?.();
      setWindow({ id, messages: pageMessages(page), detached: true, hasOlder: page.hasOlder, hasNewer: page.hasNewer, turnOffset: page.turnOffset });
      return true;
    }, true);
  }, [id, pageMessages, request]);

  const returnToLatest = useCallback(() => {
    requestNumber.current++;
    pending.current = false;
    setBusyId(undefined);
    setFailedId(undefined);
    setWindow(undefined);
  }, []);

  return {
    conversation: displayed, hasOlder, hasNewer, detached,
    turnOffset: current?.turnOffset ?? (recentPage?.turnOffset ?? 0)
      + (conversation?.messages.slice(0, localHidden).filter(message => isAsteriumUser(message.authorId)).length ?? 0), loading: Boolean(id && busyId === id),
    failed: Boolean(id && failedId === id), loadOlder, loadNewer, showAround, returnToLatest,
  };
}

function combine(first: Message[], second: Message[]) {
  const messages = new Map(first.map(message => [message.id, message]));
  for (const message of second) messages.set(message.id, message);
  return [...messages.values()];
}
