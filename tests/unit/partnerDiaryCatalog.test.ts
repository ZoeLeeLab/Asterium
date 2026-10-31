import { describe, expect, it } from 'vitest';
import { PartnerDiaryCatalog } from '../../src/main/diary/PartnerDiaryCatalog';
import type { PartnerProfileSeed } from '../../src/shared/agentProtocol';

describe('diary upstream identity', () => {
  it('observes upstream thread changes without mutating the supplied partner profile', () => {
    const seed: PartnerProfileSeed = {
      partnerId: 'p', sourceMode: 'existing_thread', publicIdentity: { displayName: 'test', introduction: '', expertise: '', mentionName: 'test' },
      management: { userProfile: false, personality: false, memoryMode: 'none' },
      connectionSettings: { threadId: 'old', serviceUrl: 'https://diary-test.example', __diaryRuntime: { available: true, credentialRef: 'ref' } },
    };
    const catalog = new PartnerDiaryCatalog({ partner: () => undefined }); catalog.sync([seed]);
    catalog.observeThread('p', 'new', 'new-root');
    expect(catalog.identity('p')).toMatchObject({ available: true, threadId: 'new' });
    expect(catalog.current('p')?.existing).toMatchObject({ threadId: 'new', workspaceRoot: 'new-root' });
    expect(seed.connectionSettings.threadId).toBe('old');
  });
});
