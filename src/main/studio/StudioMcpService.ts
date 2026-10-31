import { STUDIO_PUBLIC_HISTORY_BUDGET, type StudioExternalHistoryRequest, type StudioExternalMemberContext } from '../../shared/studioRuntime';
import type { ProjectMutationCoordinator } from '../project/ProjectMutationCoordinator';
import type { StudioRoomStore } from './StudioRoomStore';
import type { StudioMcpAccessStore } from './StudioMcpAccessStore';

/** Host-independent group capabilities. No persona, shell, filesystem, or native-thread access. */
export class StudioMcpService {
  automation?: (token: string, input: unknown) => Promise<string>;
  constructor(
    private readonly access: StudioMcpAccessStore,
    private readonly rooms: StudioRoomStore,
    private readonly coordinator: ProjectMutationCoordinator,
    private readonly partnerExists: (partnerId: string) => boolean,
  ) {}

  async authenticate(token: string) {
    const identity = await this.access.authenticate(token);
    if (!this.partnerExists(identity.partnerId)) throw new Error('STUDIO_MCP_UNAUTHORIZED');
    return identity;
  }

  listRooms(token: string) {
    return this.coordinator.run(async () => {
      const identity = await this.authenticate(token);
      const rooms = await this.rooms.listAll();
      return { partnerId: identity.partnerId, rooms: rooms.flatMap((room) => {
        try { this.coordinator.assertProjectActive(room.metadata.projectId); } catch { return []; }
        const membership = room.externalState?.memberships.find((item) => item.partnerId === identity.partnerId && item.active);
        if (!membership || !room.metadata.memberIds.includes(identity.partnerId)) return [];
        return [{ roomId: room.metadata.roomId, projectId: room.metadata.projectId, name: room.metadata.name,
          members: room.metadata.memberIds.map((partnerId) => ({ partnerId, participation: this.partnerExists(partnerId) ? 'external' : 'managed' })),
          membershipGeneration: membership.membershipGeneration, archived: Boolean(room.metadata.archived),
          latestSeq: room.messages.at(-1)?.seq ?? 0, speakingMode: room.settings.speakingMode,
          selectedPartnerIds: [...room.settings.selectedPartnerIds], mutedPartnerIds: [...room.mutedPartnerIds] }];
      }) };
    });
  }

  history(token: string, roomId: string, membershipGeneration: number, request: StudioExternalHistoryRequest) {
    return this.withRoom(token, roomId, membershipGeneration, async (context) => {
      const page = await this.rooms.readExternalHistory(context, request);
      const oversized = page.messages.find((message) => message.content.length > STUDIO_PUBLIC_HISTORY_BUDGET.maxCharacters);
      return {
        messages: page.messages.map((message) => ({
          messageId: message.messageId, seq: message.seq, authorType: message.authorType, authorId: message.authorId,
          createdAt: message.createdAt, status: message.status,
          ...(message.mentions ? { mentions: message.mentions } : {}),
          ...(message.content.length > STUDIO_PUBLIC_HISTORY_BUDGET.maxCharacters
            ? { contentRequiresChunks: true, totalCharacters: message.content.length }
            : { content: message.content }),
        })),
        // Do not expose a receipt claiming an oversized message was fully delivered.
        ...(oversized ? { contentRequiresChunks: true } : { readId: page.readId }),
        throughSeq: oversized ? oversized.seq - 1 : page.throughSeq,
        latestSeq: page.latestSeq, processedThroughSeq: page.processedThroughSeq,
        hasOlder: page.hasOlder, hasNewer: page.hasNewer,
      };
    });
  }

  content(token: string, roomId: string, membershipGeneration: number, request: { messageId: string; offset: number; limit: number; readId?: string }) {
    return this.withRoom(token, roomId, membershipGeneration, (context) => this.rooms.readExternalContent(context, request));
  }

  send(token: string, roomId: string, membershipGeneration: number, request: { requestId: string; content: string; mentionPartnerIds?: string[] }) {
    return this.withRoom(token, roomId, membershipGeneration, async (context) => {
      if (request.mentionPartnerIds?.some((id) => !this.partnerExists(id))) throw new Error('STUDIO_MENTION_EXTERNAL_TARGET_REQUIRED');
      const result = await this.rooms.appendExternalMessage(context, request);
      const message = result.snapshot.messages.find((item) => item.messageId === result.messageId)!;
      return { messageId: message.messageId, seq: message.seq, authorId: message.authorId };
    });
  }

  acknowledge(token: string, roomId: string, membershipGeneration: number, readId: string) {
    return this.withRoom(token, roomId, membershipGeneration, (context) => this.rooms.acknowledgeExternalRead(context, readId));
  }

  private withRoom<T>(token: string, roomId: string, membershipGeneration: number, operation: (context: StudioExternalMemberContext) => Promise<T>) {
    return this.coordinator.run(async () => {
      const identity = await this.authenticate(token);
      const room = await this.rooms.getRoom(roomId);
      if (!room) throw new Error('STUDIO_ROOM_NOT_FOUND');
      this.coordinator.assertProjectActive(room.metadata.projectId);
      return operation({ roomId, partnerId: identity.partnerId, membershipGeneration });
    });
  }
}
