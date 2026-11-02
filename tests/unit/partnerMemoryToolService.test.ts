import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySourceService } from '../../src/main/memory/MemorySourceService';
import { PartnerMemoryService } from '../../src/main/memory/PartnerMemoryService';
import { PartnerMemoryToolService } from '../../src/main/memory/PartnerMemoryToolService';

const NOW = '2026-10-18T00:00:00.000Z';
const LATER = '2026-10-19T00:00:00.000Z';
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-memory-tools-'));
  temporary.push(directory);
  let now = NOW;
  let id = 0;
  const memories = new PartnerMemoryService({ withManagedMemoryStorage: async (partnerId, operation) => {
    if (partnerId !== 'partner-1') throw new Error('PARTNER_MEMORY_NOT_MANAGED');
    return operation(directory);
  } }, { now: () => now, createCommentId: () => 'comment-1' });
  const sourceMessages = [
    { messageId: 'message-1', authorType: 'partner' as const, authorId: 'partner-1', content: '前文', createdAt: '10:00' },
    { messageId: 'message-2', authorType: 'user' as const, authorId: 'user', content: '本轮证据', createdAt: '10:01' },
  ];
  const sources = new MemorySourceService({ getWindow: async () => ({ partnerId: 'partner-1', targetIndex: 1, messages: sourceMessages }) }, { getRoom: async () => undefined }, () => now);
  const tools = new PartnerMemoryToolService(memories, sources, () => now, () => `memory-${++id}`);
  return { memories, tools, setNow: (value: string) => { now = value; } };
}

const context = { partnerId: 'partner-1', currentSource: { kind: 'single_chat' as const, conversationId: 'conversation-1', messageId: 'message-2' } };

describe('PartnerMemoryToolService', () => {
  it('holds a normalized memory with default weight and the automatic current source', async () => {
    const value = await setup();
    const record = await value.tools.hold(context, { type: 'stable_fact', body: '  用户偏好分阶段验收。  ', tags: ['协作'] });
    expect(record).toMatchObject({ memoryId: 'memory-1', partnerId: 'partner-1', body: '用户偏好分阶段验收。', weight: 3, status: 'active' });
    expect(record.sources).toHaveLength(1);
    expect(record.sources[0]).toMatchObject({ messageId: 'message-2', contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('searches deterministically by text, tags, type, time, status, weight, and limit', async () => {
    const value = await setup();
    await value.tools.hold({ partnerId: 'partner-1' }, { type: 'stable_fact', body: '旧事实', tags: ['用户'], weight: 2, occurredAt: NOW });
    value.setNow(LATER);
    await value.tools.hold({ partnerId: 'partner-1' }, { type: 'relationship_with_user', body: '一起协作', tags: ['用户', '协作'], weight: 5, occurredAt: LATER });
    await expect(value.tools.search(context, { text: '协作', tags: ['用户'], types: ['relationship_with_user'], statuses: ['active'], from: NOW, to: LATER, limit: 1 }))
      .resolves.toMatchObject([{ memoryId: 'memory-2', weight: 5 }]);
  });

  it('comments with new evidence while preserving the original body and avoiding an automatic duplicate source', async () => {
    const value = await setup();
    const held = await value.tools.hold(context, { type: 'stable_fact', body: '原始正文' });
    value.setNow(LATER);
    const commented = await value.tools.comment(context, { memoryId: held.memoryId, content: '后续证据' });
    expect(commented.body).toBe('原始正文');
    expect(commented.comments).toEqual([{ commentId: 'comment-1', content: '后续证据', createdAt: LATER }]);
    expect(commented.sources).toHaveLength(1);
  });

  it('updates lifecycle fields including supersession without binding the current message', async () => {
    const value = await setup();
    const first = await value.tools.hold({ partnerId: 'partner-1' }, { type: 'stable_fact', body: '旧信息' });
    const replacement = await value.tools.hold({ partnerId: 'partner-1' }, { type: 'stable_fact', body: '新信息' });
    const updated = await value.tools.update(context, { memoryId: first.memoryId, status: 'superseded', supersededByMemoryId: replacement.memoryId, weight: 1, tags: ['历史'] });
    expect(updated).toMatchObject({ status: 'superseded', supersededByMemoryId: replacement.memoryId, weight: 1, tags: ['历史'] });
    expect(updated.sources).toEqual([]);
  });

  it('reads every source or one indexed source through the fallback-aware resolver', async () => {
    const value = await setup();
    const held = await value.tools.hold(context, { type: 'stable_fact', body: '带来源' });
    await expect(value.tools.readSource(context, { memoryId: held.memoryId })).resolves.toMatchObject([{ index: 0, result: { state: 'live' } }]);
    await expect(value.tools.readSource(context, { memoryId: held.memoryId, sourceIndex: 1 })).rejects.toThrow('MEMORY_SOURCE_INDEX_INVALID');
  });

  it('inherits the managed-memory gate and rejects malformed inputs before writing', async () => {
    const value = await setup();
    await expect(value.tools.search({ partnerId: 'partner-2' }, {})).rejects.toThrow('PARTNER_MEMORY_NOT_MANAGED');
    await expect(value.tools.hold(context, { type: 'stable_fact', body: 'x', weight: 6 })).rejects.toThrow('MEMORY_WEIGHT_INVALID');
    await expect(value.memories.list('partner-1')).resolves.toEqual([]);
  });
});
