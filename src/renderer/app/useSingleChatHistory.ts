import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { AsteriumConversationsApi } from '../../shared/desktopBridge';
import type { SingleChatHistoryChange, SingleChatHistoryPage, SingleChatPageBounds, SingleChatProfile } from '../../shared/singleChatHistory';
import type { Conversation, Message, PrototypeAction, PrototypeState } from '../types/domain';
import { createInitialState } from '../data/initialState';
import {
  loadPrototypeState, prepareSingleChatMessage, prepareSingleChatMetadata, readLegacySingleChatHistory, restoreSingleChatHistory, restoreSingleChatPageMessages,
} from './persistence';

type DesktopHistory = Required<Pick<AsteriumConversationsApi, 'openHistory' | 'migrateHistory' | 'writeHistory'>>;
type PendingWrite = { id: number; changes: SingleChatHistoryChange[]; profile?: SingleChatProfile };
type RecentPages = Record<string, SingleChatPageBounds>;
type Frame = { state: PrototypeState; generation?: string; nextId: number; pending: PendingWrite[]; recentPages?: RecentPages };
type HistoryAction = PrototypeAction
  | { type: 'historyHydrated'; state: PrototypeState; generation: string; recentPages?: RecentPages }
  | { type: 'historyRecentLoaded'; conversationId: string; page: SingleChatHistoryPage }
  | { type: 'historySaved'; id: number }
  | { type: 'historySaveProfile'; profile: SingleChatProfile };

function desktopHistory(): DesktopHistory | undefined {
  const bridge = window.asteriumConversations;
  if (!bridge?.openHistory || !bridge.migrateHistory || !bridge.writeHistory) return undefined;
  return bridge as DesktopHistory;
}

export function useSingleChatHistory(reducer: (state: PrototypeState, action: PrototypeAction) => PrototypeState) {
  const bridge = desktopHistory();
  const [frame, dispatch] = useReducer((current: Frame, action: HistoryAction): Frame => {
    if (action.type === 'historyHydrated') return { ...current, state: action.state, generation: action.generation, recentPages: action.recentPages };
    if (action.type === 'historyRecentLoaded') {
      const { conversationId, page } = action;
      return {
        ...current,
        recentPages: { ...current.recentPages, [conversationId]: { hasOlder: page.hasOlder, hasNewer: page.hasNewer, turnOffset: page.turnOffset } },
        state: { ...current.state, conversations: current.state.conversations.map(conversation => {
          if (conversation.id !== conversationId) return conversation;
          const messages = new Map(restoreSingleChatPageMessages(conversation.partnerId, page.messages, Boolean(page.interrupted))
            .map(message => [message.id, message]));
          for (const message of conversation.messages) messages.set(message.id, message);
          return { ...conversation, messages: [...messages.values()] };
        }) },
      };
    }
    if (action.type === 'historySaved') return { ...current, pending: current.pending.filter(item => item.id > action.id) };
    if (action.type === 'historySaveProfile') return queue(current, { changes: [], profile: action.profile });
    const state = reducer(current.state, action);
    if (state === current.state) return current;
    if (!current.generation || current.state.conversations === state.conversations) return { ...current, state };
    const changes = collectHistoryChanges(current.state, state, action);
    return queue({ ...current, state }, { changes });
  }, undefined, (): Frame => ({ state: bridge ? createInitialState() : loadPrototypeState(), pending: [], nextId: 1 }));

  const [startupFailed, setStartupFailed] = useState(false);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [writeFailed, setWriteFailed] = useState(false);
  const [sendSaveFailed, setSendSaveFailed] = useState(false);
  const inFlight = useRef<number | undefined>(undefined);
  const startupPending = useRef<ReturnType<DesktopHistory['openHistory']> | undefined>(undefined);
  const generation = frame.generation;
  const pending = frame.pending;
  const selected = frame.state.activeConversationId;
  const selectedPage = frame.recentPages?.[selected];
  const needsRecent = Boolean(frame.recentPages && selected && !selectedPage);
  const readPage = window.asteriumConversations?.readHistoryPage;

  useEffect(() => {
    if (!generation || !needsRecent || !readPage) return;
    let live = true;
    let loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      void readPage({ conversationId: selected }).then(page => {
        if (!live) return;
        dispatch({ type: 'historyRecentLoaded', conversationId: selected, page: page ?? { messages: [], hasOlder: false, hasNewer: false } });
      }).catch(() => {
        // Retry on focus while this conversation still has no page.
      }).finally(() => { loading = false; });
    };
    load();
    window.addEventListener('focus', load);
    return () => { live = false; window.removeEventListener('focus', load); };
  }, [generation, needsRecent, readPage, selected]);

  useEffect(() => {
    if (!bridge || generation) return;
    let active = true;
    const start = async () => {
      const windowed = Boolean(readPage);
      const existing = await bridge.openHistory(windowed);
      return existing ?? bridge.migrateHistory(readLegacySingleChatHistory(), windowed);
    };
    const operation = startupPending.current ?? (startupPending.current = start());
    void operation.then(history => {
      if (!active || !history) return;
      dispatch({ type: 'historyHydrated', state: restoreSingleChatHistory(history), generation: history.generation, recentPages: history.recentPages });
    }).catch(() => {
      if (startupPending.current === operation) startupPending.current = undefined;
      if (active) setStartupFailed(true);
    });
    return () => { active = false; };
  }, [bridge, generation, readPage, startupAttempt]);

  useEffect(() => {
    const id = pending.at(-1)?.id;
    if (!bridge || !generation || id === undefined || writeFailed || inFlight.current !== undefined) return;
    inFlight.current = id;
    const changes = pending.flatMap(item => item.changes);
    const profile = [...pending].reverse().find(item => item.profile)?.profile;
    void bridge.writeHistory({ generation, changes, profile }).then(() => {
      inFlight.current = undefined;
      dispatch({ type: 'historySaved', id });
    }).catch(() => {
      inFlight.current = undefined;
      setWriteFailed(true);
    });
  }, [bridge, generation, pending, writeFailed]);

  const saveBeforeSend = useCallback(async (conversation: Conversation, message: Message) => {
    if (!bridge) return true;
    if (!generation || writeFailed) return false;
    try {
      await bridge.writeHistory({ generation, changes: [{
        conversationId: conversation.id, metadata: prepareSingleChatMetadata(conversation), metadataOnCreateOnly: true,
        upsert: [prepareSingleChatMessage(message)], remove: [], busy: Boolean(message.clientMessageId),
      }] });
      setSendSaveFailed(false);
      return true;
    } catch {
      setSendSaveFailed(true);
      return false;
    }
  }, [bridge, generation, writeFailed]);

  const saveProfile = useCallback((profile: SingleChatProfile) => {
    dispatch({ type: 'historySaveProfile', profile });
  }, []);
  const retryStartup = useCallback(() => { setStartupFailed(false); setStartupAttempt(attempt => attempt + 1); }, []);
  const retryWrite = useCallback(() => { setWriteFailed(false); setSendSaveFailed(false); }, []);

  return {
    state: frame.state, dispatch, managed: Boolean(bridge), ready: !bridge || Boolean(generation), pending: pending.length > 0,
    startupFailed, writeFailed, sendSaveFailed, retryStartup, retryWrite, saveProfile, saveBeforeSend,
    selectedPage, needsRecent,
  };
}

