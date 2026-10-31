import { describe, expect, it } from 'vitest';
import { studioPassPolicy } from '../../src/main/studio/StudioPassPolicy';
import type { StudioRoomMessage, StudioRoomSettings, StudioRound } from '../../src/shared/studioRuntime';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';

const createdAt = '2026-10-14T00:00:00.000Z';

function policy(settings: StudioRoomSettings, options: { userMention?: boolean; partnerMention?: boolean } = {}) {
  const message: StudioRoomMessage = {
    roomId: 'room-one', messageId: 'message-one', seq: 1, roundId: 'round-one', authorType: 'user', authorId: ASTERIUM_USER_ID,
    content: '请回复', createdAt, status: 'completed',
    ...(options.userMention ? { mentions: [{ partnerId: 'partner-one', label: '伙伴', source: 'user' as const }] } : {}),
  };
  const round: StudioRound = {
    roomId: 'room-one', roundId: 'round-one', triggerMessageId: 'message-one', speakerQueue: ['partner-one'],
    members: [
      { turnId: 'turn-one', partnerId: 'partner-one', state: 'running' },
      ...(options.partnerMention ? [{ turnId: 'turn-other', partnerId: 'partner-other', state: 'completed' as const, mentions: [{ partnerId: 'partner-one', label: '伙伴', source: 'partner' as const }] }] : []),
    ],
    state: 'running', participantIds: ['partner-one'], permissionMode: 'manual', createdAt, updatedAt: createdAt,
  };
  return studioPassPolicy({ settings, messages: [message], round, partnerId: 'partner-one' });
}

describe('Studio pass policy', () => {
  it('allows pass only for unmentioned free discussion turns', () => {
    const free = { speakingMode: 'free_discussion' as const, selectedPartnerIds: [], discussionProtectionEnabled: false };
    expect(policy(free)).toEqual({ allowed: true, reason: 'unmentioned_free_discussion' });
    expect(policy(free, { userMention: true })).toEqual({ allowed: false, reason: 'explicit_mention' });
    expect(policy(free, { partnerMention: true })).toEqual({ allowed: false, reason: 'explicit_mention' });
  });

  it.each(['round_robin', 'selected_partners'] as const)('requires visible replies in %s mode', (speakingMode) => {
    expect(policy({ speakingMode, selectedPartnerIds: [], discussionProtectionEnabled: false })).toEqual({ allowed: false, reason: 'required_speaking_mode' });
  });
});
