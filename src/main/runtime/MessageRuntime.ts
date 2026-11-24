import { createHash } from 'node:crypto';
import {
  type SendMessageCommand,
  type SendMessageReceipt
} from '../../shared/agentProtocol';
import { CODEX_IMPORTED_DIRECTORY_UNAVAILABLE } from '../../shared/codexThreadImport';
import { sameCodexPath } from '../adapters/codexSessionFile';
import { ApiConnectionStore } from '../api/ApiConnectionStore';
import type { ApiProviderRegistry } from '../api/ApiProviderRegistry';
import { createApiRuntimeConfiguration, resolveApiAttachmentCapabilities } from '../api/ApiRuntimeConfiguration';
import { SingleChatMessageStore } from '../conversation/SingleChatMessageStore';
import { type ApiSendRequest, type LocalCliSendRequest } from '../ipc/runInteractionIpc';
import { ConversationAttachmentStore } from '../security/ConversationAttachmentStore';
import { PartnerWorkspaceStore } from '../security/PartnerWorkspaceStore';
import type { AsteriumRuntimeToolController } from './AsteriumRuntimeTools';
import type { createLegacyRunPath } from './LegacyRunPath';
import { createLocalRuntimeResolver, resolveProjectRuntimeRoot } from './LocalRuntimeResolver';
import { PartnerRuntimeFactory, localRuntimeAdapterKey } from './PartnerRuntimeFactory';
import { RunCoordinator } from './RunCoordinator';
import { SessionBootstrapService } from './SessionBootstrapService';
interface Dependencies {
  apiConnections: ApiConnectionStore;
  apiProviders: ApiProviderRegistry;
  attachAutomationCommand: (command: SendMessageCommand) => Promise<void>;
  availableImportedDirectory: ReturnType<typeof createLocalRuntimeResolver>['availableImportedDirectory'];
  configuredApiOptions: ReturnType<typeof createApiRuntimeConfiguration>;
  ensureClaudeInstallation: ReturnType<typeof createLocalRuntimeResolver>['ensureClaudeInstallation'];
  hydrateManagedRuntimeProfile: SessionBootstrapService['prepare'];
  importedCodexBinding: ReturnType<typeof createLocalRuntimeResolver>['importedCodexBinding'];
  messageAttachments: ConversationAttachmentStore;
  partnerWorkspaces: PartnerWorkspaceStore;
  protectedRoots: string[];
  resolveImportedCodexRuntime: ReturnType<typeof createLocalRuntimeResolver>['resolveImportedCodexRuntime'];
  resolveSelectedCodexRuntime: ReturnType<typeof createLocalRuntimeResolver>['resolveSelectedCodexRuntime'];
  resolveWorkspaceGrant: ReturnType<typeof createLocalRuntimeResolver>['resolveWorkspaceGrant'];
  runCoordinator: RunCoordinator;
  runtimeFactory: PartnerRuntimeFactory;
  runtimeToolsFor: (command: SendMessageCommand, memoryMode?: string) => AsteriumRuntimeToolController;
  singleChatMessages: SingleChatMessageStore;
  startAdapterRun: ReturnType<typeof createLegacyRunPath>['startAdapterRun'];
  useLegacyRunPath: boolean;
}

