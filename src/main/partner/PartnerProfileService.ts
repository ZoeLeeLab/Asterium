import type { PartnerProfileSeed } from '../../shared/agentProtocol';
import type { ApiConnectionStore } from '../api/ApiConnectionStore';
import type { McpConnectionManager } from '../api/extensions/McpConnectionManager';
import type { PartnerDiaryCatalog } from '../diary/PartnerDiaryCatalog';
import type { PartnerDiaryService } from '../diary/PartnerDiaryService';
import type { PartnerDiaryScheduler } from '../diary/PartnerDiaryScheduler';
import type { MemoryFallbackInventory } from '../memory/fallback/MemoryFallbackInventory';
import type { MemoryFallbackScheduler } from '../memory/fallback/MemoryFallbackScheduler';
import type { ProjectTaskOrchestrator } from '../project/ProjectTaskOrchestrator';
import type { PartnerRuntimePort } from '../runtime/PartnerRuntimePort';
import { persistedPartnerProfileSeed, shouldPersistPartnerProfileSeed, type StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
import type { PartnerProfileStore } from './PartnerProfileStore';

interface PartnerProfileServiceOptions {
  prepareMemoryStorage: () => Promise<unknown>;
  studioRuntimeCatalog: Pick<StudioRuntimeCatalog, 'sync' | 'upsert' | 'partner'>;
  apiConnections: Pick<ApiConnectionStore, 'migrateLegacy'>;
  mcpConnections: Pick<McpConnectionManager, 'reconcilePartners'>;
  diaryCatalog: Pick<PartnerDiaryCatalog, 'sync' | 'upsert'>;
  wakeReadinessChanged: () => void;
  partnerProfiles: Pick<PartnerProfileStore, 'sync' | 'savePartner' | 'trashPartnerDirectory'>;
  restoreBackgroundServices: boolean;
  memoryFallbackInventory: Pick<MemoryFallbackInventory, 'activate' | 'refresh'>;
  memoryFallbackScheduler: Pick<MemoryFallbackScheduler, 'start'>;
  diaries: Pick<PartnerDiaryService, 'recover'>;
  diaryScheduler: Pick<PartnerDiaryScheduler, 'start' | 'changed'>;
  projectTaskOrchestrator: Pick<ProjectTaskOrchestrator, 'activate'>;
  partnerRuntimePort: PartnerRuntimePort;
  trashItem: (directory: string) => Promise<void>;
}

export class PartnerProfileService {
  constructor(private readonly options: PartnerProfileServiceOptions) {}

  async sync(value: { user: Parameters<PartnerProfileStore['sync']>[0]; partners: PartnerProfileSeed[] }) {
    const { prepareMemoryStorage, studioRuntimeCatalog, apiConnections, mcpConnections, diaryCatalog, wakeReadinessChanged,
      partnerProfiles, restoreBackgroundServices, memoryFallbackInventory, memoryFallbackScheduler,
      diaries, diaryScheduler, projectTaskOrchestrator, partnerRuntimePort } = this.options;
    await prepareMemoryStorage();
    studioRuntimeCatalog.sync(value.user, value.partners);
    for (const seed of value.partners) {
      const runtime = studioRuntimeCatalog.partner(seed.partnerId)?.runtime;
      if (runtime?.kind === 'api' && runtime.connection.credentialRef && shouldPersistPartnerProfileSeed(seed) && studioRuntimeCatalog.partner(seed.partnerId)?.available) await apiConnections.migrateLegacy(seed.partnerId, runtime.connection);
    }
    await mcpConnections.reconcilePartners();
    diaryCatalog.sync(value.partners);
    wakeReadinessChanged();
    const profiles = await partnerProfiles.sync(value.user, value.partners.filter(shouldPersistPartnerProfileSeed).map(persistedPartnerProfileSeed));
    if (restoreBackgroundServices) {
      await memoryFallbackInventory.activate();
      await memoryFallbackScheduler.start();
      await diaries.recover(); await diaryScheduler.start(); await diaryScheduler.changed();
      await projectTaskOrchestrator.activate(partnerRuntimePort);
    }
    return profiles;
  }

  async save(value: PartnerProfileSeed) {
    const { prepareMemoryStorage, partnerProfiles, studioRuntimeCatalog, apiConnections, mcpConnections,
      diaryCatalog, wakeReadinessChanged, memoryFallbackInventory, diaryScheduler } = this.options;
    await prepareMemoryStorage();
    const saved = await partnerProfiles.savePartner(persistedPartnerProfileSeed(value));
    studioRuntimeCatalog.upsert(value);
    const runtime = studioRuntimeCatalog.partner(value.partnerId)?.runtime;
    if (runtime?.kind === 'api' && runtime.connection.credentialRef && shouldPersistPartnerProfileSeed(value) && studioRuntimeCatalog.partner(value.partnerId)?.available) await apiConnections.migrateLegacy(value.partnerId, runtime.connection, true);
    await mcpConnections.reconcilePartners(value.partnerId);
    diaryCatalog.upsert(value);
    wakeReadinessChanged();
    await memoryFallbackInventory.refresh();
    await diaryScheduler.changed();
    return saved;
  }

  async trash(partnerId: string) {
    const { prepareMemoryStorage, partnerProfiles, trashItem } = this.options;
    await prepareMemoryStorage();
    return partnerProfiles.trashPartnerDirectory(partnerId, (directory) => trashItem(directory));
  }
}
