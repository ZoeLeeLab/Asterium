import type { SingleChatConversationSnapshot } from '../../../shared/singleChatMessages';
import type { StudioRoomSnapshot } from '../../../shared/studioRuntime';
import { fallbackHash, type FallbackInput } from './MemoryFallbackJobStore';

export function singleChatFallbackInputs(conversations: SingleChatConversationSnapshot[]): FallbackInput[] {
  return conversations.map((conversation) => ({ partnerId: conversation.partnerId, kind: 'single_chat', conversationId: conversation.conversationId, busy: Boolean(conversation.busy),
    messages: conversation.messages.filter((message) => message.fallbackEligible !== false && message.content.trim()).map((message) => ({ messageId: message.messageId, content: message.content,
      authorType: message.authorType, authorId: message.authorId, occurredAt: message.completedAt ?? message.occurredAt, hash: fallbackHash(message.content) })),
  }));
}
export function studioFallbackInputs(rooms: StudioRoomSnapshot[]): FallbackInput[] {
  return rooms.flatMap((room) => room.metadata.memberIds.map((partnerId) => ({ partnerId, kind: 'studio' as const, conversationId: room.metadata.roomId,
    busy: Boolean(room.streaming || (room.activeRound && !['completed', 'failed', 'cancelled'].includes(room.activeRound.state))),
    messages: room.messages.filter((message) => message.status === 'completed' && message.authorType !== 'system' && message.content.trim()).map((message) => ({
      messageId: message.messageId, content: message.content, authorType: message.authorType as 'user' | 'partner', authorId: message.authorId, occurredAt: message.createdAt, hash: fallbackHash(message.content),
    })),
  })));
}
