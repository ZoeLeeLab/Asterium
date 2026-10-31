import type { PartnerProfileSeed, ExistingThreadConnection } from '../../shared/agentProtocol';
import type { StudioRuntimeCatalog, StudioPartnerRecord } from '../studio/StudioRuntimeCatalog';
import type { DiaryPartnerIdentity } from './PartnerDiarySettingsStore';

export class PartnerDiaryCatalog {
  private readonly seeds = new Map<string, PartnerProfileSeed>();
  constructor(private readonly runtime: Pick<StudioRuntimeCatalog, 'partner'>) {}
  sync(seeds: PartnerProfileSeed[]) { this.seeds.clear(); for (const seed of seeds) this.upsert(seed); }
  upsert(seed: PartnerProfileSeed) { this.seeds.set(seed.partnerId, structuredClone(seed)); }
  observeThread(partnerId: string, threadId: string, workspaceRoot: string) {
    const seed = this.seeds.get(partnerId);
    if (seed?.sourceMode === 'existing_thread') seed.connectionSettings = { ...seed.connectionSettings, threadId, workspaceRoot };
  }
  identity(partnerId: string): DiaryPartnerIdentity | undefined {
    const seed = this.seeds.get(partnerId); if (!seed) return undefined;
    const raw = seed.connectionSettings.__diaryRuntime;
    const available = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && raw.available === true;
    return { sourceMode: seed.sourceMode, available: seed.sourceMode === 'existing_thread' ? available : Boolean(this.runtime.partner(partnerId)?.available),
      ...(seed.sourceMode === 'existing_thread' && typeof seed.connectionSettings.threadId === 'string' ? { threadId: seed.connectionSettings.threadId } : {}) };
  }
  current(partnerId: string): { identity: DiaryPartnerIdentity; runtime?: StudioPartnerRecord; existing?: ExistingThreadConnection } | undefined {
    const identity = this.identity(partnerId); const seed = this.seeds.get(partnerId); if (!identity || !seed) return undefined;
    const raw = seed.connectionSettings.__diaryRuntime;
    const ref = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw.credentialRef : undefined;
    const settings = seed.connectionSettings;
    if (seed.sourceMode === 'existing_thread' && typeof settings.serviceUrl === 'string' && typeof settings.threadId === 'string' && typeof ref === 'string') return { identity,
      existing: { serviceUrl: settings.serviceUrl, threadId: settings.threadId, credentialRef: ref, ...(typeof settings.workspaceRoot === 'string' ? { workspaceRoot: settings.workspaceRoot } : {}) } };
    return { identity, runtime: this.runtime.partner(partnerId) };
  }
}
