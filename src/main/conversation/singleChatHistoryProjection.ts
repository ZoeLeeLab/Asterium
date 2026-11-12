import { isAsteriumUser } from '../../shared/identity';
import type { SingleChatConversationSnapshot, SingleChatIndexedMessage } from '../../shared/singleChatMessages';
import type { SingleChatProfile } from '../../shared/singleChatHistory';
import type { Conversation, Message } from '../../renderer/types/domain';

export function projectSingleChat(conversation: Conversation, profile: SingleChatProfile, busy: boolean): SingleChatConversationSnapshot {
  const partner = profile.partners.find(candidate => candidate.id === conversation.partnerId);
  return {
    conversationId: conversation.id, partnerId: conversation.partnerId, title: conversation.title, busy,
    sessionId: conversation.sessionId, partnerRootGrantId: conversation.partnerRootGrantId,
    permissionMode: conversation.permissionMode ?? partner?.defaultPermissionMode ?? 'manual',
    planMode: conversation.planMode ?? 'default', planStatus: conversation.planStatus,
    isArchived: Boolean(conversation.isArchived), isDisabled: Boolean(conversation.isDisabled),
    apiSessionHistoryEnabled: partner?.sourceMode === 'api_partner' ? Boolean(partner.apiSessionHistoryEnabled) : undefined,
    messages: conversation.messages.filter(message => !isPendingAssistant(message)).map(message => ({
      messageId: message.id, automationRunId: message.automation?.runId,
      authorType: isAsteriumUser(message.authorId) ? 'user' : 'partner', authorId: message.authorId,
      content: message.content, createdAt: message.createdAt, occurredAt: message.occurredAt, completedAt: message.completedAt,
      fallbackEligible: !message.error && (!message.runState || message.runState === 'completed') && (!message.status || message.status === 'delivered'),
    })),
  };
}

function isPendingAssistant(message: Message) {
  return message.runState === 'running' || message.runState === 'waiting_authorization' || message.runState === 'waiting_user_input';
}

export function fromIndexedMessage(message: SingleChatIndexedMessage): Message {
  return {
    id: message.messageId, authorId: message.authorId, content: message.content, createdAt: message.createdAt,
    occurredAt: message.occurredAt, completedAt: message.completedAt,
    ...(message.automationRunId ? { automation: { automationId: '', runId: message.automationRunId, name: '自动化' } } : {}),
    ...(message.fallbackEligible === false ? { status: 'failed' as const } : { status: 'delivered' as const }),
  };
}

export function mergeLegacySingleChats(conversations: Conversation[], projections: SingleChatConversationSnapshot[]): Conversation[] {
  const indexed = new Map(projections.map(conversation => [conversation.conversationId, conversation]));
  const merged = conversations.map(conversation => {
    const projection = indexed.get(conversation.id);
    indexed.delete(conversation.id);
    if (!projection || projection.partnerId !== conversation.partnerId) return conversation;
    const remaining = new Map(projection.messages.map(message => [message.messageId, message]));
    const messages = conversation.messages.map(message => {
      const projected = remaining.get(message.id);
      remaining.delete(message.id);
      if (!projected) return message;
      const supplemental = fromIndexedMessage(projected);
      const recovered = projected.completedAt && projected.content.length > message.content.length
        && projected.content.startsWith(message.content);
      return {
        ...message,
        ...(recovered ? { content: projected.content, completedAt: projected.completedAt,
          timeline: message.timeline?.length ? [...message.timeline, {
            id: 'legacy-recovery:' + message.id, sequence: (message.timeline.at(-1)?.sequence ?? 0) + 1,
            kind: 'text' as const, text: projected.content.slice(message.content.length),
          }] : message.timeline } : {}),
        ...(!message.automation && supplemental.automation ? { automation: supplemental.automation } : {}),
      };
    });
    const before = new Map<string, Message[]>();
    let pending: Message[] = [];
    for (const projected of projection.messages) {
      if (remaining.has(projected.messageId)) pending.push(fromIndexedMessage(projected));
      else if (pending.length) {
        before.set(projected.messageId, pending);
        pending = [];
      }
    }
    return {
      ...conversation, sessionId: conversation.sessionId ?? projection.sessionId,
      messages: [...messages.flatMap(message => [...(before.get(message.id) ?? []), message]), ...pending],
    };
  });
  for (const item of indexed.values()) {
    const last = item.messages.at(-1);
    merged.push({
      id: item.conversationId, partnerId: item.partnerId, title: item.title ?? '历史单聊',
      sessionId: item.sessionId, partnerRootGrantId: item.partnerRootGrantId, permissionMode: item.permissionMode,
      planMode: item.planMode, planStatus: item.planStatus, isArchived: item.isArchived, isDisabled: item.isDisabled,
      updatedAt: last?.completedAt ?? last?.occurredAt ?? '1970-01-01T00:00:00.000Z',
      messages: item.messages.map(fromIndexedMessage),
    });
  }
  return merged;
}
