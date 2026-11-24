import type { ConversationDeleteRequest } from '../../shared/conversationLifecycle';
import type { PartnerDiarySettingsStore } from '../diary/PartnerDiarySettingsStore';
import type { PartnerDiaryScheduler } from '../diary/PartnerDiaryScheduler';
import type { MemoryFallbackInventory } from '../memory/fallback/MemoryFallbackInventory';
import type { PartnerDelegation } from '../runtime/PartnerDelegation';
import type { WriterLeaseCoordinator } from '../runtime/WriterLeaseCoordinator';
import type { ConversationDeletionService } from './ConversationDeletionService';

interface ConversationLifecycleOptions {
  cancelDelegation: (conversationId: string) => Promise<boolean>;
  writerLeases: Pick<WriterLeaseCoordinator, 'acquire' | 'tryAcquire'>;
  conversationDeletions: Pick<ConversationDeletionService, 'delete'>;
  delegation: Pick<PartnerDelegation, 'remove'>;
  diarySettings: Pick<PartnerDiarySettingsStore, 'reconcileSources'>;
  diaryScheduler: Pick<PartnerDiaryScheduler, 'changed'>;
  memoryFallbackInventory: Pick<MemoryFallbackInventory, 'refresh'>;
}

/** Coordinates deletion with existing writers and downstream sources; owns no storage or timers. */
export class ConversationLifecycleService {
  constructor(private readonly options: ConversationLifecycleOptions) {}

  async delete(request: ConversationDeleteRequest) {
    const { cancelDelegation, writerLeases, conversationDeletions, delegation, diarySettings, diaryScheduler, memoryFallbackInventory } = this.options;
    const scope = { kind: 'conversation' as const, partnerId: request.partnerId, conversationId: request.conversationId };
    const report = await cancelDelegation(request.conversationId);
    const lease = report
      ? await writerLeases.acquire(scope, `delete:${request.conversationId}`)
      : writerLeases.tryAcquire(scope, `delete:${request.conversationId}`);
    if (!lease) throw new Error('COMPACT_CONVERSATION_BUSY');
    const result = await (async () => {
      const result = await conversationDeletions.delete(request);
      await delegation.remove(request.conversationId);
      return result;
    })().finally(() => lease.release());
    await diarySettings.reconcileSources(); await diaryScheduler.changed();
    await memoryFallbackInventory.refresh();
    return result;
  }
}
