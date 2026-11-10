import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { codexHistoryMessageId, visibleNativeUserText, type CodexHistoryHit, type CodexHistoryPage, type CodexHistoryRequest, type CodexHistorySearchPosition, type CodexHistoryTurn } from '../../shared/codexHistory';
import { ASTERIUM_USER_ID, isAsteriumUser } from '../../shared/identity';
import type { Conversation, Message, Partner, TurnTimelineItem } from '../types/domain';
import { visibleAssistantText } from './messageQuote';

interface HistoryState {
  key: string;
  turns: CodexHistoryTurn[];
  nextCursor?: string;
}

export function useNativeCodexHistory(conversation: Conversation | undefined, partner: Partner | undefined, enabled: boolean, browsingLocal = false) {
  const conversationId = conversation?.id;
  const threadId = conversation?.sessionId;
  const runtime = partner?.sourceMode === 'local_cli' && partner.adapterType === 'codex_cli'
    && partner.connectionKind === 'local_codex' && !partner.isPrototype && !partner.isRemoved ? partner : undefined;
  const partnerId = runtime?.id;
  const partnerRootGrantId = conversation?.partnerRootGrantId ?? runtime?.partnerRootGrantId;
  const runtimeId = runtime?.codexRuntimeId;
  const runtimeEnvironment = runtime?.codexRuntime?.environment;
  const request = useMemo((): CodexHistoryRequest | undefined => (
    enabled && conversationId && threadId && partnerId && conversation?.nativeThreadState !== 'deleted' ? {
      conversationId, threadId, partnerId, partnerRootGrantId,
      codexRuntimeId: runtimeId, codexRuntimeEnvironment: runtimeEnvironment,
    } : undefined
  ), [enabled, conversationId, threadId, partnerId, partnerRootGrantId, runtimeId, runtimeEnvironment, conversation?.nativeThreadState]);
  const key = request ? JSON.stringify(request) : '';
  const [history, setHistory] = useState<HistoryState>();
  const [located, setLocated] = useState<HistoryState>();
  const [locationKey, setLocationKey] = useState(key);
  if (locationKey !== key) {
    setLocationKey(key);
    setLocated(undefined);
  }
  const liveKey = useRef(key);
  const revealVersion = useRef(0);
  const searchVersion = useRef(0);
  const searchHits = useRef(new Map<string, CodexHistoryHit>());
  useLayoutEffect(() => {
    liveKey.current = key;
    searchVersion.current++;
    revealVersion.current++;
    searchHits.current.clear();
  }, [key]);
  const returnToLatest = useCallback(() => {
    revealVersion.current++;
    setLocated(undefined);
  }, []);

  const searchBridge = window.asteriumAgents?.searchCodexHistory;
  const search = useCallback(async (query: string, cursor?: string) => {
    if (!request || !searchBridge) return { messageIds: [], hasMore: false };
    const version = ++searchVersion.current;
    if (!cursor) {
      revealVersion.current++;
      searchHits.current.clear();
    }
    const after = cursor ? JSON.parse(cursor) as CodexHistorySearchPosition : undefined;
    const page = await searchBridge({ ...request, query, after });
    if (liveKey.current !== key || searchVersion.current !== version) return { messageIds: [], hasMore: false };
    for (const hit of page.hits) searchHits.current.set(hit.messageId, hit);
    return { messageIds: page.hits.map(hit => hit.messageId), hasMore: Boolean(page.next), nextCursor: page.next && JSON.stringify(page.next) };
  }, [key, request, searchBridge]);

  const reveal = useCallback(async (messageId: string, beforeApply?: () => void) => {
    const hit = searchHits.current.get(messageId);
    const read = window.asteriumAgents?.readCodexHistory;
    if (!request || !hit || !read) return false;
    const version = ++revealVersion.current;
    try {
      const page = await read({ ...request, cursor: hit.pageCursor, aroundTurnId: hit.turnId });
      if (liveKey.current !== key || revealVersion.current !== version || !page.turns.some(turn => turn.id === hit.turnId)) return false;
      beforeApply?.();
      setLocated({ key, ...page });
      return true;
    } catch {
      return false;
    }
  }, [key, request]);
  const [errorKey, setErrorKey] = useState('');
  const [olderKey, setOlderKey] = useState('');
  const olderPending = useRef(new Set<string>());
  const active = Boolean(conversation?.activeRun || conversation?.awaitingFirstResponse);

  useEffect(() => {
    const read = window.asteriumAgents?.readCodexHistory;
    if (!request || !read || active || browsingLocal) return;
    let cancelled = false;
    let pending = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (retryBinding = true) => {
      if (pending || cancelled) return;
      pending = true;
      try {
        const page = await read(request);
        if (cancelled) return;
        setErrorKey('');
        setHistory(previous => mergePage(previous, key, page, false));
      } catch (error) {
        if (cancelled) return;
        if (retryBinding && String(error).includes('CODEX_HISTORY_BINDING_UNAVAILABLE')) {
          retry = setTimeout(() => { void refresh(false); }, 300);
        } else {
          setErrorKey(key);
        }
      } finally {
        pending = false;
      }
    };
    const onFocus = () => { void refresh(); };
    void refresh();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; clearTimeout(retry); window.removeEventListener('focus', onFocus); };
  }, [active, browsingLocal, key, request]);

  const detached = located?.key === key;
  const current = detached ? located : !browsingLocal && history?.key === key ? history : undefined;
  const loadOlder = useCallback(async () => {
    const read = window.asteriumAgents?.readCodexHistory;
    const cursor = current?.nextCursor;
    if (!read || !request || !cursor || olderPending.current.has(key)) return;
    const version = revealVersion.current;
    olderPending.current.add(key);
    setOlderKey(key);
    try {
      const page = await read({ ...request, cursor });
      if (liveKey.current !== key || revealVersion.current !== version) return;
      if (detached) setLocated(previous => previous?.key === key && previous.nextCursor === cursor ? { key, ...page } : previous);
      else setHistory(previous => previous?.key === key && previous.nextCursor === cursor ? mergePage(previous, key, page, true) : previous);
      setErrorKey(previous => previous === key ? '' : previous);
    } catch {
      setErrorKey(key);
    } finally {
      olderPending.current.delete(key);
      setOlderKey(previous => previous === key ? '' : previous);
    }
  }, [current?.nextCursor, detached, key, request]);

  const visible = useMemo(() => conversation && current?.turns.length
    ? { ...conversation, messages: mergeNativeCodexMessages(detached ? { ...conversation, activeRun: undefined, messages: [] } : conversation, current.turns) }
    : conversation, [conversation, current, detached]);

  return {
    conversation: visible, loadOlder, hasOlder: Boolean(current?.nextCursor), loadingOlder: Boolean(key && olderKey === key),
    unavailable: Boolean(key && errorKey === key), detached, returnToLatest, reveal, search: request && searchBridge ? search : undefined,
  };
}

