import type { SingleChatHistoryStore } from './SingleChatHistoryStore';
import { fromIndexedMessage, projectSingleChat } from './singleChatHistoryProjection';
import type { AtomicJsonStorePath } from '../storage/AtomicJsonStore';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';
import { assertSingleChatConversationSnapshots, type SingleChatConversationSnapshot } from '../../shared/singleChatMessages';

interface SingleChatMessageFile {
  version: 1;
  conversations: Record<string, SingleChatConversationSnapshot>;
}

export class SingleChatMessageStore {
  private readonly storage: AtomicJsonStore<SingleChatMessageFile>;

  constructor(filePath: AtomicJsonStorePath, private readonly history?: SingleChatHistoryStore) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 1, conversations: {} }),
      decode: decodeFile,
    });
  }

  async sync(snapshots: SingleChatConversationSnapshot[]) {
    assertSingleChatConversationSnapshots(snapshots);
    if (await this.history?.isActive()) return;
    await this.storage.runExclusive(async () => {
      const previous = await this.storage.readNow();
      const conversations = Object.fromEntries(snapshots.map((snapshot) => [snapshot.conversationId, structuredClone(snapshot)]));
      for (const [id, snapshot] of Object.entries(conversations)) {
        const managed = previous.conversations[id]?.messages.filter(m => m.automationRunId) ?? [];
        if (previous.conversations[id]?.partnerId !== snapshot.partnerId && managed.length) throw new Error('SINGLE_CHAT_MESSAGE_INDEX_INVALID');
        const ids = new Set(snapshot.messages.map(m => m.messageId));
        for (const m of managed) { const current = snapshot.messages.find(item => item.messageId === m.messageId); if (current) Object.assign(current, m); }
        snapshot.messages.push(...managed.filter(m => !ids.has(m.messageId)));
      }
      await this.storage.writeNow({ version: 1, conversations });
    });
  }

  async getConversation(conversationId: string) {
    const active = await this.history?.readProjection(conversationId);
    if (active) return active.conversations.map(item => projectSingleChat(item, active.profile, active.busy.has(item.id)))[0];
    const value = (await this.storage.read()).conversations[conversationId];
    return value ? structuredClone(value) : undefined;
  }

  async list() {
    const active = await this.history?.readProjection();
    if (active) return active.conversations.map(item => projectSingleChat(item, active.profile, active.busy.has(item.id)));
    return this.listLegacy();
  }

  async listLegacy() {
    return structuredClone(Object.values((await this.storage.read()).conversations));
  }

  async messagesInTimeRange(conversationId: string, from: string, to: string) {
    const conversation = await this.getConversation(conversationId);
    return conversation?.messages.filter((message) => message.occurredAt && message.occurredAt >= from && message.occurredAt <= to) ?? [];
  }

  async upsertMessage(conversationId: string, partnerId: string, message: SingleChatConversationSnapshot['messages'][number]) {
    assertSingleChatConversationSnapshots([{ conversationId, partnerId, messages: [message] }]);
    if (await this.history?.upsertManagedMessage(conversationId, partnerId, fromIndexedMessage(message))) return;
    await this.storage.runExclusive(async () => {
      const value = await this.storage.readNow();
      const current = value.conversations[conversationId];
      if (current && current.partnerId !== partnerId) throw new Error('SINGLE_CHAT_MESSAGE_INDEX_INVALID');
      const messages = [...(current?.messages ?? [])];
      const index = messages.findIndex((item) => item.messageId === message.messageId);
      if (index >= 0) messages[index] = structuredClone(message);
      else messages.push(structuredClone(message));
      value.conversations[conversationId] = { ...current, conversationId, partnerId, messages };
      await this.storage.writeNow(value);
    });
  }

  async getMessage(conversationId: string, messageId: string) {
    const conversation = await this.getConversation(conversationId);
    return conversation?.messages.find((message) => message.messageId === messageId);
  }

  async getWindow(conversationId: string, messageId: string, radius = 2) {
    const conversation = await this.getConversation(conversationId);
    if (!conversation) return undefined;
    const index = conversation.messages.findIndex((message) => message.messageId === messageId);
    if (index < 0) return undefined;
    return {
      partnerId: conversation.partnerId,
      targetIndex: index,
      messages: conversation.messages.slice(Math.max(0, index - radius), index + radius + 1),
    };
  }

  async deleteConversation(conversationId: string) {
    if (await this.history?.deleteConversation(conversationId)) return;
    await this.storage.runExclusive(async () => {
      const value = await this.storage.readNow();
      if (!(conversationId in value.conversations)) return;
      delete value.conversations[conversationId];
      await this.storage.writeNow(value);
    });
  }
}

function decodeFile(value: unknown): SingleChatMessageFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.conversations)) throw new Error('SINGLE_CHAT_MESSAGE_INDEX_INVALID');
  const conversations = value.conversations as Record<string, unknown>;
  const snapshots = Object.values(conversations);
  assertSingleChatConversationSnapshots(snapshots);
  if (snapshots.some((snapshot) => conversations[snapshot.conversationId] !== snapshot)) throw new Error('SINGLE_CHAT_MESSAGE_INDEX_INVALID');
  return value as unknown as SingleChatMessageFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
