import { createHash } from 'node:crypto';
import {
  type SendMessageCommand
} from '../../shared/agentProtocol';
import { REVIEW_MARKDOWN_MAX_BYTES } from '../../shared/existingPartnerReview';
import { ApiConnectionStore } from '../api/ApiConnectionStore';
import { resolveApiAttachmentCapabilities } from '../api/ApiRuntimeConfiguration';
import { ConversationDeletionService } from '../conversation/ConversationDeletionService';
import { ArtifactRegistry } from '../security/ArtifactRegistry';
import { ConversationAttachmentStore } from '../security/ConversationAttachmentStore';
import { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
import { assertReadOnlyDelegation, resolveDelegationAccess } from './DelegationAccess';
import { DelegationConversationRuntime } from './DelegationConversationRuntime';
import { codexDelegationImageLimit, createDelegationExecutor, delegationConnectionFingerprint } from './DelegationExecutor';
import { describeReviewFile, existingPartnerReviewMessage, snapshotReviewArtifact } from './ExistingPartnerReview';
import { PartnerDelegation, delegationInput, delegationWaitInput } from './PartnerDelegation';
interface Dependencies {
  apiConnections: ApiConnectionStore;
  artifacts: ArtifactRegistry;
  assertReviewThread: ReturnType<typeof createDelegationExecutor>['assertReviewThread'];
  conversationDeletions: ConversationDeletionService;
  delegation: PartnerDelegation;
  delegationHandles: { conversation?: DelegationConversationRuntime };
  existingReviewConnection: ReturnType<typeof createDelegationExecutor>['existingReviewConnection'];
  messageAttachments: ConversationAttachmentStore;
  reviewClient: ReturnType<typeof createDelegationExecutor>['reviewClient'];
  reviewConnectionFingerprint: ReturnType<typeof createDelegationExecutor>['reviewConnectionFingerprint'];
  studioRuntimeCatalog: StudioRuntimeCatalog;
}

export function createDelegationToolHandler(dependencies: Dependencies) {
  const { apiConnections, artifacts, assertReviewThread, conversationDeletions, delegation, delegationHandles, existingReviewConnection, messageAttachments, reviewClient, reviewConnectionFingerprint, studioRuntimeCatalog } = dependencies;
  return (command: SendMessageCommand) => async (tool: string, input: Record<string, unknown>, signal: AbortSignal, toolCallId?: string) => {
    signal.throwIfAborted();
    if (await conversationDeletions.isDeleted(command.conversationId)) throw new Error('DELEGATION_SOURCE_DELETED');
    const owner = { conversationId: command.conversationId, partnerId: command.partnerId, turnId: command.clientMessageId, messageId: command.sourceMessage!.messageId };
    if (tool === 'wait_delegate_tasks') return JSON.stringify(await delegation.wait(owner, delegationWaitInput.parse(input).batchId, signal));
    const targets = studioRuntimeCatalog.allPartners().filter(partner => partner.partnerId !== owner.partnerId
      && (partner.available || existingReviewConnection(partner.partnerId)));
    if (tool === 'list_delegate_partners') {
      const available = await Promise.all(targets.map(async partner => {
        const identity = { id: partner.partnerId, name: partner.publicIdentity.displayName };
        if (partner.sourceMode === 'existing_thread') {
          const connection = existingReviewConnection(partner.partnerId);
          if (!connection) return undefined;
          try {
            await assertReviewThread(await reviewClient(connection), connection.threadId, signal);
            const canWrite = command.execution?.permissionMode !== 'read_only' && command.execution?.planMode !== 'plan';
            return { ...identity, kind: 'existing_thread', materials: ['markdown_file'], accessModes: canWrite ? ['read', 'write'] : ['read'] };
          } catch { return undefined; }
        }
        const codex = partner.runtime.kind === 'local' && partner.runtime.adapterType === 'codex_cli';
        const images = codex || (partner.runtime.kind === 'api' && resolveApiAttachmentCapabilities(await apiConnections.resolve(partner.partnerId, partner.runtime.connection)).supportsImageInput);
        return { ...identity, accessModes: ['read'], materials: images ? ['text', 'png', 'jpeg'] : ['text'], ...(codex ? { fileReadBoundary: 'host_read_access' } : {}) };
      }));
      signal.throwIfAborted();
      return JSON.stringify(available.filter(Boolean));
    }
    if (tool !== 'delegate_tasks') throw new Error('DELEGATION_TOOL_FORBIDDEN');
    const parsed = delegationInput.parse(input);
    const attachmentIds = new Set(command.attachments?.map(attachment => attachment.id));
    const requestId = toolCallId ?? createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
    const destination = await delegationHandles.conversation?.capture(command);
    const batch = await delegation.submit(owner, requestId, parsed, async task => {
      signal.throwIfAborted();
      const target = targets.find(item => item.partnerId === task.targetPartnerId);
      if (!target) throw new Error('DELEGATION_TARGET_UNAVAILABLE');
      const access = resolveDelegationAccess(task.access, command.execution);
      if (target.sourceMode === 'existing_thread') {
        const connection = existingReviewConnection(target.partnerId);
        if (!connection) throw new Error('DELEGATION_REVIEW_UNAVAILABLE');
        if (parsed.tasks.length !== 1) throw new Error('DELEGATION_REVIEW_SINGLE_TARGET');
        if (task.attachmentIds.length + Number(Boolean(task.reviewDraft)) + Number(Boolean(task.reviewArtifactId)) !== 1) throw new Error('DELEGATION_REVIEW_MARKDOWN_REQUIRED');
        const id = task.reviewArtifactId ?? (task.reviewDraft ? 'review-draft' : task.attachmentIds[0]);
        let reviewDraft = task.reviewDraft;
        let file;
        if (task.reviewArtifactId) {
          const snapshot = await snapshotReviewArtifact(artifacts, task.reviewArtifactId, owner, signal);
          file = snapshot.file;
          reviewDraft = snapshot.draft;
        } else if (reviewDraft) {
          file = describeReviewFile(reviewDraft.name, Buffer.from(reviewDraft.markdown, 'utf8'));
        } else {
          if (!attachmentIds.has(id)) throw new Error('DELEGATION_ATTACHMENT_UNAVAILABLE');
          const attachment = await messageAttachments.inspect(id, owner.conversationId);
          if (!attachment.sends.some(send => send.messageId === owner.messageId)) throw new Error('DELEGATION_ATTACHMENT_UNAVAILABLE');
          if (attachment.sizeBytes > REVIEW_MARKDOWN_MAX_BYTES) throw new Error('DELEGATION_REVIEW_FILE_SIZE');
          file = describeReviewFile(attachment.name, await messageAttachments.read(id, owner.conversationId));
        }
        const sender = studioRuntimeCatalog.partner(owner.partnerId)?.publicIdentity.displayName ?? '伙伴';
        const message = existingPartnerReviewMessage(sender, task.instruction, command.sourceMessage!.content, file.name, studioRuntimeCatalog.user().displayName || '用户', access);
        signal.throwIfAborted();
        return { materials: [{ id, name: file.name, sha256: file.sha256 }], connectionFingerprint: reviewConnectionFingerprint(connection), review: { threadId: connection.threadId, message }, reviewDraft };
      }
      assertReadOnlyDelegation(task.access);
      if (task.reviewDraft || task.reviewArtifactId) throw new Error('DELEGATION_REVIEW_UNAVAILABLE');
      const connection = target.runtime.kind === 'api' ? await apiConnections.resolve(target.partnerId, target.runtime.connection) : undefined;
      const caps = connection ? resolveApiAttachmentCapabilities(connection) : undefined;
      const materials = [];
      for (const id of new Set(task.attachmentIds)) {
        if (!attachmentIds.has(id)) throw new Error('DELEGATION_ATTACHMENT_UNAVAILABLE');
        const file = await messageAttachments.inspect(id, owner.conversationId);
        if (!file.sends.some(send => send.messageId === owner.messageId)) throw new Error('DELEGATION_ATTACHMENT_UNAVAILABLE');
        if (file.mediaType === 'image/png' || file.mediaType === 'image/jpeg') {
          const isCodex = target.runtime.kind === 'local' && target.runtime.adapterType === 'codex_cli';
          const supported = isCodex ? file.sizeBytes <= codexDelegationImageLimit : caps?.supportsImageInput && caps.attachmentTransport === 'native_multimodal' && caps.acceptedMimeTypes.includes(file.mediaType) && file.sizeBytes <= caps.maxImageBytes;
          if (!supported) throw new Error('DELEGATION_IMAGE_UNSUPPORTED');
        } else if (!/\.(txt|md)$/iu.test(file.name) || file.sizeBytes > 160_000) throw new Error('DELEGATION_ATTACHMENT_UNSUPPORTED');
        const bytes = await messageAttachments.read(id, owner.conversationId);
        materials.push({ id, name: file.name, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      signal.throwIfAborted();
      return { materials, connectionFingerprint: delegationConnectionFingerprint(connection ?? target.runtime) };
    }, destination);
    return JSON.stringify({ id: batch.id, tasks: batch.tasks.map(task => ({ id: task.id, targetPartnerId: task.targetPartnerId, status: task.status, reason: task.reason })) });
  };
}