export function createMessageRuntime(dependencies: Dependencies) {
  const { apiConnections, apiProviders, attachAutomationCommand, availableImportedDirectory, configuredApiOptions, ensureClaudeInstallation, hydrateManagedRuntimeProfile, importedCodexBinding, messageAttachments, partnerWorkspaces, protectedRoots, resolveImportedCodexRuntime, resolveSelectedCodexRuntime, resolveWorkspaceGrant, runCoordinator, runtimeFactory, runtimeToolsFor, singleChatMessages, startAdapterRun, useLegacyRunPath } = dependencies;
  function handoffFingerprint(command: SendMessageCommand) {
    return command.contextHandoff ? createHash('sha256').update(JSON.stringify(command.contextHandoff)).digest('hex') : undefined;
  }

  async function startApiRuntime(request: ApiSendRequest, background = false) {
    await attachAutomationCommand(request.command);
    request = { ...request, connection: await apiConnections.resolve(request.command.partnerId, request.connection) };
    request.command = await messageAttachments.prepareSend(request.command, protectedRoots);
    if (request.command.sourceMessage) await singleChatMessages.upsertMessage(request.command.conversationId, request.command.partnerId, request.command.sourceMessage);
    const storedProfile = await hydrateManagedRuntimeProfile(request.command);
    if (request.command.runtimeContext) request.command.runtimeContext = { ...request.command.runtimeContext, runtime: { ...request.command.runtimeContext?.runtime, source: 'api_partner', provider: request.connection.provider, model: request.connection.model } };
    apiProviders.require(request.connection.provider);
    const attachmentCapabilities = resolveApiAttachmentCapabilities(request.connection);
    const normalizedProvider = apiProviders.normalizeConnection(request.connection);
    const apiOptions = await configuredApiOptions(request.connection);
    const fingerprint = JSON.stringify({
      connection: request.connection,
      command: { ...request.command, sessionBootstrap: undefined, sessionBootstrapVersion: undefined, contextHandoff: handoffFingerprint(request.command) },
    });
    return runCoordinator.runIdempotent(request.command.clientMessageId, fingerprint, async () => {
      let primaryDirectory: string | undefined;
      let additionalDirectories: string[] = [];
      if (request.projectRootOverride) {
        primaryDirectory = await resolveProjectRuntimeRoot(request.projectRootOverride, protectedRoots);
      } else {
        await partnerWorkspaces.ensure(request.command.partnerId, request.connection.primaryWorkspaceGrantId, request.connection.workspaceGrantIds ?? []);
        const partnerBindings = await partnerWorkspaces.grantIds(request.command.partnerId);
        const grantIds = [...new Set(partnerBindings?.workspaceGrantIds ?? request.connection.workspaceGrantIds ?? [])];
        const primaryGrantId = partnerBindings?.cwdGrantId ?? request.connection.primaryWorkspaceGrantId;
        primaryDirectory = primaryGrantId ? await resolveWorkspaceGrant(primaryGrantId) : undefined;
        if (primaryGrantId && !primaryDirectory) throw new Error('WORKSPACE_GRANT_REQUIRED');
        const resolvedDirectories = await Promise.all(grantIds.map((grantId) => resolveWorkspaceGrant(grantId)));
        if (resolvedDirectories.some((directory) => !directory)) throw new Error('WORKSPACE_GRANT_REQUIRED');
        additionalDirectories = resolvedDirectories.filter((directory): directory is string => Boolean(directory && directory !== primaryDirectory));
      }
      const adapter = runtimeFactory.createApi({
        command: request.command,
        provider: normalizedProvider.definition.id,
        endpoint: normalizedProvider.endpoint,
        model: normalizedProvider.model,
        ...apiOptions,
        bindingKey: request.connection.bindingKey,
        toolsEnabled: background ? false : request.connection.toolsEnabled,
        thinkingMode: request.connection.thinkingMode ?? 'auto',
        reasoningEffort: request.connection.reasoningEffort ?? 'high',
        primaryDirectory,
        additionalDirectories,
        attachmentCapabilities,
        runtimeTools: runtimeToolsFor(request.command, storedProfile?.management.memoryMode),
      });
      return useLegacyRunPath
        ? startAdapterRun(adapter, request.command, true, primaryDirectory)
        : runCoordinator.start(adapter, request.command, { disposeAfter: true, artifactBaseDirectory: primaryDirectory, waitForWriter: !background });
    });
  }

  async function startLocalRuntime(request: LocalCliSendRequest, background = false) {
    if (request.command.execution?.codexModel && (request.adapterType !== 'codex_cli'
      || (request.command.route && request.command.route.scope !== 'single'))) throw new Error('CODEX_MODEL_SELECTION_UNAVAILABLE');
    const imported = !request.command.route || request.command.route.scope === 'single'
      ? await importedCodexBinding(request.command.partnerId, request.command.conversationId, request.command.sessionId) : undefined;
    const importedDirectory = imported && await availableImportedDirectory(imported.workspace.directory, imported.workspace.canonicalDirectory);
    if (imported && !importedDirectory) throw new Error(CODEX_IMPORTED_DIRECTORY_UNAVAILABLE);
    if (imported && (request.adapterType !== 'codex_cli' || !request.command.sessionId || request.command.forkFromTurnId)) throw new Error('CODEX_IMPORTED_THREAD_MISMATCH');
    await attachAutomationCommand(request.command);
    request.command = await messageAttachments.prepareSend(request.command, protectedRoots);
    if (request.command.sourceMessage) await singleChatMessages.upsertMessage(request.command.conversationId, request.command.partnerId, request.command.sourceMessage);
    const storedProfile = await hydrateManagedRuntimeProfile(request.command);
    let partnerRoot: string;
    let grantIds: string[] = [];
    let additionalDirectories: string[] = [];
    if (importedDirectory) {
      partnerRoot = importedDirectory;
    } else if (request.projectRootOverride) {
      partnerRoot = await resolveProjectRuntimeRoot(request.projectRootOverride, protectedRoots);
    } else {
      if (!request.partnerRootGrantId) throw new Error('PARTNER_ROOT_GRANT_REQUIRED');
      await partnerWorkspaces.ensure(request.command.partnerId, request.partnerRootGrantId, request.workspaceGrantIds);
      const partnerBindings = await partnerWorkspaces.grantIds(request.command.partnerId);
      grantIds = [...new Set(partnerBindings?.workspaceGrantIds ?? request.workspaceGrantIds)];
      const workingDirectories = await Promise.all(grantIds.map((grantId) => resolveWorkspaceGrant(grantId)));
      if (workingDirectories.some((directory) => !directory)) throw new Error('WORKSPACE_GRANT_REQUIRED');
      const partnerRootGrantId = partnerBindings?.cwdGrantId ?? request.partnerRootGrantId;
      const resolvedPartnerRoot = await resolveWorkspaceGrant(partnerRootGrantId);
      if (!resolvedPartnerRoot) throw new Error('PARTNER_ROOT_GRANT_REQUIRED');
      partnerRoot = resolvedPartnerRoot;
      additionalDirectories = workingDirectories.filter((directory): directory is string => Boolean(directory && directory !== partnerRoot));
    }
    let executablePath: string;
    let resolvedCodexRuntimeId = request.codexRuntimeId;
    if (request.adapterType === 'codex_cli') {
      const runtime = imported ? await resolveImportedCodexRuntime(imported.workspace)
        : await resolveSelectedCodexRuntime(request.codexRuntimeId, request.codexRuntimeEnvironment);
      executablePath = runtime.executablePath;
      resolvedCodexRuntimeId = runtime.runtimeId;
    } else {
      const installation = await ensureClaudeInstallation();
      if (!installation.executablePath) throw new Error('CLAUDE_NOT_FOUND');
      if (!installation.loggedIn) throw new Error('CLAUDE_NOT_LOGGED_IN');
      executablePath = installation.executablePath;
    }

    const fingerprint = JSON.stringify({
      adapterType: request.adapterType,
      codexRuntimeId: resolvedCodexRuntimeId,
      partnerId: request.command.partnerId,
      conversationId: request.command.conversationId,
      connectionSource: request.command.connectionSource,
      sessionId: request.command.sessionId,
      forkFromTurnId: request.command.forkFromTurnId,
      content: request.command.content,
      contextHandoff: handoffFingerprint(request.command),
      execution: request.command.execution,
      attachments: request.command.attachments,
      partnerRootGrantId: request.partnerRootGrantId,
      workspaceGrantIds: grantIds,
      projectRootOverride: request.projectRootOverride,
      importedDirectory,
    });
    return runCoordinator.runIdempotent(request.command.clientMessageId, fingerprint, async (): Promise<SendMessageReceipt> => {
      const adapterKey = localRuntimeAdapterKey({
        adapterType: request.adapterType,
        runtimeId: resolvedCodexRuntimeId,
        partnerId: request.command.partnerId,
        conversationId: request.command.conversationId,
        partnerRoot,
        additionalDirectories,
      });
      const runtimeTools = runtimeToolsFor(request.command, storedProfile?.management.memoryMode);
      const adapter = runtimeFactory.getLocal({
        adapterType: request.adapterType,
        adapterKey,
        executablePath,
        partnerRoot,
        additionalDirectories,
        runtimeTools,
        deferRuntimeConfiguration: true,
        importedCodexThread: Boolean(imported),
      });
      const validateBeforeStart = async () => {
        if (imported) {
          const { partnerId, conversationId, sessionId } = request.command;
          const current = await importedCodexBinding(partnerId, conversationId, sessionId);
          const directory = current && await availableImportedDirectory(current.workspace.directory, current.workspace.canonicalDirectory);
          if (!directory || !sameCodexPath(directory, partnerRoot)) throw new Error(CODEX_IMPORTED_DIRECTORY_UNAVAILABLE);
        }
        // Reuse the original native session and apply this turn's handlers only
        // after obtaining its writer lease. A queued user turn must restore its
        // own controller rather than inherit the background report's tools.
        adapter.replaceRuntimeTools?.(runtimeTools);
        adapter.replaceRuntimeWorkspaceRoots?.(additionalDirectories);
        adapter.updateRuntimeContext?.(request.command);
      };
      return useLegacyRunPath
        ? startAdapterRun(adapter, request.command, Boolean(imported), partnerRoot, validateBeforeStart)
        : runCoordinator.start(adapter, request.command, { artifactBaseDirectory: partnerRoot, disposeAfter: Boolean(imported), validateBeforeStart, waitForWriter: !background });
    });
  }
  return { startApiRuntime, startLocalRuntime };
}
