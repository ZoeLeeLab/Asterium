import { app, safeStorage, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_PROTOCOL_VERSION,
  type ExistingThreadConnection,
  type ExistingThreadConnectionStatus,
  type ExistingThreadReplyEvent,
  type PartnerProfileSeed,
  type PartnerWorkspaceState,
  type SendMessageCommand
} from '../shared/agentProtocol';
import type { AutomationRun, AutomationTargetOption } from '../shared/automations';
import { trimChatHistory } from '../shared/chatHistory';
import { resolveCodexRuntime } from '../shared/codexRuntimeSelection';
import { CODEX_IMPORTED_DIRECTORY_UNAVAILABLE } from '../shared/codexThreadImport';
import { DESKTOP_IPC as AGENT_IPC, DESKTOP_INVOKE_CHANNELS } from '../shared/desktopIpc';
import { REVIEW_MARKDOWN_MAX_BYTES } from '../shared/existingPartnerReview';
import type { MemorySourceAnchor } from '../shared/memoryArchive';
import type { StudioPrepareTurnRequest, StudioRoomMetadata } from '../shared/studioRuntime';
import { AdapterHost } from './AdapterHost';
import { loadClaudeCliRuntime } from './adapters/ClaudeCodeAdapter';
import { getCodexThreadLastTurnId, getCodexThreadLifecycles } from './adapters/CodexCliAdapter';
import { CyberBossBridgeClient, normalizeCyberBossServiceUrl } from './adapters/CyberBossBridgeClient';
import type { PartnerAdapter } from './adapters/PartnerAdapter';
import { ApiAgentSessionStore } from './api/ApiAgentSessionStore';
import { ApiConnectionStore } from './api/ApiConnectionStore';
import { ApiExtensionStore } from './api/ApiExtensionStore';
import type { ApiProviderContentPart } from './api/ApiProviderAdapter';
import { createDefaultApiProviderRegistry } from './api/ApiProviderRegistry';
import { createApiRuntimeConfiguration, isAttachmentCapabilities, resolveApiAttachmentCapabilities } from './api/ApiRuntimeConfiguration';
import { compactApiSession } from './api/ApiSessionCompactor';
import { confirmProfileReload } from './api/confirmProfileReload';
import { McpConnectionManager } from './api/extensions/McpConnectionManager';
import { McpManagementWorkspace } from './api/extensions/McpManagementWorkspace';
import { AutomationAgentTools } from './automation/AutomationAgentTools';
import { AutomationConfirmations } from './automation/AutomationConfirmations';
import { AutomationRuntime } from './automation/AutomationRuntime';
import { AutomationScheduler } from './automation/AutomationScheduler';
import { AutomationService } from './automation/AutomationService';
import { AutomationStore } from './automation/AutomationStore';
import { automationPrompt } from './automation/automationPrompt';
import { ConversationDeletionService } from './conversation/ConversationDeletionService';
import { ConversationDeletionStore } from './conversation/ConversationDeletionStore';
import { ConversationLifecycleService } from './conversation/ConversationLifecycleService';
import { SingleChatHistoryStore } from './conversation/SingleChatHistoryStore';
import { SingleChatMessageStore } from './conversation/SingleChatMessageStore';
import { generateApiDiary, generateClaudeDiary, generateClaudeOneShot, generateCodexDelegation, generateCodexDiary, generateExistingDiary } from './diary/DiaryGenerators';
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
import { MemorySourceService } from './memory/MemorySourceService';
import { PartnerMemoryBriefingService } from './memory/PartnerMemoryBriefingService';
import { PartnerMemoryManagementService } from './memory/PartnerMemoryManagementService';
import { PartnerMemoryService } from './memory/PartnerMemoryService';
import { PartnerMemoryToolService } from './memory/PartnerMemoryToolService';
import { SqliteMemoryCutover } from './memory/SqliteMemoryCutover';
import { MemoryConsolidation, createMemoryFallbackAdapter } from './memory/fallback/MemoryConsolidation';
import { singleChatFallbackInputs, studioFallbackInputs } from './memory/fallback/MemoryFallbackInputs';
import { MemoryFallbackInventory } from './memory/fallback/MemoryFallbackInventory';
import { MemoryFallbackJobStore } from './memory/fallback/MemoryFallbackJobStore';
import { MemoryFallbackScheduler } from './memory/fallback/MemoryFallbackScheduler';
import { MemoryFallbackSettingsStore } from './memory/fallback/MemoryFallbackSettingsStore';
import { PartnerProjectNotebookService } from './notebook/PartnerProjectNotebookService';
import { PartnerProfileService } from './partner/PartnerProfileService';
import { PartnerProfileStore } from './partner/PartnerProfileStore';
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
import { createAsteriumRuntimeTools, memoryToolAccess, projectNotebookToolAccess, type ProjectNotebookToolInput } from './runtime/AsteriumRuntimeTools';
import { ContextHandoffService } from './runtime/ContextHandoffService';
import { assertReadOnlyDelegation, delegationSystemPrompt, resolveDelegationAccess } from './runtime/DelegationAccess';
import { DelegationConversationRuntime, delegationReportTools } from './runtime/DelegationConversationRuntime';
import { DelegationResultDelivery } from './runtime/DelegationResultDelivery';
import { describeReviewFile, existingPartnerReviewMessage, runExistingPartnerReview, snapshotReviewArtifact } from './runtime/ExistingPartnerReview';
import { createExistingThreadService } from './runtime/ExistingThreadService';
import { ExistingThreadWatchRegistry } from './runtime/ExistingThreadWatchRegistry';
import { createLegacyRunPath } from './runtime/LegacyRunPath';
import { createLocalRuntimeResolver } from './runtime/LocalRuntimeResolver';
import { createMessageRuntime } from './runtime/MessageRuntime';
import { NativeProfileReloadError, confirmNativeProfileReload } from './runtime/NativeProfileReload';
import { PartnerDelegation, delegationInput, delegationWaitInput, type DelegationBatch, type DelegationTask } from './runtime/PartnerDelegation';
import { PartnerRuntimeFactory, localRuntimeAdapterKey } from './runtime/PartnerRuntimeFactory';
import { PartnerRuntimePort } from './runtime/PartnerRuntimePort';
import { RunCoordinator } from './runtime/RunCoordinator';
import { createRuntimeEventBridge } from './runtime/RuntimeEventBridge';
import { createRuntimeRunHooks } from './runtime/RuntimeRunHooks';
import { assembleSessionBootstrap } from './runtime/SessionBootstrapAssembler';
import { SessionBootstrapRecorder } from './runtime/SessionBootstrapRecorder';
import { SessionBootstrapService } from './runtime/SessionBootstrapService';
import { SessionCommandService } from './runtime/SessionCommandService';
import { SessionCompactionService } from './runtime/SessionCompactionService';
import { SessionProfileReloadService, profileReloadPrompt } from './runtime/SessionProfileReloadService';
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
import { StudioWakeControlService } from './studio/StudioWakeControlService';
import { StudioWakeEventStore } from './studio/StudioWakeEventStore';
import { StudioWakeEvents } from './studio/StudioWakeEvents';

