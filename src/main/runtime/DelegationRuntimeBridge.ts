import { createHash, randomUUID } from 'node:crypto';
import { ConversationDeletionService } from '../conversation/ConversationDeletionService';
import { SingleChatMessageStore } from '../conversation/SingleChatMessageStore';
import { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
import { DelegationConversationRuntime } from './DelegationConversationRuntime';
import { DelegationResultDelivery } from './DelegationResultDelivery';
import { createMessageRuntime } from './MessageRuntime';
import { PartnerDelegation } from './PartnerDelegation';
import { RunCoordinator } from './RunCoordinator';
import { WriterLeaseCoordinator } from './WriterLeaseCoordinator';
interface Dependencies {
  nativeBindings: NativeThreadBindingStore;
  singleChatMessages: SingleChatMessageStore;
  conversationDeletions: ConversationDeletionService;
  studioRuntimeCatalog: StudioRuntimeCatalog;
  writerLeases: WriterLeaseCoordinator;
  automationWorkspaceSignature: (partnerId: string, projectId?: string) => Promise<string>;
  startApiRuntime: ReturnType<typeof createMessageRuntime>['startApiRuntime'];
  startLocalRuntime: ReturnType<typeof createMessageRuntime>['startLocalRuntime'];
  runCoordinator: RunCoordinator;
  delegation: PartnerDelegation;
}

/** Original-conversation delivery uses the same launch and writer paths as user input. */
export function createDelegationRuntimeBridge(dependencies: Dependencies) {
  const { nativeBindings, singleChatMessages, conversationDeletions, studioRuntimeCatalog, writerLeases, automationWorkspaceSignature, startApiRuntime, startLocalRuntime, runCoordinator, delegation } = dependencies;
  const conversation = new DelegationConversationRuntime({
    binding: (partnerId, conversationId) => nativeBindings.getForScope(partnerId, 'single', conversationId),
    source: id => singleChatMessages.getConversation(id), deleted: id => conversationDeletions.isDeleted(id),
    partner: id => studioRuntimeCatalog.partner(id), leases: writerLeases,
    workspaceSignature: async (partnerId, binding) => createHash('sha256').update(JSON.stringify({
      workspace: await automationWorkspaceSignature(partnerId), imported: binding.importedCodexWorkspace,
      runtime: studioRuntimeCatalog.partner(partnerId)?.runtime,
    })).digest('hex'),
    save: (conversationId, partnerId, message) => singleChatMessages.upsertMessage(conversationId, partnerId, message),
  });
  const resultConversation = conversation;
  const delivery = new DelegationResultDelivery(delegation, {
    prepare: (batch, underLease) => resultConversation.prepare(batch, underLease),
    start: async command => {
      const partner = studioRuntimeCatalog.partner(command.partnerId);
      if (!partner?.available || partner.runtime.kind === 'unsupported') throw new Error('DELEGATION_DELIVERY_DEFERRED');
      if (partner.runtime.kind === 'api') return startApiRuntime({ connection: partner.runtime.connection, command }, true);
      return startLocalRuntime({
        adapterType: partner.runtime.adapterType, partnerId: command.partnerId,
        partnerRootGrantId: partner.runtime.partnerRootGrantId, workspaceGrantIds: partner.runtime.workspaceGrantIds,
        codexRuntimeId: partner.runtime.codexRuntimeId, codexRuntimeEnvironment: partner.runtime.codexRuntimeEnvironment, command
      }, true);
    },
    cancel: (command, receipt) => runCoordinator.cancel({
      ...command, type: 'run.cancel', commandId: 'delegation-cancel:' + randomUUID(),
      runId: receipt.runId, sessionId: receipt.sessionId, reason: '用户消息优先'
    }),
    saveReply: (batch, event, text, completed) => resultConversation.saveReply(batch, event, text, completed),
  });
  return { conversation, delivery };
}