function mergePage(previous: HistoryState | undefined, key: string, page: CodexHistoryPage, older: boolean): HistoryState {
  if (previous?.key !== key) return { key, ...page };
  const turns = new Map<string, CodexHistoryTurn>();
  const ordered = older ? [...previous.turns, ...page.turns] : [...page.turns, ...previous.turns];
  for (const turn of ordered) if (!turns.has(turn.id)) turns.set(turn.id, turn);
  const previousIds = new Set(previous.turns.map(turn => turn.id));
  const overlaps = page.turns.some(turn => previousIds.has(turn.id));
  return {
    key,
    turns: [...turns.values()],
    nextCursor: older ? page.nextCursor : overlaps ? previous.nextCursor : page.nextCursor,
  };
}

export function mergeNativeCodexMessages(conversation: Conversation, newestFirst: CodexHistoryTurn[]): Message[] {
  const local = conversation.messages;
  const localAssistantByRun = new Map<string, number>();
  const earlierAssistantByRun = new Map<string, string>();
  for (const [index, message] of local.entries()) {
    if (!message.runId || isAsteriumUser(message.authorId)) continue;
    localAssistantByRun.set(message.runId, index);
    const guidance = message.runId.indexOf(':before-guidance:');
    if (guidance < 0) continue;
    const turnId = message.runId.slice(0, guidance);
    earlierAssistantByRun.set(turnId, (earlierAssistantByRun.get(turnId) ?? '') + message.content);
  }

  const before = new Map<number, Message[]>();
  const replacements = new Map<number, Message>();
  let nextAnchor = local.length;
  let lastAnchor = -1;
  const pending: Message[] = [];
  const claimedUsers = new Set<number>();
  const canonicalTurns = newestFirst.filter(turn => turn.id !== conversation.activeRun?.runId);

  // Walk newest to oldest so an unmatched native turn can be inserted before the next matched local turn.
  for (const turn of canonicalTurns) {
    const match = localAssistantByRun.get(turn.id);
    const turnTime = turn.startedAt;
    if (match !== undefined) {
      const original = local[match];
      const beforeGuidance = earlierAssistantByRun.get(turn.id);
      const native = beforeGuidance ? renderAssistant(conversation, trimEarlierAssistantText(turn, beforeGuidance), original)
        : renderAssistant(conversation, turn, original);
      if (native) replacements.set(match, native);
      let userIndex = match - 1;
      while (userIndex >= 0 && (local[userIndex].isGuidance || local[userIndex].runId?.startsWith(turn.id + ':before-guidance:'))) userIndex--;
      nextAnchor = userIndex >= 0 && isAsteriumUser(local[userIndex].authorId) ? userIndex : match;
      if (nextAnchor === userIndex) claimedUsers.add(userIndex);
      lastAnchor = Math.max(lastAnchor, match);
      continue;
    }

    const user = turn.items.find(item => item.kind === 'user');
    const nativePrompt = user ? visibleNativeUserText(user.text) : undefined;
    const assistant = renderAssistant(conversation, turn);
    // A force quit can leave the local prompt without its assistant row. Reuse that prompt if it is unambiguous.
    const candidates = user ? local.flatMap((message, index) => {
      if (index >= nextAnchor || claimedUsers.has(index) || message.isGuidance || !isAsteriumUser(message.authorId)) return [];
      if (message.runId === turn.id) return [index];
      if (message.runId || message.content !== nativePrompt) return [];
      const following = local[index + 1];
      return !following || isAsteriumUser(following.authorId) ? [index] : [];
    }) : [];
    if (candidates.length === 1) {
      const index = candidates[0];
      claimedUsers.add(index);
      if (assistant) before.set(index + 1, [assistant, ...(before.get(index + 1) ?? [])]);
      nextAnchor = index;
      continue;
    }
    const newMessages: Message[] = [];
    if (user) newMessages.push({
      id: codexHistoryMessageId(turn.id, user.id), authorId: ASTERIUM_USER_ID,
      content: nativePrompt ?? '', createdAt: nativeDisplayTime(turnTime), occurredAt: turnTime, status: 'delivered',
    });
    if (assistant) newMessages.push(assistant);
    if (!newMessages.length) continue;
    if (nextAnchor < local.length) before.set(nextAnchor, [...newMessages, ...(before.get(nextAnchor) ?? [])]);
    else pending.unshift(...newMessages);
  }

  const appendAt = lastAnchor + 1;
  const chronological = local.flatMap((message, index) => [
    ...(index === appendAt ? pending : []), ...(before.get(index) ?? []), replacements.get(index) ?? message,
  ]);
  if (appendAt === local.length) chronological.push(...pending);
  chronological.push(...(before.get(local.length) ?? []));
  return chronological;
}

