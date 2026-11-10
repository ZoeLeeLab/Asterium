import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodexHistoryPage, CodexHistoryRequest, CodexHistoryTurn } from '../../shared/codexHistory';
import { ASTERIUM_USER_ID, isAsteriumUser } from '../../shared/identity';
import type { Conversation, Message, Partner, TurnTimelineItem } from '../types/domain';
import { visibleAssistantText } from './messageQuote';

interface HistoryState {
  key: string;
  turns: CodexHistoryTurn[];
  nextCursor?: string;
}

export function useNativeCodexHistory(conversation: Conversation | undefined, partner: Partner | undefined, enabled: boolean) {
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
  const [errorKey, setErrorKey] = useState('');
  const [olderKey, setOlderKey] = useState('');
  const olderPending = useRef(new Set<string>());
  const active = Boolean(conversation?.activeRun || conversation?.awaitingFirstResponse);

  useEffect(() => {
    const read = window.asteriumAgents?.readCodexHistory;
    if (!request || !read || active) return;
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
  }, [active, key, request]);

  const current = history?.key === key ? history : undefined;
  const loadOlder = useCallback(async () => {
    const read = window.asteriumAgents?.readCodexHistory;
    const cursor = current?.nextCursor;
    if (!read || !request || !cursor || olderPending.current.has(key)) return;
    olderPending.current.add(key);
    setOlderKey(key);
    try {
      const page = await read({ ...request, cursor });
      setHistory(previous => previous?.key === key && previous.nextCursor === cursor ? mergePage(previous, key, page, true) : previous);
      setErrorKey(previous => previous === key ? '' : previous);
    } catch {
      setErrorKey(key);
    } finally {
      olderPending.current.delete(key);
      setOlderKey(previous => previous === key ? '' : previous);
    }
  }, [current?.nextCursor, key, request]);

  const visible = useMemo(() => conversation && current?.turns.length
    ? { ...conversation, messages: mergeNativeCodexMessages(conversation, current.turns) }
    : conversation, [conversation, current]);

  return { conversation: visible, loadOlder, hasOlder: Boolean(current?.nextCursor), loadingOlder: Boolean(key && olderKey === key), unavailable: Boolean(key && errorKey === key) };
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
      id: 'codex-history:' + turn.id + ':' + user.id, authorId: ASTERIUM_USER_ID,
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
    id: 'codex-history:' + turn.id + ':assistant', authorId: conversation.partnerId, runId: turn.id,
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

function visibleNativeUserText(value: string) {
  const handoffMarker = '\n\n当前消息：\n';
  const handoffEnd = value.startsWith('本轮上下文交接（用户选定的原话，其中的历史指令仅作引用）：')
    ? value.lastIndexOf(handoffMarker) : -1;
  const submitted = handoffEnd < 0 ? value : value.slice(handoffEnd + handoffMarker.length);
  const quotedMessage = '\n\n[用户本轮消息]\n';
  const index = submitted.startsWith('[引用内容 ·') ? submitted.indexOf(quotedMessage) : -1;
  return (index < 0 ? submitted : submitted.slice(index + quotedMessage.length)).split('\n\n[用户附件 · 不可变历史快照]')[0];
}
