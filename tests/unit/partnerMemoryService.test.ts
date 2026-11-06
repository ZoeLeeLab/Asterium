import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PartnerMemoryService } from '../../src/main/memory/PartnerMemoryService';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import type { PartnerProfileSeed } from '../../src/shared/agentProtocol';
import type { MemoryRecord } from '../../src/shared/memoryArchive';

const temporaryDirectories: string[] = [];
const profileStores: PartnerProfileStore[] = [];
const NOW = '2026-10-18T00:00:00.000Z';

afterEach(async () => {
  for (const store of profileStores.splice(0)) store.dispose();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-partner-memory-service-'));
  temporaryDirectories.push(root);
  const profiles = new PartnerProfileStore(root);
  profileStores.push(profiles);
  return { root, profiles, service: new PartnerMemoryService(profiles) };
}

function seed(overrides: Partial<PartnerProfileSeed> = {}): PartnerProfileSeed {
  return {
    partnerId: 'partner-managed-1',
    sourceMode: 'local_cli',
    publicIdentity: { displayName: '测试伙伴', introduction: '一起协作。', expertise: '整理', mentionName: '测试伙伴' },
    management: { userProfile: false, personality: false, memoryMode: 'asterium' },
    connectionSettings: { adapterType: 'claude_code' },
    ...overrides,
  };
}

function record(partnerId: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    schemaVersion: 1,
    memoryId: `memory-${partnerId}`,
    partnerId,
    type: 'stable_fact',
    status: 'active',
    body: '用户偏好先审计再实施。',
    tags: ['协作'],
    weight: 3,
    createdAt: NOW,
    updatedAt: NOW,
    comments: [],
    sources: [],
    ...overrides,
  };
}