export { AGENT_IPC };

const BRAVE_SEARCH_CREDENTIAL_REF = 'asterium-web-search-brave';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerAgentIpc(ipcMain: IpcMain, getWindow: () => BrowserWindow | null, options: { generalSettings?: GeneralSettingsStore; notifications?: DesktopNotifications; updates?: AppUpdateService; environment?: import('../shared/runtimeEnvironment').RuntimeEnvironment } = {}) {
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
  const localRuntimeResolver = createLocalRuntimeResolver({ nativeBindings, singleChatHistory, conversationDeletions, workspaceGrants, grants, protectedRoots, userDataDirectory: () => app.getPath('userData') });
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
  const codexDelegationImageLimit = 10 * 1024 * 1024;
  function withDelegationChatPriority<T>(conversationId: string, start: () => Promise<T>) {
    return delegationHandles.delivery ? delegationHandles.delivery.withUserPriority(conversationId, start) : start();
  }

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
        const cwd = await mkdtemp(path.join(app.getPath('temp'), 'asterium-delegation-'));
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
      const cwd = await mkdtemp(path.join(app.getPath('temp'), 'asterium-delegation-'));
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
  function delegationConnectionFingerprint(connection: unknown) {
    return createHash('sha256').update(JSON.stringify(connection)).digest('hex');
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
  const configuredApiOptions = createApiRuntimeConfiguration(credentials);
  const contextHandoff = new ContextHandoffService(singleChatMessages, studioRooms, id => {
    const partner = studioRuntimeCatalog.partner(id);
    return Boolean(partner?.available && (partner.runtime.kind === 'local' || partner.runtime.kind === 'api'));
  }, id => studioRuntimeCatalog.partner(id)?.publicIdentity.displayName ?? '伙伴');
  const memoryImport = new MemoryImportService(partnerMemories, fallbackEligible, async input => {
    const config = await memoryFallbackSettings.get();
    if (config.provider !== input.provider || config.endpoint !== input.endpoint || config.model !== input.model) {
      throw new Error('MEMORY_IMPORT_CONNECTION_CHANGED');
    }
    const apiKey = await memoryFallbackSettings.secret(config);
    if (!apiKey) throw new Error('MEMORY_IMPORT_CREDENTIAL_REQUIRED');
    return createMemoryFallbackAdapter(config, apiKey);
  });
  const memoryFallbackScheduler = new MemoryFallbackScheduler(memoryFallbackSettings, memoryFallbackJobs, memoryFallbackInventory,
    new MemoryConsolidation(partnerMemories, memorySources), async (config) => {
      const apiKey = await memoryFallbackSettings.secret(config);
      if (!apiKey) throw new Error('MEMORY_FALLBACK_CREDENTIAL_REQUIRED');
      return createMemoryFallbackAdapter(config, apiKey);
    }, fallbackEligible);
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
      const adapterKey = localRuntimeAdapterKey({ adapterType: 'codex_cli', runtimeId: selected.runtimeId,
        partnerId: request.partnerId, conversationId: request.conversationId, partnerRoot: root, additionalDirectories: [] });
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
        return { message,
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
  const sessionCommands = new SessionCommandService({ bindings: nativeBindings, catalog: studioRuntimeCatalog, messages: singleChatMessages, leases: writerLeases, compactions: sessionCompactions, reload: (request) => profileReloads.execute(request), isDeleted: (id) => conversationDeletions.isDeleted(id) });
  const diaryCatalog = new PartnerDiaryCatalog(studioRuntimeCatalog);
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
    generate: async ({ config, entry, source, signal }) => {
      const current = diaryCatalog.current(config.partnerId);
      if (!current?.identity.available) throw new Error('DIARY_RUNTIME_UNAVAILABLE');
      if (current.existing) {
        const secret = await credentials.get(current.existing.credentialRef);
        if (!secret || !config.upstreamThreadId) throw new Error('DIARY_RUNTIME_UNAVAILABLE');
        return generateExistingDiary(current.existing, secret, config.upstreamThreadId, entry.generationId, source, signal);
      }
      const partner = current.runtime;
      const profile = await partnerProfiles.runtimeProfile(config.partnerId);
      if (!partner || !profile) throw new Error('DIARY_RUNTIME_UNAVAILABLE');
      const persona = await partnerProfiles.managedPersonaState(config.partnerId);
      const bootstrap = assembleSessionBootstrap({ source: partner.sourceMode, partnerName: profile.publicIdentity.displayName,
        management: { ...profile.management, memoryMode: 'self_managed' }, user: await partnerProfiles.runtimeUserProfile(),
        ...(persona.enabled ? { persona } : {}), platformContext: '本回合是隔离的每日伙伴日记，不属于用户聊天；不提供记忆简报和记忆工具。',
      })?.content ?? '';
      if (partner.runtime.kind === 'api') {
        const connection = await apiConnections.resolve(partner.partnerId, partner.runtime.connection); const apiOptions = await configuredApiOptions(connection);
        const provider = apiProviders.normalizeConnection(connection);
        return generateApiDiary(provider.definition.createAdapter({ ...apiOptions, endpoint: provider.endpoint, model: provider.model, thinkingMode: 'disabled' }), source, bootstrap, signal);
      }
      if (partner.runtime.kind !== 'local') throw new Error('DIARY_RUNTIME_UNAVAILABLE');
      const directory = path.join(app.getPath('userData'), 'diary-runtime', entry.generationId);
      await mkdir(directory, { recursive: true });
      const input = { cwd: directory, source, bootstrap, signal };
      if (partner.runtime.adapterType === 'codex_cli') {
        const installation = await ensureCodexInstallation();
        const runtime = resolveCodexRuntime(installation.runtimes, partner.runtime.codexRuntimeId, partner.runtime.codexRuntimeEnvironment);
        if (!runtime?.loggedIn) throw new Error('DIARY_RUNTIME_UNAVAILABLE');
        return generateCodexDiary({ ...input, executablePath: runtime.executablePath });
      }
      const installation = await ensureClaudeInstallation();
      if (!installation.executablePath || !installation.loggedIn) throw new Error('DIARY_RUNTIME_UNAVAILABLE');
      return generateClaudeDiary({ ...input, executablePath: installation.executablePath, ...(partner.recentModel?.model ? { model: partner.recentModel.model } : {}) }, (await loadClaudeCliRuntime()).query);
    },
  });

  const automationStore = new AutomationStore(() => path.join(app.getPath('userData'), 'automations.v1.json'));
  const automationConfirmations = new AutomationConfirmations(() => { notifications?.confirmations(automationConfirmations.list()); const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.automationsConfirmationsChanged); });
  const automationHandles: { runtime?: AutomationRuntime; scheduler?: AutomationScheduler } = {};
  const automationService = new AutomationService(automationStore, {
    runtimeReady: () => restoreBackgroundServices && Boolean(automationHandles.scheduler),
    get scheduler() { return restoreBackgroundServices ? automationHandles.scheduler : undefined; },
    targets: async () => {
      const targets: AutomationTargetOption[] = [];
      for (const c of await singleChatMessages.list()) {
        const partner = studioRuntimeCatalog.partner(c.partnerId);
        if (!partner || c.isArchived || c.isDisabled || !c.sessionId || await conversationDeletions.isDeleted(c.conversationId)) continue;
        const b = await nativeBindings.getForScope(c.partnerId, 'single', c.conversationId);
        if ((!b || b.state !== 'active' || b.nativeThreadId !== c.sessionId) && partner.sourceMode !== 'existing_thread') continue;
        targets.push({ target: { partnerId: c.partnerId, conversationId: c.conversationId, sourceMode: partner.sourceMode, nativeThreadId: c.sessionId, bindingGeneration: b?.generation ?? 1, workspaceSignature: await automationWorkspaceSignature(c.partnerId) },
          label: `${partner.publicIdentity.displayName} · ${c.title || '单聊'}`, available: partner.sourceMode !== 'existing_thread' && partner.available,
          ...(partner.sourceMode === 'existing_thread' ? { reason: '外部宿主尚未声明自动化能力' } : {}) });
      }
      for (const room of await studioRooms.listAll()) {
        if (room.metadata.archived) continue;
        for (const id of room.metadata.memberIds) {
          const p = studioRuntimeCatalog.partner(id), b = await nativeBindings.getForScope(id, 'group', room.metadata.roomId);
          if (!p || !b || b.state !== 'active' || !b.nativeThreadId) continue;
          targets.push({ target: { partnerId: id, conversationId: b.conversationId, nativeThreadId: b.nativeThreadId, bindingGeneration: b.generation, sourceMode: p.sourceMode, workspaceSignature: await automationWorkspaceSignature(id, room.metadata.projectId), roomId: room.metadata.roomId, projectId: room.metadata.projectId }, label: `${p.publicIdentity.displayName} · ${room.metadata.name}`, available: p.available && p.sourceMode !== 'existing_thread' });
        }
      }
      return targets;
    },
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
  const { sendEvent, transformRuntimeEvent, delivery, notifyHandoffDelivered } = createRuntimeEventBridge({ automationConfirmations, automationHandles, getWindow, notifications, partnerProfiles, projectFileDelivery, projectTaskRuntimeRef, sessionCommands, singleChatHistory, studioRuntimeCatalog });
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
  const unsubscribeProjectDomain = projectDomain.subscribe((snapshot) => {
    notifications?.tasks(snapshot.tasks);
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.projectDomainChanged, { type: 'snapshot', snapshot });
    void projectTaskOrchestrator.reconcileProject(snapshot).catch((error) => console.error('Failed to reconcile project task dependencies.', error));
    for (const project of snapshot.projects) {
      void projectWorkflows.reconcileProject(project.id, snapshot.tasks.filter((task) => task.projectId === project.id))
        .catch((error) => console.error('Failed to reconcile project workflow state.', error));
    }
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
  const currentMemorySource = async (command: SendMessageCommand): Promise<MemorySourceAnchor | undefined> => {
    if (command.route?.scope === 'group') {
      const route = command.route;
      const room = await studioRooms.getRoom(route.roomId);
      const triggerMessageId = room?.activeRound?.roundId === route.roundId
        ? room.activeRound.triggerMessageId
        : room?.messages.find((message) => message.roundId === route.roundId && message.authorType === 'user')?.messageId;
      return triggerMessageId ? { kind: 'studio', roomId: route.roomId, messageId: triggerMessageId } : undefined;
    }
    return command.messageId ? { kind: 'single_chat', conversationId: command.conversationId, messageId: command.messageId } : undefined;
  };
  const runtimeToolsFor = (command: SendMessageCommand, memoryMode?: string) => {
    const memoryAccess = memoryToolAccess(memoryMode, command.route);
    const notebookAccess = projectNotebookToolAccess(command.route);
    const memoryContext = async () => ({ partnerId: command.partnerId, currentSource: await currentMemorySource(command) });
    const projectNotebook = async (input: ProjectNotebookToolInput) => {
      const studioProjectId = command.route?.scope === 'group' ? command.runtimeContext?.conversation?.studio?.projectId : undefined;
      if (input.action === 'list') {
        if (studioProjectId) {
          const project = await projectNotebooks.assertActiveMembership(command.partnerId, studioProjectId);
          return JSON.stringify([{ projectId: project.id, name: project.name, status: project.status, current: true }], null, 2);
        }
        return JSON.stringify(await projectNotebooks.listAccessibleProjects(command.partnerId), null, 2);
      }
      const projectId = studioProjectId ?? input.projectId;
      if (!projectId) throw new Error('PROJECT_NOTEBOOK_PROJECT_REQUIRED');
      if (studioProjectId && input.projectId && input.projectId !== studioProjectId) throw new Error('PROJECT_NOTEBOOK_STUDIO_PROJECT_FIXED');
      const project = await projectNotebooks.assertActiveMembership(command.partnerId, projectId);
      const store = await projectNotebooks.notebookStore(command.partnerId);
      if (input.action === 'read') {
        const notebook = await store.get(projectId);
        return JSON.stringify({ project: { projectId: project.id, name: project.name }, notebook: notebook ?? null, revision: notebook?.revision ?? 0 }, null, 2);
      }
      if (input.action === 'append') return JSON.stringify(await store.append({ projectId, projectName: project.name, content: input.content }), null, 2);
      return JSON.stringify(await store.replace({ projectId, projectName: project.name, content: input.content, expectedRevision: input.expectedRevision }), null, 2);
    };
    const tools = createAsteriumRuntimeTools({
    ...((!command.route || command.route.scope === 'single') && command.sourceMessage?.authorType === 'user' && !automationHandles.runtime?.runFor(command) ? {
      delegation: async (tool: string, input: Record<string, unknown>, signal: AbortSignal, toolCallId?: string) => {
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
      },
    } : {}),
    workspaceChangesAllowed: !automationHandles.runtime?.runFor(command),
    automation: (input, signal) => automationAgentTools.call(input, {
      partnerId: command.partnerId, conversationId: command.conversationId,
      ownerKey: command.clientMessageId, signal,
      permissionMode: command.execution?.permissionMode ?? 'manual',
      automatic: Boolean(automationHandles.runtime?.runFor(command)), readOnly: command.execution?.permissionMode === 'read_only' || command.execution?.planMode === 'plan',
      report: changed => automationHandles.runtime!.report(command, changed),
    }),
    partnerId: command.partnerId,
    conversationId: command.conversationId,
    permissionMode: command.execution?.permissionMode ?? 'manual',
    planMode: command.execution?.planMode ?? 'default',
    context: command.runtimeContext,
    route: command.route,
    ...(command.route?.scope === 'group' ? { mentionPartner: async ({ route, partnerId, targetPartnerId, label }: { route: Extract<NonNullable<SendMessageCommand['route']>, { scope: 'group' }>; partnerId: string; targetPartnerId: string; label: string }) => {
      await studioRooms.mentionPartner({ ...route, partnerId, targetPartnerId, label,
        externalTarget: studioRuntimeCatalog.partner(targetPartnerId)?.sourceMode === 'existing_thread' });
    } } : {}),
    workspaces: partnerWorkspaces,
    artifacts,
    attachments: messageAttachments,
    ...projectTaskRuntimeRef.current?.toolOptions(command),
    ...workflowGenerationRuntimeRef.current?.toolOptions(command),
    ...(notebookAccess ? { projectNotebook } : {}),
    ...(memoryAccess === 'none' ? {} : { memory: {
      access: memoryAccess,
      search: async (input: Parameters<PartnerMemoryToolService['search']>[1]) => JSON.stringify(await partnerMemoryTools.search(await memoryContext(), input), null, 2),
      readSource: async (input: Parameters<PartnerMemoryToolService['readSource']>[1]) => JSON.stringify(await partnerMemoryTools.readSource(await memoryContext(), input), null, 2),
      ...(memoryAccess === 'write' ? {
        hold: async (input: Parameters<PartnerMemoryToolService['hold']>[1]) => JSON.stringify(await partnerMemoryTools.hold(await memoryContext(), input), null, 2),
        comment: async (input: Parameters<PartnerMemoryToolService['comment']>[1]) => JSON.stringify(await partnerMemoryTools.comment(await memoryContext(), input), null, 2),
        update: async (input: Parameters<PartnerMemoryToolService['update']>[1]) => JSON.stringify(await partnerMemoryTools.update(await memoryContext(), input), null, 2),
      } : {}),
    } }),
    });
    return delegationHandles.delivery?.owns(command) ? delegationReportTools(tools) : tools;
  };

  const { hooks, persistFirstSingleChatBinding, captureGuidanceSource, markAcceptedStudioSpeakingMode } = createRuntimeRunHooks({ automationHandles, checkAutomation: (run, owner) => checkAutomation(run, owner), delegation, delegationHandles, delivery, hydrateManagedRuntimeProfile, nativeBindings, notifyHandoffDelivered, projectChanges, projectTaskRuntimeRef, sendEvent, sessionBootstrapRecorder, singleChatHistory, singleChatMessages, studioOrchestration, studioRooms, transformRuntimeEvent, workflowGenerationRuntimeRef });
  const runCoordinator = new RunCoordinator(host, hooks, writerLeases);
  const { startAdapterRun } = createLegacyRunPath({ captureGuidanceSource, delivery, host, hydrateManagedRuntimeProfile, markAcceptedStudioSpeakingMode, nativeBindings, notifyHandoffDelivered, persistFirstSingleChatBinding, sendEvent, sessionBootstrapRecorder, studioOrchestration, studioRooms, transformRuntimeEvent, writerLeases });
  const useLegacyRunPath = process.env.ASTERIUM_USE_LEGACY_RUN_PATH === '1';
  const { startApiRuntime, startLocalRuntime } = createMessageRuntime({ apiConnections, apiProviders, attachAutomationCommand: command => attachAutomationCommand(command), availableImportedDirectory, configuredApiOptions, ensureClaudeInstallation, hydrateManagedRuntimeProfile, importedCodexBinding, messageAttachments, partnerWorkspaces, protectedRoots, resolveImportedCodexRuntime, resolveSelectedCodexRuntime, resolveWorkspaceGrant, runCoordinator, runtimeFactory, runtimeToolsFor, singleChatMessages, startAdapterRun, useLegacyRunPath });
  const projectTaskRuntime = new ProjectTaskRuntime({
    catalog: studioRuntimeCatalog,
    bindings: nativeBindings,
    startApi: ({ partner, command, projectRoot }) => {
      if (partner.runtime.kind !== 'api') throw new Error('PROJECT_TASK_PARTNER_RUNTIME_UNAVAILABLE');
      return startApiRuntime({ connection: partner.runtime.connection, command, projectRootOverride: projectRoot });
    },
    startLocal: ({ partner, command, projectRoot }) => {
      if (partner.runtime.kind !== 'local') throw new Error('PROJECT_TASK_PARTNER_RUNTIME_UNAVAILABLE');
      return startLocalRuntime({
        adapterType: partner.runtime.adapterType,
        partnerId: partner.partnerId,
        partnerRootGrantId: partner.runtime.partnerRootGrantId,
        workspaceGrantIds: [],
        command,
        codexRuntimeId: partner.runtime.codexRuntimeId,
        codexRuntimeEnvironment: partner.runtime.codexRuntimeEnvironment,
        projectRootOverride: projectRoot,
      });
    },
    cancelRun: (command) => runCoordinator.cancel(command),
    submitHandoff: async (attemptId, handoff) => {
      const result = await projectTaskOrchestrator.submitHandoff(attemptId, handoff);
      projectTaskRuntimeRef.current?.reportChanges(attemptId, handoff.changedPaths, projectChanges, handoff.verification);
      return result;
    },
    submitReview: (attemptId, review) => projectTaskOrchestrator.submitReview(attemptId, review),
    captureChangedFiles: (projectId, changedPaths) => projectFiles.captureChangedPaths(projectId, changedPaths),
  });
  projectTaskRuntimeRef.current = projectTaskRuntime;
  const workflowGenerationRuntime = new ProjectWorkflowGenerationRuntime({
    generations: projectWorkflowGenerations,
    rooms: studioRooms,
    catalog: studioRuntimeCatalog,
    bindings: nativeBindings,
    project: (projectId) => projectDomain.getProject(projectId),
    roles: (projectId) => projectWorkRoles.catalog(projectId),
    workflowCatalog: (projectId) => projectService.workflowCatalog(projectId),
    createWorkflow: (input) => projectService.createGeneratedWorkflow(input),
    workflowForGeneration: (generationId) => projectWorkflows.getByGenerationId(generationId),
    startApi: ({ partner, command, planningRoot }) => {
      if (partner.runtime.kind !== 'api') throw new Error('PROJECT_WORKFLOW_GENERATION_PLANNER_UNAVAILABLE');
      return startApiRuntime({ connection: partner.runtime.connection, command, projectRootOverride: planningRoot });
    },
    startLocal: ({ partner, command, planningRoot }) => {
      if (partner.runtime.kind !== 'local') throw new Error('PROJECT_WORKFLOW_GENERATION_PLANNER_UNAVAILABLE');
      return startLocalRuntime({
        adapterType: partner.runtime.adapterType,
        partnerId: partner.partnerId,
        partnerRootGrantId: partner.runtime.partnerRootGrantId,
        workspaceGrantIds: [],
        command,
        codexRuntimeId: partner.runtime.codexRuntimeId,
        codexRuntimeEnvironment: partner.runtime.codexRuntimeEnvironment,
        projectRootOverride: planningRoot,
      });
    },
    cancelRun: (command) => runCoordinator.cancel(command),
    planningRoot: async () => {
      const root = path.join(options.environment?.temporaryDirectory ?? app.getPath('temp'), 'workflow-planning');
      await mkdir(root, { recursive: true });
      return root;
    },
  });
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
  const sendExistingThreadChanged = (partnerId: string, change: { threadId: string; previousThreadId?: string; workspaceRoot: string; reason: string }) => {
    diaryCatalog.observeThread(partnerId, change.threadId, change.workspaceRoot);
    void diaryScheduler.changed().catch(() => console.error('Diary upstream binding update failed.'));
    sendEvent({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'existing_thread.changed',
    eventId: randomUUID(),
    partnerId,
    connectionSource: 'existing_thread',
    threadId: change.threadId,
    ...(change.previousThreadId ? { previousThreadId: change.previousThreadId } : {}),
    workspaceRoot: change.workspaceRoot,
    reason: change.reason,
    occurredAt: new Date().toISOString(),
  }); };
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
    onReply: (command, threadId, reply) => {
      const window = getWindow();
      if (!window || window.isDestroyed()) return;
      window.webContents.send(AGENT_IPC.event, {
        type: 'existing_thread.reply',
        partnerId: command.partnerId,
        conversationId: command.conversationId,
        threadId,
        eventId: reply.id,
        occurredAt: Number.isFinite(Date.parse(reply.createdAt)) ? reply.createdAt : new Date().toISOString(),
        text: reply.text,
      } satisfies ExistingThreadReplyEvent);
    },
  });
  registerExistingThreadIpc(ipcMain, credentials, existingThreads, requireSender);

  registerLocalMessageIpc(ipcMain, { contextHandoff, withDelegationChatPriority, startLocalRuntime }, requireSender);

  registerRunControlIpc(ipcMain, { runCoordinator, automationConfirmations }, requireSender);

  async function prepareStudioTurn(value: StudioPrepareTurnRequest) {
    if (value.source === 'existing_thread') throw new Error('STUDIO_EXISTING_THREAD_NOT_SUPPORTED');
    // v3 group bindings rebuild once from the canonical ledger so runtimes
    // receive their own registered replies (including the public seq) instead
    // of relying on native-thread history that cannot know the later seq.
    const conversationBase = `group:v3:${value.roomId}:${value.partnerId}`;
    let binding = await nativeBindings.reserve({
      partnerId: value.partnerId,
      source: value.source,
      scope: 'group',
      conversationId: conversationBase, generationScopedConversation: true,
      roomId: value.roomId,
    });
    if (binding.conversationId !== conversationBase && !binding.conversationId.startsWith(conversationBase + ':generation:')) {
      await nativeBindings.invalidate(binding.bindingId);
      binding = await nativeBindings.reserve({ partnerId: value.partnerId, source: value.source, scope: 'group', conversationId: conversationBase, generationScopedConversation: true, roomId: value.roomId });
    }
    if (binding.state === 'active' && binding.nativeThreadId && value.adapterType === 'codex_cli') {
      const { runtime, workingDirectory } = await resolveCodexLifecycleRuntime(value);
      const [lifecycle] = await getCodexThreadLifecycles(runtime.executablePath, workingDirectory, [binding.nativeThreadId]);
      const lastTurnId = lifecycle?.state === 'active'
        ? await getCodexThreadLastTurnId(runtime.executablePath, workingDirectory, binding.nativeThreadId).catch(() => undefined)
        : undefined;
      if (lifecycle?.state !== 'active' || !binding.lastCompletedRunId || lastTurnId !== binding.lastCompletedRunId) {
        await nativeBindings.invalidate(binding.bindingId);
        binding = await nativeBindings.reserve({
          partnerId: value.partnerId,
          source: value.source,
          scope: 'group',
          conversationId: conversationBase, generationScopedConversation: true,
          roomId: value.roomId,
        });
      }
    }
    const prepared = await studioRooms.prepareTurn(value.roomId, value.roundId, value.partnerId, binding.generation, binding.conversationId, binding.nativeThreadId, binding.studioSpeakingMode);
    const snapshot = await studioRooms.getRoom(value.roomId);
    return studioAttachments.prepareTurn(prepared, snapshot?.messages ?? []);
  }

  async function automationWorkspaceSignature(partnerId: string, projectId?: string) {
    const workspace = projectId ? await projectWorkspaces.get(projectId) : await partnerWorkspaces.grantIds(partnerId);
    return createHash('sha256').update(JSON.stringify(workspace ?? null)).digest('hex');
  }
  async function checkAutomation(run: AutomationRun, leaseOwner?: string) {
    const t = run.definition.target, partner = studioRuntimeCatalog.partner(t.partnerId);
    const unavailable = (reason: string) => ({ available: false, reason });
    if (useLegacyRunPath) return unavailable('旧运行路径尚不支持自动化');
    if (!partner || !partner.available || partner.sourceMode !== t.sourceMode) return unavailable('伙伴暂不可用');
    if (partner.sourceMode === 'existing_thread') return unavailable('外部宿主尚未声明自动化能力');
    if (!t.workspaceSignature || t.workspaceSignature !== await automationWorkspaceSignature(t.partnerId, t.projectId)) return unavailable('工作区已变化，请编辑后重新绑定');
    const binding = await nativeBindings.getForScope(t.partnerId, t.roomId ? 'group' : 'single', t.roomId ?? t.conversationId);
    if (!binding || binding.state !== 'active' || binding.nativeThreadId !== t.nativeThreadId || binding.generation !== t.bindingGeneration || binding.profileRecoveryRequired) return unavailable('原线程绑定已变化或需要恢复');
    const owner = writerLeases.ownerFor({ kind: 'conversation', partnerId: t.partnerId, conversationId: t.conversationId });
    if (owner && owner !== leaseOwner) return unavailable('原线程忙碌，等待空闲');
    if (t.roomId) {
      const room = await studioRooms.getRoom(t.roomId);
      if (!room || room.metadata.archived || room.metadata.projectId !== t.projectId || !room.metadata.memberIds.includes(t.partnerId) || room.mutedPartnerIds.includes(t.partnerId)) return unavailable('群聊资格或项目已变化');
      if (room.settings.speakingMode === 'selected_partners' && !room.settings.selectedPartnerIds.includes(t.partnerId)) return unavailable('目标伙伴不在当前指定发言成员中');
      if (room.activeRound && !['completed', 'cancelled', 'failed'].includes(room.activeRound.state)
        && room.activeRound.triggerMessageId !== `automation-trigger:${run.id}`) return unavailable('群聊正在进行另一轮');
      const projectOwner = writerLeases.ownerFor({ kind: 'project_workspace', projectId: t.projectId! });
      if (projectOwner && projectOwner !== `automation:${run.id}`) return unavailable('项目工作区忙碌');
    } else {
      const source = await singleChatMessages.getConversation(t.conversationId);
      if (await conversationDeletions.isDeleted(t.conversationId) || !source || source.partnerId !== t.partnerId || source.isArchived || source.isDisabled || source.sessionId !== t.nativeThreadId) return unavailable('原对话不可用');
      if (source.busy && !leaseOwner) return unavailable('原对话忙碌，等待空闲');
      const workspace = await partnerWorkspaces.grantIds(t.partnerId);
      if (source.partnerRootGrantId && source.partnerRootGrantId !== workspace?.cwdGrantId) return unavailable('请先切回原对话的工作区');
    }
    return { available: true };
  }
  async function attachAutomationCommand(command: SendMessageCommand) {
    if (command.route?.scope === 'group') {
      const run = automationHandles.runtime?.pendingGroup(command.route.roomId, command.partnerId);
      if (run) {
        const room = await studioRooms.getRoom(command.route.roomId);
        if (room?.activeRound?.triggerMessageId === `automation-trigger:${run.id}`) automationHandles.runtime?.attach(command, run.id);
      }
    } else automationHandles.runtime?.attach(command);
  }
  const automationProjectLeases = new Map<string, ReturnType<WriterLeaseCoordinator['tryAcquire']>>();
  const automationAgentTools = new AutomationAgentTools(automationService, async (request, owner) => {
    const window = getWindow(); if (!window || window.isDestroyed()) return false;
    if (request.action !== 'create' && request.action !== 'update' && request.action !== 'remove') return false;
    const task = 'input' in request ? request.input : (await automationStore.snapshot()).automations.find(d => d.id === request.id);
    if (!task) return false;
    const target = (await automationService.get(owner.partnerId)).targets.find(t => t.target.conversationId === task.target.conversationId);
    return automationConfirmations.request({ action: request.action,
      partnerName: studioRuntimeCatalog.partner(owner.partnerId)?.publicIdentity.displayName ?? '伙伴', targetLabel: target?.label ?? '原对话',
      task: { name: task.name, instructions: task.instructions, schedule: task.schedule, timezone: task.timezone, catchUp: task.catchUp, notifications: task.notifications, enabled: task.enabled },
    }, owner.ownerKey, owner.signal);
  });
  studioMcpService.automation = async (token, input) => {
    const identity = await studioMcpService.authenticate(token);
    const revalidate = async () => {
      if ((await studioMcpService.authenticate(token)).partnerId !== identity.partnerId) throw new Error('STUDIO_MCP_UNAUTHORIZED');
      if (!(await studioMcpAccess.snapshot()).configuration.automationManagementEnabled) throw new Error('AUTOMATION_EXTERNAL_DISABLED');
    };
    return automationAgentTools.call(input, { partnerId: identity.partnerId, automatic: false, revalidate });
  };
  automationHandles.runtime = new AutomationRuntime(automationStore, {
    check: run => checkAutomation(run),
    launch: async (run, signal) => {
      const t = run.definition.target, p = studioRuntimeCatalog.partner(t.partnerId);
      if (!p || p.runtime.kind === 'unsupported') throw new Error('AUTOMATION_PARTNER_UNAVAILABLE');
      const previous = (await automationStore.snapshot()).runs.filter(r => r.automationId === run.automationId && r.state === 'succeeded').slice(-3).map(r => ({ summary: r.summary?.slice(0, 8000), finishedAt: r.finishedAt }));
      const prompt = automationPrompt(run, previous);
      signal.throwIfAborted();
      if (t.roomId) {
        const lease = writerLeases.tryAcquire({ kind: 'project_workspace', projectId: t.projectId! }, `automation:${run.id}`);
        if (!lease) throw new Error('AUTOMATION_PROJECT_BUSY'); automationProjectLeases.set(run.id, lease);
        const policy = await projectExecutionPolicies.getOrCreate(t.projectId!);
        await studioRooms.publishAutomationMessage(t.roomId, t.partnerId, { automationId: run.automationId, runId: run.id, name: run.definition.name }, prompt, policy.permissionMode);
        return;
      }
      const source = await singleChatMessages.getConversation(t.conversationId); if (!source) throw new Error('AUTOMATION_SOURCE_MISSING');
      const command: SendMessageCommand = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: `automation-command:${run.id}`, clientMessageId: `automation:${run.id}`,
        partnerId: t.partnerId, conversationId: t.conversationId, connectionSource: t.sourceMode, sessionId: t.nativeThreadId,
        content: { type: 'text', text: prompt }, execution: { permissionMode: source.permissionMode ?? 'manual', planMode: source.planMode ?? 'default' },
        runtimeContext: { partner: { displayName: p.publicIdentity.displayName, introduction: p.publicIdentity.introduction, expertise: p.publicIdentity.expertise, mentionName: p.publicIdentity.mentionName, avatarAvailable: Boolean(p.publicIdentity.avatarDataUrl) },
          runtime: p.runtimeContext, user: studioRuntimeCatalog.user(), conversation: { title: source.title ?? run.definition.name } },
        apiContext: { apiSessionHistoryEnabled: source.apiSessionHistoryEnabled ?? true, history: trimChatHistory(source.messages.filter(m => m.fallbackEligible !== false).map(m => ({ role: m.authorType === 'user' ? 'user' as const : 'assistant' as const, content: m.content }))) },
      };
      automationHandles.runtime!.attach(command);
      if (p.runtime.kind === 'api') await startApiRuntime({ connection: p.runtime.connection, command });
      else await startLocalRuntime({ adapterType: p.runtime.adapterType, partnerId: t.partnerId, partnerRootGrantId: p.runtime.partnerRootGrantId, workspaceGrantIds: p.runtime.workspaceGrantIds,
        codexRuntimeId: p.runtime.codexRuntimeId, codexRuntimeEnvironment: p.runtime.codexRuntimeEnvironment, command });
    },
    cancel: (command, receipt) => runCoordinator.cancel({ ...command, type: 'run.cancel', commandId: `automation-cancel:${randomUUID()}`, runId: receipt.runId, sessionId: receipt.sessionId, reason: '取消自动化本次执行' }),
    saveResult: async (run, summary, messageId, completed) => {
      if (run.definition.target.roomId) return;
      const now = new Date(); await singleChatMessages.upsertMessage(run.definition.target.conversationId, run.definition.target.partnerId, {
        messageId, automationRunId: run.id, authorType: 'partner', authorId: run.definition.target.partnerId, content: summary,
        createdAt: now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), occurredAt: run.startedAt ?? now.toISOString(), completedAt: now.toISOString(), fallbackEligible: completed,
      });
    },
  });
  automationHandles.scheduler = new AutomationScheduler(automationStore, {
    check: run => automationHandles.runtime!.check(run),
    execute: async (run, signal) => { try { return await automationHandles.runtime!.execute(run, signal); } finally { automationProjectLeases.get(run.id)?.release(); automationProjectLeases.delete(run.id); } },
  });
  delegationHandles.conversation = new DelegationConversationRuntime({
    binding: (partnerId, conversationId) => nativeBindings.getForScope(partnerId, 'single', conversationId),
    source: id => singleChatMessages.getConversation(id), deleted: id => conversationDeletions.isDeleted(id),
    partner: id => studioRuntimeCatalog.partner(id), leases: writerLeases,
    workspaceSignature: async (partnerId, binding) => createHash('sha256').update(JSON.stringify({
      workspace: await automationWorkspaceSignature(partnerId), imported: binding.importedCodexWorkspace,
      runtime: studioRuntimeCatalog.partner(partnerId)?.runtime,
    })).digest('hex'),
    save: (conversationId, partnerId, message) => singleChatMessages.upsertMessage(conversationId, partnerId, message),
  });
  const resultConversation = delegationHandles.conversation;
  delegationHandles.delivery = new DelegationResultDelivery(delegation, {
    prepare: (batch, underLease) => resultConversation.prepare(batch, underLease),
    start: async command => {
      const partner = studioRuntimeCatalog.partner(command.partnerId);
      if (!partner?.available || partner.runtime.kind === 'unsupported') throw new Error('DELEGATION_DELIVERY_DEFERRED');
      if (partner.runtime.kind === 'api') return startApiRuntime({ connection: partner.runtime.connection, command }, true);
      return startLocalRuntime({ adapterType: partner.runtime.adapterType, partnerId: command.partnerId,
        partnerRootGrantId: partner.runtime.partnerRootGrantId, workspaceGrantIds: partner.runtime.workspaceGrantIds,
        codexRuntimeId: partner.runtime.codexRuntimeId, codexRuntimeEnvironment: partner.runtime.codexRuntimeEnvironment, command }, true);
    },
    cancel: (command, receipt) => runCoordinator.cancel({ ...command, type: 'run.cancel', commandId: 'delegation-cancel:' + randomUUID(),
      runId: receipt.runId, sessionId: receipt.sessionId, reason: '用户消息优先' }),
    saveReply: (batch, event, text, completed) => resultConversation.saveReply(batch, event, text, completed),
  });
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

