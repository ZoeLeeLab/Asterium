import { app, safeStorage, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import {
  type ExistingThreadConnectionStatus,
  type PartnerWorkspaceState,
  type SendMessageCommand
} from '../shared/agentProtocol';
import { DESKTOP_IPC as AGENT_IPC, DESKTOP_INVOKE_CHANNELS } from '../shared/desktopIpc';
import { AdapterHost } from './AdapterHost';
import { ApiAgentSessionStore } from './api/ApiAgentSessionStore';
import { ApiConnectionStore } from './api/ApiConnectionStore';
import { ApiExtensionStore } from './api/ApiExtensionStore';
import { createDefaultApiProviderRegistry } from './api/ApiProviderRegistry';
import { createApiRuntimeConfiguration, isAttachmentCapabilities } from './api/ApiRuntimeConfiguration';
import { McpConnectionManager } from './api/extensions/McpConnectionManager';
import { McpManagementWorkspace } from './api/extensions/McpManagementWorkspace';
import { AutomationConfirmations } from './automation/AutomationConfirmations';
import { createAutomationExecutionBridge } from './automation/AutomationExecutionBridge';
import { AutomationRuntime } from './automation/AutomationRuntime';
import { AutomationScheduler } from './automation/AutomationScheduler';
import { AutomationService } from './automation/AutomationService';
import { AutomationStore } from './automation/AutomationStore';
import { createAutomationTargetPolicy } from './automation/AutomationTargetPolicy';
import { ConversationDeletionService } from './conversation/ConversationDeletionService';
import { ConversationDeletionStore } from './conversation/ConversationDeletionStore';
import { ConversationLifecycleService } from './conversation/ConversationLifecycleService';
import { SingleChatHistoryStore } from './conversation/SingleChatHistoryStore';
import { SingleChatMessageStore } from './conversation/SingleChatMessageStore';
import { createDiaryGeneration } from './diary/DiaryGeneration';
import { PartnerDiaryCatalog } from './diary/PartnerDiaryCatalog';
import { PartnerDiaryScheduler } from './diary/PartnerDiaryScheduler';
import { PartnerDiaryService } from './diary/PartnerDiaryService';
import { PartnerDiarySettingsStore } from './diary/PartnerDiarySettingsStore';
import { ExecutionBackendRouter } from './execution/ExecutionBackendRouter';
import { SandboxExtensionLaunchBackend } from './execution/SandboxExtensionLaunchBackend';
import { WindowsSandboxProcess } from './execution/WindowsSandboxProcess';
import { registerApiConnectionProbeIpc } from './ipc/apiConnectionProbeIpc';
import { registerApiConnectionsIpc, registerApiCredentialIpc, registerApiModelListIpc } from './ipc/apiConnectionsIpc';
import { registerAppUpdateIpc } from './ipc/appUpdateIpc';
import { registerArtifactIpc } from './ipc/artifactIpc';
import { registerAttachmentAccessIpc, registerAttachmentMaintenanceIpc, registerAttachmentSelectionIpc } from './ipc/attachmentIpc';
import { registerAutomationIpc } from './ipc/automationIpc';
import { registerClaudeSessionImportIpc } from './ipc/claudeSessionImportIpc';
import { registerConversationHistoryIpc } from './ipc/conversationHistoryIpc';
import { registerDelegationIpc } from './ipc/delegationIpc';
import { registerDesktopNavigationIpc } from './ipc/desktopNavigationIpc';
import { registerExistingThreadIpc } from './ipc/existingThreadIpc';
import { registerExtensionsIpc } from './ipc/extensionsIpc';
import { registerGeneralSettingsIpc } from './ipc/generalSettingsIpc';
import { registerCodexRuntimeQueryIpc, registerLocalRuntimeDetectionIpc } from './ipc/localRuntimeIpc';
import { archivedMarkdownFileName } from './ipc/markdownExport';
import { registerMemoryArchiveIpc } from './ipc/memoryArchiveIpc';
import { registerMemoryBackupExportIpc, registerMemoryBackupImportIpc } from './ipc/memoryBackupIpc';
import { registerMemoryFallbackModelListIpc, registerMemoryFallbackSettingsIpc } from './ipc/memoryFallbackIpc';
import { registerMemoryImportIpc } from './ipc/memoryImportIpc';
import { registerNativeSessionHistoryIpc, registerNativeSessionImportIpc, registerNativeSessionLifecycleIpc, registerNativeSingleBindingIpc } from './ipc/nativeSessionIpc';
import { registerPartnerDiaryIpc } from './ipc/partnerDiaryIpc';
import { registerPartnerWorkspaceIpc } from './ipc/partnerWorkspaceIpc';
import { registerPartnerProfileIpc, registerPartnerProfileRefreshIpc, registerProfileDirectoryIpc, registerUserProfileIpc } from './ipc/profileIpc';
import { registerProjectFileDeletionIpc, registerProjectFileOpenIpc, registerProjectFileQueryIpc } from './ipc/projectFilesIpc';
import { registerProjectLifecycleIpc, registerProjectManagementIpc } from './ipc/projectIpc';
import { registerProjectNotebookIpc } from './ipc/projectNotebookIpc';
import { registerProjectRoleIpc } from './ipc/projectRoleIpc';
import { registerProjectRunChangesIpc } from './ipc/projectRunChangesIpc';
import { registerProjectTaskExecutionIpc } from './ipc/projectTaskExecutionIpc';
import { registerProjectTaskIpc } from './ipc/projectTaskIpc';
import { registerProjectWorkflowGenerationIpc } from './ipc/projectWorkflowGenerationIpc';
import { registerProjectWorkflowMutationIpc, registerProjectWorkflowQueryIpc, registerProjectWorkflowTemplateIpc } from './ipc/projectWorkflowIpc';
import { registerProjectWorkspaceCreationIpc, registerProjectWorkspaceIpc } from './ipc/projectWorkspaceIpc';
import { registerApiMessageIpc, registerLocalMessageIpc, registerRunControlIpc } from './ipc/runInteractionIpc';
import { registerApiSessionDeletionIpc, registerSessionMaintenanceIpc, registerSessionStatusIpc } from './ipc/sessionIpc';
import { registerStorageIpc } from './ipc/storageIpc';
import { registerStudioMcpCredentialIpc, registerStudioMcpHostIpc } from './ipc/studioMcpIpc';
import { registerStudioNoteIpc } from './ipc/studioNoteIpc';
import { registerStudioRoomIpc, registerStudioRoomMaintenanceIpc, registerStudioRoomSyncIpc } from './ipc/studioRoomIpc';
import { registerStudioRoundCancellationIpc, registerStudioRoundIpc } from './ipc/studioRoundIpc';
import { registerStudioWakeIpc } from './ipc/studioWakeIpc';
import { registerWebSearchCredentialIpc } from './ipc/webSearchCredentialIpc';
import { registerWorkspaceGrantRevocationIpc, registerWorkspaceGrantSelectionIpc } from './ipc/workspaceGrantIpc';
import { MemoryImportService } from './memory/MemoryImportService';
import { createMemoryModelConnections } from './memory/MemoryModelConnections';
import { MemorySourceService } from './memory/MemorySourceService';
import { PartnerMemoryBriefingService } from './memory/PartnerMemoryBriefingService';
import { PartnerMemoryManagementService } from './memory/PartnerMemoryManagementService';
import { PartnerMemoryService } from './memory/PartnerMemoryService';
import { PartnerMemoryToolService } from './memory/PartnerMemoryToolService';
import { SqliteMemoryCutover } from './memory/SqliteMemoryCutover';
import { MemoryConsolidation } from './memory/fallback/MemoryConsolidation';
import { singleChatFallbackInputs, studioFallbackInputs } from './memory/fallback/MemoryFallbackInputs';
import { MemoryFallbackInventory } from './memory/fallback/MemoryFallbackInventory';
import { MemoryFallbackJobStore } from './memory/fallback/MemoryFallbackJobStore';
import { MemoryFallbackScheduler } from './memory/fallback/MemoryFallbackScheduler';
import { MemoryFallbackSettingsStore } from './memory/fallback/MemoryFallbackSettingsStore';
import { PartnerProjectNotebookService } from './notebook/PartnerProjectNotebookService';
import { PartnerProfileService } from './partner/PartnerProfileService';
import { PartnerProfileStore } from './partner/PartnerProfileStore';
import { isPartnerProfileSeed, isUserProfileSeed } from './partner/profileSeedValidation';
import { ArtifactDeliveryService } from './project/ArtifactDeliveryService';
import { ProjectBrowserService } from './project/ProjectBrowserService';
import { ProjectDeletionStore } from './project/ProjectDeletionStore';
import { ProjectDomainStore } from './project/ProjectDomainStore';
import { ProjectExecutionPolicyStore } from './project/ProjectExecutionPolicyStore';
import { ProjectFileDeletionService } from './project/ProjectFileDeletionService';
import { ProjectFileDeliveryCoordinator } from './project/ProjectFileDeliveryCoordinator';
import { ProjectFileStore } from './project/ProjectFileStore';
import { ProjectLifecycleService } from './project/ProjectLifecycleService';
import { ProjectMutationCoordinator } from './project/ProjectMutationCoordinator';
import { ProjectRunChangeRecorder } from './project/ProjectRunChangeRecorder';
import { createProjectRuntimeBindings, createProjectStateReconciler } from './project/ProjectRuntimeBindings';
import { ProjectService } from './project/ProjectService';
import { ProjectTaskExecutionStore } from './project/ProjectTaskExecutionStore';
import { ProjectTaskHandoffValidator } from './project/ProjectTaskHandoffValidator';
import { ProjectTaskOrchestrator } from './project/ProjectTaskOrchestrator';
import { ProjectTaskReviewValidator } from './project/ProjectTaskReviewValidator';
import { ProjectTaskRuntime } from './project/ProjectTaskRuntime';
import { ProjectTransactionStore } from './project/ProjectTransactionStore';
import { ProjectWorkRoleStore } from './project/ProjectWorkRoleStore';
import { ProjectWorkflowGenerationRuntime } from './project/ProjectWorkflowGenerationRuntime';
import { ProjectWorkflowGenerationStore } from './project/ProjectWorkflowGenerationStore';
import { ProjectWorkflowStore } from './project/ProjectWorkflowStore';
import { ProjectWorkflowTemplateStore } from './project/ProjectWorkflowTemplateStore';
import { ProjectWorkspaceStore } from './project/ProjectWorkspaceStore';
import { ContextHandoffService } from './runtime/ContextHandoffService';
import { DelegationConversationRuntime } from './runtime/DelegationConversationRuntime';
import { createDelegationExecutor } from './runtime/DelegationExecutor';
import { DelegationResultDelivery } from './runtime/DelegationResultDelivery';
import { createDelegationRuntimeBridge } from './runtime/DelegationRuntimeBridge';
import { createDelegationToolHandler } from './runtime/DelegationToolHandler';
import { createExistingThreadEvents, createExistingThreadService } from './runtime/ExistingThreadService';
import { ExistingThreadWatchRegistry } from './runtime/ExistingThreadWatchRegistry';
import { createLegacyRunPath } from './runtime/LegacyRunPath';
import { createLocalRuntimeResolver } from './runtime/LocalRuntimeResolver';
import { createMessageRuntime } from './runtime/MessageRuntime';
import { PartnerDelegation } from './runtime/PartnerDelegation';
import { PartnerRuntimeFactory } from './runtime/PartnerRuntimeFactory';
import { PartnerRuntimePort } from './runtime/PartnerRuntimePort';
import { RunCoordinator } from './runtime/RunCoordinator';
import { createRuntimeEventBridge } from './runtime/RuntimeEventBridge';
import { createRuntimeRunHooks } from './runtime/RuntimeRunHooks';
import { createRuntimeToolBindings } from './runtime/RuntimeToolBindings';
import { SessionBootstrapRecorder } from './runtime/SessionBootstrapRecorder';
import { SessionBootstrapService } from './runtime/SessionBootstrapService';
import { SessionCommandService } from './runtime/SessionCommandService';
import { createSessionMaintenanceRuntime } from './runtime/SessionMaintenanceRuntime';
import { WriterLeaseCoordinator } from './runtime/WriterLeaseCoordinator';
import { ArtifactRegistry } from './security/ArtifactRegistry';
import { BridgeCursorStore } from './security/BridgeCursorStore';
import { ConversationAttachmentStore } from './security/ConversationAttachmentStore';
import { API_EXTENSION_CREDENTIAL_PREFIX, CredentialStore } from './security/CredentialStore';
import { PartnerWorkspaceStore } from './security/PartnerWorkspaceStore';
import { WorkspaceGrantStore } from './security/WorkspaceGrantStore';
import type { AppUpdateService } from './settings/AppUpdateService';
import type { DesktopNotifications } from './settings/DesktopNotifications';
import { GeneralSettingsStore } from './settings/GeneralSettingsStore';
import { validateProjectDirectory } from './settings/projectDirectory';
import { NativeThreadBindingStore } from './studio/NativeThreadBindingStore';
import { StudioAttachments } from './studio/StudioAttachments';
import { StudioMcpAccessStore } from './studio/StudioMcpAccessStore';
import { StudioMcpHost } from './studio/StudioMcpHost';
import { StudioMcpService } from './studio/StudioMcpService';
import { StudioNoteStore } from './studio/StudioNoteStore';
import { StudioOrchestrator } from './studio/StudioOrchestrator';
import { StudioRoomStore } from './studio/StudioRoomStore';
import { StudioRuntimeCatalog } from './studio/StudioRuntimeCatalog';
import { createStudioTurnRuntime, isStudioRoomMetadata } from './studio/StudioTurnRuntime';
import { StudioWakeControlService } from './studio/StudioWakeControlService';
import { StudioWakeEventStore } from './studio/StudioWakeEventStore';
import { StudioWakeEvents } from './studio/StudioWakeEvents';

export { AGENT_IPC };

const BRAVE_SEARCH_CREDENTIAL_REF = 'asterium-web-search-brave';

export function registerAgentIpc(ipcMain: IpcMain, getWindow: () => BrowserWindow | null, options: { generalSettings?: GeneralSettingsStore; notifications?: DesktopNotifications; updates?: AppUpdateService; environment?: import('../shared/runtimeEnvironment').RuntimeEnvironment } = {}) {
  const useLegacyRunPath = process.env.ASTERIUM_USE_LEGACY_RUN_PATH === '1';
  const restoreBackgroundServices = options.environment?.restoreBackgroundServices ?? true;
  const notifications = options.notifications;
  const generalSettings = options.generalSettings ?? new GeneralSettingsStore(() => path.join(app.getPath('userData'), 'general-settings.v1.json'));
  const grants = new Map<string, string>();
  const host = new AdapterHost();
  const credentials = new CredentialStore(() => path.join(app.getPath('userData'), 'secure-credentials.v1.json'), safeStorage);
  const apiConnections = new ApiConnectionStore(() => path.join(app.getPath('userData'), 'api-connections.v1.json'));
  const bridgeCursors = new BridgeCursorStore(() => path.join(app.getPath('userData'), 'bridge-cursors.v1.json'));
  const workspaceGrants = new WorkspaceGrantStore(() => path.join(app.getPath('userData'), 'workspace-grants.v1.json'));
  const profileDataRoot = path.join(app.getPath('userData'), 'AsteriumData');
  const protectedRoots = [profileDataRoot];
  const partnerWorkspaces = new PartnerWorkspaceStore(() => path.join(app.getPath('userData'), 'conversation-workspaces.v1.json'), workspaceGrants, protectedRoots);
  const partnerProfiles = new PartnerProfileStore(profileDataRoot);
  const studioRuntimeCatalog = new StudioRuntimeCatalog();
  const projectWorkspaces = new ProjectWorkspaceStore(
    path.join(app.getPath('userData'), 'project-workspaces.v1.json'),
    async () => {
      const custom = (await generalSettings.get()).settings.defaultProjectRoot;
      return custom ? validateProjectDirectory(custom) : options.environment?.projectsDirectory ?? path.join(app.getPath('documents'), 'Asterium Projects');
    },
  );
  const projectExecutionPolicies = new ProjectExecutionPolicyStore(() => path.join(app.getPath('userData'), 'project-execution-policies.v1.json'));
  const projectDomain = new ProjectDomainStore(() => path.join(app.getPath('userData'), 'project-domain.v1.json'));
  const projectNotebooks = new PartnerProjectNotebookService(partnerProfiles, projectDomain);
  const projectTaskExecutions = new ProjectTaskExecutionStore(() => path.join(app.getPath('userData'), 'project-task-executions.v1.json'));
  const projectWorkRoles = new ProjectWorkRoleStore(() => path.join(app.getPath('userData'), 'project-work-roles.v1.json'));
  const projectWorkflows = new ProjectWorkflowStore(() => path.join(app.getPath('userData'), 'project-workflows.v1.json'));
  const projectWorkflowTemplates = new ProjectWorkflowTemplateStore(() => path.join(app.getPath('userData'), 'project-workflow-templates.v1.json'));
  const projectWorkflowGenerations = new ProjectWorkflowGenerationStore(() => path.join(app.getPath('userData'), 'project-workflow-generations.v1.json'));
  const writerLeases = new WriterLeaseCoordinator();
  const nativeBindings = new NativeThreadBindingStore(() => path.join(app.getPath('userData'), 'native-thread-bindings.v1.json'));
  const sessionBootstrapRecorder = new SessionBootstrapRecorder(nativeBindings);
  const studioRooms = new StudioRoomStore(() => path.join(app.getPath('userData'), 'studio-rooms.v1.json'));
  const studioNotes = new StudioNoteStore(() => path.join(app.getPath('userData'), 'studio-notes.v1.json'));
  const projectLocationSelections = new Map<string, string>();
  const workflowGenerationRuntimeRef: { current?: ProjectWorkflowGenerationRuntime } = {};
  const artifacts = new ArtifactRegistry({
    storePath: path.join(app.getPath('userData'), 'artifacts.v1.json'),
    cacheDirectory: path.join(app.getPath('userData'), 'artifact-cache-v2'),
  });
  const projectFiles = new ProjectFileStore(() => path.join(app.getPath('userData'), 'project-files.v1.json'), projectWorkspaces);
  const projectBrowser = new ProjectBrowserService(projectWorkspaces, projectFiles);
  const projectChanges = new ProjectRunChangeRecorder(
    () => path.join(app.getPath('userData'), 'project-run-changes'), projectBrowser,
    async (roomId) => (await studioRooms.getRoom(roomId))?.metadata.projectId,
    (command) => projectTaskRuntimeRef.current?.changeContext(command),
    (projectId) => { const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.projectRunChangesChanged, projectId); },
  );
  const projectTaskOrchestrator = new ProjectTaskOrchestrator(
    projectTaskExecutions,
    projectDomain,
    projectExecutionPolicies,
    writerLeases,
    undefined,
    {
      workspaces: projectWorkspaces,
      handoffs: new ProjectTaskHandoffValidator({ validateFileRefs: (projectId, refs) => projectFiles.validateRefs(projectId, refs) }),
      reviews: new ProjectTaskReviewValidator(),
    },
  );
  const projectCoordinator = new ProjectMutationCoordinator();
  const studioMcpAccess = new StudioMcpAccessStore(() => path.join(app.getPath('userData'), 'studio-mcp-access.v1.json'), options.environment?.mcpPort, options.environment?.profile === 'autotest');
  const studioMcpService = new StudioMcpService(studioMcpAccess, studioRooms, projectCoordinator,
    (partnerId) => studioRuntimeCatalog.partner(partnerId)?.sourceMode === 'existing_thread');
  const studioWakeJournal = new StudioWakeEventStore(() => path.join(app.getPath('userData'), 'studio-wake-events.v1.json'));
  const studioWakeEvents = new StudioWakeEvents(studioWakeJournal, studioRooms, studioRuntimeCatalog, projectCoordinator, studioMcpService);
  const studioMcpHost = new StudioMcpHost(studioMcpAccess, studioMcpService, studioWakeEvents);
  const publishProjectFiles = (snapshot: import('../shared/projectWorkspace').ProjectFilesSnapshot) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.projectFilesChanged, snapshot);
  };
  const projectFileDeletions = new ProjectFileDeletionService({
    files: projectFiles,
    artifacts,
    workspaces: projectWorkspaces,
    domain: projectDomain,
    executions: projectTaskExecutions,
    workflows: projectWorkflows,
    coordinator: projectCoordinator,
    trashItem: (absolutePath) => shell.trashItem(absolutePath),
  });
  const artifactDelivery = new ArtifactDeliveryService({
    artifacts,
    workspaces: projectWorkspaces,
    files: projectFiles,
    partnerName: async (partnerId) => (await partnerProfiles.runtimeProfile(partnerId))?.publicIdentity.displayName,
    coordinator: projectCoordinator,
  });
  const projectService = new ProjectService({
    workspaces: projectWorkspaces,
    partnerWorkspaces,
    rooms: studioRooms,
    notes: studioNotes,
    bindings: nativeBindings,
    transactions: new ProjectTransactionStore(() => path.join(app.getPath('userData'), 'project-transactions.v1.json')),
    deletions: new ProjectDeletionStore(() => path.join(app.getPath('userData'), 'project-deletions.v1.json')),
    executionPolicies: projectExecutionPolicies,
    domain: projectDomain,
    roles: projectWorkRoles,
    workflows: projectWorkflows,
    workflowTemplates: projectWorkflowTemplates,
    executions: projectTaskExecutions,
    artifacts,
    files: projectFiles,
    notebooks: projectNotebooks,
    coordinator: projectCoordinator,
    workflowActivationGuard: (operation) => projectTaskOrchestrator.withDispatchPaused(operation),
  });
  const projectLifecycle = new ProjectLifecycleService({ selections: projectLocationSelections, projectService, projectWorkspaces, generalSettings, artifactDelivery, projectWorkflowGenerations, projectChanges });
  const projectFileDelivery = new ProjectFileDeliveryCoordinator({
    delivery: artifactDelivery,
    artifacts,
    rooms: studioRooms,
    publish: publishProjectFiles,
  });
  void projectService.recover()
    .then(() => projectTaskOrchestrator.recover())
    .catch((error) => console.error('Failed to recover project state.', error));
  const apiSessions = new ApiAgentSessionStore(() => path.join(app.getPath('userData'), 'api-agent-sessions', 'v1'));
  const messageAttachments = new ConversationAttachmentStore({
    rootDirectory: () => path.join(app.getPath('userData'), 'conversation-attachments', 'v2'),
    legacyIndexPath: () => path.join(app.getPath('userData'), 'message-attachments.v1.json'),
  });
  const singleChatHistory = new SingleChatHistoryStore(() => app.getPath('userData'));
  const singleChatMessages = new SingleChatMessageStore(() => path.join(app.getPath('userData'), 'single-chat-messages.v1.json'), singleChatHistory);
  const studioAttachments = new StudioAttachments(messageAttachments, {
    workspaces: projectWorkspaces,
    rooms: studioRooms,
    onArchived: (projectId) => projectFileDelivery.publish(projectId),
  });
  const partnerMemories = new PartnerMemoryService(partnerProfiles, { ready: prepareMemoryStorage });
  const partnerMemoryBriefings = new PartnerMemoryBriefingService(partnerMemories);
  const sessionBootstraps = new SessionBootstrapService(partnerProfiles, partnerMemoryBriefings, nativeBindings, studioRooms, apiSessions);
  const memorySources = new MemorySourceService(singleChatMessages, studioRooms);
  const partnerMemoryTools = new PartnerMemoryToolService(partnerMemories, memorySources);
  const partnerMemoryManagement = new PartnerMemoryManagementService(partnerMemories, partnerMemoryTools, partnerMemoryBriefings);
  const fallbackEligible = (partnerId: string) => {
    const partner = studioRuntimeCatalog.partner(partnerId);
    return Boolean(partner?.available && partner.sourceMode !== 'existing_thread' && partner.management.memoryMode === 'asterium');
  };
  const apiExtensions = new ApiExtensionStore(() => path.join(app.getPath('userData'), 'api-extensions.v1.json'), credentials.forNamespace(API_EXTENSION_CREDENTIAL_PREFIX), (partnerId) => {
    const partner = studioRuntimeCatalog.partner(partnerId);
    return Boolean(partner?.available && partner.sourceMode === 'api_partner' && partner.runtime.kind === 'api');
  });
  const memoryFallbackSettings = new MemoryFallbackSettingsStore(() => path.join(app.getPath('userData'), 'memory-fallback-settings.v1.json'), credentials, fallbackEligible);
  const sandboxProcesses = new WindowsSandboxProcess(app.isPackaged ? path.join(process.resourcesPath, 'sandbox') : path.join(app.getAppPath(), '.sandbox-build', 'sandbox'),
    path.join(app.getPath('userData'), 'sandbox-state'), [...protectedRoots, app.getPath('userData')]);
  const extensionLaunchBackend = new ExecutionBackendRouter(async () => (await generalSettings.get()).settings, new SandboxExtensionLaunchBackend(sandboxProcesses));
  const mcpManagementWorkspace = new McpManagementWorkspace(workspaceGrants, [...protectedRoots, app.getPath('userData')]);
  const mcpConnections = new McpConnectionManager(apiExtensions, extensionLaunchBackend, 15_000, configuration => mcpManagementWorkspace.resolve(configuration));
  generalSettings.setSandboxTransition((before, after) => extensionLaunchBackend.beginSettingsChange(before, after, networkOnly => mcpConnections.invalidateLocalExecution(networkOnly)));
  const memoryFallbackJobs = new MemoryFallbackJobStore(() => path.join(app.getPath('userData'), 'memory-fallback-jobs.v1.json'));
  const memorySqliteCutover = new SqliteMemoryCutover(profileDataRoot, app.getPath('userData'), memoryFallbackJobs, async () => [
    ...singleChatFallbackInputs(await singleChatMessages.list()),
    ...studioFallbackInputs(await studioRooms.listAll()),
  ]);
  async function prepareMemoryStorage() { return memorySqliteCutover.run(); }
  const memoryFallbackInventory = new MemoryFallbackInventory(singleChatMessages, studioRooms, memoryFallbackJobs, memoryFallbackSettings, fallbackEligible);
  const conversationDeletions = new ConversationDeletionService({
    deletions: new ConversationDeletionStore(() => path.join(app.getPath('userData'), 'conversation-deletions.v1.json')),
    apiSessions,
    attachments: messageAttachments,
    bindings: nativeBindings,
    messages: singleChatMessages,
  });
  void conversationDeletions.recover().catch((error) => console.error('Failed to recover conversation deletion cleanup.', error));
  const localRuntimeResolver = createLocalRuntimeResolver({
    nativeBindings,
    singleChatHistory,
    conversationDeletions,
    workspaceGrants,
    grants,
    protectedRoots,
    userDataDirectory: () => app.getPath('userData'),
  });
  const { availableImportedDirectory, resolveSelectedCodexRuntime, resolveCodexDirectoryRuntime, resolveImportedCodexRuntime, importedCodexBinding, ensureCodexInstallation, resolveCodexLifecycleRuntime, resolveWorkspaceGrant, ensureClaudeInstallation, refreshCodexInstallation, refreshClaudeInstallation, currentCodexInstallation } = localRuntimeResolver;
  const apiProviders = createDefaultApiProviderRegistry();
  const delegationHandles: { delivery?: DelegationResultDelivery; conversation?: DelegationConversationRuntime } = {};
  const delegation = new PartnerDelegation(
    () => path.join(app.getPath('userData'), 'partner-delegation.v1.json'),
    (batch, task, signal, lookupOnly) => task.review
      ? executeExistingReview(batch, task, task.review, signal, lookupOnly)
      : executeDelegation(batch, task, signal),
    () => delegationHandles.delivery?.kick(),
  );
  const unsubscribeDelegationLease = writerLeases.subscribeAvailable(scope => {
    if (scope.kind === 'conversation') delegationHandles.delivery?.kick();
  });
  function withDelegationChatPriority<T>(conversationId: string, start: () => Promise<T>) {
    return delegationHandles.delivery ? delegationHandles.delivery.withUserPriority(conversationId, start) : start();
  }
  const configuredApiOptions = createApiRuntimeConfiguration(credentials);
  const contextHandoff = new ContextHandoffService(singleChatMessages, studioRooms, id => {
    const partner = studioRuntimeCatalog.partner(id);
    return Boolean(partner?.available && (partner.runtime.kind === 'local' || partner.runtime.kind === 'api'));
  }, id => studioRuntimeCatalog.partner(id)?.publicIdentity.displayName ?? '伙伴');
  const { connectImport, connectFallback } = createMemoryModelConnections({ memoryFallbackSettings });
  const memoryImport = new MemoryImportService(partnerMemories, fallbackEligible, connectImport);
  const memoryFallbackScheduler = new MemoryFallbackScheduler(memoryFallbackSettings, memoryFallbackJobs, memoryFallbackInventory,
    new MemoryConsolidation(partnerMemories, memorySources), connectFallback, fallbackEligible);
  const unsubscribeFallbackInventory = memoryFallbackInventory.subscribe(() => { void memoryFallbackScheduler.revalidate().catch(() => memoryFallbackScheduler.cancelCurrent()); });
  const runtimeFactory = new PartnerRuntimeFactory({
    host,
    credentials,
    bridgeCursors,
    apiSessions,
    attachments: messageAttachments,
    braveApiKey: () => credentials.get(BRAVE_SEARCH_CREDENTIAL_REF),
    protectedRoots,
    apiProviders,
    apiExtensions,
    mcpConnections,
    extensionLaunchBackend,
  });
  const existingThreadWatches = new ExistingThreadWatchRegistry<ExistingThreadConnectionStatus>();
  const { sessionCompactions, profileReloads } = createSessionMaintenanceRuntime({
    apiConnections,
    apiProviders,
    apiSessions,
    configuredApiOptions,
    conversationDeletions,
    host,
    nativeBindings,
    partnerProfiles,
    partnerWorkspaces,
    runtimeFactory,
    singleChatMessages,
    studioRuntimeCatalog,
    writerLeases,
    availableImportedDirectory,
    ensureClaudeInstallation,
    importedCodexBinding,
    resolveCodexLifecycleRuntime,
    resolveImportedCodexRuntime,
    resolveWorkspaceGrant,
  });
  const prepareStudioTurn = createStudioTurnRuntime({
    nativeBindings,
    resolveCodexLifecycleRuntime,
    studioAttachments,
    studioRooms,
  });
  const sessionCommands = new SessionCommandService({ bindings: nativeBindings, catalog: studioRuntimeCatalog, messages: singleChatMessages, leases: writerLeases, compactions: sessionCompactions, reload: (request) => profileReloads.execute(request), isDeleted: (id) => conversationDeletions.isDeleted(id) });
  const diaryCatalog = new PartnerDiaryCatalog(studioRuntimeCatalog);
  const { executeDelegation, existingReviewConnection, reviewConnectionFingerprint, reviewClient, assertReviewThread, executeExistingReview } = createDelegationExecutor({
    apiConnections,
    apiProviders,
    configuredApiOptions,
    conversationDeletions,
    credentials,
    diaryCatalog,
    ensureClaudeInstallation,
    ensureCodexInstallation,
    messageAttachments,
    singleChatMessages,
    studioRuntimeCatalog,
    temporaryDirectory: () => app.getPath('temp'),
  });
  const studioWakeControl = new StudioWakeControlService(() => path.join(app.getPath('userData'), 'studio-wake-settings.v1.json'), {
    autoConnect: restoreBackgroundServices,
    connection: (partnerId) => {
      const current = diaryCatalog.current(partnerId);
      return studioRuntimeCatalog.partner(partnerId)?.sourceMode === 'existing_thread' && current?.identity.available ? current.existing : undefined;
    },
    ready: async (partnerId) => {
      const status = await studioMcpHost.status();
      return status.running && Boolean(status.configuration.publicOrigin) && status.credentials.some((item) => item.partnerId === partnerId && !item.revokedAt);
    },
    secret: (ref) => credentials.get(ref),
  });
  const wakeReadinessChanged = () => { void studioWakeControl.changed().catch(() => undefined); };
  const studioMcpStartup = app.whenReady().then(async () => {
    if (restoreBackgroundServices) try { await studioMcpHost.restore(); } catch { /* Host status retains the error; manual start remains available. */ }
    wakeReadinessChanged();
  });
  const diaries = new PartnerDiaryService(partnerProfiles);
  const diarySettings = new PartnerDiarySettingsStore(() => path.join(app.getPath('userData'), 'partner-diary-settings.v1.json'),
    (id) => singleChatMessages.getConversation(id), (id) => diaryCatalog.identity(id));
  const diaryScheduler = new PartnerDiaryScheduler({
    settings: diarySettings, store: (id) => diaries.store(id), source: (id) => singleChatMessages.getConversation(id),
    identity: (id) => diaryCatalog.identity(id), leases: writerLeases,
    generate: createDiaryGeneration({
    apiConnections,
    apiProviders,
    configuredApiOptions,
    credentials,
    diaryCatalog,
    partnerProfiles,
    ensureClaudeInstallation,
    ensureCodexInstallation,
    userDataDirectory: () => app.getPath('userData'),
  }),
  });

  const automationStore = new AutomationStore(() => path.join(app.getPath('userData'), 'automations.v1.json'));
  const automationConfirmations = new AutomationConfirmations(() => { notifications?.confirmations(automationConfirmations.list()); const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.automationsConfirmationsChanged); });
  const automationHandles: { runtime?: AutomationRuntime; scheduler?: AutomationScheduler } = {};
  const { automationWorkspaceSignature, checkAutomation, attachAutomationCommand, targets } = createAutomationTargetPolicy({
    automationHandles,
    conversationDeletions,
    nativeBindings,
    partnerWorkspaces,
    projectWorkspaces,
    singleChatMessages,
    studioRooms,
    studioRuntimeCatalog,
    useLegacyRunPath,
    writerLeases,
  });
  const automationService = new AutomationService(automationStore, {
    runtimeReady: () => restoreBackgroundServices && Boolean(automationHandles.scheduler),
    get scheduler() { return restoreBackgroundServices ? automationHandles.scheduler : undefined; },
    targets: targets,
  });
  const unsubscribeAutomations = automationStore.subscribe(() => { if (notifications) void automationStore.snapshot().then(snapshot => notifications.automations(snapshot.runs)).catch(() => undefined); const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.automationsChanged); });
  const requireSender = (event: IpcMainInvokeEvent) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents) throw new Error('INVALID_IPC_SENDER');
    return window;
  };
  registerDelegationIpc(ipcMain, delegation, requireSender);
  registerDesktopNavigationIpc(ipcMain, notifications, options, requireSender);
  registerStorageIpc(ipcMain, generalSettings, options, protectedRoots, requireSender);
  registerAppUpdateIpc(ipcMain, options, requireSender);
  const unsubscribeUpdates = options.updates?.subscribe(snapshot => { const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.updatesChanged, snapshot); });
  registerGeneralSettingsIpc(ipcMain, generalSettings, requireSender);
  const unsubscribeGeneralSettings = generalSettings.subscribe(snapshot => { const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.generalSettingsChanged, snapshot); });
  const projectTaskRuntimeRef: { current?: ProjectTaskRuntime } = {};
  const { sendEvent, transformRuntimeEvent, delivery, notifyHandoffDelivered } = createRuntimeEventBridge({
    automationConfirmations,
    automationHandles,
    getWindow,
    notifications,
    partnerProfiles,
    projectFileDelivery,
    projectTaskRuntimeRef,
    sessionCommands,
    singleChatHistory,
    studioRuntimeCatalog,
  });
  const studioOrchestration = { orchestrator: undefined as StudioOrchestrator | undefined };
  const unsubscribeStudioRooms = studioRooms.subscribe((snapshot) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.studioRoomChanged, snapshot);
    notifications?.room(snapshot);
    studioOrchestration.orchestrator?.handleSnapshot(snapshot);
    if (!snapshot.streaming) void memoryFallbackInventory.refresh().catch(() => console.error('Memory fallback inventory could not be updated.'));
  });
  const unsubscribePartnerMemories = partnerMemories.subscribe((change) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.memoryArchiveChanged, change);
  });
  const hydrateManagedRuntimeProfile = async (command: SendMessageCommand) => {
    return sessionBootstraps.prepare(command);
  };
  const unsubscribePartnerWorkspaces = partnerWorkspaces.subscribe(async (state: PartnerWorkspaceState) => {
    await extensionLaunchBackend.invalidatePartner(state.partnerId, () => mcpConnections.invalidateLocalPartner(state.partnerId));
    studioRuntimeCatalog.updateWorkspace(state);
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.partnerWorkspaceChanged, state);
  });
  const unsubscribePartnerProfiles = partnerProfiles.subscribe((profiles) => {
    studioRuntimeCatalog.applyProfiles(profiles);
    void diaryScheduler.changed().catch(() => console.error('Diary schedule update failed.'));
    void memoryFallbackInventory.refresh().catch(() => console.error('Memory fallback inventory could not be updated.'));
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.partnerProfilesChanged, profiles);
  });
  const unsubscribeProjectExecutionPolicies = projectExecutionPolicies.subscribe((policy) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.projectExecutionPolicyChanged, policy);
  });
  const reconcileProjectState = createProjectStateReconciler(projectTaskOrchestrator, projectWorkflows);
  const unsubscribeProjectDomain = projectDomain.subscribe((snapshot) => {
    notifications?.tasks(snapshot.tasks);
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.projectDomainChanged, { type: 'snapshot', snapshot });
    reconcileProjectState(snapshot);
  });
  const unsubscribeProjectTaskExecutions = projectTaskExecutions.subscribe((snapshot) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.projectTaskExecutionChanged, { type: 'snapshot', snapshot });
  });
  const unsubscribeProjectWorkRoles = projectWorkRoles.subscribe((change) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.projectRolesChanged, change);
  });
  const unsubscribeProjectWorkflows = projectWorkflows.subscribe((change) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.projectWorkflowsChanged, change);
  });
  const unsubscribeProjectWorkflowTemplates = projectWorkflowTemplates.subscribe((change) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.projectWorkflowsChanged, change);
  });
  const unsubscribeProjectWorkflowGenerations = projectWorkflowGenerations.subscribe((change) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.projectWorkflowGenerationChanged, change);
  });

  const saveArtifactToProject = async (artifactId: string, projectId: string, source: 'partner' | 'user' = 'partner') => {
    return projectFileDelivery.deliver({ artifactId, projectId, source });
  };

  registerProjectLifecycleIpc(ipcMain, projectLifecycle, projectService, requireSender);
  registerProjectTaskIpc(ipcMain, projectService, requireSender);
  registerProjectRoleIpc(ipcMain, projectService, requireSender);
  registerProjectWorkflowQueryIpc(ipcMain, projectService, requireSender);
  registerProjectWorkflowMutationIpc(ipcMain, { projectService, projectTaskOrchestrator, getPartnerRuntimePort: () => partnerRuntimePort }, requireSender);
  registerProjectWorkflowTemplateIpc(ipcMain, projectService, requireSender);
  registerProjectWorkflowGenerationIpc(ipcMain, { projectWorkflowGenerations, workflowGenerationRuntimeRef }, requireSender);
  registerProjectTaskExecutionIpc(ipcMain, { projectTaskOrchestrator, getPartnerRuntimePort: () => partnerRuntimePort }, requireSender);
  registerProjectWorkspaceCreationIpc(ipcMain, projectLifecycle, requireSender);
  registerProjectWorkspaceIpc(ipcMain, projectService, projectWorkspaces, requireSender);
  registerProjectFileOpenIpc(ipcMain, projectFiles, requireSender);

  registerProjectRunChangesIpc(ipcMain, projectChanges, requireSender);
  registerProjectFileQueryIpc(ipcMain, projectBrowser, artifactDelivery, requireSender);
  registerProjectFileDeletionIpc(ipcMain, { projectFileDeletions, publishProjectFiles }, requireSender);

  registerProjectManagementIpc(ipcMain, projectLifecycle, projectService, requireSender);

  registerStudioRoomSyncIpc(ipcMain, projectService, isStudioRoomMetadata, requireSender);

  registerStudioNoteIpc(ipcMain, studioNotes, requireSender);

  registerProjectNotebookIpc(ipcMain, projectNotebooks, archivedMarkdownFileName, requireSender);

  registerStudioRoomIpc(ipcMain, studioRooms, archivedMarkdownFileName, requireSender);

  registerStudioRoomMaintenanceIpc(ipcMain, { projectCoordinator, studioRooms, studioAttachments, projectService, memoryFallbackInventory }, requireSender);

  registerStudioRoundCancellationIpc(ipcMain, { studioOrchestration, studioRooms }, requireSender);

  registerStudioWakeIpc(ipcMain, studioWakeControl, requireSender);

  registerStudioMcpHostIpc(ipcMain, { studioMcpHost, studioMcpStartup, wakeReadinessChanged }, requireSender);
  registerStudioMcpCredentialIpc(ipcMain, { projectCoordinator, studioRuntimeCatalog, studioMcpAccess, studioMcpHost, wakeReadinessChanged }, requireSender);

  registerStudioRoundIpc(ipcMain, { studioOrchestration, contextHandoff, prepareStudioTurn, studioRooms, isStudioRoomMetadata }, requireSender);

  registerNativeSingleBindingIpc(ipcMain, { conversationDeletions, singleChatHistory, nativeBindings }, requireSender);

  registerArtifactIpc(ipcMain, {
    requireSender, artifacts, saveArtifactToProject, projectFileDeletions, publishProjectFiles,
  });
  registerAttachmentSelectionIpc(ipcMain, messageAttachments, requireSender);
  registerAttachmentAccessIpc(ipcMain, { messageAttachments, artifacts, saveArtifactToProject }, requireSender);
  const cancelDelegation = async (id: string) => await delegationHandles.delivery?.cancelConversation(id) ?? false;
  registerAttachmentMaintenanceIpc(ipcMain, { messageAttachments, cancelDelegation, delegation }, requireSender);
  const conversationLifecycle = new ConversationLifecycleService({ cancelDelegation, writerLeases, conversationDeletions, delegation, diarySettings, diaryScheduler, memoryFallbackInventory });
  registerConversationHistoryIpc(ipcMain, { conversationLifecycle, conversationDeletions, singleChatHistory, singleChatMessages, nativeBindings, diarySettings, diaryScheduler, memoryFallbackInventory }, requireSender);

  const delegationToolFor = createDelegationToolHandler({
    apiConnections,
    artifacts,
    assertReviewThread,
    conversationDeletions,
    delegation,
    delegationHandles,
    existingReviewConnection,
    messageAttachments,
    reviewClient,
    reviewConnectionFingerprint,
    studioRuntimeCatalog,
  });
  const runtimeToolsFor = createRuntimeToolBindings({
    automationAgentTools: () => automationAgentTools,
    automationHandles,
    artifacts,
    delegationHandles,
    delegationToolFor,
    messageAttachments,
    partnerMemoryTools,
    partnerWorkspaces,
    projectNotebooks,
    projectTaskRuntimeRef,
    studioRooms,
    studioRuntimeCatalog,
    workflowGenerationRuntimeRef,
  });
  const { hooks, persistFirstSingleChatBinding, captureGuidanceSource, markAcceptedStudioSpeakingMode } = createRuntimeRunHooks({
    automationHandles,
    checkAutomation: (run, owner) => checkAutomation(run, owner),
    delegation,
    delegationHandles,
    delivery,
    hydrateManagedRuntimeProfile,
    nativeBindings,
    notifyHandoffDelivered,
    projectChanges,
    projectTaskRuntimeRef,
    sendEvent,
    sessionBootstrapRecorder,
    singleChatHistory,
    singleChatMessages,
    studioOrchestration,
    studioRooms,
    transformRuntimeEvent,
    workflowGenerationRuntimeRef,
  });
  const runCoordinator = new RunCoordinator(host, hooks, writerLeases);
  const { startAdapterRun } = createLegacyRunPath({
    captureGuidanceSource,
    delivery,
    host,
    hydrateManagedRuntimeProfile,
    markAcceptedStudioSpeakingMode,
    nativeBindings,
    notifyHandoffDelivered,
    persistFirstSingleChatBinding,
    sendEvent,
    sessionBootstrapRecorder,
    studioOrchestration,
    studioRooms,
    transformRuntimeEvent,
    writerLeases,
  });
  const { startApiRuntime, startLocalRuntime } = createMessageRuntime({
    apiConnections,
    apiProviders,
    attachAutomationCommand: command => attachAutomationCommand(command),
    availableImportedDirectory,
    configuredApiOptions,
    ensureClaudeInstallation,
    hydrateManagedRuntimeProfile,
    importedCodexBinding,
    messageAttachments,
    partnerWorkspaces,
    protectedRoots,
    resolveImportedCodexRuntime,
    resolveSelectedCodexRuntime,
    resolveWorkspaceGrant,
    runCoordinator,
    runtimeFactory,
    runtimeToolsFor,
    singleChatMessages,
    startAdapterRun,
    useLegacyRunPath,
  });
  const { taskOptions, workflowOptions } = createProjectRuntimeBindings({
    nativeBindings,
    projectChanges,
    projectDomain,
    projectFiles,
    projectService,
    projectTaskOrchestrator,
    projectTaskRuntimeRef,
    projectWorkflowGenerations,
    projectWorkflows,
    projectWorkRoles,
    runCoordinator,
    startApiRuntime,
    startLocalRuntime,
    studioRooms,
    studioRuntimeCatalog,
    temporaryDirectory: () => options.environment?.temporaryDirectory ?? app.getPath('temp'),
  });
  const projectTaskRuntime = new ProjectTaskRuntime(taskOptions);
  projectTaskRuntimeRef.current = projectTaskRuntime;
  const workflowGenerationRuntime = new ProjectWorkflowGenerationRuntime(workflowOptions);
  workflowGenerationRuntimeRef.current = workflowGenerationRuntime;
  void workflowGenerationRuntime.recover().catch((error) => console.error('Failed to recover workflow generations.', error));
  const partnerRuntimePort = new PartnerRuntimePort({
    prepareTurn: prepareStudioTurn,
    startApi: startApiRuntime,
    startLocal: startLocalRuntime,
    cancelRun: (command) => runCoordinator.cancel(command),
    startProjectTask: (command) => projectTaskRuntime.startProjectTask(command),
    projectTaskWriterScope: projectTaskRuntime.workspaceWriterScope,
  });
  const studioOrchestrator = new StudioOrchestrator(studioRooms, studioRuntimeCatalog, partnerRuntimePort, projectCoordinator, projectExecutionPolicies, studioAttachments);
  studioOrchestration.orchestrator = studioOrchestrator;
  const { sendExistingThreadChanged, onReply } = createExistingThreadEvents({
    getWindow,
    diaryCatalog,
    diaryScheduler,
    sendEvent,
  });
  registerLocalRuntimeDetectionIpc(
    ipcMain,
    refreshClaudeInstallation,
    refreshCodexInstallation,
    requireSender,
  );

  registerNativeSessionImportIpc(ipcMain, {
    nativeBindings, singleChatHistory, conversationDeletions, studioRuntimeCatalog, partnerProfiles, writerLeases,
    resolveCodexDirectoryRuntime, availableImportedDirectory, importedCodexBinding,
  }, requireSender);

  registerNativeSessionHistoryIpc(ipcMain, {
    nativeBindings, conversationDeletions, partnerWorkspaces, importedCodexBinding, delegation,
    resolveImportedCodexRuntime, resolveCodexLifecycleRuntime,
  }, requireSender);

  registerCodexRuntimeQueryIpc(ipcMain, {
    studioRuntimeCatalog,
    importedCodexBinding,
    resolveImportedCodexRuntime,
    availableImportedDirectory,
    resolveCodexLifecycleRuntime,
    currentCodexInstallation,
    ensureCodexInstallation,
    refreshCodexInstallation,
  }, requireSender);

  registerNativeSessionLifecycleIpc(ipcMain, {
    importedCodexBinding, resolveImportedCodexRuntime, resolveCodexLifecycleRuntime,
  }, requireSender);

  registerWorkspaceGrantSelectionIpc(ipcMain, { workspaceGrants, grants, protectedRoots }, requireSender);

  registerClaudeSessionImportIpc(ipcMain, { nativeBindings, workspaceGrants, grants }, requireSender);

  registerWorkspaceGrantRevocationIpc(ipcMain, { workspaceGrants, grants, extensionLaunchBackend, mcpConnections }, requireSender);

  registerPartnerWorkspaceIpc(ipcMain, partnerWorkspaces, requireSender);

  registerApiCredentialIpc(ipcMain, credentials, apiConnections, requireSender);

  registerApiConnectionsIpc(ipcMain, apiConnections, credentials, requireSender);
  const disposeApiConnectionProbe = registerApiConnectionProbeIpc(ipcMain, { apiConnections, apiProviders, configuredApiOptions }, requireSender);

  registerWebSearchCredentialIpc(ipcMain, credentials, BRAVE_SEARCH_CREDENTIAL_REF, requireSender);

  registerExtensionsIpc(ipcMain, apiExtensions, mcpConnections, requireSender);

  const partnerProfileService = new PartnerProfileService({
    prepareMemoryStorage, studioRuntimeCatalog, apiConnections, mcpConnections, diaryCatalog, wakeReadinessChanged,
    partnerProfiles, restoreBackgroundServices, memoryFallbackInventory, memoryFallbackScheduler,
    diaries, diaryScheduler, projectTaskOrchestrator, partnerRuntimePort, trashItem: directory => shell.trashItem(directory),
  });
  registerPartnerProfileRefreshIpc(ipcMain, partnerProfiles, requireSender);

  registerPartnerProfileIpc(ipcMain, { partnerProfileService, isUserProfileSeed, isPartnerProfileSeed }, requireSender);

  registerUserProfileIpc(ipcMain, { partnerProfiles, studioRuntimeCatalog, isUserProfileSeed }, requireSender);

  registerProfileDirectoryIpc(ipcMain, profileDataRoot, requireSender);

  registerPartnerDiaryIpc(ipcMain, { diaries, diarySettings, diaryCatalog, diaryScheduler, singleChatMessages }, requireSender);
  registerMemoryFallbackModelListIpc(ipcMain, memoryFallbackSettings, apiProviders, requireSender);
  registerMemoryFallbackSettingsIpc(ipcMain, {
    prepareMemoryStorage, memoryFallbackSettings, memoryFallbackScheduler, memoryFallbackInventory,
  }, requireSender);

  registerMemoryImportIpc(ipcMain, memoryImport, requireSender);

  const memoryBackupFilters = [{ name: '星丛伙伴记忆备份', extensions: ['gz'] }];
  registerMemoryBackupExportIpc(ipcMain, { partnerProfiles, partnerMemories, protectedRoots, memoryBackupFilters }, requireSender);
  const disposeMemoryBackupImport = registerMemoryBackupImportIpc(ipcMain, { partnerMemories, memoryBackupFilters }, requireSender);

  registerMemoryArchiveIpc(ipcMain, { partnerMemoryManagement, partnerMemories }, requireSender);

  registerApiSessionDeletionIpc(ipcMain, apiSessions, requireSender);

  registerSessionStatusIpc(ipcMain, sessionCommands, requireSender);
  registerSessionMaintenanceIpc(ipcMain, { sessionCommands, sessionCompactions }, requireSender);

  registerApiMessageIpc(ipcMain, { contextHandoff, withDelegationChatPriority, startApiRuntime, isAttachmentCapabilities }, requireSender);

  registerApiModelListIpc(ipcMain, { apiProviders, apiConnections, credentials, configuredApiOptions }, requireSender);

  const existingThreads = createExistingThreadService({
    credentials, bridgeCursors, existingThreadWatches, messageAttachments, protectedRoots, hydrateManagedRuntimeProfile,
    runCoordinator, runtimeFactory, sendExistingThreadChanged,
    startRun: (adapter, command) => useLegacyRunPath ? startAdapterRun(adapter, command) : runCoordinator.start(adapter, command),
    onReply: onReply,
  });
  registerExistingThreadIpc(ipcMain, credentials, existingThreads, requireSender);

  registerLocalMessageIpc(ipcMain, { contextHandoff, withDelegationChatPriority, startLocalRuntime }, requireSender);

  registerRunControlIpc(ipcMain, { runCoordinator, automationConfirmations }, requireSender);

  const { automationAgentTools, externalAutomation } = createAutomationExecutionBridge({
    automationConfirmations,
    automationHandles,
    automationService,
    automationStore,
    checkAutomation,
    getWindow,
    projectExecutionPolicies,
    runCoordinator,
    singleChatMessages,
    startApiRuntime,
    startLocalRuntime,
    studioMcpAccess,
    studioMcpService,
    studioRooms,
    studioRuntimeCatalog,
    writerLeases,
  });
  studioMcpService.automation = externalAutomation;

  const delegationRuntime = createDelegationRuntimeBridge({
    nativeBindings,
    singleChatMessages,
    conversationDeletions,
    studioRuntimeCatalog,
    writerLeases,
    automationWorkspaceSignature: (partnerId, projectId) => automationWorkspaceSignature(partnerId, projectId),
    startApiRuntime,
    startLocalRuntime,
    runCoordinator,
    delegation,
  });
  delegationHandles.conversation = delegationRuntime.conversation;
  delegationHandles.delivery = delegationRuntime.delivery;

  const delegationStartup = app.whenReady().then(() => {
    if (restoreBackgroundServices && !useLegacyRunPath) delegationHandles.delivery?.start();
  });
  const automationStartup = app.whenReady().then(() => restoreBackgroundServices ? automationHandles.scheduler!.start() : undefined).catch(() => console.error('Automation startup requires storage review; no automatic replay.'));
  const unsubscribeAutomationWriters = writerLeases.subscribeAvailable(() => { if (restoreBackgroundServices) void automationHandles.scheduler?.tick(); });
  registerAutomationIpc(ipcMain, automationService, automationConfirmations, requireSender);

  return async () => {
    disposeMemoryBackupImport();
    unsubscribeUpdates?.(); options.updates?.dispose();
    notifications?.dispose();
    unsubscribeGeneralSettings();
    automationConfirmations.dispose();
    await automationStartup;
    await automationHandles.scheduler?.dispose();
    unsubscribeAutomationWriters();
    unsubscribeAutomations();
    disposeApiConnectionProbe();
    await studioWakeControl.dispose();
    await studioMcpStartup;
    await studioMcpHost.dispose();
    await studioWakeEvents.dispose();
    profileReloads.dispose();
    sessionCompactions.dispose();
    await mcpConnections.dispose();
    await diaryScheduler.dispose();
    await delegationStartup;
    unsubscribeDelegationLease();
    await delegationHandles.delivery?.close();
    delegation.close();
    unsubscribeFallbackInventory();
    memoryImport.dispose();
    await memoryFallbackScheduler.dispose();
    for (const channel of DESKTOP_INVOKE_CHANNELS) ipcMain.removeHandler(channel);
    unsubscribePartnerWorkspaces();
    unsubscribePartnerProfiles();
    unsubscribeProjectExecutionPolicies();
    unsubscribeProjectDomain();
    unsubscribeProjectTaskExecutions();
    unsubscribeProjectWorkRoles();
    unsubscribeProjectWorkflows();
    unsubscribeProjectWorkflowTemplates();
    unsubscribeProjectWorkflowGenerations();
    unsubscribeStudioRooms();
    unsubscribePartnerMemories();
    partnerProfiles.dispose();
    existingThreadWatches.clear();
    runCoordinator.clearIdempotency();
    await host.dispose();
    await messageAttachments.dispose();
    await singleChatHistory.flush();
    grants.clear();
  };
}
