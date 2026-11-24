import { CODEX_IMPORTED_DIRECTORY_UNAVAILABLE } from '../../shared/codexThreadImport';
import { AdapterHost } from '../AdapterHost';
import type { PartnerAdapter } from '../adapters/PartnerAdapter';
import { ApiAgentSessionStore } from '../api/ApiAgentSessionStore';
import { ApiConnectionStore } from '../api/ApiConnectionStore';
import type { ApiProviderRegistry } from '../api/ApiProviderRegistry';
import { createApiRuntimeConfiguration } from '../api/ApiRuntimeConfiguration';
import { compactApiSession } from '../api/ApiSessionCompactor';
import { confirmProfileReload } from '../api/confirmProfileReload';
import { ConversationDeletionService } from '../conversation/ConversationDeletionService';
import { SingleChatMessageStore } from '../conversation/SingleChatMessageStore';
import { PartnerProfileStore } from '../partner/PartnerProfileStore';
import { createLocalRuntimeResolver } from './LocalRuntimeResolver';
import { NativeProfileReloadError, confirmNativeProfileReload } from './NativeProfileReload';
import { PartnerRuntimeFactory, localRuntimeAdapterKey } from './PartnerRuntimeFactory';
import { SessionCompactionService } from './SessionCompactionService';
import { SessionProfileReloadService, profileReloadPrompt } from './SessionProfileReloadService';
import { WriterLeaseCoordinator } from './WriterLeaseCoordinator';
import { PartnerWorkspaceStore } from '../security/PartnerWorkspaceStore';
import { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';

interface Dependencies {
  apiConnections: ApiConnectionStore;
  apiProviders: ApiProviderRegistry;
  apiSessions: ApiAgentSessionStore;
  configuredApiOptions: ReturnType<typeof createApiRuntimeConfiguration>;
  conversationDeletions: ConversationDeletionService;
  host: AdapterHost;
  nativeBindings: NativeThreadBindingStore;
  partnerProfiles: PartnerProfileStore;
  partnerWorkspaces: PartnerWorkspaceStore;
  runtimeFactory: PartnerRuntimeFactory;
  singleChatMessages: SingleChatMessageStore;
  studioRuntimeCatalog: StudioRuntimeCatalog;
  writerLeases: WriterLeaseCoordinator;
  availableImportedDirectory: ReturnType<typeof createLocalRuntimeResolver>['availableImportedDirectory'];
  ensureClaudeInstallation: ReturnType<typeof createLocalRuntimeResolver>['ensureClaudeInstallation'];
  importedCodexBinding: ReturnType<typeof createLocalRuntimeResolver>['importedCodexBinding'];
  resolveCodexLifecycleRuntime: ReturnType<typeof createLocalRuntimeResolver>['resolveCodexLifecycleRuntime'];
  resolveImportedCodexRuntime: ReturnType<typeof createLocalRuntimeResolver>['resolveImportedCodexRuntime'];
  resolveWorkspaceGrant: ReturnType<typeof createLocalRuntimeResolver>['resolveWorkspaceGrant'];
}

export function createSessionMaintenanceRuntime(dependencies: Dependencies) {
  const { apiConnections, apiProviders, apiSessions, configuredApiOptions, conversationDeletions, host, nativeBindings, partnerProfiles, partnerWorkspaces, runtimeFactory, singleChatMessages, studioRuntimeCatalog, writerLeases, availableImportedDirectory, ensureClaudeInstallation, importedCodexBinding, resolveCodexLifecycleRuntime, resolveImportedCodexRuntime, resolveWorkspaceGrant } = dependencies;
  const sessionCompactions = new SessionCompactionService(writerLeases, async (request, signal) => {
    if (await conversationDeletions.isDeleted(request.conversationId)) throw new Error('COMPACT_SESSION_UNAVAILABLE');
    const indexed = await singleChatMessages.getConversation(request.conversationId);
    if (indexed && (indexed.partnerId !== request.partnerId || indexed.isArchived || indexed.isDisabled || indexed.busy)) throw new Error('COMPACT_SESSION_UNAVAILABLE');
    const binding = await nativeBindings.getForScope(request.partnerId, 'single', request.conversationId);
    if (!binding || binding.state !== 'active' || binding.nativeThreadId !== request.sessionId || binding.source !== request.source) throw new Error('COMPACT_SESSION_MISMATCH');
    if (binding.profileRecoveryRequired) throw new Error('PROFILE_RELOAD_RECOVERY_REQUIRED');
    const partner = studioRuntimeCatalog.partner(request.partnerId);
    if (!partner?.available || partner.sourceMode !== request.source) throw new Error('COMPACT_NOT_SUPPORTED');
    if (partner.runtime.kind === 'api') {
      const connection = await apiConnections.resolve(partner.partnerId, partner.runtime.connection);
      const { definition, endpoint, model } = apiProviders.normalizeConnection(connection);
      const apiOptions = await configuredApiOptions(connection);
      return compactApiSession(apiSessions, request.partnerId, request.conversationId, definition.createAdapter({ ...apiOptions, endpoint, model, thinkingMode: 'disabled', reasoningEffort: 'low' }), signal);
    }
    if (partner.runtime.kind !== 'local') throw new Error('COMPACT_NOT_SUPPORTED');
    const adapter = await localMaintenanceAdapter(request);
    if (!adapter.capabilities.compaction || !adapter.compactSession) throw new Error('COMPACT_NOT_SUPPORTED');
    try {
      return await adapter.compactSession(request.sessionId, signal, binding.bootstrap);
    } finally {
      if (binding.importedCodexWorkspace) await adapter.dispose?.();
    }
  });

  async function localMaintenanceAdapter(request: { partnerId: string; conversationId: string; sessionId: string }) {
    const partner = studioRuntimeCatalog.partner(request.partnerId);
    if (!partner?.available || partner.runtime.kind !== 'local') throw new Error('SESSION_COMMAND_UNAVAILABLE');
    const runtime = partner.runtime;
    const imported = await importedCodexBinding(request.partnerId, request.conversationId, request.sessionId);
    if (imported && runtime.adapterType !== 'codex_cli') throw new Error('CODEX_IMPORTED_THREAD_MISMATCH');
    if (imported) {
      const root = await availableImportedDirectory(imported.workspace.directory, imported.workspace.canonicalDirectory);
      if (!root) throw new Error(CODEX_IMPORTED_DIRECTORY_UNAVAILABLE);
      const selected = await resolveImportedCodexRuntime(imported.workspace);
      const adapterKey = localRuntimeAdapterKey({
        adapterType: 'codex_cli', runtimeId: selected.runtimeId,
        partnerId: request.partnerId, conversationId: request.conversationId, partnerRoot: root, additionalDirectories: []
      });
      return runtimeFactory.getLocal({ adapterType: 'codex_cli', adapterKey, executablePath: selected.executablePath, partnerRoot: root, additionalDirectories: [], importedCodexThread: true });
    }
    const workspace = await partnerWorkspaces.grantIds(request.partnerId);
    const rootGrant = workspace?.cwdGrantId ?? runtime.partnerRootGrantId;
    if (!rootGrant) throw new Error('PARTNER_ROOT_GRANT_REQUIRED');
    const partnerRoot = await resolveWorkspaceGrant(rootGrant);
    if (!partnerRoot) throw new Error('PARTNER_ROOT_GRANT_REQUIRED');
    const additionalDirectories = (await Promise.all((workspace?.workspaceGrantIds ?? runtime.workspaceGrantIds).map(resolveWorkspaceGrant))).filter((directory): directory is string => Boolean(directory && directory !== partnerRoot));
    let executablePath: string, runtimeId = runtime.codexRuntimeId;
    if (runtime.adapterType === 'codex_cli') {
      const resolved = await resolveCodexLifecycleRuntime({ partnerRootGrantId: rootGrant, codexRuntimeId: runtime.codexRuntimeId, codexRuntimeEnvironment: runtime.codexRuntimeEnvironment });
      executablePath = resolved.runtime.executablePath; runtimeId = resolved.runtime.runtimeId;
    } else {
      const installed = await ensureClaudeInstallation();
      if (!installed.executablePath || !installed.loggedIn) throw new Error('CLAUDE_NOT_LOGGED_IN');
      executablePath = installed.executablePath;
    }
    const adapter = host.adapterForSession(request.partnerId, request.conversationId, request.sessionId) ?? runtimeFactory.getLocal({
      adapterKey: localRuntimeAdapterKey({ adapterType: runtime.adapterType, runtimeId, partnerId: request.partnerId, conversationId: request.conversationId, partnerRoot, additionalDirectories }),
      adapterType: runtime.adapterType, executablePath, partnerRoot, additionalDirectories,
    });
    return adapter;
  }

  const profileReloads = new SessionProfileReloadService({
    leases: writerLeases, profiles: partnerProfiles, bindings: nativeBindings,
    legacyBootstrap: async (request) => {
      if (request.source !== 'api_partner') return undefined;
      const stored = await apiSessions.load(request.partnerId, request.conversationId);
      return stored?.bootstrapSystemPrompt ? { version: 1, content: stored.bootstrapSystemPrompt, createdAt: '', timeZone: '', appliedProfiles: {} } : undefined;
    },
    validate: async (request) => {
      if (await conversationDeletions.isDeleted(request.conversationId)) throw new Error('SESSION_COMMAND_UNAVAILABLE');
      const partner = studioRuntimeCatalog.partner(request.partnerId);
      const indexed = await singleChatMessages.getConversation(request.conversationId);
      if (!partner?.available || partner.sourceMode !== request.source || request.source === 'existing_thread' || indexed && (indexed.partnerId !== request.partnerId || indexed.isArchived || indexed.isDisabled || indexed.busy)) throw new Error('SESSION_COMMAND_UNAVAILABLE');
    },
    confirm: async (request, kind, previous, next, signal, recoverFirst) => {
      const partner = studioRuntimeCatalog.partner(request.partnerId)!;
      if (partner.runtime.kind === 'api') {
        const connection = await apiConnections.resolve(partner.partnerId, partner.runtime.connection);
        const { definition, endpoint, model } = apiProviders.normalizeConnection(connection);
        const apiOptions = await configuredApiOptions(connection);
        const original = await apiSessions.load(request.partnerId, request.conversationId);
        const message = await confirmProfileReload(definition.createAdapter({ ...apiOptions, endpoint, model, thinkingMode: 'disabled', reasoningEffort: 'low' }), kind, next, signal);
        let saved: typeof original;
        return {
          message,
          commit: async () => { if (original) saved = await apiSessions.replaceIfUnchanged(original, { ...original, bootstrapSystemPrompt: next.content, bootstrapVersion: next.version, turns: [...original.turns, { clientMessageId: 'profile-reload:' + request.commandId, userContent: profileReloadPrompt(kind, next), messages: [{ role: 'assistant', content: message, reasoningContent: '' }], completedAt: new Date().toISOString() }] }); },
          rollback: async () => { if (original && saved) await apiSessions.replaceIfUnchanged(saved, original); },
        };
      }
      if (!request.sessionId) throw new Error('SESSION_COMMAND_UNAVAILABLE');
      const imported = await importedCodexBinding(request.partnerId, request.conversationId, request.sessionId);
      let adapter: PartnerAdapter;
      try {
        adapter = await localMaintenanceAdapter({ ...request, sessionId: request.sessionId });
      } catch (error) {
        throw new NativeProfileReloadError(error, recoverFirst);
      }
      try {
        const result = await confirmNativeProfileReload(adapter, request.sessionId, kind, previous, next, signal, recoverFirst);
        return { ...result, release: imported ? () => adapter.dispose?.() : undefined };
      } catch (error) {
        if (imported) await adapter.dispose?.();
        throw error;
      }
    },
  });
  return { sessionCompactions, profileReloads };
}
