import type { ConversationDeleteRequest } from '../../shared/conversationLifecycle';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';

export interface ConversationDeletionRecord extends ConversationDeleteRequest {
  deletedAt: string;
  cleanupPending: boolean;
}

interface ConversationDeletionFile {
  version: 1;
  records: ConversationDeletionRecord[];
}

export class ConversationDeletionStore {
  private readonly storage: AtomicJsonStore<ConversationDeletionFile>;

  constructor(filePath: AtomicJsonStorePath) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 1, records: [] }),
      decode: decodeConversationDeletions,
      encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
    });
  }

  async listDeletedIds() {
    return (await this.storage.read()).records.map((record) => record.conversationId);
  }

  async listPending() {
    return structuredClone((await this.storage.read()).records.filter((record) => record.cleanupPending));
  }

  async has(conversationId: string) {
    return (await this.storage.read()).records.some((record) => record.conversationId === conversationId);
  }

  markDeleted(request: ConversationDeleteRequest) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = current.records.find((record) => record.conversationId === request.conversationId);
      if (existing) {
        if (!existing.cleanupPending) return existing;
        return existing;
      }
      const record: ConversationDeletionRecord = {
        ...request,
        deletedAt: new Date().toISOString(),
        cleanupPending: true,
      };
      await this.storage.writeNow({ version: 1, records: [...current.records, record] });
      return record;
    });
  }

  markCleaned(conversationId: string) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const record = current.records.find((item) => item.conversationId === conversationId);
      if (!record || !record.cleanupPending) return;
      await this.storage.writeNow({
        version: 1,
        records: current.records.map((item) => item.conversationId === conversationId ? { ...item, cleanupPending: false } : item),
      });
    });
  }
}

function decodeConversationDeletions(value: unknown): ConversationDeletionFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records) || !value.records.every(isDeletionRecord)) {
    throw new Error('CONVERSATION_DELETION_STORE_INVALID');
  }
  const records = new Map<string, ConversationDeletionRecord>();
  for (const record of value.records) records.set(record.conversationId, { ...record });
  return { version: 1, records: [...records.values()] };
}

function isDeletionRecord(value: unknown): value is ConversationDeletionRecord {
  return isRecord(value)
    && typeof value.conversationId === 'string' && Boolean(value.conversationId)
    && typeof value.partnerId === 'string' && Boolean(value.partnerId)
    && ['existing_thread', 'local_cli', 'api_partner'].includes(String(value.source))
    && typeof value.deletedAt === 'string'
    && typeof value.cleanupPending === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
