import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SqliteMemoryCutover } from '../../src/main/memory/SqliteMemoryCutover';
import { SqliteMemoryArchiveStore } from '../../src/main/memory/SqliteMemoryArchiveStore';
import { MemoryFallbackJobStore, fallbackHash, type FallbackInput } from '../../src/main/memory/fallback/MemoryFallbackJobStore';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-cutover-')); roots.push(root);
  const profiles = path.join(root, 'AsteriumData'); const partner = path.join(profiles, 'partners', '测试__p');
  const memory = path.join(partner, 'private-memory'); await mkdir(path.join(memory, 'archive-v1', 'records'), { recursive: true });
  await writeFile(path.join(partner, 'partner.json'), JSON.stringify({ partnerId: 'p', management: { memoryMode: 'asterium' } }));
  await writeFile(path.join(partner, 'persona.md'), '不改人设');
  await writeFile(path.join(memory, 'memory.md'), Buffer.from([0xef, 0xbb, 0xbf, 65, 13, 10]));
  const oldRecord = path.join(memory, 'archive-v1', 'records', `${createHash('sha256').update('m').digest('hex')}.md`);
  await writeFile(oldRecord, 'test data, not imported or parsed');
  await writeFile(path.join(memory, 'archive-v1', 'briefing-cache.v1.json'), '{}');
  const jobsFile = path.join(root, 'memory-fallback-jobs.v1.json'); const jobs = new MemoryFallbackJobStore(jobsFile);
  const input: FallbackInput = { partnerId: 'p', conversationId: 'c', kind: 'single_chat', busy: false, messages: [{ messageId: 'm', content: 'old', hash: fallbackHash('old'), authorId: 'u', authorType: 'user' }] };
  await jobs.sync([input]); const jobsBefore = await readFile(jobsFile);
  const make = (fault?: ConstructorParameters<typeof SqliteMemoryCutover>[4]) => new SqliteMemoryCutover(profiles, root, jobs, async () => [structuredClone(input)], fault);
  return { root, profiles, partner, memory, oldRecord, jobs, jobsFile, jobsBefore, input, make };
}
it.each(['prepared', 'backed_up', 'databases_ready', 'baselined', 'complete'] as const)('resumes interruption at %s and never repeats the baseline', async (stage) => {
  const value = await fixture(); const legacy = await readFile(path.join(value.memory, 'memory.md'));
  await expect(value.make((state) => { if (state === stage) throw new Error('crash'); }).run()).rejects.toThrow('crash');
  const coordinator = value.make(); const manifest = await coordinator.run(); expect(manifest.state).toBe('complete');
  expect(await readFile(path.join(coordinator.backupDirectory(manifest), 'profiles/partners/测试__p/private-memory/memory.md'))).toEqual(legacy);
  expect(await readdir(path.join(value.memory, 'archive-v1', 'records'))).toEqual([]);
  expect(await new SqliteMemoryArchiveStore(path.join(value.memory, 'memory.sqlite'), 'p').list()).toEqual([]);
  expect((await value.jobs.list())[0].dirty).toBe(false);
  value.input.messages.push({ ...value.input.messages[0], messageId: 'new', hash: fallbackHash('new'), content: 'new' });
  await value.jobs.sync([value.input]); await value.make().run(); expect((await value.jobs.list())[0].dirty).toBe(true);
  expect(await readFile(path.join(value.partner, 'persona.md'), 'utf8')).toBe('不改人设');
});
it('does not consume revisions arriving after capture, including on baseline replay', async () => {
  const value = await fixture();
  await expect(value.make((state) => { if (state === 'databases_ready') throw new Error('stop'); }).run()).rejects.toThrow();
  value.input.messages[0] = { ...value.input.messages[0], content: 'edited', hash: fallbackHash('edited') };
  await value.jobs.sync([value.input]); await value.make().run();
  expect((await value.jobs.list())[0].dirty).toBe(true);
});
it('refuses damaged backups and changed originals without deleting them', async () => {
  const value = await fixture();
  await expect(value.make((state) => { if (state === 'backed_up') throw new Error('stop'); }).run()).rejects.toThrow();
  const coordinator = value.make(); const manifest = (await coordinator.status())!;
  const backup = path.join(coordinator.backupDirectory(manifest), 'profiles/partners/测试__p/private-memory/memory.md');
  await writeFile(backup, 'bad'); await expect(coordinator.run()).rejects.toThrow('CHECKSUM_MISMATCH');
  expect(await readFile(value.oldRecord, 'utf8')).toContain('not imported');
});
it('rejects unknown files and symbolic directories rather than moving them', async () => {
  const value = await fixture(); await writeFile(path.join(value.memory, 'unknown.md'), 'user');
  await expect(value.make().run()).rejects.toThrow('UNKNOWN_FILE');
  await rm(path.join(value.memory, 'unknown.md'));
  const outside = path.join(value.root, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(value.memory, 'linked'), 'junction');
  await expect(value.make().run()).rejects.toThrow('PATH_INVALID');
  expect(await readdir(outside)).toEqual([]);
});
it('restores exact old bytes and cursors while preserving the new SQLite snapshot', async () => {
  const value = await fixture(); const coordinator = value.make(); const manifest = await coordinator.run();
  const timestamp = new Date().toISOString();
  await new SqliteMemoryArchiveStore(path.join(value.memory, 'memory.sqlite'), 'p').create({ schemaVersion: 1, memoryId: 'new', partnerId: 'p', type: 'stable_fact', status: 'active', body: 'new SQLite memory', tags: [], weight: 3, comments: [], sources: [], createdAt: timestamp, updatedAt: timestamp });
  await expect(coordinator.rollback(false)).rejects.toThrow('REQUIRES_STOPPED');
  await coordinator.rollback(true);
  expect(await readFile(value.jobsFile)).toEqual(value.jobsBefore);
  expect(await readFile(value.oldRecord, 'utf8')).toContain('not imported');
  expect(await readdir(path.join(coordinator.backupDirectory(manifest), 'rollback-sqlite'))).toContain('p.sqlite');
  const snapshot = new SqliteMemoryArchiveStore(path.join(coordinator.backupDirectory(manifest), 'rollback-sqlite', 'p.sqlite'), 'p');
  expect((await snapshot.get('new'))?.body).toBe('new SQLite memory');
  await expect(value.make().run()).rejects.toThrow('ROLLED_BACK');
});
it('rolls back to the current partner directory after a rename without recreating the old directory', async () => {
  const value = await fixture(); const coordinator = value.make(); await coordinator.run();
  const renamed = path.join(path.dirname(value.partner), '改名__p'); await rename(value.partner, renamed);
  await coordinator.rollback(true);
  expect(await readFile(path.join(renamed, 'private-memory', 'memory.md'))).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 65, 13, 10]));
  await expect(readFile(path.join(value.partner, 'private-memory', 'memory.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(coordinator.run()).rejects.toThrow('ROLLED_BACK');
});
