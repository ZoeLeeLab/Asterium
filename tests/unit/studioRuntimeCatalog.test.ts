import { describe, expect, it } from 'vitest';
import type { JsonValue, PartnerProfileSeed } from '../../src/shared/agentProtocol';
import { persistedPartnerProfileSeed, shouldPersistPartnerProfileSeed, StudioRuntimeCatalog } from '../../src/main/studio/StudioRuntimeCatalog';

function apiSeed(): PartnerProfileSeed {
  return {
    partnerId: 'partner-api',
    sourceMode: 'api_partner',
    publicIdentity: { displayName: '小星', introduction: '介绍', expertise: '架构', mentionName: '小星' },
    management: { userProfile: true, personality: true, memoryMode: 'asterium' },
    personality: '稳定人设',
    systemPrompt: '系统提示',
    connectionSettings: {
      provider: 'deepseek',
      configuredModel: 'deepseek-chat',
      __studioRuntime: {
        available: true,
        defaultPermissionMode: 'manual',
        runtime: {
          kind: 'api',
          connection: {
            provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', credentialRef: 'credential-one',
            thinkingMode: 'auto', reasoningEffort: 'high', primaryWorkspaceGrantId: 'root-one', workspaceGrantIds: ['extra-one'],
            attachmentCapabilities: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' },
          },
        },
      },
    },
  };
}

describe('StudioRuntimeCatalog', () => {
  it('keeps Studio launch data in memory while preserving the persisted profile shape', () => {
    const seed = apiSeed();
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '用户介绍', updatedAt: '2026-10-13T00:00:00.000Z' }, [seed]);

    expect(catalog.partner(seed.partnerId)).toMatchObject({
      available: true,
      publicIdentity: { displayName: '小星' },
      runtime: { kind: 'api', connection: { credentialRef: 'credential-one', primaryWorkspaceGrantId: 'root-one', workspaceGrantIds: ['extra-one'] } },
    });
    expect(catalog.user()).toMatchObject({ displayName: '用户', introduction: '用户介绍' });

    const persisted = persistedPartnerProfileSeed(seed);
    expect(persisted.connectionSettings).toEqual({ provider: 'deepseek', configuredModel: 'deepseek-chat' });
    expect(seed.connectionSettings).toHaveProperty('__studioRuntime');
    const prototypeSeed = apiSeed();
    const prototypeRuntime = prototypeSeed.connectionSettings.__studioRuntime as Record<string, JsonValue>;
    prototypeSeed.connectionSettings.__studioRuntime = { ...prototypeRuntime, persist: false };
    expect(shouldPersistPartnerProfileSeed(prototypeSeed)).toBe(false);
  });

  it('takes workspace changes from the Main-owned workspace store without waiting for renderer state', () => {
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: '' }, [apiSeed()]);
    catalog.updateWorkspace({
      partnerId: 'partner-api',
      cwd: { grantId: 'root-two', displayPath: 'K:\\root-two' },
      workspaces: [{ grantId: 'extra-two', displayPath: 'K:\\extra-two', source: 'manual' }],
      version: 2,
      unavailableGrantIds: [],
    });
    expect(catalog.partner('partner-api')?.runtime).toMatchObject({
      kind: 'api',
      connection: { primaryWorkspaceGrantId: 'root-two', workspaceGrantIds: ['root-two', 'extra-two'] },
    });
  });
});
