import { studioAttachmentConversationId, type StudioPreparedTurn, type StudioStartRoundRequest } from '../../shared/studioRuntime';
import type { ConversationAttachmentStore } from '../security/ConversationAttachmentStore';

export class StudioAttachments {
  constructor(private readonly store: ConversationAttachmentStore) {}
  async prepareMessage(request: StudioStartRoundRequest): Promise<StudioStartRoundRequest> {
    if (!request.attachmentSelectionIds?.length) return request;
    const attachments = await this.store.commit(studioAttachmentConversationId(request.room.roomId), request.attachmentSelectionIds, request.messageId, true);
    return { ...request, attachments };
  }
  async published(request: StudioStartRoundRequest) {
    await this.store.discard(request.attachmentSelectionIds ?? []).catch(() => undefined);
  }
  prepareTurn(prepared: StudioPreparedTurn, ledger: StudioPreparedTurn['messages']) {
    this.store.authorizeGroup(prepared.conversationId, prepared.room.roomId, ledger.filter(message => message.seq <= prepared.inputThroughSeq).flatMap(message => message.attachments ?? []));
    const unique = new Map(prepared.messages.flatMap(message => message.attachments ?? []).map(item => [item.id, item]));
    return { ...prepared, ...(unique.size ? { attachments: [...unique.values()].slice(-10) } : {}) };
  }
}
