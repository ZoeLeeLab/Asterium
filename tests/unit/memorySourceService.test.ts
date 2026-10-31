import { describe, expect, it } from 'vitest';
import { MemorySourceService, memoryMessageContentHash } from '../../src/main/memory/MemorySourceService';
import type { StudioRoomSnapshot } from '../../src/shared/studioRuntime';

const NOW = '2026-10-18T00:00:00.000Z';

const single = {
  partnerId: 'partner-1',
  targetIndex: 2,
  messages: ['一', '二', '三', '四', '五'].map((content, index) => ({
    messageId: `single-${index + 1}`,
    authorType: index % 2 ? 'partner' as const : 'user' as const,
    authorId: index % 2 ? 'partner-1' : 'user',
    content,
    createdAt: `10:0${index}`,
  })),
};

function room(): StudioRoomSnapshot {
  return {
    metadata: { roomId: 'room-1', projectId: 'project-1', name: '讨论区', memberIds: ['partner-1'] },
    messages: ['甲', '乙', '丙', '丁'].map((content, index) => ({
      roomId: 'room-1', messageId: `studio-${index + 1}`, seq: index + 1, roundId: 'round-1',
      authorType: index % 2 ? 'partner' as const : 'user' as const,
      authorId: index % 2 ? 'partner-1' : 'user', content, createdAt: NOW, status: 'completed' as const,
    })),
    cursors: [], mutedPartnerIds: [], settings: { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: true }, rotationOffset: 0, models: {},
  };
}

describe('MemorySourceService', () => {
  it('captures exact UTF-8 hashes and at most two live messages on each side', async () => {
    const service = new MemorySourceService({ getWindow: async () => single }, { getRoom: async () => room() }, () => NOW);
    const captured = await service.capture('partner-1', { kind: 'single_chat', conversationId: 'conversation-1', messageId: 'single-3' });
    expect(captured.contentHash).toBe(memoryMessageContentHash('三'));
    expect(captured.frozenExcerpt?.messages.map((message) => message.offset)).toEqual([-2, -1, 0, 1, 2]);
    expect(await service.read('partner-1', captured)).toMatchObject({ state: 'live' });
  });

  it('uses Studio public sequence order and trims edge windows', async () => {
    const service = new MemorySourceService({ getWindow: async () => undefined }, { getRoom: async () => room() }, () => NOW);
    const captured = await service.capture('partner-1', { kind: 'studio', roomId: 'room-1', messageId: 'studio-1' });
    expect(captured.frozenExcerpt?.messages.map((message) => [message.messageId, message.offset])).toEqual([
      ['studio-1', 0], ['studio-2', 1], ['studio-3', 2],
    ]);
  });

  it('falls back to frozen evidence after deletion and detects same-ID content changes', async () => {
    let current = single;
    const service = new MemorySourceService({ getWindow: async () => current }, { getRoom: async () => undefined }, () => NOW);
    const captured = await service.capture('partner-1', { kind: 'single_chat', conversationId: 'conversation-1', messageId: 'single-3' });
    current = { ...single, messages: single.messages.map((message) => message.messageId === 'single-3' ? { ...message, content: '已编辑' } : message) };
    await expect(service.read('partner-1', captured)).resolves.toMatchObject({ state: 'changed', reason: 'content_changed' });
    const deleted = new MemorySourceService({ getWindow: async () => undefined }, { getRoom: async () => undefined }, () => NOW);
    await expect(deleted.read('partner-1', captured)).resolves.toMatchObject({ state: 'frozen', reason: 'source_missing' });
  });

  it('prevents capturing another partner single chat or an unrelated Studio room', async () => {
    const service = new MemorySourceService(
      { getWindow: async () => ({ ...single, partnerId: 'partner-2' }) },
      { getRoom: async () => ({ ...room(), metadata: { ...room().metadata, memberIds: ['partner-2'] } }) },
      () => NOW,
    );
    await expect(service.capture('partner-1', { kind: 'single_chat', conversationId: 'conversation-2', messageId: 'single-3' })).rejects.toThrow('MEMORY_SOURCE_ACCESS_DENIED');
    await expect(service.capture('partner-1', { kind: 'studio', roomId: 'room-1', messageId: 'studio-1' })).rejects.toThrow('MEMORY_SOURCE_ACCESS_DENIED');
  });

  it('keeps missing legacy anchors explicit instead of inventing fallback text', async () => {
    const service = new MemorySourceService({ getWindow: async () => undefined }, { getRoom: async () => undefined }, () => NOW);
    await expect(service.read('partner-1', { kind: 'studio', roomId: 'deleted', messageId: 'missing' }))
      .resolves.toMatchObject({ state: 'unavailable', messages: [], reason: 'legacy_source_missing' });
  });
});
