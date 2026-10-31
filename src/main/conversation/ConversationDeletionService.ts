import type { ConversationDeleteRequest, ConversationDeleteResult } from '../../shared/conversationLifecycle';
import type { ApiAgentSessionStore } from '../api/ApiAgentSessionStore';
import type { ConversationAttachmentStore } from '../security/ConversationAttachmentStore';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import type { ConversationDeletionRecord, ConversationDeletionStore } from './ConversationDeletionStore';
import type { SingleChatMessageStore } from './SingleChatMessageStore';

interface ConversationDeletionServiceOptions {
  deletions: ConversationDeletionStore;
  apiSessions: Pick<ApiAgentSessionStore, 'delete'>;
  attachments: Pick<ConversationAttachmentStore, 'deleteConversation'>;
  bindings: Pick<NativeThreadBindingStore, 'removeConversations'>;
  messages: Pick<SingleChatMessageStore, 'deleteConversation'>;
}

export class ConversationDeletionService {
  private mutation = Promise.resolve();

  constructor(private readonly options: ConversationDeletionServiceOptions) {}

  listDeletedIds() {
    return this.options.deletions.listDeletedIds();
  }

  isDeleted(conversationId: string) {
    return this.options.deletions.has(conversationId);
  }

  delete(request: ConversationDeleteRequest): Promise<ConversationDeleteResult> {
    validateRequest(request);
    return this.run(async () => {
      const record = await this.options.deletions.markDeleted(request);
      return this.cleanup(record);
    });
  }

  recover() {
    return this.run(async () => {
      for (const record of await this.options.deletions.listPending()) await this.cleanup(record);
    });
  }

  private async cleanup(record: ConversationDeletionRecord): Promise<ConversationDeleteResult> {
    const results = await Promise.allSettled([
      ...(record.source === 'api_partner' ? [this.options.apiSessions.delete(record.partnerId, record.conversationId)] : []),
      this.options.attachments.deleteConversation(record.conversationId),
      this.options.bindings.removeConversations([record.conversationId]),
      this.options.messages.deleteConversation(record.conversationId),
    ]);
    const cleanupPending = results.some((result) => result.status === 'rejected');
    if (!cleanupPending) await this.options.deletions.markCleaned(record.conversationId);
    return { conversationId: record.conversationId, cleanupPending };
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateRequest(request: ConversationDeleteRequest) {
  if (!isSafeId(request.conversationId) || !isSafeId(request.partnerId)
    || !['existing_thread', 'local_cli', 'api_partner'].includes(request.source)) {
    throw new Error('INVALID_CONVERSATION_DELETE');
  }
}

function isSafeId(value: string) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(value);
}
