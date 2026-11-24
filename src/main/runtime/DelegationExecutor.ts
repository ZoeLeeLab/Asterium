import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExistingThreadConnection } from '../../shared/agentProtocol';
import { resolveCodexRuntime } from '../../shared/codexRuntimeSelection';
import { loadClaudeCliRuntime } from '../adapters/ClaudeCodeAdapter';
import { CyberBossBridgeClient, normalizeCyberBossServiceUrl } from '../adapters/CyberBossBridgeClient';
import type { ApiConnectionStore } from '../api/ApiConnectionStore';
import type { ApiProviderContentPart } from '../api/ApiProviderAdapter';
import type { ApiProviderRegistry } from '../api/ApiProviderRegistry';
import { type createApiRuntimeConfiguration, resolveApiAttachmentCapabilities } from '../api/ApiRuntimeConfiguration';
import type { ConversationDeletionService } from '../conversation/ConversationDeletionService';
import type { SingleChatMessageStore } from '../conversation/SingleChatMessageStore';
import { generateClaudeOneShot, generateCodexDelegation } from '../diary/DiaryGenerators';
import type { PartnerDiaryCatalog } from '../diary/PartnerDiaryCatalog';
import type { ConversationAttachmentStore } from '../security/ConversationAttachmentStore';
import type { CredentialStore } from '../security/CredentialStore';
import type { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
import { assertReadOnlyDelegation, delegationSystemPrompt, resolveDelegationAccess } from './DelegationAccess';
import { describeReviewFile, runExistingPartnerReview } from './ExistingPartnerReview';
import type { createLocalRuntimeResolver } from './LocalRuntimeResolver';
import type { DelegationBatch, DelegationTask } from './PartnerDelegation';

interface Dependencies {
  apiConnections: ApiConnectionStore;
  apiProviders: ApiProviderRegistry;
  configuredApiOptions: ReturnType<typeof createApiRuntimeConfiguration>;
  conversationDeletions: ConversationDeletionService;
  credentials: CredentialStore;
  diaryCatalog: PartnerDiaryCatalog;
  ensureClaudeInstallation: ReturnType<typeof createLocalRuntimeResolver>['ensureClaudeInstallation'];
  ensureCodexInstallation: ReturnType<typeof createLocalRuntimeResolver>['ensureCodexInstallation'];
  messageAttachments: ConversationAttachmentStore;
  singleChatMessages: SingleChatMessageStore;
  studioRuntimeCatalog: StudioRuntimeCatalog;
  temporaryDirectory: () => string;
}

export function createDelegationExecutor(dependencies: Dependencies) {
  const { apiConnections, apiProviders, configuredApiOptions, conversationDeletions, credentials, diaryCatalog, ensureClaudeInstallation, ensureCodexInstallation, messageAttachments, singleChatMessages, studioRuntimeCatalog, temporaryDirectory } = dependencies;
  async function executeDelegation(batch: DelegationBatch, task: DelegationTask, signal: AbortSignal) {
    assertReadOnlyDelegation(task.access);
    const partner = studioRuntimeCatalog.partner(task.targetPartnerId);
    if (!partner?.available || (partner.runtime.kind !== 'api' && partner.runtime.kind !== 'local')) throw new Error('DELEGATION_TARGET_UNAVAILABLE');
    if (await conversationDeletions.isDeleted(batch.conversationId)) throw new Error('DELEGATION_SOURCE_DELETED');
    const connection = partner.runtime.kind === 'api' ? await apiConnections.resolve(partner.partnerId, partner.runtime.connection) : undefined;
    if (task.connectionFingerprint && task.connectionFingerprint !== delegationConnectionFingerprint(connection ?? partner.runtime)) throw new Error('DELEGATION_CONNECTION_CHANGED');
    const capabilities = connection ? resolveApiAttachmentCapabilities(connection) : undefined;
    const codex = partner.runtime.kind === 'local' && partner.runtime.adapterType === 'codex_cli' ? partner.runtime : undefined;
    const imageLimit = codex ? codexDelegationImageLimit : capabilities?.maxImageBytes ?? 0;
    const parts: ApiProviderContentPart[] = [{ type: 'text', text: task.instruction }];
    let textLength = task.instruction.length;
    for (const id of task.attachmentIds) {
      const file = await messageAttachments.inspect(id, batch.conversationId);
      if (!file.sends.some(send => send.messageId === batch.messageId)) throw new Error('DELEGATION_ATTACHMENT_UNAVAILABLE');
      if (file.mediaType === 'image/png' || file.mediaType === 'image/jpeg') {
        if ((!codex && (!capabilities?.supportsImageInput || capabilities.attachmentTransport !== 'native_multimodal' || !capabilities.acceptedMimeTypes.includes(file.mediaType))) || file.sizeBytes > imageLimit) throw new Error('DELEGATION_IMAGE_UNSUPPORTED');
        const bytes = await messageAttachments.read(id, batch.conversationId);
        verifyDelegationMaterial(task, id, bytes);
        if (bytes.length > imageLimit) throw new Error('DELEGATION_IMAGE_UNSUPPORTED');
        parts.push({ type: 'image', mediaType: file.mediaType, data: bytes.toString('base64') });
      } else {
        if (!/\.(txt|md)$/iu.test(file.name) || file.sizeBytes > 160_000) throw new Error('DELEGATION_ATTACHMENT_UNSUPPORTED');
        const bytes = await messageAttachments.read(id, batch.conversationId);
        verifyDelegationMaterial(task, id, bytes);
        if (bytes.length > 160_000) throw new Error('DELEGATION_ATTACHMENT_UNSUPPORTED');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        textLength += text.length;
        if (textLength > 40_000) throw new Error('DELEGATION_TEXT_LIMIT');
        parts.push({ type: 'text', text: JSON.stringify({ attachment: file.name, text }) });
      }
    }
    const system = delegationSystemPrompt(partner.publicIdentity.displayName);
    const plainText = parts.map(part => part.type === 'text' ? part.text : '').join('\n\n');
    if (!connection) {
      if (codex) {
        const installation = await ensureCodexInstallation();
        const runtime = resolveCodexRuntime(installation.runtimes, codex.codexRuntimeId, codex.codexRuntimeEnvironment);
        if (!runtime?.loggedIn) throw new Error('DELEGATION_TARGET_UNAVAILABLE');
        const cwd = await mkdtemp(path.join(temporaryDirectory(), 'asterium-delegation-'));
        try {
          const images: string[] = [];
          for (const part of parts) {
            if (part.type !== 'image') continue;
            const file = path.join(cwd, `image-${images.length + 1}.${part.mediaType === 'image/png' ? 'png' : 'jpg'}`);
            await writeFile(file, Buffer.from(part.data, 'base64'), { flag: 'wx' });
            images.push(file);
          }
          if (await conversationDeletions.isDeleted(batch.conversationId)) throw new Error('DELEGATION_SOURCE_DELETED');
          signal.throwIfAborted();
          return await generateCodexDelegation({ executablePath: runtime.executablePath, cwd, source: plainText, bootstrap: '', signal, model: partner.recentModel?.model }, system, images);
        } finally {
          await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
      const installation = await ensureClaudeInstallation();
      if (!installation.executablePath || !installation.loggedIn) throw new Error('DELEGATION_TARGET_UNAVAILABLE');
      signal.throwIfAborted();
      if (await conversationDeletions.isDeleted(batch.conversationId)) throw new Error('DELEGATION_SOURCE_DELETED');
      const cwd = await mkdtemp(path.join(temporaryDirectory(), 'asterium-delegation-'));
      try {
        return await generateClaudeOneShot({ executablePath: installation.executablePath, cwd, source: plainText, bootstrap: '', signal, model: partner.recentModel?.model }, (await loadClaudeCliRuntime()).query, system, 20_000);
      } finally {
        await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {
          console.warn('Claude delegation temporary directory cleanup failed.');
        });
      }
    }
    const provider = apiProviders.normalizeConnection(connection);
    const options = await configuredApiOptions(connection);
    signal.throwIfAborted();
    if (await conversationDeletions.isDeleted(batch.conversationId)) throw new Error('DELEGATION_SOURCE_DELETED');
    const adapter = provider.definition.createAdapter({ ...options, endpoint: provider.endpoint, model: provider.model, thinkingMode: 'disabled' });
    let output = '';
    let finish = '';
    for await (const event of adapter.stream({ signal, tools: [], messages: [{ role: 'system', content: system }, { role: 'user', content: parts.some(part => part.type === 'image') ? parts : plainText }] })) {
      if (event.type === 'tool.delta') throw new Error('DELEGATION_TOOL_FORBIDDEN');
      if (event.type === 'finish') finish = event.reason;
      if (event.type === 'text.delta') output += event.text;
      if (output.length > 20_000) throw new Error('DELEGATION_OUTPUT_INVALID');
    }
    if (!['stop', 'end_turn', 'stop_sequence', 'STOP'].includes(finish)) throw new Error('DELEGATION_OUTPUT_INVALID');
    if (!output.trim()) throw new Error('DELEGATION_OUTPUT_INVALID');
    return output;
  }

  function verifyDelegationMaterial(task: DelegationTask, id: string, bytes: Buffer) {
    if (task.materials?.find(material => material.id === id)?.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('DELEGATION_ATTACHMENT_CHANGED');
  }

  function existingReviewConnection(partnerId: string) {
    const current = diaryCatalog.current(partnerId);
    return studioRuntimeCatalog.partner(partnerId)?.sourceMode === 'existing_thread'
      && current?.identity.available && current.existing?.threadId ? current.existing : undefined;
  }

  function reviewConnectionFingerprint(connection: ExistingThreadConnection) {
    return delegationConnectionFingerprint([normalizeCyberBossServiceUrl(connection.serviceUrl).origin, connection.credentialRef]);
  }

  async function reviewClient(connection: ExistingThreadConnection) {
    const secret = await credentials.get(connection.credentialRef);
    if (!secret) throw new Error('DELEGATION_REVIEW_UNAVAILABLE');
    return new CyberBossBridgeClient({ serviceUrl: connection.serviceUrl, secret });
  }

  async function assertReviewThread(client: CyberBossBridgeClient, threadId: string, signal: AbortSignal) {
    const capability = await client.reviewCapability(signal).catch(() => { throw new Error('DELEGATION_REVIEW_UNAVAILABLE'); });
    signal.throwIfAborted();
    if (capability.threadId !== threadId) throw new Error('DELEGATION_REVIEW_THREAD_CHANGED');
  }

  async function executeExistingReview(batch: DelegationBatch, task: DelegationTask, review: NonNullable<DelegationTask['review']>, signal: AbortSignal, lookupOnly: boolean) {
    if (await conversationDeletions.isDeleted(batch.conversationId)) throw new Error('DELEGATION_SOURCE_DELETED');
    const connection = existingReviewConnection(task.targetPartnerId);
    if (!connection || reviewConnectionFingerprint(connection) !== task.connectionFingerprint) {
      throw new Error(lookupOnly ? 'DELEGATION_REVIEW_UNCERTAIN' : 'DELEGATION_CONNECTION_CHANGED');
    }
    const client = await reviewClient(connection).catch(() => { throw new Error(lookupOnly ? 'DELEGATION_REVIEW_UNCERTAIN' : 'DELEGATION_REVIEW_UNAVAILABLE'); });
    const key = { requestId: review.requestId!, threadId: review.threadId };
    if (lookupOnly) return runExistingPartnerReview(client, key, undefined, signal);
    if (connection.threadId !== review.threadId) throw new Error('DELEGATION_REVIEW_THREAD_CHANGED');
    const material = task.materials?.[0];
    if (!material) throw new Error('DELEGATION_REVIEW_MARKDOWN_REQUIRED');
    const bytes = task.reviewDraft
      ? Buffer.from(task.reviewDraft.markdown, 'utf8')
      : await messageAttachments.read(material.id, batch.conversationId);
    verifyDelegationMaterial(task, material.id, bytes);
    const file = describeReviewFile(material.name, bytes);
    await assertReviewThread(client, review.threadId, signal);
    if (task.access === 'write') {
      const source = await singleChatMessages.getConversation(batch.conversationId);
      if (!source || source.partnerId !== batch.partnerId || source.isArchived || source.isDisabled) throw new Error('DELEGATION_SOURCE_UNAVAILABLE');
      resolveDelegationAccess('write', source);
    }
    if (await conversationDeletions.isDeleted(batch.conversationId)) throw new Error('DELEGATION_SOURCE_DELETED');
    const current = existingReviewConnection(task.targetPartnerId);
    if (!current || reviewConnectionFingerprint(current) !== task.connectionFingerprint) throw new Error('DELEGATION_CONNECTION_CHANGED');
    if (current.threadId !== review.threadId) throw new Error('DELEGATION_REVIEW_THREAD_CHANGED');
    return runExistingPartnerReview(client, key, { message: review.message, file, bytes }, signal);
  }
  return { executeDelegation, existingReviewConnection, reviewConnectionFingerprint, reviewClient, assertReviewThread, executeExistingReview };
}

export const codexDelegationImageLimit = 10 * 1024 * 1024;

export function delegationConnectionFingerprint(connection: unknown) {
  return createHash('sha256').update(JSON.stringify(connection)).digest('hex');
}