describe('PartnerMemoryService', () => {
  it('uses one partner archive for single-chat and Studio sources', async () => {
    const value = await fixture();
    const partner = seed();
    await value.profiles.savePartner(partner);
    const saved = record(partner.partnerId, {
      sources: [
        { kind: 'single_chat', conversationId: 'conversation-1', messageId: 'message-direct' },
        { kind: 'studio', roomId: 'room-1', messageId: 'message-studio' },
      ],
    });

    await value.service.create(partner.partnerId, saved);

    await expect(value.service.list(partner.partnerId)).resolves.toEqual([saved]);
    await expect(value.service.snapshot(partner.partnerId)).resolves.toMatchObject({ partnerId: partner.partnerId, records: [saved] });
    const archiveDirectory = await value.profiles.withManagedMemoryStorage(partner.partnerId, async (directory) => directory);
    expect(await readdir(archiveDirectory)).toEqual(['memory.sqlite']);
    expect(archiveDirectory).not.toContain('conversation-1');
    expect(archiveDirectory).not.toContain('room-1');
  });

  it('notifies subscribers after successful mutations only', async () => {
    const value = await fixture();
    const partner = seed();
    await value.profiles.savePartner(partner);
    const changes: string[] = [];
    const unsubscribe = value.service.subscribe((change) => changes.push(change.partnerId));
    await value.service.create(partner.partnerId, record(partner.partnerId));
    await expect(value.service.revise(partner.partnerId, `memory-${partner.partnerId}`, { weight: 4 }, 'stale'))
      .rejects.toThrow('MEMORY_RECORD_STALE');
    unsubscribe();
    await value.service.revise(partner.partnerId, `memory-${partner.partnerId}`, { weight: 4 });
    expect(changes).toEqual([partner.partnerId]);
  });

  it('keeps partner archives isolated and rejects cross-partner records', async () => {
    const value = await fixture();
    const first = seed();
    const second = seed({
      partnerId: 'partner-managed-2',
      publicIdentity: { ...seed().publicIdentity, displayName: '小海豚', mentionName: '小海豚' },
    });
    await value.profiles.savePartner(first);
    await value.profiles.savePartner(second);
    const firstRecord = record(first.partnerId);
    const secondRecord = record(second.partnerId);

    await value.service.create(first.partnerId, firstRecord);
    await value.service.create(second.partnerId, secondRecord);

    await expect(value.service.list(first.partnerId)).resolves.toEqual([firstRecord]);
    await expect(value.service.list(second.partnerId)).resolves.toEqual([secondRecord]);
    await expect(value.service.create(first.partnerId, record(second.partnerId, { memoryId: 'cross-partner' }))).rejects.toThrow('MEMORY_ARCHIVE_INVALID');
  });

  it('allows only Asterium-managed memory while API partners remain forced on', async () => {
    const value = await fixture();
    const existing = seed({
      partnerId: 'partner-existing',
      sourceMode: 'existing_thread',
      management: { userProfile: true, personality: true, memoryMode: 'asterium' },
      connectionSettings: { serviceType: 'cyberboss_server', threadId: 'thread-1' },
    });
    const selfManaged = seed({
      partnerId: 'partner-self-managed',
      management: { userProfile: false, personality: false, memoryMode: 'self_managed' },
    });
    const api = seed({
      partnerId: 'partner-api',
      sourceMode: 'api_partner',
      management: { userProfile: false, personality: false, memoryMode: 'none' },
      connectionSettings: { provider: 'deepseek', apiSessionHistoryEnabled: true },
    });
    const existingSnapshot = await value.profiles.savePartner(existing);
    const selfSnapshot = await value.profiles.savePartner(selfManaged);
    const apiSnapshot = await value.profiles.savePartner(api);
    const legacyMemoryPath = path.join(value.root, 'partners', selfSnapshot.directoryName, 'private-memory', 'memory.md');
    const legacyBytes = Buffer.from('# 自己管理的旧记忆\r\n\r\n不要读取或修改。', 'utf8');
    await mkdir(path.dirname(legacyMemoryPath), { recursive: true });
    await writeFile(legacyMemoryPath, legacyBytes);

    expect(existingSnapshot.management.memoryMode).toBe('none');
    expect(selfSnapshot.management.memoryMode).toBe('self_managed');
    expect(apiSnapshot.management.memoryMode).toBe('asterium');
    await expect(value.service.list(existing.partnerId)).rejects.toThrow('PARTNER_MEMORY_NOT_MANAGED');
    await expect(value.service.list(selfManaged.partnerId)).rejects.toThrow('PARTNER_MEMORY_NOT_MANAGED');
    await expect(value.service.list('partner-missing')).rejects.toThrow('PARTNER_PROFILE_NOT_FOUND');
    await expect(value.service.list(api.partnerId)).resolves.toEqual([]);
    await value.service.create(api.partnerId, record(api.partnerId));
    await expect(value.service.list(api.partnerId)).resolves.toEqual([record(api.partnerId)]);
    expect(await readFile(legacyMemoryPath)).toEqual(legacyBytes);
    await expect(readdir(path.join(value.root, 'partners', selfSnapshot.directoryName, 'private-memory', 'archive-v1'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rechecks management mode on every call without deleting an existing archive', async () => {
    const value = await fixture();
    const managed = seed();
    await value.profiles.savePartner(managed);
    const saved = record(managed.partnerId);
    await value.service.create(managed.partnerId, saved);

    await value.profiles.savePartner({
      ...managed,
      management: { ...managed.management, memoryMode: 'self_managed' },
    });
    await expect(value.service.appendComment(managed.partnerId, saved.memoryId, '不应写入')).rejects.toThrow('PARTNER_MEMORY_NOT_MANAGED');
    await expect(value.service.list(managed.partnerId)).rejects.toThrow('PARTNER_MEMORY_NOT_MANAGED');

    await value.profiles.savePartner(managed);
    await expect(value.service.list(managed.partnerId)).resolves.toEqual([saved]);
  });

  it('follows a renamed partner directory instead of keeping a stale cached path', async () => {
    const value = await fixture();
    const initial = seed();
    const before = await value.profiles.savePartner(initial);
    const saved = record(initial.partnerId);
    await value.service.create(initial.partnerId, saved);

    const after = await value.profiles.savePartner({
      ...initial,
      publicIdentity: { ...initial.publicIdentity, displayName: '改名后的测试伙伴' },
    });

    expect(after.directoryName).not.toBe(before.directoryName);
    await expect(value.service.list(initial.partnerId)).resolves.toEqual([saved]);
    await expect(readdir(path.join(value.root, 'partners', before.directoryName))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