function trimEarlierAssistantText(turn: CodexHistoryTurn, prefix: string): CodexHistoryTurn {
  const full = turn.items.flatMap(item => item.kind === 'assistant' ? [item.text] : []).join('');
  if (!full.startsWith(prefix)) return { ...turn, items: [] };
  let remaining = prefix.length;
  return { ...turn, items: turn.items.flatMap((item): CodexHistoryTurn['items'] => {
    if (!remaining) return [item];
    if (item.kind !== 'assistant') return [];
    const text = item.text.slice(remaining);
    remaining = Math.max(0, remaining - item.text.length);
    return text ? [{ ...item, text }] : [];
  }) };
}

function renderAssistant(conversation: Conversation, turn: CodexHistoryTurn, original?: Message): Message | undefined {
  const items = turn.items.filter(item => item.kind !== 'user');
  const nativeText = items.flatMap(item => item.kind === 'assistant' ? [item.text] : []);
  if (!items.length) return undefined;
  const content = nativeText.join('');
  const state = turn.state === 'inProgress' ? 'running' : turn.state === 'interrupted' ? 'cancelled' : turn.state;
  const base: Message = original ?? {
    id: codexHistoryMessageId(turn.id), authorId: conversation.partnerId, runId: turn.id,
    content, createdAt: nativeDisplayTime(turn.startedAt), occurredAt: turn.startedAt,
  };
  const originalBody = visibleAssistantText(base.content);
  const nativeBody = visibleAssistantText(content);
  const sameBody = nativeBody.trim() === originalBody.trim();
  if (original && sameBody && original.runState === state) return original;
  const originalTimeline = original?.timeline ?? [];
  const preservePrefix = Boolean(original && originalBody.trim() && nativeBody.startsWith(originalBody));
  let remainingPrefix = preservePrefix ? originalBody.length : 0;
  const timeline: TurnTimelineItem[] = preservePrefix ? [...originalTimeline] : [];
  let sequence = timeline.at(-1)?.sequence ?? 0;
  if (preservePrefix && !timeline.some(item => item.kind === 'text')) {
    timeline.push({ id: turn.id + ':legacy-text', sequence: ++sequence, kind: 'text', text: originalBody });
  }
  for (const item of items) {
    if (item.kind === 'tool') {
      if (remainingPrefix > 0 || (sameBody && original)) continue;
      timeline.push({ id: item.id, sequence: ++sequence, kind: 'tool', toolCallId: item.id, summary: item.label,
        state: item.state === 'running' && turn.state !== 'inProgress' ? 'failure' : item.state });
      continue;
    }
    const text = visibleAssistantText(item.text);
    if (remainingPrefix >= text.length) { remainingPrefix -= text.length; continue; }
    const rest = text.slice(remainingPrefix);
    remainingPrefix = 0;
    if (rest) timeline.push({ id: item.id, sequence: ++sequence, kind: 'text', text: rest });
  }
  return {
    ...base,
    content,
    timeline: sameBody && original ? originalTimeline : timeline,
    runState: state,
    isStreaming: false,
    ...(state === 'completed' ? { error: undefined } : {}),
  };
}

function nativeDisplayTime(value?: string) {
  return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
}
