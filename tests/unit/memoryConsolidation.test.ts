import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PartnerMemoryService } from '../../src/main/memory/PartnerMemoryService';
import { SqliteMemoryArchiveStore } from '../../src/main/memory/SqliteMemoryArchiveStore';
import { MemorySourceService } from '../../src/main/memory/MemorySourceService';
import { SingleChatMessageStore } from '../../src/main/conversation/SingleChatMessageStore';
import { MemoryConsolidation, fallbackBatch } from '../../src/main/memory/fallback/MemoryConsolidation';
import { fallbackHash, type FallbackJob } from '../../src/main/memory/fallback/MemoryFallbackJobStore';
import type { ApiProviderAdapter, ApiProviderRequest } from '../../src/main/api/ApiProviderAdapter';
import { DeepSeekProviderAdapter } from '../../src/main/adapters/DeepSeekProviderAdapter';
import type { MemoryRecord } from '../../src/shared/memoryArchive';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const now = '2026-10-21T00:00:00.000Z';
const record = (body = 'old'): MemoryRecord => ({ schemaVersion: 1, memoryId: 'old', partnerId: 'p', type: 'stable_fact', status: 'active', body, tags: [], weight: 3, createdAt: now, updatedAt: now, comments: [], sources: [] });
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-consolidate-')); directories.push(dir);
  const singles = new SingleChatMessageStore(path.join(dir, 'messages.json'));
  const messages = [0, 1, 2, 3, 4].map((index) => ({ messageId: `m${index}`, content: `message ${index}`, authorId: 'u', authorType: 'user' as const, createdAt: now, occurredAt: now }));
  await singles.sync([{ conversationId: 'c', partnerId: 'p', messages }]);
  const memories = new PartnerMemoryService({ withManagedMemoryStorage: async (_id, operation) => operation(path.join(dir, 'archive')) });
  const consolidation = new MemoryConsolidation(memories, new MemorySourceService(singles, { getRoom: async () => undefined }), () => now);
  const job: FallbackJob = { key: 'job', partnerId: 'p', kind: 'single_chat', conversationId: 'c', messages: messages.map((message) => ({ ...message, hash: fallbackHash(message.content) })), processed: {}, dirty: true, busy: false, lastMessageAt: now };
  return { dir, singles, memories, consolidation, job };
}
function planner(proposal: unknown, inspect?: (request: ApiProviderRequest, count: number) => void | Promise<void>) {
  let count = 0;
  const adapter: ApiProviderAdapter = { provider: 'fake', capabilities: new DeepSeekProviderAdapter({ endpoint: '', model: '', apiKey: '' }).capabilities,
    async *stream(request) {
      count++; await inspect?.(request, count);
      yield { type: 'tool.delta', index: 0, id: `call-${count}`, name: count === 1 ? 'search_memory' : 'submit_memory_consolidation', arguments: JSON.stringify(count === 1 ? {} : proposal) };
      yield { type: 'finish', reason: 'tool_calls' };
    } };
  return { adapter, requests: () => count };
}
const creation = { kind: 'create', key: 'new', type: 'stable_fact', body: 'new durable fact', weight: 3, sourceMessageIds: ['m2'] };
describe('dedicated memory consolidation', () => {
  it('exposes only two read tools and proposal submission; captures frozen ±2 sources and durable receipts', async () => {
    const { consolidation, memories, job } = await fixture();
    const fake = planner({ operations: [creation] }, (request) => { expect(request.tools.map((tool) => tool.name)).toEqual(['search_memory', 'read_memory_source', 'submit_memory_consolidation']); });
    const receipt = await consolidation.execute(job, 'op', fake.adapter, new AbortController().signal, async () => true);
    const records = await memories.list('p');
    expect(records).toHaveLength(1); expect(records[0].sources[0].frozenExcerpt?.messages).toHaveLength(5);
    expect(records[0].sources[0].contentHash).toBe(fallbackHash('message 2'));
    expect(await memories.fallbackMemoryIds('p')).toEqual([records[0].memoryId]);
    expect(await consolidation.execute(job, 'op', fake.adapter, new AbortController().signal, async () => true)).toEqual(receipt);
    expect(fake.requests()).toBe(2); expect(await memories.list('p')).toHaveLength(1);
  });
  it.each([
    [{ ...creation, weight: 2.5 }], [{ ...creation, sourceMessageIds: ['foreign'] }], [{ kind: 'delete', memoryId: 'old' }],
  ])('rejects invalid proposals before any archive write: %j', async (operations) => {
    const { consolidation, memories, job } = await fixture();
    await expect(consolidation.execute(job, 'op', planner({ operations }).adapter, new AbortController().signal, async () => true)).rejects.toThrow();
    expect(await memories.list('p')).toEqual([]);
  });
  it('cannot restore deleted facts or modify deleted targets', async () => {
    const { consolidation, memories, job } = await fixture();
    await memories.create('p', { ...record(creation.body), deletedAt: now });
    await expect(consolidation.execute(job, 'op', planner({ operations: [creation] }).adapter, new AbortController().signal, async () => true)).rejects.toThrow('DUPLICATE_FACT');
    await expect(consolidation.execute(job, 'op2', planner({ operations: [{ kind: 'comment', memoryId: 'old', content: 'restore', sourceMessageIds: ['m2'] }] }).adapter, new AbortController().signal, async () => true)).rejects.toThrow('TARGET_UNAVAILABLE');
    expect(await memories.list('p')).toEqual([]);
  });
  it('keeps comments and history, and validates supersession within the proposal', async () => {
    const { consolidation, memories, job } = await fixture(); await memories.create('p', record());
    const proposal = { operations: [creation, { kind: 'comment', memoryId: 'old', content: 'new evidence', sourceMessageIds: ['m2'] }, { kind: 'update', memoryId: 'old', status: 'superseded', supersededBy: 'new', sourceMessageIds: ['m2'] }] };
    await consolidation.execute(job, 'op', planner(proposal).adapter, new AbortController().signal, async () => true);
    const records = await memories.list('p'); const old = records.find((item) => item.memoryId === 'old')!;
    expect(old.body).toBe('old'); expect(old.comments[0].content).toBe('new evidence'); expect(old.status).toBe('superseded');
    expect(records.some((item) => item.memoryId === old.supersededByMemoryId)).toBe(true);
  });
  it('rejects archive and source changes instead of overwriting concurrent edits', async () => {
    const { consolidation, memories, job, singles } = await fixture(); await memories.create('p', record());
    const fake = planner({ operations: [creation] }, async (_, count) => { if (count === 2) await memories.revise('p', 'old', { body: 'user edited' }); });
    await expect(consolidation.execute(job, 'op', fake.adapter, new AbortController().signal, async () => true)).rejects.toThrow('ARCHIVE_STALE');
    const changed = planner({ operations: [creation] }, async (_, count) => { if (count === 2) await singles.upsertMessage('c', 'p', { messageId: 'm2', content: 'edited', authorType: 'user', authorId: 'u', createdAt: now }); });
    await expect(consolidation.execute(job, 'op', changed.adapter, new AbortController().signal, async () => true)).rejects.toThrow('SOURCE_CHANGED');
    expect((await memories.list('p'))[0].body).toBe('user edited');
  });
  it('bounds batch size and never silently consumes oversized messages', async () => {
    const { job } = await fixture(); job.messages[0].content = 'x'.repeat(40_001);
    expect(() => fallbackBatch(job)).toThrow('TOO_LARGE');
  });
  it('limits normal tool continuations to four requests per attempt', async () => {
    const { job, consolidation } = await fixture();
    let count = 0;
    const adapter: ApiProviderAdapter = { ...planner({}).adapter, async *stream() {
      count++; yield { type: 'tool.delta', index: 0, id: `call-${count}`, name: 'search_memory', arguments: '{}' };
      yield { type: 'finish', reason: 'tool_calls' };
    } };
    await expect(consolidation.execute(job, 'op', adapter, new AbortController().signal, async () => true)).rejects.toThrow('REQUEST_LIMIT');
    expect(count).toBe(4);
  });
  it('recovers a crash after writing a record and before committing the receipt, without duplicate comments', async () => {
    const { dir } = await fixture(); const archive = path.join(dir, 'crash');
    let crash = true;
    const store = new SqliteMemoryArchiveStore(path.join(archive, 'memory.sqlite'), 'p', { afterFallbackRecordWrite: () => { if (crash) { crash = false; throw new Error('simulated crash'); } } });
    const initial = record(); await store.create(initial);
    const snapshot = await store.snapshot();
    const changed = { ...initial, comments: [{ commentId: 'stable-comment-id', content: 'one comment', createdAt: now }] };
    await expect(store.applyFallback('op', snapshot.archiveVersion, [changed], 'receipt')).rejects.toThrow('simulated crash');
    const restarted = new SqliteMemoryArchiveStore(path.join(archive, 'memory.sqlite'), 'p');
    expect(await restarted.fallbackReceipt('op')).toBeUndefined();
    expect((await restarted.get('old'))?.comments).toHaveLength(0);
    await restarted.applyFallback('op', snapshot.archiveVersion, [changed], 'receipt');
    expect((await restarted.get('old'))?.comments).toHaveLength(1);
  });
});
