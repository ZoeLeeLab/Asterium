import { createHash } from 'node:crypto';
import type {
  MemorySourceAnchor,
  MemorySourceExcerptMessage,
  MemorySourceExcerptOffset,
  MemorySourceReadResult,
} from '../../shared/memoryArchive';
import type { StudioRoomSnapshot } from '../../shared/studioRuntime';
import type { SingleChatMessageStore } from '../conversation/SingleChatMessageStore';
import type { StudioRoomStore } from '../studio/StudioRoomStore';

type StudioReader = Pick<StudioRoomStore, 'getRoom'>;

export class MemorySourceService {
  constructor(
    private readonly singleChats: Pick<SingleChatMessageStore, 'getWindow'>,
    private readonly studioRooms: StudioReader,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async capture(partnerId: string, source: MemorySourceAnchor): Promise<MemorySourceAnchor> {
    const live = await this.liveWindow(partnerId, source, true);
    if (!live) throw new Error('MEMORY_SOURCE_NOT_FOUND');
    const target = live.messages.find((message) => message.offset === 0)!;
    return {
      ...(source.kind === 'single_chat'
        ? { kind: 'single_chat' as const, conversationId: source.conversationId, messageId: source.messageId }
        : { kind: 'studio' as const, roomId: source.roomId, messageId: source.messageId }),
      contentHash: target.contentHash,
      frozenExcerpt: { capturedAt: this.now(), messages: live.messages },
    };
  }

  async read(partnerId: string, source: MemorySourceAnchor): Promise<MemorySourceReadResult> {
    let live: { messages: MemorySourceExcerptMessage[] } | undefined;
    let accessDenied = false;
    try {
      live = await this.liveWindow(partnerId, source, false);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'MEMORY_SOURCE_ACCESS_DENIED') throw error;
      accessDenied = true;
    }
    if (live) {
      const target = live.messages.find((message) => message.offset === 0)!;
      if (!source.contentHash || target.contentHash === source.contentHash) {
        return { state: 'live', source: structuredClone(source), messages: live.messages };
      }
      return source.frozenExcerpt
        ? { state: 'changed', source: structuredClone(source), messages: structuredClone(source.frozenExcerpt.messages), reason: 'content_changed' }
        : { state: 'changed', source: structuredClone(source), messages: [], reason: 'content_changed' };
    }
    if (source.frozenExcerpt) return {
      state: 'frozen',
      source: structuredClone(source),
      messages: structuredClone(source.frozenExcerpt.messages),
      reason: accessDenied ? 'source_access_denied' : 'source_missing',
    };
    return {
      state: 'unavailable',
      source: structuredClone(source),
      messages: [],
      reason: accessDenied ? 'source_access_denied' : 'legacy_source_missing',
    };
  }

  private async liveWindow(partnerId: string, source: MemorySourceAnchor, requireStudioMembership: boolean) {
    if (source.kind === 'single_chat') {
      const window = await this.singleChats.getWindow(source.conversationId, source.messageId, 2);
      if (!window) return undefined;
      if (window.partnerId !== partnerId) throw new Error('MEMORY_SOURCE_ACCESS_DENIED');
      const targetIndex = window.messages.findIndex((message) => message.messageId === source.messageId);
      return { messages: window.messages.map((message, index) => excerptMessage(message, index - targetIndex)) };
    }
    const room = await this.studioRooms.getRoom(source.roomId);
    if (!room) return undefined;
    if (requireStudioMembership && !room.metadata.memberIds.includes(partnerId)) throw new Error('MEMORY_SOURCE_ACCESS_DENIED');
    const targetIndex = room.messages.findIndex((message) => message.messageId === source.messageId);
    if (targetIndex < 0) return undefined;
    const start = Math.max(0, targetIndex - 2);
    const messages = room.messages.slice(start, targetIndex + 3);
    return { messages: messages.map((message, index) => excerptStudioMessage(message, start + index - targetIndex)) };
  }
}

export function memoryMessageContentHash(content: string) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function excerptMessage(message: { messageId: string; authorType: 'user' | 'partner'; authorId: string; content: string; createdAt: string }, offset: number): MemorySourceExcerptMessage {
  return {
    ...message,
    contentHash: memoryMessageContentHash(message.content),
    offset: offset as MemorySourceExcerptOffset,
  };
}

function excerptStudioMessage(message: StudioRoomSnapshot['messages'][number], offset: number): MemorySourceExcerptMessage {
  return {
    messageId: message.messageId,
    authorType: message.authorType,
    authorId: message.authorId,
    content: message.content,
    createdAt: message.createdAt,
    contentHash: memoryMessageContentHash(message.content),
    offset: offset as MemorySourceExcerptOffset,
  };
}
