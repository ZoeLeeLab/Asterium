import type { Conversation, Message, PrototypeState } from '../renderer/types/domain';

export type SingleChatMetadata = Omit<Conversation, 'messages'>;
export type SingleChatProfile = Omit<PrototypeState, 'conversations'>;

export interface SingleChatHistorySnapshot {
  generation: string;
  profile: SingleChatProfile;
  conversations: Conversation[];
  interruptedConversationIds?: string[];
  recentPages?: Record<string, SingleChatPageBounds>;
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

export const SINGLE_CHAT_PAGE_SIZE = 80;
export const SINGLE_CHAT_SEARCH_SIZE = 100;

export interface SingleChatPageBounds {
  hasOlder: boolean;
  hasNewer: boolean;
  turnOffset?: number;
}

export interface SingleChatPageRequest {
  conversationId: string;
  before?: string;
  after?: string;
  around?: string;
}

export interface SingleChatHistoryPage extends SingleChatPageBounds {
  messages: Message[];
  interrupted?: boolean;
}

export interface SingleChatSearchRequest {
  query: string;
  conversationId?: string;
  after?: string;
}

export interface SingleChatSearchResult {
  conversationIds: string[];
  messageIds: string[];
  hasMore: boolean;
}
