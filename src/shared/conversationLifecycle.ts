import type { ConnectionSource } from './agentProtocol';

export interface ConversationDeleteRequest {
  conversationId: string;
  partnerId: string;
  source: ConnectionSource;
}

export interface ConversationDeleteResult {
  conversationId: string;
  cleanupPending: boolean;
}
