import type { Conversation, Message, PrototypeState } from '../renderer/types/domain';

export type SingleChatMetadata = Omit<Conversation, 'messages'>;
export type SingleChatProfile = Omit<PrototypeState, 'conversations'>;

export interface SingleChatHistorySnapshot {
  generation: string;
  profile: SingleChatProfile;
  conversations: Conversation[];
  interruptedConversationIds?: string[];
}

export interface SingleChatHistoryImport {
  profile: SingleChatProfile;
  conversations: Conversation[];
}

export interface SingleChatHistoryChange {
  conversationId: string;
  metadata?: SingleChatMetadata;
  metadataOnCreateOnly?: boolean;
  upsert: Message[];
  remove: string[];
  busy?: boolean;
  order?: string[];
}

export interface SingleChatHistoryWrite {
  generation: string;
  profile?: SingleChatProfile;
  changes: SingleChatHistoryChange[];
}
