import { expect, it, vi } from 'vitest';
import { ContextHandoffService } from '../../src/main/runtime/ContextHandoffService';
import type { StudioRoomSnapshot } from '../../src/shared/studioRuntime';

const date = '2026-11-03T00:00:00.000Z';

it('reads only selected original text, in source order, for the same partner', async () => {
  const room: StudioRoomSnapshot = {
    metadata: { roomId: 'group', name: '测试群', projectId: 'project', memberIds: ['p'] },
    messages: ['原话一', '不带过去', '原话二\n第二行'].map((content, seq) => ({
      roomId: 'group', messageId: String(seq), seq, roundId: 'round', authorType: 'partner', authorId: 'p',
      content, createdAt: date, status: 'completed',
    })),
    cursors: [], mutedPartnerIds: [], settings: { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false },
    rotationOffset: 0, models: {},
  };
  const service = new ContextHandoffService({ getConversation: vi.fn(async () => ({ conversationId: 'single', partnerId: 'p', messages: [] })) },
    { getRoom: vi.fn(async () => room) }, () => true, () => '示例伙伴甲');
  const route = { source: { kind: 'group' as const, id: 'group' }, target: { kind: 'single' as const, id: 'single' }, partnerId: 'p' };
  const draft = { ...route, id: '00000002-0000-4000-8000-000000000004', messageIds: ['2', '0'] };
  await expect(service.validate(draft, route.target, 'p')).resolves.toEqual({ ...draft, text: '示例伙伴甲：原话一\n\n示例伙伴甲：原话二\n第二行' });
  await expect(service.validate({ ...draft, messageIds: ['missing'] }, route.target)).rejects.toThrow('HANDOFF_SOURCE_UNAVAILABLE');
  await expect(service.validate({ ...draft, messageIds: ['0', '0'] }, route.target)).rejects.toThrow('HANDOFF_SOURCE_UNAVAILABLE');
  await expect(service.validate(draft, { ...route.target, id: 'other' }, 'p')).rejects.toThrow('HANDOFF_SCOPE_UNAVAILABLE');
  await expect(service.validate({ ...draft, partnerId: 'q' }, route.target)).rejects.toThrow('HANDOFF_SCOPE_UNAVAILABLE');
});
