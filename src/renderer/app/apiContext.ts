import { trimChatHistory } from '../../shared/chatHistory';
import type { Message, Partner, UserProfile } from '../types/domain';
import { isAsteriumUser } from '../../shared/identity';
import { messageTextForRuntime } from './messageQuote';

export function apiHistory(messages: Message[]) {
  const candidates = messages.filter((message) => message.authorId !== 'system' && (Boolean(message.content.trim()) || Boolean(message.attachments?.length)))
    .map((message) => ({
      role: isAsteriumUser(message.authorId) ? 'user' as const : 'assistant' as const,
      content: message.attachments?.length
        ? `${messageTextForRuntime(message)}${message.content || message.quote ? '\n\n' : ''}[用户附件]\n${message.attachments.map((item) => `- ${item.name} (${item.mediaType}, ${item.sizeBytes} bytes), attachment_id: ${item.id}`).join('\n')}`
        : messageTextForRuntime(message),
    }));
  return trimChatHistory(candidates);
}

export function sharesUserProfile(partner: Pick<Partner, 'sourceMode' | 'profileManagement'>) {
  return partner.profileManagement?.userProfile ?? partner.sourceMode === 'api_partner';
}

export function userProfileContext(profile: UserProfile, partner: Pick<Partner, 'sourceMode' | 'profileManagement'>) {
  if (!sharesUserProfile(partner)) return '';
  const lines = [`用户姓名：${profile.displayName.trim() || '用户'}`];
  if (profile.introduction.trim()) lines.push(`用户个人介绍：\n${profile.introduction.trim()}`);
  return lines.join('\n');
}

export function withUserProfile(content: string, profileContext: string) {
  return profileContext
    ? `[星丛提供的当前用户资料]\n${profileContext}\n\n[用户本轮消息]\n${content}`
    : content;
}

export function apiSystemPrompt(profileContext = '', partnerName = '') {
  return [
    partnerName.trim() ? `你在星丛中的名字：${partnerName.trim()}` : '',
    profileContext ? `关于当前用户：\n${profileContext}` : '',
  ].filter(Boolean).join('\n\n');
}
