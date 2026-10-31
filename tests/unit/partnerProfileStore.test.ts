import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import type { PartnerProfileSeed } from '../../src/shared/agentProtocol';

const temporaryDirectories: string[] = [];
const stores: PartnerProfileStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function trackedStore(...args: ConstructorParameters<typeof PartnerProfileStore>) {
  const store = new PartnerProfileStore(...args);
  stores.push(store);
  return store;
}

function seed(overrides: Partial<PartnerProfileSeed> = {}): PartnerProfileSeed {
  return {
    partnerId: 'partner-external-22ca5dde',
    sourceMode: 'existing_thread',
    publicIdentity: { displayName: '外部伙伴', introduction: '一起做项目。', expertise: '系统设计', mentionName: '外部伙伴' },
    management: { userProfile: false, personality: false, memoryMode: 'none' },
    connectionSettings: { serviceType: 'cyberboss_server', threadId: 'native-thread' },
    ...overrides,
  };
}

describe('PartnerProfileStore', () => {
  it('rejects saving over externally changed user/persona MD and returns fresh revisions after refresh', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-profile-conflict-')); temporaryDirectories.push(root);
    const store = trackedStore(root), managed = seed({ management: { userProfile: true, personality: true, memoryMode: 'none' }, personality: '旧人设' });
    const first = await store.sync({ displayName: '旧用户', introduction: '', updatedAt: '' }, [managed]);
    const userPath = path.join(root, 'user', 'user-profile.md'), personaPath = path.join(root, 'partners', first.partners[0].directoryName, 'persona.md');
    const userMd = '# 用户介绍\n\n## 名字\n\n外部用户\n\n## 介绍\n\n外部介绍\n';
    const personaMd = '# 伙伴设定\n\n## 性格与相处方式\n\n外部人设\n\n## 稳定指令\n\n外部指令\n';
    await writeFile(userPath, userMd); await writeFile(personaPath, personaMd);
    await expect(store.saveUser({ ...first.user, displayName: '草稿' })).rejects.toThrow('PROFILE_VERSION_CONFLICT');
    await expect(store.savePartner({ ...managed, expectedRevision: first.partners[0].revision })).rejects.toThrow('PROFILE_VERSION_CONFLICT');
    expect(await readFile(userPath, 'utf8')).toBe(userMd); expect(await readFile(personaPath, 'utf8')).toBe(personaMd);
    const refreshed = await store.refresh(); expect(refreshed.user.revision).not.toBe(first.user.revision); expect(refreshed.partners[0].revision).not.toBe(first.partners[0].revision);
    await expect(store.saveUser({ ...refreshed.user, displayName: '确认后的用户' })).resolves.toMatchObject({ displayName: '确认后的用户' });
  });
  it('creates the visible shallow profile layout and treats markdown edits as the source of truth', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-visible-profiles-'));
    temporaryDirectories.push(root);
    const store = trackedStore(root);
    const first = await store.sync({ displayName: '用户', introduction: '用户介绍', updatedAt: '2026-10-08T00:00:00.000Z' }, [seed()]);
    const directory = path.join(root, 'partners', first.partners[0].directoryName);

    expect(await readdir(directory)).toEqual(expect.arrayContaining(['partner.json', 'profile.md', 'runtime.json', 'connection.json', 'work-memory']));
    expect(await readdir(directory)).not.toContain('persona.md');
    expect(await readFile(path.join(root, 'user', 'user-profile.md'), 'utf8')).toContain('用户');

    await writeFile(path.join(directory, 'profile.md'), '# 伙伴介绍\n\n## 名字\n\n外部伙伴 B\n\n## 简短介绍\n\n改过的介绍\n\n## 长期擅长\n\n架构与实现\n\n## @称呼\n\n外部B\n', 'utf8');
    const second = await store.sync({ displayName: '不会覆盖', introduction: '', updatedAt: '2026-10-08T01:00:00.000Z' }, [seed({ publicIdentity: { ...seed().publicIdentity, displayName: '渲染器旧名字' } })]);
    expect(second.partners[0].publicIdentity).toMatchObject({ displayName: '外部伙伴 B', expertise: '架构与实现', mentionName: '外部B' });
    expect(second.partners[0].directoryName).toBe(first.partners[0].directoryName);
  });

  it('refreshes external user and partner markdown edits only on demand', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-watched-profiles-'));
    temporaryDirectories.push(root);
    const store = trackedStore(root);
    const updates: Array<{ userName: string; partnerName: string }> = [];
    store.subscribe((profiles) => updates.push({ userName: profiles.user.displayName, partnerName: profiles.partners[0].publicIdentity.displayName }));
    const initial = await store.sync({ displayName: '用户', introduction: '旧介绍', updatedAt: new Date(0).toISOString() }, [seed()]);
    const partnerDirectory = path.join(root, 'partners', initial.partners[0].directoryName);

    await writeFile(path.join(root, 'user', 'user-profile.md'), '# 用户介绍\n\n## 名字\n\n新用户\n\n## 介绍\n\n从文件更新\n', 'utf8');
    await writeFile(path.join(partnerDirectory, 'profile.md'), '# 伙伴介绍\n\n## 名字\n\n新外部伙伴\n\n## 简短介绍\n\n文件里的伙伴\n\n## 长期擅长\n\n架构\n\n## @称呼\n\n外部B\n', 'utf8');

    expect(updates).toEqual([]);
    await store.refresh();
    expect(updates).toContainEqual({ userName: '新用户', partnerName: '新外部伙伴' });
  });

  it('tracks semantic persona versions from external markdown edits and keeps API persona management forced on', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-watched-persona-'));
    temporaryDirectories.push(root);
    const store = trackedStore(root);
    const managed = seed({
      sourceMode: 'local_cli',
      management: { userProfile: false, personality: true, memoryMode: 'self_managed' },
      personality: '旧人设',
      systemPrompt: '旧指令',
      connectionSettings: { adapterType: 'claude_code' },
    });
    const updates: string[] = [];
    store.subscribe((profiles) => updates.push(profiles.partners[0].personality ?? ''));
    const initial = await store.sync({ displayName: '用户', introduction: '', updatedAt: new Date(0).toISOString() }, [managed]);
    const directory = path.join(root, 'partners', initial.partners[0].directoryName);
    const before = await store.managedPersonaState(managed.partnerId);

    await writeFile(path.join(directory, 'persona.md'), '# 伙伴设定\n\n## 性格与相处方式\n\n外部新版人设\n\n## 稳定指令\n\n外部新版指令\n', 'utf8');
    expect(updates).toEqual([]); await store.refresh(); expect(updates).toContain('外部新版人设');
    const after = await store.managedPersonaState(managed.partnerId);
    expect(before.enabled).toBe(true);
    expect(after.enabled).toBe(true);
    if (!before.enabled || !after.enabled) throw new Error('MANAGED_PERSONA_EXPECTED');
    expect(before.version).not.toBe(after.version);
    expect(after).toMatchObject({ enabled: true, personality: '外部新版人设', systemPrompt: '外部新版指令' });

    const api = seed({
      partnerId: 'partner-api',
      sourceMode: 'api_partner',
      management: { userProfile: false, personality: false, memoryMode: 'none' },
      personality: 'API 强制人设',
      connectionSettings: { provider: 'deepseek' },
    });
    const apiSnapshot = await store.savePartner(api);
    expect(apiSnapshot.management).toMatchObject({ userProfile: true, personality: true, memoryMode: 'asterium' });
    expect(await store.managedPersonaState(api.partnerId)).toMatchObject({ enabled: true, personality: 'API 强制人设' });
  });

  it('enforces memory management modes by partner source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-memory-modes-'));
    temporaryDirectories.push(root);
    const store = trackedStore(root);

    const existing = await store.savePartner(seed({ management: { userProfile: false, personality: false, memoryMode: 'asterium' } }));
    const localSelf = await store.savePartner(seed({ partnerId: 'partner-local-self', sourceMode: 'local_cli', management: { userProfile: false, personality: false, memoryMode: 'none' }, connectionSettings: { adapterType: 'codex_cli' } }));
    const localManaged = await store.savePartner(seed({ partnerId: 'partner-local-managed', sourceMode: 'local_cli', management: { userProfile: false, personality: false, memoryMode: 'asterium' }, connectionSettings: { adapterType: 'claude_code' } }));
    const api = await store.savePartner(seed({ partnerId: 'partner-api-managed', sourceMode: 'api_partner', management: { userProfile: false, personality: false, memoryMode: 'none' }, connectionSettings: { provider: 'deepseek', apiSessionHistoryEnabled: true } }));

    expect(existing.management.memoryMode).toBe('none');
    expect(localSelf.management.memoryMode).toBe('self_managed');
    expect(localManaged.management.memoryMode).toBe('asterium');
    expect(api.management.memoryMode).toBe('asterium');
  });

  it('moves only the requested partner profile directory through the supplied recycle-bin operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-partner-trash-'));
    temporaryDirectories.push(root);
    const recycled = path.join(root, 'recycled-partner');
    const store = trackedStore(root);
    const saved = await store.sync({ displayName: '用户', introduction: '', updatedAt: new Date(0).toISOString() }, [
      seed({ management: { userProfile: false, personality: false, memoryMode: 'asterium' } }),
      seed({ partnerId: 'partner-kept', publicIdentity: { ...seed().publicIdentity, displayName: '保留伙伴' } }),
    ]);
    const removedDirectory = path.join(root, 'partners', saved.partners[0].directoryName);
    const keptDirectory = path.join(root, 'partners', saved.partners[1].directoryName);
    const trashItem = vi.fn(async (directory: string) => rename(directory, recycled));

    await expect(store.trashPartnerDirectory(seed().partnerId, trashItem)).resolves.toBe(true);

    expect(trashItem).toHaveBeenCalledWith(removedDirectory);
    expect(await readFile(path.join(recycled, 'partner.json'), 'utf8')).toContain(seed().partnerId);
    expect(await readFile(path.join(keptDirectory, 'partner.json'), 'utf8')).toContain('partner-kept');
    await expect(store.trashPartnerDirectory(seed().partnerId, trashItem)).resolves.toBe(false);
  });

  it('migrates v1 metadata and API history settings without rewriting legacy memory content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-memory-metadata-v2-'));
    temporaryDirectories.push(root);
    const partnerId = 'partner-api-v1';
    const directory = path.join(root, 'partners', 'legacy-api__12345678');
    const memoryPath = path.join(directory, 'private-memory', 'memory.md');
    const legacyMemory = '# 旧记忆\n\n这段内容必须逐字保留。\n';
    await mkdir(path.dirname(memoryPath), { recursive: true });
    await writeFile(path.join(directory, 'partner.json'), JSON.stringify({ version: 1, partnerId, sourceMode: 'api_partner', management: { personality: true, privateMemory: false }, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }), 'utf8');
    await writeFile(path.join(directory, 'profile.md'), '# 伙伴介绍\n\n## 名字\n\n旧 API\n\n## 简短介绍\n\n旧资料\n\n## 长期擅长\n\n整理\n\n## @称呼\n\n旧API\n', 'utf8');
    await writeFile(path.join(directory, 'persona.md'), '# 伙伴设定\n\n## 性格与相处方式\n\n可靠\n\n## 稳定指令\n\n保持准确\n', 'utf8');
    await writeFile(path.join(directory, 'connection.json'), JSON.stringify({ version: 1, partnerId, sourceMode: 'api_partner', provider: 'deepseek', memoryEnabled: false }), 'utf8');
    await writeFile(memoryPath, legacyMemory, 'utf8');

    const store = trackedStore(root);
    const input = seed({ partnerId, sourceMode: 'api_partner', management: { userProfile: false, personality: false, memoryMode: 'none' }, connectionSettings: { provider: 'deepseek', apiSessionHistoryEnabled: false } });
    const result = await store.sync({ displayName: '用户', introduction: '', updatedAt: new Date(0).toISOString() }, [input]);
    const metadata = JSON.parse(await readFile(path.join(directory, 'partner.json'), 'utf8')) as { version: number; management: Record<string, unknown> };
    const connection = JSON.parse(await readFile(path.join(directory, 'connection.json'), 'utf8')) as Record<string, unknown>;

    expect(result.partners[0].management).toEqual({ userProfile: true, personality: true, memoryMode: 'asterium' });
    expect(metadata).toMatchObject({ version: 2, management: { userProfile: true, personality: true, memoryMode: 'asterium' } });
    expect(metadata.management).not.toHaveProperty('privateMemory');
    expect(connection).toMatchObject({ version: 2, apiSessionHistoryEnabled: false });
    expect(connection).not.toHaveProperty('memoryEnabled');
    expect(await readFile(memoryPath, 'utf8')).toBe(legacyMemory);

    await store.sync({ displayName: '用户', introduction: '', updatedAt: new Date(0).toISOString() }, [input]);
    expect(await readFile(memoryPath, 'utf8')).toBe(legacyMemory);
  });

  it('preserves the latest persona MD when local management is disabled and then re-enabled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-persona-reenable-'));
    temporaryDirectories.push(root);
    const store = trackedStore(root);
    const enabled = seed({
      sourceMode: 'local_cli',
      management: { userProfile: false, personality: true, memoryMode: 'self_managed' },
      personality: '初始人设',
      systemPrompt: '初始指令',
      connectionSettings: { adapterType: 'claude_code' },
    });
    const initial = await store.sync({ displayName: '用户', introduction: '', updatedAt: new Date(0).toISOString() }, [enabled]);
    await store.savePartner({
      ...enabled,
      management: { ...enabled.management, personality: false },
      personality: undefined,
      systemPrompt: undefined,
    });
    const personaPath = path.join(root, 'partners', initial.partners[0].directoryName, 'persona.md');
    await writeFile(personaPath, '# 伙伴设定\n\n## 性格与相处方式\n\n关闭期间的磁盘最新版\n\n## 稳定指令\n\n只采用磁盘内容\n', 'utf8');

    await store.savePartner({
      ...enabled,
      management: { ...enabled.management, personality: true },
      personality: '',
      systemPrompt: '',
    });

    expect(await store.managedPersonaState(enabled.partnerId)).toMatchObject({
      enabled: true,
      personality: '关闭期间的磁盘最新版',
      systemPrompt: '只采用磁盘内容',
    });
  });

  it('does not expose update timestamps in the user markdown and removes the legacy comment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-user-profile-format-'));
    temporaryDirectories.push(root);
    const store = trackedStore(root);
    await store.sync({ displayName: '用户', introduction: '用户介绍', updatedAt: '2026-10-08T00:00:00.000Z' }, []);
    const profilePath = path.join(root, 'user', 'user-profile.md');
    expect(await readFile(profilePath, 'utf8')).not.toContain('星丛更新时间');

    await writeFile(profilePath, '# 用户介绍\n\n## 名字\n\n用户\n\n## 介绍\n\n保留这段介绍\n\n<!-- 星丛更新时间：2026-10-08T00:00:00.000Z -->\n', 'utf8');
    const result = await store.sync({ displayName: '旧值', introduction: '', updatedAt: new Date(0).toISOString() }, []);
    expect(result.user.introduction).toBe('保留这段介绍');
    expect(await readFile(profilePath, 'utf8')).not.toContain('星丛更新时间');
  });

  it('keeps managed files after disabling them and never crosses conversation model observations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-managed-profiles-'));
    temporaryDirectories.push(root);
    const store = trackedStore(root);
    const managed = seed({ sourceMode: 'local_cli', management: { userProfile: true, personality: true, memoryMode: 'asterium' }, personality: '安静可靠', systemPrompt: '保持准确', connectionSettings: { adapterType: 'claude_code' } });
    const saved = await store.savePartner(managed);
    const directory = path.join(root, 'partners', saved.directoryName);
    await store.observeModel({ partnerId: managed.partnerId, conversationId: 'conversation-a', threadId: 'thread-a', model: 'gpt-a', source: 'runtime' });
    await store.observeModel({ partnerId: managed.partnerId, conversationId: 'conversation-b', threadId: 'thread-b', model: 'gpt-b', source: 'native_thread' });
    await store.savePartner({ ...managed, management: { userProfile: false, personality: false, memoryMode: 'self_managed' } });

    expect(await readFile(path.join(directory, 'persona.md'), 'utf8')).toContain('安静可靠');
    await expect(readFile(path.join(directory, 'private-memory', 'memory.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const runtime = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8')) as { recentModel: { model: string }; conversations: Record<string, { model: string; threadId: string }> };
    expect(runtime.recentModel.model).toBe('gpt-b');
    expect(runtime.conversations['conversation-a']).toMatchObject({ model: 'gpt-a', threadId: 'thread-a' });
    expect(runtime.conversations['conversation-b']).toMatchObject({ model: 'gpt-b', threadId: 'thread-b' });
  });
});
