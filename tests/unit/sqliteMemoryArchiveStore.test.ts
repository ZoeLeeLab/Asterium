import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryRecord } from '../../src/shared/memoryArchive';
import { SqliteMemoryArchiveStore } from '../../src/main/memory/SqliteMemoryArchiveStore';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-sqlite-')); roots.push(root); const file = path.join(root, 'memory.sqlite'); return { file, store: new SqliteMemoryArchiveStore(file, 'p') }; }
function record(id = 'm'): MemoryRecord { return { schemaVersion: 1, memoryId: id, partnerId: 'p', type: 'stable_fact', status: 'active', body: '测试 SQLite', tags: ['标签'], weight: 3, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', comments: [], sources: [] }; }
describe('SQLite memory archive', () => {
  it('persists records, comments, sources and revisions without Markdown', async () => {
    const { file, store } = await fixture(); const first = await store.snapshot(); await store.create(record());
    await store.appendComment('m', '补充');
    await store.addSource('m', { kind: 'studio', roomId: 'r', messageId: 'msg' });
    const restarted = new SqliteMemoryArchiveStore(file, 'p');
    expect((await restarted.get('m'))?.comments).toHaveLength(1);
    expect((await restarted.get('m'))?.sources).toHaveLength(1);
    expect((await restarted.snapshot()).archiveVersion).not.toBe(first.archiveVersion);
    expect((await readFile(file)).subarray(0, 15).toString()).toBe('SQLite format 3');
  });
  it('enforces ownership, stale writes, weights and source uniqueness', async () => {
    const { file, store } = await fixture(); await store.create(record());
    await expect(new SqliteMemoryArchiveStore(file, 'other').list()).rejects.toThrow('MEMORY_ARCHIVE_INVALID');
    await expect(store.create({ ...record('x'), partnerId: 'other' })).rejects.toThrow();
    await expect(store.revise('m', { body: 'x' }, 'stale')).rejects.toThrow('MEMORY_RECORD_STALE');
    await expect(store.revise('m', { weight: 6 as 3 })).rejects.toThrow();
    const source = { kind: 'single_chat' as const, conversationId: 'c', messageId: 'msg' };
    await store.addSource('m', source); await expect(store.addSource('m', source)).rejects.toThrow('MEMORY_SOURCE_DUPLICATE');
  });
  it('preserves recycle and replacement constraints', async () => {
    const { store } = await fixture(); await store.create(record()); await store.create(record('n'));
    await store.revise('m', { status: 'superseded', supersededByMemoryId: 'n' });
    await expect(store.revise('n', { status: 'superseded', supersededByMemoryId: 'm' })).rejects.toThrow();
    await expect(store.purge('n')).rejects.toThrow('MEMORY_PURGE_REQUIRES_SOFT_DELETE');
    await store.softDelete('m'); expect(await store.get('m')).toBeUndefined(); await store.restore('m');
    await store.softDelete('m'); await store.purge('m'); expect(await store.get('m', { includeDeleted: true })).toBeUndefined();
  });
  it('atomically rolls back fallback, supports replay and durable noop receipts', async () => {
    const { file, store } = await fixture(); const version = (await store.snapshot()).archiveVersion;
    const crashing = new SqliteMemoryArchiveStore(file, 'p', { afterFallbackRecordWrite: () => { throw new Error('crash'); } });
    await expect(crashing.applyFallback('op', version, [record()], 'ok')).rejects.toThrow('crash');
    expect(await store.list()).toEqual([]); expect(await store.fallbackReceipt('op')).toBeUndefined();
    await store.applyFallback('op', version, [record()], 'ok');
    expect(await store.applyFallback('op', 'stale', [], 'different')).toBe('ok');
    await expect(store.applyFallback('other', version, [], 'noop')).rejects.toThrow('MEMORY_ARCHIVE_STALE');
    await store.applyFallback('empty', (await store.snapshot()).archiveVersion, [], '[]');
    expect(await new SqliteMemoryArchiveStore(file, 'p').fallbackReceipt('empty')).toBe('[]');
    expect(await store.fallbackMemoryIds()).toEqual(['m']);
  });
  it('does not reset damaged, unknown or locked databases', async () => {
    const { file, store } = await fixture(); await store.create(record());
    const db = new DatabaseSync(file); db.exec('BEGIN IMMEDIATE');
    await expect(store.create(record('n'))).rejects.toThrow(/locked/); db.exec('ROLLBACK; PRAGMA user_version = 99'); db.close();
    await expect(store.list()).rejects.toThrow('MEMORY_DATABASE_VERSION_UNSUPPORTED');
    await writeFile(file, 'broken'); await expect(store.list()).rejects.toThrow(); expect(await readFile(file, 'utf8')).toBe('broken');
  });
  it('round-trips every field including frozen evidence and Markdown body text', async () => {
    const { file, store } = await fixture();
    const value: MemoryRecord = { ...record(), body: '正文\r\n```md\n# 不作为文件\n```\n🌟', occurredAt: '2026-10-20T00:00:00.000Z',
      comments: [{ commentId: 'c', content: '原有补充', createdAt: record().createdAt }],
      sources: [{ kind: 'single_chat', conversationId: 'c', messageId: 'source', contentHash: 'a'.repeat(64), frozenExcerpt: { capturedAt: record().createdAt, messages: [{ messageId: 'source', content: '证据', contentHash: 'a'.repeat(64), authorId: 'u', authorType: 'user', createdAt: record().createdAt, offset: 0 }] } }] };
    await store.create(value); expect(await new SqliteMemoryArchiveStore(file, 'p').get('m')).toEqual(value);
    expect(await readdir(path.dirname(file))).toEqual(['memory.sqlite']);
  });
  it('keeps invariants for conflicts, missing updates, source replacement and noops', async () => {
    const { store } = await fixture(); await store.create(record());
    await expect(store.create(record())).rejects.toThrow('MEMORY_RECORD_CONFLICT');
    await expect(store.update(record('absent'))).rejects.toThrow('MEMORY_RECORD_NOT_FOUND');
    const version = (await store.snapshot()).archiveVersion;
    await store.revise('m', { weight: 3 }); expect((await store.snapshot()).archiveVersion).toBe(version);
    const revised = await store.revise('m', { type: 'self_summary', tags: ['new'], occurredAt: '2026-10-20T00:00:00.000Z', sources: [{ kind: 'studio', roomId: 'r', messageId: 's' }] });
    expect(revised).toMatchObject({ type: 'self_summary', tags: ['new'] });
    await store.revise('m', { occurredAt: null, sources: [] }); expect(await store.get('m')).not.toHaveProperty('occurredAt');
    await store.softDelete('m'); await expect(store.update(revised)).rejects.toThrow('MEMORY_RECORD_DELETED');
  });
  it('checks all rows on direct reads and prevents identity corruption from being served', async () => {
    const { file, store } = await fixture(); await store.create(record());
    const db = new DatabaseSync(file); db.prepare('UPDATE memories SET data = ?').run(JSON.stringify({ ...record(), partnerId: 'other' })); db.close();
    await expect(store.get('m')).rejects.toThrow('MEMORY_ARCHIVE_INVALID');
    await expect(store.get('missing')).rejects.toThrow('MEMORY_ARCHIVE_INVALID');
  });
  it('does not write an obsolete cache after a concurrent archive change', async () => {
    const { store } = await fixture(); const snapshot = await store.snapshot(); await store.create(record());
    await store.putBriefing({ schemaVersion: 1, partnerId: 'p', archiveVersion: snapshot.archiveVersion, generatedAt: record().createdAt, logicalDate: '2026-10-21', content: 'old' });
    expect(await store.getBriefing()).toBeUndefined();
  });
  it('rejects a symbolic database path', async () => {
    const { file, store } = await fixture(); await writeFile(`${file}.outside`, 'private');
    await symlink(`${file}.outside`, file);
    await expect(store.list()).rejects.toThrow('MEMORY_DATABASE_PATH_INVALID');
    expect(await readFile(`${file}.outside`, 'utf8')).toBe('private');
  });
  it('serializes transaction changes and leaves no open handle after concurrent use', async () => {
    const { file, store } = await fixture();
    await Promise.all([store.create(record()), store.create(record('n'))]); expect(await store.list()).toHaveLength(2);
    await rm(file); expect(await readdir(path.dirname(file))).toEqual([]);
  });
  it('recovers an uncommitted transaction after a separate writer process exits abruptly', async () => {
    const { file, store } = await fixture(); await store.create(record());
    const child = spawnSync(process.execPath, ['-e', "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE memories SET data = ?').run(JSON.stringify({...JSON.parse(db.prepare('SELECT data FROM memories').get().data),body:'not committed'}));process.exit(71);", file], { windowsHide: true, timeout: 5000 });
    expect(child.status).toBe(71); expect((await store.get('m'))?.body).toBe(record().body);
  });
});
