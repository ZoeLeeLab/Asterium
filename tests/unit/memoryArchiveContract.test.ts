import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_WEIGHT,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  assertMemoryArchiveRecords,
  assertMemoryRecord,
  assertMemorySources,
  isMemoryRecord,
  memorySourceKey,
  memoryWeightOrDefault,
  type MemoryRecord,
  type MemorySourceAnchor,
} from '../../src/shared/memoryArchive';

const NOW = '2026-10-18T00:00:00.000Z';

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    schemaVersion: 1,
    memoryId: 'memory-1',
    partnerId: 'partner-1',
    type: 'stable_fact',
    status: 'active',
    body: '用户喜欢把复杂工作拆成可验收的小阶段。',
    tags: ['协作'],
    weight: DEFAULT_MEMORY_WEIGHT,
    createdAt: NOW,
    updatedAt: NOW,
    comments: [],
    sources: [],
    ...overrides,
  };
}

describe('memory archive contract', () => {
  it('accepts every agreed memory type and lifecycle status', () => {
    for (const type of MEMORY_TYPES) expect(isMemoryRecord(record({ type }))).toBe(true);
    for (const status of MEMORY_STATUSES) {
      const supersededByMemoryId = status === 'superseded' ? 'memory-2' : undefined;
      expect(isMemoryRecord(record({ status, supersededByMemoryId }))).toBe(true);
    }
  });

  it('defaults omitted creation weights to 3 and accepts the inclusive integer range', () => {
    expect(memoryWeightOrDefault()).toBe(3);
    expect(memoryWeightOrDefault(1)).toBe(1);
    expect(memoryWeightOrDefault(5)).toBe(5);
  });

  it.each([0, 6, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid weight %s', (weight) => {
    expect(() => memoryWeightOrDefault(weight)).toThrowError('MEMORY_WEIGHT_INVALID');
    expect(isMemoryRecord({ ...record(), weight })).toBe(false);
  });

  it('requires persisted records to carry an explicit valid weight', () => {
    const withoutWeight = { ...record() } as Partial<MemoryRecord>;
    delete withoutWeight.weight;
    expect(() => assertMemoryRecord(withoutWeight)).toThrowError('MEMORY_RECORD_INVALID');
  });

  it('accepts zero or multiple mixed source anchors in stable order', () => {
    const sources: MemorySourceAnchor[] = [
      { kind: 'single_chat', conversationId: 'conversation-1', messageId: 'message-1' },
      { kind: 'studio', roomId: 'room-1', messageId: 'message-2' },
    ];

    expect(() => assertMemorySources([])).not.toThrow();
    expect(() => assertMemorySources(sources)).not.toThrow();
    expect(record({ sources }).sources).toEqual(sources);
  });

  it('accepts an enriched immutable source excerpt while preserving legacy ID-only anchors', () => {
    const contentHash = 'a'.repeat(64);
    const source: MemorySourceAnchor = {
      kind: 'single_chat',
      conversationId: 'conversation-1',
      messageId: 'message-2',
      contentHash,
      frozenExcerpt: {
        capturedAt: NOW,
        messages: [
          { messageId: 'message-1', authorType: 'partner', authorId: 'partner-1', content: '前文', createdAt: NOW, contentHash: 'b'.repeat(64), offset: -1 },
          { messageId: 'message-2', authorType: 'user', authorId: 'user', content: '目标', createdAt: NOW, contentHash, offset: 0 },
        ],
      },
    };

    expect(() => assertMemorySources([source])).not.toThrow();
    expect(() => assertMemorySources([{ kind: 'studio', roomId: 'room-1', messageId: 'legacy-message' }])).not.toThrow();
  });

  it('rejects incomplete or inconsistent frozen source evidence', () => {
    const contentHash = 'a'.repeat(64);
    const base = { kind: 'single_chat', conversationId: 'conversation-1', messageId: 'message-1' } as const;
    expect(() => assertMemorySources([{ ...base, contentHash }])).toThrowError('MEMORY_SOURCES_INVALID');
    expect(() => assertMemorySources([{
      ...base,
      contentHash,
      frozenExcerpt: {
        capturedAt: NOW,
        messages: [{ messageId: 'other-message', authorType: 'user', authorId: 'user', content: '目标', createdAt: NOW, contentHash, offset: 0 }],
      },
    }])).toThrowError('MEMORY_SOURCES_INVALID');
  });

  it('rejects duplicate single-chat and Studio anchors', () => {
    const single = { kind: 'single_chat', conversationId: 'conversation-1', messageId: 'message-1' } as const;
    const studio = { kind: 'studio', roomId: 'room-1', messageId: 'message-1' } as const;

    expect(() => assertMemorySources([single, { ...single }])).toThrowError('MEMORY_SOURCE_DUPLICATE');
    expect(() => assertMemorySources([studio, { ...studio }])).toThrowError('MEMORY_SOURCE_DUPLICATE');
  });

  it('does not conflate matching message IDs across containers or surfaces', () => {
    const sources: MemorySourceAnchor[] = [
      { kind: 'single_chat', conversationId: 'conversation-1', messageId: 'shared-message' },
      { kind: 'single_chat', conversationId: 'conversation-2', messageId: 'shared-message' },
      { kind: 'studio', roomId: 'room-1', messageId: 'shared-message' },
      { kind: 'studio', roomId: 'room-2', messageId: 'shared-message' },
    ];

    expect(new Set(sources.map(memorySourceKey)).size).toBe(sources.length);
    expect(() => assertMemorySources(sources)).not.toThrow();
  });

  it('builds collision-safe source keys even when IDs contain separators', () => {
    const first: MemorySourceAnchor = { kind: 'single_chat', conversationId: 'a', messageId: 'b\u0000c' };
    const second: MemorySourceAnchor = { kind: 'single_chat', conversationId: 'a\u0000b', messageId: 'c' };

    expect(memorySourceKey(first)).not.toBe(memorySourceKey(second));
    expect(() => assertMemorySources([first, second])).not.toThrow();
  });

  it('keeps soft deletion separate from the business lifecycle status', () => {
    expect(isMemoryRecord(record({ status: 'obsolete', deletedAt: '2026-10-19T00:00:00.000Z' }))).toBe(true);
  });

  it('requires superseded records to point at another record', () => {
    expect(() => assertMemoryRecord(record({ status: 'superseded' }))).toThrowError('MEMORY_SUPERSESSION_INVALID');
    expect(() => assertMemoryRecord(record({ status: 'superseded', supersededByMemoryId: 'memory-1' }))).toThrowError('MEMORY_SUPERSESSION_INVALID');
    expect(() => assertMemoryRecord(record({ status: 'active', supersededByMemoryId: 'memory-2' }))).toThrowError('MEMORY_SUPERSESSION_INVALID');
  });

  it('validates archive ownership, unique IDs, and replacement targets', () => {
    const replacement = record({ memoryId: 'memory-2', body: '更新后的事实。' });
    const superseded = record({ status: 'superseded', supersededByMemoryId: replacement.memoryId });

    expect(() => assertMemoryArchiveRecords([superseded, replacement], 'partner-1')).not.toThrow();
    expect(() => assertMemoryArchiveRecords([record({ partnerId: 'partner-2' })], 'partner-1')).toThrowError('MEMORY_ARCHIVE_INVALID');
    expect(() => assertMemoryArchiveRecords([record(), record()], 'partner-1')).toThrowError('MEMORY_ARCHIVE_INVALID');
    expect(() => assertMemoryArchiveRecords([superseded], 'partner-1')).toThrowError('MEMORY_SUPERSESSION_INVALID');
  });

  it('rejects supersession cycles', () => {
    const first = record({ memoryId: 'memory-1', status: 'superseded', supersededByMemoryId: 'memory-2' });
    const second = record({ memoryId: 'memory-2', status: 'superseded', supersededByMemoryId: 'memory-1' });

    expect(() => assertMemoryArchiveRecords([first, second], 'partner-1')).toThrowError('MEMORY_SUPERSESSION_INVALID');
  });

  it('rejects duplicate tags and comments without mutating the record', () => {
    const duplicateTags = record({ tags: ['协作', '协作'] });
    const duplicateComments = record({
      comments: [
        { commentId: 'comment-1', content: '第一次补充。', createdAt: NOW },
        { commentId: 'comment-1', content: '第二次补充。', createdAt: NOW },
      ],
    });

    expect(isMemoryRecord(duplicateTags)).toBe(false);
    expect(isMemoryRecord(duplicateComments)).toBe(false);
    expect(duplicateTags.tags).toEqual(['协作', '协作']);
  });
});
