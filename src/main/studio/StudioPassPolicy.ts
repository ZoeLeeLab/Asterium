import type { StudioRoomMessage, StudioRoomSettings, StudioRound } from '../../shared/studioRuntime';

export type StudioPassPolicy =
  | { allowed: true; reason: 'unmentioned_free_discussion' }
  | { allowed: false; reason: 'explicit_mention' | 'required_speaking_mode' };

export function studioPassPolicy(input: {
  settings: StudioRoomSettings;
  messages: StudioRoomMessage[];
  round: StudioRound;
  partnerId: string;
}): StudioPassPolicy {
  if (input.settings.speakingMode !== 'free_discussion') {
    return { allowed: false, reason: 'required_speaking_mode' };
  }
  const trigger = input.messages.find((message) => message.messageId === input.round.triggerMessageId);
  const mentionedByUser = trigger?.mentions?.some((mention) => mention.partnerId === input.partnerId) ?? false;
  const mentionedByPartner = input.round.members.some((member) => member.mentions?.some((mention) => mention.partnerId === input.partnerId));
  return mentionedByUser || mentionedByPartner
    ? { allowed: false, reason: 'explicit_mention' }
    : { allowed: true, reason: 'unmentioned_free_discussion' };
}
