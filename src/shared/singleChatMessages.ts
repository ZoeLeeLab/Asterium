import type { PermissionMode, PlanMode } from './agentProtocol';

export interface SingleChatIndexedMessage {
  messageId: string;
  automationRunId?: string;
  authorType: 'user' | 'partner';
  authorId: string;
  content: string;
  createdAt: string;
  /** Real event time; absent on legacy messages whose date is unknown. */
  occurredAt?: string;
  completedAt?: string;
  fallbackEligible?: boolean;
}

export interface SingleChatConversationSnapshot {
  conversationId: string;
  partnerId: string;
  messages: SingleChatIndexedMessage[];
  busy?: boolean;
  title?: string;
  sessionId?: string;
  partnerRootGrantId?: string;
  permissionMode?: PermissionMode;
  planMode?: PlanMode;
  planStatus?: 'planning' | 'waiting_user' | 'ready' | 'executing' | 'completed';
  apiSessionHistoryEnabled?: boolean;
  isArchived?: boolean;
  isDisabled?: boolean;
}

export function assertSingleChatConversationSnapshots(value: unknown): asserts value is SingleChatConversationSnapshot[] {
  if (!Array.isArray(value)) throw new Error('SINGLE_CHAT_MESSAGE_INDEX_INVALID');
  const conversations = new Set<string>();
  for (const conversation of value) {
    if (!isRecord(conversation) || !hasText(conversation.conversationId) || !hasText(conversation.partnerId)
      || conversations.has(conversation.conversationId) || !Array.isArray(conversation.messages)
      || (conversation.busy !== undefined && typeof conversation.busy !== 'boolean')
      || (conversation.title !== undefined && typeof conversation.title !== 'string')
      || (conversation.sessionId !== undefined && !hasText(conversation.sessionId))
      || (conversation.permissionMode !== undefined && !['read_only', 'manual', 'automatic', 'full'].includes(String(conversation.permissionMode)))
      || (conversation.planStatus !== undefined && !['planning', 'waiting_user', 'ready', 'executing', 'completed'].includes(String(conversation.planStatus)))
      || (conversation.planMode !== undefined && !['default', 'plan'].includes(String(conversation.planMode)))
      || (conversation.apiSessionHistoryEnabled !== undefined && typeof conversation.apiSessionHistoryEnabled !== 'boolean')
      || (conversation.isArchived !== undefined && typeof conversation.isArchived !== 'boolean')
      || (conversation.isDisabled !== undefined && typeof conversation.isDisabled !== 'boolean')) throw new Error('SINGLE_CHAT_MESSAGE_INDEX_INVALID');
    conversations.add(conversation.conversationId);
    const messages = new Set<string>();
    for (const message of conversation.messages) {
      if (!isRecord(message) || !hasText(message.messageId) || messages.has(message.messageId)
        || !['user', 'partner'].includes(String(message.authorType)) || !hasText(message.authorId)
        || typeof message.content !== 'string' || !hasText(message.createdAt)
        || (message.occurredAt !== undefined && !isMessageTimestamp(message.occurredAt))
        || (message.completedAt !== undefined && !isMessageTimestamp(message.completedAt))
        || (message.fallbackEligible !== undefined && typeof message.fallbackEligible !== 'boolean')) throw new Error('SINGLE_CHAT_MESSAGE_INDEX_INVALID');
      messages.add(message.messageId);
    }
  }
}

export function isMessageTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
