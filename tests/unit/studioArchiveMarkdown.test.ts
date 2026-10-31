import { describe, expect, it } from 'vitest';
import { formatStudioArchiveMarkdown } from '../../src/renderer/app/studioArchiveMarkdown';
import type { StudioRoomSnapshot } from '../../src/shared/studioRuntime';

describe('formatStudioArchiveMarkdown', () => {
  it('exports the complete public ledger with resolved user, partner, and system names', () => {
    const snapshot: StudioRoomSnapshot = {
      metadata: { roomId: 'room-1', projectId: 'deleted-project', name: '归档讨论', memberIds: ['partner-1'] },
      messages: [
        { roomId: 'room-1', messageId: 'm1', seq: 1, roundId: 'r1', authorType: 'user', authorId: 'user-1', content: '用户消息', createdAt: '2026-10-18T01:00:00.000Z', status: 'completed' },
        { roomId: 'room-1', messageId: 'm2', seq: 2, roundId: 'r1', authorType: 'partner', authorId: 'partner-1', content: '伙伴回复', createdAt: '2026-10-18T01:01:00.000Z', status: 'completed' },
        { roomId: 'room-1', messageId: 'm3', seq: 3, roundId: 'r1', authorType: 'system', authorId: 'system', content: '系统提示', createdAt: '2026-10-18T01:02:00.000Z', status: 'completed' },
      ],
      cursors: [], mutedPartnerIds: [], settings: { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: true },
      rotationOffset: 0, models: {},
    };

    const markdown = formatStudioArchiveMarkdown(snapshot, {
      userId: 'user-1', userName: '用户', partners: [{ id: 'partner-1', name: '测试助手' }],
    });

    expect(markdown).toContain('# 归档讨论');
    expect(markdown).toContain('### 用户 ·');
    expect(markdown).toContain('用户消息');
    expect(markdown).toContain('### 测试助手 ·');
    expect(markdown).toContain('伙伴回复');
    expect(markdown).toContain('### 系统 ·');
    expect(markdown).toContain('系统提示');
  });

  it('produces a readable document for an empty archived room', () => {
    const snapshot: StudioRoomSnapshot = {
      metadata: { roomId: 'empty', projectId: 'project', name: '空群聊', memberIds: [] },
      messages: [], cursors: [], mutedPartnerIds: [],
      settings: { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false },
      rotationOffset: 0, models: {},
    };
    expect(formatStudioArchiveMarkdown(snapshot, { userId: 'user', userName: '用户', partners: [] }))
      .toContain('_此群聊没有消息。_');
  });
});