function queue(frame: Frame, write: Omit<PendingWrite, 'id'>): Frame {
  if (!frame.generation || (!write.changes.length && !write.profile)) return frame;
  return { ...frame, nextId: frame.nextId + 1, pending: [...frame.pending, { id: frame.nextId, ...write }] };
}

const checkpointEvents = new Set<string>([
  'session.bound', 'message.accepted', 'message.delivery', 'tool.completed', 'file.produced',
  'run.completed', 'run.failed', 'run.cancelled', 'existing_thread.reply', 'existing_thread.changed',
  'guidance.applied',
]);

export function collectHistoryChanges(previous: PrototypeState, next: PrototypeState, action: PrototypeAction): SingleChatHistoryChange[] {
  if (previous.conversations === next.conversations) return [];
  if ((action.type === 'agentEvent' || action.type === 'automationEvent') && !checkpointEvents.has(action.event.type)) return [];
  const before = new Map(previous.conversations.map(conversation => [conversation.id, conversation]));
  const changes: SingleChatHistoryChange[] = [];
  for (const conversation of next.conversations) {
    const prior = before.get(conversation.id);
    if (conversation === prior) continue;
    if (action.type === 'sendChatMessage' && action.historySaved) continue;
    // Keep the previous completed turn on disk until regeneration settles.
    if ((action.type === 'replaceLastTurn' && action.restoreOnFailure) || (conversation.regenerationBackup && action.type !== 'messageSendFailed'
      && !(action.type === 'agentEvent' && ['run.completed', 'run.failed', 'run.cancelled'].includes(action.event.type)))) continue;
    const previousMessages = prior?.regenerationBackup?.messages ?? prior?.messages ?? [];
    const upsert: Message[] = [];
    const remove: string[] = [];
    let order: string[] | undefined;
    if (conversation.messages !== previousMessages) {
      const old = new Map(previousMessages.map(message => [message.id, message]));
      const appended: string[] = [];
      const partialTextBoundary = (action.type === 'agentEvent' || action.type === 'automationEvent') && action.event.type === 'tool.completed';
      for (const message of conversation.messages) {
        const former = old.get(message.id);
        old.delete(message.id);
        if (message === former || (message.isStreaming && !partialTextBoundary)) continue;
        upsert.push(prepareSingleChatMessage(message));
        if (!former) appended.push(message.id);
      }
      remove.push(...old.keys());
      if (appended.length || remove.length) {
        const naturalOrder = [...previousMessages.filter(message => !old.has(message.id)).map(message => message.id), ...appended];
        if (naturalOrder.length === conversation.messages.length && naturalOrder.some((id, index) => id !== conversation.messages[index].id)) {
          order = conversation.messages.map(message => message.id);
        }
      }
    }
    changes.push({
      conversationId: conversation.id, metadata: prepareSingleChatMetadata(conversation),
      metadataOnCreateOnly: action.type === 'createConversation' || action.type === 'rebindPartnerRoot',
      upsert, remove, order, busy: Boolean(conversation.activeRun || conversation.awaitingFirstResponse),
    });
  }
  return changes;
}
