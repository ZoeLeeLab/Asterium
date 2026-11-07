import { studioAttachmentConversationId, type StudioPreparedTurn, type StudioRoomSnapshot, type StudioStartRoundRequest } from '../../shared/studioRuntime';
import type { ConversationAttachmentStore } from '../security/ConversationAttachmentStore';
import type { ProjectWorkspaceStore } from '../project/ProjectWorkspaceStore';
import type { StudioRoomStore } from './StudioRoomStore';

export class StudioAttachments {
  constructor(
    private readonly store: ConversationAttachmentStore,
    private readonly projectUploads?: {
      workspaces: Pick<ProjectWorkspaceStore, 'archiveUpload'>;
      rooms: Pick<StudioRoomStore, 'completeProjectUploads' | 'getRoom'>;
      onArchived?: (projectId: string) => Promise<unknown>;
    },
  ) {}
  async prepareMessage(request: StudioStartRoundRequest): Promise<StudioStartRoundRequest> {
    if (!request.attachmentSelectionIds?.length) return request;
    const attachments = await this.store.commit(studioAttachmentConversationId(request.room.roomId), request.attachmentSelectionIds, request.messageId, true);
    return { ...request, attachments };
  }
  async published(request: StudioStartRoundRequest) {
    await this.store.discard(request.attachmentSelectionIds ?? []).catch(() => undefined);
  }
  async archivePublished(snapshot: StudioRoomSnapshot) {
    const uploads = this.projectUploads;
    if (!uploads || snapshot.metadata.archived) return snapshot;
    const completed: string[] = [];
    let attempted = false;
    let copied = false;
    for (const message of snapshot.messages) {
      if (message.authorType !== 'user' || !message.projectUploadPending || !message.attachments?.length) continue;
      attempted = true;
      try {
        const context = studioAttachmentConversationId(snapshot.metadata.roomId);
        for (const attachment of message.attachments) {
          const source = await this.store.pathFor(attachment.id, context);
          await uploads.workspaces.archiveUpload(snapshot.metadata.projectId, source, attachment.name);
          copied = true;
        }
        completed.push(message.messageId);
      } catch {
        // The published message and its snapshots stay available for a later retry.
      }
    }
    if (completed.length) await uploads.rooms.completeProjectUploads(snapshot.metadata.roomId, completed).catch(() => undefined);
    if (copied) await uploads.onArchived?.(snapshot.metadata.projectId).catch(() => undefined);
    return attempted ? (await uploads.rooms.getRoom(snapshot.metadata.roomId).catch(() => undefined)) ?? snapshot : snapshot;
  }
  prepareTurn(prepared: StudioPreparedTurn, ledger: StudioPreparedTurn['messages']) {
    this.store.authorizeGroup(prepared.conversationId, prepared.room.roomId, ledger.filter(message => message.seq <= prepared.inputThroughSeq).flatMap(message => message.attachments ?? []));
    const unique = new Map(prepared.messages.flatMap(message => message.attachments ?? []).map(item => [item.id, item]));
    return { ...prepared, ...(unique.size ? { attachments: [...unique.values()].slice(-10) } : {}) };
  }
}
