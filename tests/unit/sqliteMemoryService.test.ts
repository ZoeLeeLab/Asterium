import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import { PartnerMemoryService } from '../../src/main/memory/PartnerMemoryService';
import { PartnerMemoryBriefingService } from '../../src/main/memory/PartnerMemoryBriefingService';
import { PartnerMemoryToolService } from '../../src/main/memory/PartnerMemoryToolService';
import { MemorySourceService } from '../../src/main/memory/MemorySourceService';
import type { PartnerProfileSeed } from '../../src/shared/agentProtocol';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const seed: PartnerProfileSeed = { partnerId: 'partner-p', sourceMode: 'local_cli', publicIdentity: { displayName: '测试', introduction: '', expertise: '', mentionName: '测试' }, management: { memoryMode: 'asterium', personality: false, userProfile: false }, connectionSettings: {} };
it('serves tools and SQLite briefings through profile lifecycle serialization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-sqlite-service-')); roots.push(root);
  const profiles = new PartnerProfileStore(root); await profiles.savePartner(seed);
  const memories = new PartnerMemoryService(profiles);
  const tools = new PartnerMemoryToolService(memories, new MemorySourceService({ getWindow: async () => undefined }, { getRoom: async () => undefined }));
  let events = 0; memories.subscribe(() => events++);
  const record = await tools.hold({ partnerId: seed.partnerId }, { type: 'stable_fact', body: '先给结论' });
  await tools.comment({ partnerId: seed.partnerId }, { memoryId: record.memoryId, content: '再给细节' });
  expect((await tools.search({ partnerId: seed.partnerId }, { text: '细节' }))).toHaveLength(1);
  await tools.update({ partnerId: seed.partnerId }, { memoryId: record.memoryId, weight: 4 });
  expect(await tools.readSource({ partnerId: seed.partnerId }, { memoryId: record.memoryId })).toEqual([]);
  const snapshot = await memories.snapshot(seed.partnerId);
  await memories.applyFallback(seed.partnerId, 'op', snapshot.archiveVersion, [], '[]');
  expect(await new PartnerMemoryService(profiles).fallbackReceipt(seed.partnerId, 'op')).toBe('[]');
  const briefings = new PartnerMemoryBriefingService(memories);
  const first = await briefings.get(seed.partnerId); expect(first.content).toContain('先给结论');
  expect(await briefings.get(seed.partnerId)).toEqual(first);
  await profiles.savePartner({ ...seed, publicIdentity: { ...seed.publicIdentity, displayName: '改名' } });
  expect(await memories.get(seed.partnerId, record.memoryId)).toBeDefined();
  await profiles.savePartner({ ...seed, management: { ...seed.management, memoryMode: 'self_managed' } });
  await expect(memories.list(seed.partnerId)).rejects.toThrow('PARTNER_MEMORY_NOT_MANAGED');
  await profiles.savePartner(seed);
  expect((await memories.list(seed.partnerId))).toHaveLength(1);
  const cache = await memories.cachedBriefing(seed.partnerId); expect(cache).toEqual(first);
  expect(events).toBe(4);
  await profiles.trashPartnerDirectory(seed.partnerId, async (directory) => {
    // Moving/removing the complete directory proves no SQLite handle remains open on Windows.
    expect(await readdir(path.join(directory, 'private-memory'))).toContain('memory.sqlite');
    await rm(directory, { recursive: true });
  });
  await expect(memories.list(seed.partnerId)).rejects.toThrow('PARTNER_PROFILE_NOT_FOUND'); profiles.dispose();
});
it('does not open an archive while the cutover gate is failed', async () => {
  const withManagedMemoryStorage = vi.fn();
  const memories = new PartnerMemoryService({ withManagedMemoryStorage }, { ready: async () => { throw new Error('cutover failed'); } });
  await expect(memories.list('p')).rejects.toThrow('cutover failed'); expect(withManagedMemoryStorage).not.toHaveBeenCalled();
});
