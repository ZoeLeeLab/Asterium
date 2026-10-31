import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMemoryArchiveStore } from '../../src/main/memory/SqliteMemoryArchiveStore';
import { PartnerMemoryBriefingService, generatePartnerMemoryBriefing } from '../../src/main/memory/PartnerMemoryBriefingService';
import { PartnerMemoryService } from '../../src/main/memory/PartnerMemoryService';
import type { MemoryRecord } from '../../src/shared/memoryArchive';

const temporaryDirectories: string[] = [];
const PARTNER_ID = 'partner-1';
const NOW = '2026-10-18T04:00:00.000Z';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function record(memoryId: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    schemaVersion: 1,
    memoryId,
    partnerId: PARTNER_ID,
    type: 'stable_fact',
    status: 'active',
    body: `正文 ${memoryId}`,
    tags: [],
    weight: 3,
    createdAt: NOW,
    updatedAt: NOW,
    comments: [],
    sources: [],
    ...overrides,
  };
}

async function fixture(now = NOW) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-memory-briefing-'));
  temporaryDirectories.push(root);
  const archiveDirectory = path.join(root, 'archive-v1');
  const profiles = { withManagedMemoryStorage: async <T>(_id: string, operation: (directory: string) => Promise<T>) => operation(archiveDirectory) };
  const memories = new PartnerMemoryService(profiles);
  const service = new PartnerMemoryBriefingService(memories, { now: () => new Date(now) });
  return { archiveDirectory, memories, service };
}

describe('deterministic partner memory briefing', () => {
  it('prioritizes self-awareness and relationship before temporal and durable sections', () => {
    const content = generatePartnerMemoryBriefing([
      record('today', { body: '今天事项', occurredAt: NOW, weight: 5 }),
      record('relationship', { type: 'relationship_with_user', body: '关系认识', weight: 1 }),
      record('self', { type: 'self_summary', body: '自我认识', weight: 1 }),
      record('open', { type: 'open_question_and_follow_up', body: '未闭合事项' }),
    ], '2026-10-18');

    expect(content.indexOf('## 自我认知')).toBeLessThan(content.indexOf('## 与用户的关系'));
    expect(content.indexOf('## 与用户的关系')).toBeLessThan(content.indexOf('## 今天发生的事情'));
    expect(content).toContain('自我认识');
    expect(content).toContain('关系认识');
    expect(content).toContain('今天事项');
    expect(content).toContain('未闭合事项');
  });

  it('uses explicit occurrence time for recent sections and omits replaced, obsolete, deleted, and closed old items', () => {
    const content = generatePartnerMemoryBriefing([
      record('recent', { body: '最近事项', occurredAt: '2026-10-15T04:00:00.000Z' }),
      record('old-stable', { body: '长期事实', occurredAt: '2026-09-01T04:00:00.000Z' }),
      record('closed-old', { type: 'open_question_and_follow_up', status: 'completed', body: '很早已完成' }),
      record('obsolete', { status: 'obsolete', body: '过时内容' }),
      record('superseded', { status: 'superseded', supersededByMemoryId: 'old-stable', body: '被取代内容' }),
      record('deleted', { body: '软删除内容', deletedAt: NOW }),
    ], '2026-10-18');

    expect(content).toContain('最近事项');
    expect(content).toContain('长期事实');
    expect(content).not.toContain('很早已完成');
    expect(content).not.toContain('过时内容');
    expect(content).not.toContain('被取代内容');
    expect(content).not.toContain('软删除内容');
  });
});

describe('PartnerMemoryBriefingService cache', () => {
  it('reuses the cache while archive version and local logical date are unchanged', async () => {
    const value = await fixture();
    await value.memories.create(PARTNER_ID, record('memory-1'));

    const first = await value.service.get(PARTNER_ID);
    const second = await value.service.get(PARTNER_ID);
    expect(second).toEqual(first);
    expect(await value.memories.cachedBriefing(PARTNER_ID)).toEqual(first);
  });

  it('invalidates on archive changes and local logical-date changes', async () => {
    const value = await fixture();
    await value.memories.create(PARTNER_ID, record('memory-1'));
    const first = await value.service.get(PARTNER_ID);

    await value.memories.create(PARTNER_ID, record('memory-2', { body: '新增档案' }));
    const changedArchive = await value.service.get(PARTNER_ID);
    expect(changedArchive.archiveVersion).not.toBe(first.archiveVersion);
    expect(changedArchive.content).toContain('新增档案');

    const nextDay = new PartnerMemoryBriefingService(value.memories, { now: () => new Date('2026-10-19T04:00:00.000Z') });
    const changedDate = await nextDay.get(PARTNER_ID);
    expect(changedDate.logicalDate).not.toBe(changedArchive.logicalDate);
    expect(changedDate.archiveVersion).toBe(changedArchive.archiveVersion);
    expect(changedDate.generatedAt).not.toBe(changedArchive.generatedAt);
  });

  it('rebuilds an invalid cache without reading conversation messages', async () => {
    const value = await fixture();
    const archive = new SqliteMemoryArchiveStore(path.join(value.archiveDirectory, 'memory.sqlite'), PARTNER_ID);
    await archive.create(record('memory-1', { body: '只来自结构化档案' }));
    const db = new DatabaseSync(path.join(value.archiveDirectory, 'memory.sqlite'));
    db.exec("INSERT INTO briefing_cache VALUES (1, '{}')"); db.close();
    const rebuilt = await value.service.get(PARTNER_ID);
    expect(rebuilt.content).toContain('只来自结构化档案');
  });
});