function isUserProfileSeed(value: unknown): value is { displayName: string; introduction: string; updatedAt: string; revision?: string } {
  return isRecord(value)
    && typeof value.displayName === 'string' && value.displayName.length <= 80
    && typeof value.introduction === 'string' && value.introduction.length <= 20_000
    && typeof value.updatedAt === 'string'
    && (value.revision === undefined || typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision));
}

function isPartnerProfileSeed(value: unknown): value is PartnerProfileSeed {
  if (!isRecord(value) || typeof value.partnerId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value.partnerId)
    || !['existing_thread', 'local_cli', 'api_partner'].includes(String(value.sourceMode))
    || !isRecord(value.publicIdentity) || !isRecord(value.management) || !isRecord(value.connectionSettings)) return false;
  const identity = value.publicIdentity;
  return typeof identity.displayName === 'string' && identity.displayName.length <= 80
    && typeof identity.introduction === 'string' && identity.introduction.length <= 20_000
    && typeof identity.expertise === 'string' && identity.expertise.length <= 20_000
    && typeof identity.mentionName === 'string' && identity.mentionName.length <= 80
    && (identity.avatarDataUrl === undefined || typeof identity.avatarDataUrl === 'string')
    && typeof value.management.personality === 'boolean'
    && ['none', 'self_managed', 'asterium'].includes(String(value.management.memoryMode))
    && typeof value.management.userProfile === 'boolean'
    && (value.personality === undefined || (typeof value.personality === 'string' && value.personality.length <= 40_000))
    && (value.systemPrompt === undefined || (typeof value.systemPrompt === 'string' && value.systemPrompt.length <= 80_000))
    && (value.expectedRevision === undefined || typeof value.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(value.expectedRevision))
    && isJsonRecord(value.connectionSettings);
}

function isJsonRecord(value: Record<string, unknown>) {
  const valid = (item: unknown, depth: number): boolean => depth <= 8 && (
    item === null || ['string', 'number', 'boolean'].includes(typeof item)
    || (Array.isArray(item) && item.length <= 500 && item.every((entry) => valid(entry, depth + 1)))
    || (isRecord(item) && Object.keys(item).length <= 200 && Object.values(item).every((entry) => valid(entry, depth + 1)))
  );
  return valid(value, 0);
}

function isStudioRoomMetadata(value: unknown): value is StudioRoomMetadata {
  return isRecord(value)
    && typeof value.roomId === 'string' && Boolean(value.roomId)
    && typeof value.projectId === 'string' && Boolean(value.projectId)
    && typeof value.name === 'string' && Boolean(value.name.trim())
    && (value.archived === undefined || typeof value.archived === 'boolean')
    && Array.isArray(value.memberIds) && value.memberIds.every((id) => typeof id === 'string' && Boolean(id));
}

function archivedMarkdownFileName(name: string, suffix: string) {
  const withoutControlCharacters = [...name].map((character) => character.charCodeAt(0) < 32 ? '_' : character).join('');
  const safeName = withoutControlCharacters.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 120) || '项目';
  return `${safeName}-${suffix}.md`;
}
