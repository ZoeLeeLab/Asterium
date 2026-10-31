import type { DesktopNotifications } from './settings/DesktopNotifications';
import { GeneralSettingsStore } from './settings/GeneralSettingsStore';
import { trimChatHistory } from '../shared/chatHistory';
import { AutomationScheduler } from './automation/AutomationScheduler';
import { AutomationRuntime } from './automation/AutomationRuntime';
import { automationPrompt } from './automation/automationPrompt';
import { automationRunExpired } from '../shared/automationTime';
import type { AutomationRun } from '../shared/automations';
import { AutomationStore } from './automation/AutomationStore';
import { AutomationService } from './automation/AutomationService';
import { AutomationAgentTools } from './automation/AutomationAgentTools';
import { AutomationConfirmations } from './automation/AutomationConfirmations';
import { automationConfirmationReplySchema } from '../shared/automations';
import type { AutomationTargetOption } from '../shared/automations';
import { apiEndpoint, apiModelsEndpoint } from '../shared/apiEndpoints';
import { apiHeaders } from './api/ApiRequestConfiguration';
import { listApiSiteModels } from './api/listApiSiteModels';
import { ProjectRunChangeRecorder } from './project/ProjectRunChangeRecorder';
import { ProjectBrowserService } from './project/ProjectBrowserService';
import { SessionProfileReloadService, profileReloadPrompt } from './runtime/SessionProfileReloadService';
import { confirmProfileReload } from './api/confirmProfileReload';
import { SessionCommandService } from './runtime/SessionCommandService';
import { assertSessionCommandTarget } from '../shared/sessionCommands';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { copyFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, clipboard, dialog, nativeImage, safeStorage, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { AdapterHost } from './AdapterHost';
import { CyberBossBridgeClient, normalizeCyberBossServiceUrl } from './adapters/CyberBossBridgeClient';
import { readClaudeSessionFile } from './adapters/claudeSessionFile';
import { detectClaudeCode, type ClaudeInstallation } from './adapters/ClaudeCodeAdapter';
import { changeCodexThreadLifecycle, detectCodexCli, getCodexThreadLastTurnId, getCodexThreadLifecycles, getCodexThreadLifecyclesSafely, listCodexThreads, type CodexInstallation } from './adapters/CodexCliAdapter';
import type { PartnerAdapter } from './adapters/PartnerAdapter';
import { API_EXTENSION_CREDENTIAL_PREFIX, CredentialStore } from './security/CredentialStore';
import { BridgeCursorStore } from './security/BridgeCursorStore';
import { WorkspaceGrantStore } from './security/WorkspaceGrantStore';
import { ArtifactRegistry } from './security/ArtifactRegistry';
import { ConversationAttachmentStore, MAX_MESSAGE_ATTACHMENTS } from './security/ConversationAttachmentStore';
import { ApiAgentSessionStore } from './api/ApiAgentSessionStore';
import { ApiConnectionStore } from './api/ApiConnectionStore';
import { apiConfigurationMutationSchema, apiRequestSettingsSchema, apiModelSettingsSchema } from '../shared/apiConnections';
import { ApiExtensionStore } from './api/ApiExtensionStore';
import { McpConnectionManager } from './api/extensions/McpConnectionManager';
import { McpManagementWorkspace } from './api/extensions/McpManagementWorkspace';
import { ExecutionBackendRouter } from './execution/ExecutionBackendRouter';
import { SandboxExtensionLaunchBackend } from './execution/SandboxExtensionLaunchBackend';
import { WindowsSandboxProcess } from './execution/WindowsSandboxProcess';
import { mcpDisconnectSchema } from '../shared/apiExtensions';
import { createDefaultApiProviderRegistry } from './api/ApiProviderRegistry';
import { PartnerProfileStore } from './partner/PartnerProfileStore';
import { PartnerProjectNotebookService } from './notebook/PartnerProjectNotebookService';
import { ProjectWorkspaceStore } from './project/ProjectWorkspaceStore';
import { ArtifactDeliveryService } from './project/ArtifactDeliveryService';
import { ProjectService } from './project/ProjectService';
import { ProjectTransactionStore } from './project/ProjectTransactionStore';
import { ProjectMutationCoordinator } from './project/ProjectMutationCoordinator';
import { ProjectDeletionStore } from './project/ProjectDeletionStore';
import { ProjectExecutionPolicyStore } from './project/ProjectExecutionPolicyStore';
import { ProjectDomainStore } from './project/ProjectDomainStore';
import { ProjectTaskExecutionStore } from './project/ProjectTaskExecutionStore';
import { ProjectTaskOrchestrator } from './project/ProjectTaskOrchestrator';
import { ProjectTaskHandoffValidator } from './project/ProjectTaskHandoffValidator';
import { ProjectTaskReviewValidator } from './project/ProjectTaskReviewValidator';
import { ProjectTaskRuntime } from './project/ProjectTaskRuntime';
import { ProjectWorkRoleStore } from './project/ProjectWorkRoleStore';
import { ProjectWorkflowStore } from './project/ProjectWorkflowStore';
import { ProjectWorkflowTemplateStore } from './project/ProjectWorkflowTemplateStore';
import { ProjectWorkflowGenerationStore } from './project/ProjectWorkflowGenerationStore';
import { ProjectWorkflowGenerationRuntime } from './project/ProjectWorkflowGenerationRuntime';
import { ProjectFileDeliveryCoordinator } from './project/ProjectFileDeliveryCoordinator';
import { ProjectFileStore } from './project/ProjectFileStore';
import { ProjectFileDeletionService } from './project/ProjectFileDeletionService';
import { ConversationDeletionStore } from './conversation/ConversationDeletionStore';
import { ConversationDeletionService } from './conversation/ConversationDeletionService';
import { SingleChatMessageStore } from './conversation/SingleChatMessageStore';
import { assertSingleChatConversationSnapshots } from '../shared/singleChatMessages';
import { PartnerMemoryService } from './memory/PartnerMemoryService';
import { SqliteMemoryCutover } from './memory/SqliteMemoryCutover';
import { singleChatFallbackInputs, studioFallbackInputs } from './memory/fallback/MemoryFallbackInputs';
import { MemoryFallbackSettingsStore } from './memory/fallback/MemoryFallbackSettingsStore';
import { MemoryFallbackJobStore } from './memory/fallback/MemoryFallbackJobStore';
import { MemoryFallbackInventory } from './memory/fallback/MemoryFallbackInventory';
import { MemoryConsolidation } from './memory/fallback/MemoryConsolidation';
import { MemoryFallbackScheduler } from './memory/fallback/MemoryFallbackScheduler';
import { PartnerDiaryCatalog } from './diary/PartnerDiaryCatalog';
import { PartnerDiarySettingsStore } from './diary/PartnerDiarySettingsStore';
import { PartnerDiaryService } from './diary/PartnerDiaryService';
import { PartnerDiaryScheduler } from './diary/PartnerDiaryScheduler';
import { generateApiDiary, generateClaudeDiary, generateCodexDiary, generateExistingDiary } from './diary/DiaryGenerators';
import { assembleSessionBootstrap } from './runtime/SessionBootstrapAssembler';
import { diaryTarget } from '../shared/partnerDiary';
import { loadClaudeAgentSdk } from './adapters/ClaudeCodeAdapter';
import { PartnerMemoryBriefingService } from './memory/PartnerMemoryBriefingService';
import { SessionBootstrapService } from './runtime/SessionBootstrapService';
import { MemorySourceService } from './memory/MemorySourceService';
import { PartnerMemoryToolService } from './memory/PartnerMemoryToolService';
import { PartnerMemoryManagementService } from './memory/PartnerMemoryManagementService';
import { MEMORY_STATUSES, MEMORY_TYPES, type MemoryArchiveCommentRequest, type MemoryArchiveCreateRequest, type MemoryArchiveMutationRequest, type MemoryArchiveQuery, type MemoryArchiveSourceReadRequest, type MemoryArchiveUpdateRequest, type MemorySourceAnchor } from '../shared/memoryArchive';
import { NativeThreadBindingStore } from './studio/NativeThreadBindingStore';
import { StudioRoomStore } from './studio/StudioRoomStore';
import { StudioNoteStore } from './studio/StudioNoteStore';
import { PartnerWorkspaceStore } from './security/PartnerWorkspaceStore';
import { assertCanonicalPathOutsideProtectedRoots } from './security/ProtectedPathPolicy';
import { createAsteriumRuntimeTools, memoryToolAccess, projectNotebookToolAccess, type ProjectNotebookToolInput } from './runtime/AsteriumRuntimeTools';
import { localRuntimeAdapterKey, PartnerRuntimeFactory } from './runtime/PartnerRuntimeFactory';
import { PartnerRuntimePort } from './runtime/PartnerRuntimePort';
import { ExistingThreadWatchRegistry } from './runtime/ExistingThreadWatchRegistry';
import { StudioMcpAccessStore } from './studio/StudioMcpAccessStore';
import { StudioMcpService } from './studio/StudioMcpService';
import { StudioMcpHost } from './studio/StudioMcpHost';
import { StudioWakeControlService } from './studio/StudioWakeControlService';
import { StudioWakeEventStore } from './studio/StudioWakeEventStore';
import { StudioWakeEvents } from './studio/StudioWakeEvents';
import { RunCoordinator, sameEventRoute, streamFailureEvent, withCommandRoute } from './runtime/RunCoordinator';
import { WriterLeaseCoordinator } from './runtime/WriterLeaseCoordinator';
import { SessionCompactionService } from './runtime/SessionCompactionService';
import { compactApiSession } from './api/ApiSessionCompactor';
import { assertSessionCompactRequest } from '../shared/sessionCompaction';
import { SessionBootstrapRecorder } from './runtime/SessionBootstrapRecorder';
import { confirmNativeProfileReload } from './runtime/NativeProfileReload';
import { StudioOrchestrator } from './studio/StudioOrchestrator';
import { persistedPartnerProfileSeed, shouldPersistPartnerProfileSeed, StudioRuntimeCatalog } from './studio/StudioRuntimeCatalog';
import {
  AGENT_PROTOCOL_VERSION,
  type ApiPartnerConnection,
  type PartnerProfileSeed,
  type CancelRunCommand,
  type CodexRuntimeInfo,
  type ChangeLocalThreadLifecycleRequest,
  type LocalThreadLifecycleRequest,
  type NativeThreadLifecycleResult,
  type MessageDeliveryEvent,
  type PartnerWorkspaceState,
  type PartnerEvent,
  type ResolveAuthorizationCommand,
  type ResolveUserInputCommand,
  type ResumeSessionCommand,
  type SendGuidanceCommand,
  type SendGuidanceResult,
  type SendMessageCommand,
  type SendMessageReceipt,
  type ExistingThreadConnection,
  type ExistingThreadChangedEvent,
  type ExistingThreadConnectionStatus,
} from '../shared/agentProtocol';
import type { StudioRoomMetadata, StudioStartRoundRequest, StudioPrepareTurnRequest } from '../shared/studioRuntime';
import type { SaveStudioNoteRequest, StudioNoteStatus } from '../shared/studioNotes';
import type { ProjectNotebookTarget, ProjectNotebookUserReplaceRequest } from '../shared/projectNotebook';
import type { ConversationDeleteRequest } from '../shared/conversationLifecycle';
import { assertAgentCommand, isPartnerEvent } from '../shared/agentProtocolValidation';
import { resolveCodexRuntime } from '../shared/codexRuntimeSelection';
import { DESKTOP_INVOKE_CHANNELS, DESKTOP_IPC as AGENT_IPC } from '../shared/desktopIpc';
import { isProjectPermissionMode } from '../shared/projectExecutionPolicy';
import type { ProjectCreateRequest, ProjectDomainInitializeRequest, ProjectTaskCreateRequest, ProjectTaskRemoveRequest, ProjectTaskUpdateRequest, ProjectUpdateRequest } from '../shared/projectDomain';
import type { ProjectWorkRoleArchiveRequest, ProjectWorkRoleCreateRequest, ProjectWorkRoleRemoveRequest, ProjectWorkRoleUpdateRequest } from '../shared/projectRoles';
import type {
  ProjectWorkflowActivateRequest,
  ProjectWorkflowCreateRequest,
  ProjectWorkflowRemoveRequest,
  ProjectWorkflowTemplateRemoveRequest,
  ProjectWorkflowTemplateSaveRequest,
  ProjectWorkflowTemplateUpdateRequest,
  ProjectWorkflowUpdateRequest,
} from '../shared/projectWorkflows';
import type { TaskGateResolutionRequest } from '../shared/projectTaskExecution';
import type { ProjectWorkflowGenerationCancelRequest, ProjectWorkflowGenerationRetryRequest, ProjectWorkflowGenerationStartRequest } from '../shared/projectWorkflowGeneration';

export { AGENT_IPC };

type LocalAdapterType = 'claude_code' | 'codex_cli';
const BRAVE_SEARCH_CREDENTIAL_REF = 'asterium-web-search-brave';

interface LocalCliSendRequest {
  adapterType: LocalAdapterType;
  codexRuntimeId?: string;
  codexRuntimeEnvironment?: CodexRuntimeInfo['environment'];
  partnerId: string;
  partnerRootGrantId?: string;
  workspaceGrantIds: string[];
  command: SendMessageCommand;
  projectRootOverride?: string;
}

interface ApiSendRequest {
  connection: ApiPartnerConnection;
  command: SendMessageCommand;
  projectRootOverride?: string;
}

interface ExistingThreadSendRequest {
  connection: ExistingThreadConnection;
  command: SendMessageCommand;
}

interface ExistingThreadWatchRequest {
  partnerId: string;
  connection: ExistingThreadConnection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalAdapterType(value: unknown): value is LocalAdapterType {
  return value === 'claude_code' || value === 'codex_cli';
}

function assertTaskAttemptRequest(value: unknown) {
  if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.taskId !== 'string') throw new Error('INVALID_TASK_ATTEMPT_REQUEST');
  return { projectId: value.projectId, taskId: value.taskId };
}

function assertTaskAttemptControlRequest(value: unknown) {
  if (!isRecord(value) || typeof value.attemptId !== 'string' || (value.reason !== undefined && typeof value.reason !== 'string')) {
    throw new Error('INVALID_TASK_ATTEMPT_CONTROL_REQUEST');
  }
  return { attemptId: value.attemptId, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) };
}

function assertTaskGateResolutionRequest(value: unknown): TaskGateResolutionRequest {
  if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.taskId !== 'string'
    || (value.action !== 'accept' && value.action !== 'request_changes')
    || (value.feedback !== undefined && typeof value.feedback !== 'string')
    || (value.affectedCriteria !== undefined && (!Array.isArray(value.affectedCriteria) || value.affectedCriteria.some((item) => typeof item !== 'string')))) {
    throw new Error('INVALID_TASK_GATE_RESOLUTION_REQUEST');
  }
  return value as unknown as TaskGateResolutionRequest;
}

export function registerAgentIpc(ipcMain: IpcMain, getWindow: () => BrowserWindow | null, options: { generalSettings?: GeneralSettingsStore; notifications?: DesktopNotifications } = {}) {
  const notifications = options.notifications;
  const generalSettings = options.generalSettings ?? new GeneralSettingsStore(() => path.join(app.getPath('userData'), 'general-settings.v1.json'));
  const grants = new Map<string, string>();
  const host = new AdapterHost();
  const credentials = new CredentialStore(() => path.join(app.getPath('userData'), 'secure-credentials.v1.json'), safeStorage);
  const apiConnections = new ApiConnectionStore(() => path.join(app.getPath('userData'), 'api-connections.v1.json'));
  const apiProbes = new Map<string, AbortController>();
  const bridgeCursors = new BridgeCursorStore(() => path.join(app.getPath('userData'), 'bridge-cursors.v1.json'));
  const workspaceGrants = new WorkspaceGrantStore(() => path.join(app.getPath('userData'), 'workspace-grants.v1.json'));
  const profileDataRoot = path.join(app.getPath('userData'), 'AsteriumData');
  const protectedRoots = [profileDataRoot];
  const partnerWorkspaces = new PartnerWorkspaceStore(() => path.join(app.getPath('userData'), 'conversation-workspaces.v1.json'), workspaceGrants, protectedRoots);
  const partnerProfiles = new PartnerProfileStore(profileDataRoot);
  const studioRuntimeCatalog = new StudioRuntimeCatalog();
  const projectWorkspaces = new ProjectWorkspaceStore(
    path.join(app.getPath('userData'), 'project-workspaces.v1.json'),
    () => path.join(app.getPath('documents'), 'Asterium Projects'),
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
  const studioMcpAccess = new StudioMcpAccessStore(() => path.join(app.getPath('userData'), 'studio-mcp-access.v1.json'));
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
  const singleChatMessages = new SingleChatMessageStore(() => path.join(app.getPath('userData'), 'single-chat-messages.v1.json'));
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
  const apiProviders = createDefaultApiProviderRegistry();
  async function configuredApiOptions(connection: ApiPartnerConnection, keyOverride?: string) {
    const requestSettings = connection.requestSettings ? apiRequestSettingsSchema.parse(connection.requestSettings) : undefined;
    const modelSettings = connection.modelSettings ? apiModelSettingsSchema.parse(connection.modelSettings) : undefined;
    const apiKey = requestSettings?.auth === 'none' ? '' : keyOverride || await credentials.get(connection.credentialRef);
    if (apiKey === undefined) throw new Error('API_CREDENTIAL_REQUIRED');
    const headers: Record<string, string> = {};
    for (const header of requestSettings?.headers ?? []) {
      const secret = await credentials.get(header.credentialRef);
      if (secret === undefined) throw new Error('API_HEADER_CREDENTIAL_REQUIRED');
      headers[header.name] = secret;
    }
    return { apiKey, requestSettings, modelSettings, headers };
  }
  const memoryFallbackScheduler = new MemoryFallbackScheduler(memoryFallbackSettings, memoryFallbackJobs, memoryFallbackInventory,
    new MemoryConsolidation(partnerMemories, memorySources), async (config) => {
      const apiKey = await memoryFallbackSettings.secret();
      if (!apiKey) throw new Error('MEMORY_FALLBACK_CREDENTIAL_REQUIRED');
      return apiProviders.require(config.provider).createAdapter({ endpoint: config.endpoint, model: config.model, apiKey, thinkingMode: 'disabled' });
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
    return adapter.compactSession(request.sessionId, signal, binding.bootstrap);
  });
  async function localMaintenanceAdapter(request: { partnerId: string; conversationId: string; sessionId: string }) {
    const partner = studioRuntimeCatalog.partner(request.partnerId);
    if (!partner?.available || partner.runtime.kind !== 'local') throw new Error('SESSION_COMMAND_UNAVAILABLE');
    const runtime = partner.runtime;
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
      const adapter = await localMaintenanceAdapter({ ...request, sessionId: request.sessionId });
      return confirmNativeProfileReload(adapter, request.sessionId, kind, previous, next, signal, recoverFirst);
    },
  });
  const sessionCommands = new SessionCommandService({ bindings: nativeBindings, catalog: studioRuntimeCatalog, messages: singleChatMessages, leases: writerLeases, compactions: sessionCompactions, reload: (request) => profileReloads.execute(request), isDeleted: (id) => conversationDeletions.isDeleted(id) });
  let claudeInstallation: ClaudeInstallation | undefined;
  let codexInstallation: CodexInstallation | undefined;
  const diaryCatalog = new PartnerDiaryCatalog(studioRuntimeCatalog);
  const studioWakeControl = new StudioWakeControlService(() => path.join(app.getPath('userData'), 'studio-wake-settings.v1.json'), {
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
    try { await studioMcpHost.restore(); } catch { /* Host status retains the error; manual start remains available. */ }
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
      return generateClaudeDiary({ ...input, executablePath: installation.executablePath, ...(partner.recentModel?.model ? { model: partner.recentModel.model } : {}) }, (await loadClaudeAgentSdk()).query);
    },
  });

  const automationStore = new AutomationStore(() => path.join(app.getPath('userData'), 'automations.v1.json'));
  const automationConfirmations = new AutomationConfirmations(() => { notifications?.confirmations(automationConfirmations.list()); const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.automationsConfirmationsChanged); });
  const automationHandles: { runtime?: AutomationRuntime; scheduler?: AutomationScheduler } = {};
  const automationService = new AutomationService(automationStore, {
    runtimeReady: () => Boolean(automationHandles.scheduler),
    get scheduler() { return automationHandles.scheduler; },
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
  ipcMain.handle(AGENT_IPC.desktopNavigationTake, event => { requireSender(event); return notifications?.takeNavigation(); });
  ipcMain.handle(AGENT_IPC.generalSettingsGet, async event => { requireSender(event); return generalSettings.get(); });
  ipcMain.handle(AGENT_IPC.generalSettingsUpdate, async (event, value: unknown) => { requireSender(event); return generalSettings.update(value); });
  const unsubscribeGeneralSettings = generalSettings.subscribe(snapshot => { const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.generalSettingsChanged, snapshot); });
  const sendEvent = (event: PartnerEvent | MessageDeliveryEvent | ExistingThreadChangedEvent) => {
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') automationConfirmations.cancelOwner(event.clientMessageId);
    sessionCommands.observe(event as PartnerEvent);
    if (event.type === 'run.completed' || event.type === 'authorization.requested') notifications?.agent(event, automationHandles.runtime?.eventRunFor(event), studioRuntimeCatalog.partner(event.partnerId)?.publicIdentity.displayName);
    const observed = event.type === 'session.bound' && event.model
      ? { partnerId: event.partnerId, conversationId: event.conversationId, threadId: event.sessionId, observedAt: event.occurredAt, model: event.model, source: event.modelSource ?? 'runtime' }
      : event.type === 'extension.event' && event.namespace === 'asterium.runtime' && event.name === 'model_observed' && isRecord(event.payload) && typeof event.payload.model === 'string'
        ? { partnerId: event.partnerId, conversationId: event.conversationId, threadId: event.sessionId, observedAt: event.occurredAt, model: event.payload.model, source: event.payload.source === 'native_thread' ? 'native_thread' as const : 'runtime' as const }
        : undefined;
    if (observed) {
      studioRuntimeCatalog.observeModel(observed.partnerId, {
        model: observed.model,
        status: 'recent',
        observedAt: observed.observedAt,
        source: observed.source,
        conversationId: observed.conversationId,
        ...(observed.threadId ? { threadId: observed.threadId } : {}),
      });
      void partnerProfiles.observeModel({
        partnerId: observed.partnerId,
        conversationId: observed.conversationId,
        threadId: observed.threadId,
        model: observed.model,
        source: observed.source,
        observedAt: observed.observedAt,
      }).catch(() => undefined);
    }
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      const run = 'clientMessageId' in event ? automationHandles.runtime?.eventRunFor(event) : undefined;
      if (run && event.type !== 'message.delivery' && event.type !== 'existing_thread.changed') {
        automationHandles.runtime?.replaceEvent(event); window.webContents.send(AGENT_IPC.automationsEvent, { run, event });
        if (run.definition.target.roomId) window.webContents.send(AGENT_IPC.event, event); // Studio retains its approval/question interaction path.
      }
      else window.webContents.send(AGENT_IPC.event, event);
    }
  };
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

  ipcMain.handle(AGENT_IPC.projectChooseLocation, async (event) => {
    const window = requireSender(event);
    const result = await dialog.showOpenDialog(window, {
      title: '选择项目文件夹',
      buttonLabel: '使用这个文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selectionId = randomUUID();
    const selectedPath = path.resolve(result.filePaths[0]);
    projectLocationSelections.set(selectionId, selectedPath);
    return { selectionId, path: selectedPath };
  });
  ipcMain.handle(AGENT_IPC.projectDomainInitialize, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || !Array.isArray(value.legacyProjects)) throw new Error('INVALID_PROJECT_DOMAIN_MIGRATION');
    const snapshot = await projectService.initializeDomain((value as unknown as ProjectDomainInitializeRequest).legacyProjects);
    for (const project of snapshot.projects) {
      if (await projectWorkspaces.get(project.id)) await artifactDelivery.initializeProject(project.id);
    }
    return snapshot;
  });
  ipcMain.handle(AGENT_IPC.projectCreate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.name !== 'string') throw new Error('INVALID_PROJECT_CREATE_REQUEST');
    let selectedRoot: string | undefined;
    if (value.locationSelectionId !== undefined) {
      if (typeof value.locationSelectionId !== 'string') throw new Error('INVALID_PROJECT_LOCATION_SELECTION');
      selectedRoot = projectLocationSelections.get(value.locationSelectionId);
      projectLocationSelections.delete(value.locationSelectionId);
      if (!selectedRoot) throw new Error('PROJECT_LOCATION_SELECTION_EXPIRED');
    }
    const request = value as unknown as ProjectCreateRequest;
    const result = await projectService.createProject({
      projectId: request.projectId,
      name: request.name,
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.avatarDataUrl !== undefined ? { avatarDataUrl: request.avatarDataUrl } : {}),
      ...(request.tags !== undefined ? { tags: request.tags } : {}),
      ...(request.memberIds !== undefined ? { memberIds: request.memberIds } : {}),
      ...(selectedRoot ? { selectedRoot } : {}),
    });
    return result;
  });
  ipcMain.handle(AGENT_IPC.projectUpdate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string') throw new Error('INVALID_PROJECT_UPDATE_REQUEST');
    return projectService.updateProject(value as unknown as ProjectUpdateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectTaskCreate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.title !== 'string') throw new Error('INVALID_PROJECT_TASK_CREATE');
    return projectService.createTask(value as unknown as ProjectTaskCreateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectTaskUpdate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.taskId !== 'string') throw new Error('INVALID_PROJECT_TASK_UPDATE');
    return projectService.updateTask(value as unknown as ProjectTaskUpdateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectTaskRemove, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.taskId !== 'string') throw new Error('INVALID_PROJECT_TASK_REMOVE');
    await projectService.removeTask(value as unknown as ProjectTaskRemoveRequest);
  });
  ipcMain.handle(AGENT_IPC.projectRoleList, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string') throw new Error('INVALID_PROJECT_ROLE_QUERY');
    return projectService.listRoles(value);
  });
  ipcMain.handle(AGENT_IPC.projectRoleCreate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || (value.scope !== 'global' && value.scope !== 'project')) throw new Error('INVALID_PROJECT_ROLE_CREATE');
    return projectService.createRole(value as unknown as ProjectWorkRoleCreateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectRoleUpdate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roleId !== 'string') throw new Error('INVALID_PROJECT_ROLE_UPDATE');
    return projectService.updateRole(value as unknown as ProjectWorkRoleUpdateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectRoleArchive, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roleId !== 'string' || typeof value.archived !== 'boolean') throw new Error('INVALID_PROJECT_ROLE_ARCHIVE');
    return projectService.archiveRole(value as unknown as ProjectWorkRoleArchiveRequest);
  });
  ipcMain.handle(AGENT_IPC.projectRoleRemove, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roleId !== 'string') throw new Error('INVALID_PROJECT_ROLE_REMOVE');
    await projectService.removeRole(value as unknown as ProjectWorkRoleRemoveRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowCatalog, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_QUERY');
    return projectService.workflowCatalog(value);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowList, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_QUERY');
    return projectService.listWorkflows(value);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowCreate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.templateId !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_CREATE');
    return projectService.createWorkflow(value as unknown as ProjectWorkflowCreateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowUpdate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.workflowId !== 'string' || !Array.isArray(value.nodes)) throw new Error('INVALID_PROJECT_WORKFLOW_UPDATE');
    return projectService.updateWorkflow(value as unknown as ProjectWorkflowUpdateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowRemove, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.workflowId !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_REMOVE');
    await projectService.removeWorkflow(value as unknown as ProjectWorkflowRemoveRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowActivate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.workflowId !== 'string' || typeof value.activationId !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_ACTIVATE');
    const result = await projectService.activateWorkflow(value as unknown as ProjectWorkflowActivateRequest);
    await projectTaskOrchestrator.activate(partnerRuntimePort);
    return result;
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowTemplateSave, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.workflowId !== 'string' || typeof value.name !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_TEMPLATE_SAVE');
    return projectService.saveWorkflowTemplate(value as unknown as ProjectWorkflowTemplateSaveRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowTemplateUpdate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.workflowId !== 'string' || typeof value.templateId !== 'string' || typeof value.name !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_TEMPLATE_UPDATE');
    return projectService.updateWorkflowTemplate(value as unknown as ProjectWorkflowTemplateUpdateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowTemplateRemove, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.templateId !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_TEMPLATE_REMOVE');
    await projectService.removeWorkflowTemplate(value as unknown as ProjectWorkflowTemplateRemoveRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowGenerationList, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_GENERATION_QUERY');
    return projectWorkflowGenerations.listProject(value);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowGenerationStart, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.requestId !== 'string' || typeof value.projectId !== 'string' || typeof value.roomId !== 'string'
      || typeof value.plannerPartnerId !== 'string' || !Array.isArray(value.messageIds)) throw new Error('INVALID_PROJECT_WORKFLOW_GENERATION_START');
    if (!workflowGenerationRuntimeRef.current) throw new Error('PROJECT_WORKFLOW_GENERATION_RUNTIME_NOT_READY');
    return workflowGenerationRuntimeRef.current.start(value as unknown as ProjectWorkflowGenerationStartRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowGenerationCancel, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.generationId !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_GENERATION_CANCEL');
    if (!workflowGenerationRuntimeRef.current) throw new Error('PROJECT_WORKFLOW_GENERATION_RUNTIME_NOT_READY');
    return workflowGenerationRuntimeRef.current.cancel(value as unknown as ProjectWorkflowGenerationCancelRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowGenerationRetry, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.generationId !== 'string' || typeof value.requestId !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_GENERATION_RETRY');
    if (!workflowGenerationRuntimeRef.current) throw new Error('PROJECT_WORKFLOW_GENERATION_RUNTIME_NOT_READY');
    return workflowGenerationRuntimeRef.current.retry(value as unknown as ProjectWorkflowGenerationRetryRequest);
  });
  ipcMain.handle(AGENT_IPC.projectTaskExecutionGet, async (event, value: unknown) => {
    requireSender(event);
    if (value !== undefined && typeof value !== 'string') throw new Error('INVALID_PROJECT_TASK_EXECUTION_QUERY');
    return projectTaskOrchestrator.snapshot(value);
  });
  ipcMain.handle(AGENT_IPC.projectTaskExecutionEnqueue, async (event, value: unknown) => {
    requireSender(event);
    const request = assertTaskAttemptRequest(value);
    await projectTaskOrchestrator.activate(partnerRuntimePort);
    return projectTaskOrchestrator.enqueue(request.projectId, request.taskId);
  });
  ipcMain.handle(AGENT_IPC.projectTaskExecutionPause, async (event, value: unknown) => {
    requireSender(event);
    const request = assertTaskAttemptControlRequest(value);
    return projectTaskOrchestrator.pause(request.attemptId, request.reason);
  });
  ipcMain.handle(AGENT_IPC.projectTaskExecutionResume, async (event, value: unknown) => {
    requireSender(event);
    const request = assertTaskAttemptControlRequest(value);
    return projectTaskOrchestrator.resume(request.attemptId, request.reason);
  });
  ipcMain.handle(AGENT_IPC.projectTaskExecutionCancel, async (event, value: unknown) => {
    requireSender(event);
    const request = assertTaskAttemptControlRequest(value);
    return projectTaskOrchestrator.cancel(request.attemptId, request.reason);
  });
  ipcMain.handle(AGENT_IPC.projectTaskExecutionRetry, async (event, value: unknown) => {
    requireSender(event);
    const request = assertTaskAttemptControlRequest(value);
    return projectTaskOrchestrator.retry(request.attemptId);
  });
  ipcMain.handle(AGENT_IPC.projectTaskExecutionResolve, async (event, value: unknown) => {
    requireSender(event);
    return projectTaskOrchestrator.resolveGate(assertTaskGateResolutionRequest(value));
  });
  ipcMain.handle(AGENT_IPC.projectCreateWorkspace, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.name !== 'string') throw new Error('INVALID_PROJECT_WORKSPACE_REQUEST');
    let selectedRoot: string | undefined;
    if (value.locationSelectionId !== undefined) {
      if (typeof value.locationSelectionId !== 'string') throw new Error('INVALID_PROJECT_LOCATION_SELECTION');
      selectedRoot = projectLocationSelections.get(value.locationSelectionId);
      projectLocationSelections.delete(value.locationSelectionId);
      if (!selectedRoot) throw new Error('PROJECT_LOCATION_SELECTION_EXPIRED');
    }
    const workspace = await projectService.createWorkspace({
      projectId: value.projectId,
      name: value.name,
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(selectedRoot ? { selectedRoot } : {}),
    });
    return workspace;
  });
  ipcMain.handle(AGENT_IPC.projectGetWorkspace, async (event, projectId: unknown) => {
    requireSender(event);
    if (typeof projectId !== 'string') throw new Error('INVALID_PROJECT_ID');
    return (await projectService.getWorkspace(projectId)) ?? null;
  });
  ipcMain.handle(AGENT_IPC.projectOpenWorkspace, async (event, projectId: unknown) => {
    requireSender(event);
    if (typeof projectId !== 'string') throw new Error('INVALID_PROJECT_ID');
    const project = await projectWorkspaces.get(projectId);
    if (!project) throw new Error('PROJECT_WORKSPACE_NOT_READY');
    const error = await shell.openPath(project.rootPath);
    if (error) throw new Error(error);
  });
  ipcMain.handle(AGENT_IPC.projectOpenFile, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.fileId !== 'string') throw new Error('INVALID_PROJECT_FILE_REQUEST');
    const error = await shell.openPath(await projectFiles.resolve(value.projectId, value.fileId));
    if (error) throw new Error(error);
  });

  ipcMain.handle(AGENT_IPC.projectRunChangesList, async (event, projectId) => {
    requireSender(event);
    if (typeof projectId !== 'string') throw new Error('INVALID_PROJECT_ID');
    return projectChanges.list(projectId);
  });
  ipcMain.handle(AGENT_IPC.projectRunChangesRead, async (event, request) => {
    requireSender(event);
    if (!isRecord(request) || typeof request.projectId !== 'string' || typeof request.id !== 'string' || typeof request.path !== 'string') throw new Error('INVALID_PROJECT_CHANGE_REQUEST');
    return projectChanges.read({ projectId: request.projectId, id: request.id, path: request.path });
  });
  ipcMain.handle(AGENT_IPC.projectBrowse, async (event, request) => {
    requireSender(event);
    return projectBrowser.query(request);
  });
  ipcMain.handle(AGENT_IPC.projectListFiles, async (event, projectId: unknown) => {
    requireSender(event);
    if (typeof projectId !== 'string') throw new Error('INVALID_PROJECT_ID');
    return artifactDelivery.listProjectFiles(projectId);
  });
  ipcMain.handle(AGENT_IPC.projectInspectFileDeletion, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.fileId !== 'string') throw new Error('INVALID_PROJECT_FILE_REQUEST');
    return projectFileDeletions.inspect({ kind: 'project_file', projectId: value.projectId, fileId: value.fileId });
  });
  ipcMain.handle(AGENT_IPC.projectDeleteFile, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.fileId !== 'string') throw new Error('INVALID_PROJECT_FILE_REQUEST');
    const result = await projectFileDeletions.delete({ kind: 'project_file', projectId: value.projectId, fileId: value.fileId });
    for (const snapshot of result.projectSnapshots) publishProjectFiles(snapshot);
    return result;
  });

  ipcMain.handle(AGENT_IPC.projectGetExecutionPolicy, async (event, projectId: unknown) => {
    requireSender(event);
    if (typeof projectId !== 'string') throw new Error('INVALID_PROJECT_ID');
    return projectService.getExecutionPolicy(projectId);
  });

  ipcMain.handle(AGENT_IPC.projectSetExecutionPolicy, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || !isProjectPermissionMode(value.permissionMode)) throw new Error('INVALID_PROJECT_EXECUTION_POLICY');
    return projectService.setExecutionPolicy(value.projectId, value.permissionMode);
  });

  ipcMain.handle(AGENT_IPC.projectSyncMembers, async (event, value: unknown) => {
    requireSender(event);
    if (!Array.isArray(value) || !value.every((item) => isRecord(item) && typeof item.projectId === 'string'
      && Array.isArray(item.partnerIds) && item.partnerIds.every((id) => typeof id === 'string'))) throw new Error('INVALID_PROJECT_MEMBER_SYNC');
    const assignments = [];
    for (const item of value as Array<{ projectId: string; partnerIds: string[] }>) {
      const workspace = await projectWorkspaces.get(item.projectId);
      if (!workspace) continue;
      const folder = await stat(workspace.rootPath).catch(() => undefined);
      if (!folder?.isDirectory()) continue;
      assignments.push({ projectId: item.projectId, rootPath: workspace.rootPath, partnerIds: item.partnerIds });
    }
    return projectService.syncWorkspaceMemberships(assignments);
  });

  ipcMain.handle(AGENT_IPC.projectChangeMembers, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value)) throw new Error('INVALID_PROJECT_MEMBER_CHANGE');
    return projectService.changeMembers(value as unknown as import('../shared/projectWorkspace').ProjectMembershipChangeRequest);
  });

  ipcMain.handle(AGENT_IPC.projectRemove, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || !Array.isArray(value.roomIds)
      || !value.roomIds.every((roomId) => typeof roomId === 'string' && roomId)) throw new Error('INVALID_PROJECT_REMOVE_REQUEST');
    if ((await projectWorkflowGenerations.listProject(value.projectId)).some((generation) => generation.status === 'running')) throw new Error('PROJECT_HAS_ACTIVE_WORKFLOW_GENERATION');
    await projectService.removeProject(value.projectId, value.roomIds as string[]);
    await projectWorkflowGenerations.removeProject(value.projectId);
    await projectChanges.removeProject(value.projectId).catch((error) => console.error('Project change cleanup failed', error));
  });

  ipcMain.handle(AGENT_IPC.studioSyncRoom, async (event, value: unknown) => {
    requireSender(event);
    if (!isStudioRoomMetadata(value)) throw new Error('INVALID_STUDIO_ROOM');
    return projectService.syncRoom(value);
  });

  ipcMain.handle(AGENT_IPC.studioAnnounce, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roomId !== 'string' || typeof value.content !== 'string') throw new Error('INVALID_STUDIO_ANNOUNCEMENT');
    return studioRooms.appendSystemMessage(value.roomId, value.content);
  });

  ipcMain.handle(AGENT_IPC.studioNoteList, async (event, projectId: unknown) => {
    requireSender(event);
    if (projectId !== undefined && typeof projectId !== 'string') throw new Error('INVALID_STUDIO_NOTE_PROJECT');
    return studioNotes.list(projectId as string | undefined);
  });

  ipcMain.handle(AGENT_IPC.studioNoteSave, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || (value.id !== undefined && typeof value.id !== 'string') || typeof value.projectId !== 'string' || typeof value.content !== 'string') throw new Error('INVALID_STUDIO_NOTE');
    return studioNotes.save(value as unknown as SaveStudioNoteRequest);
  });

  ipcMain.handle(AGENT_IPC.studioNoteSetStatus, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.id !== 'string' || !['open', 'completed', 'archived'].includes(String(value.status))) throw new Error('INVALID_STUDIO_NOTE_STATUS');
    return studioNotes.setStatus(value.id, value.status as StudioNoteStatus);
  });

  ipcMain.handle(AGENT_IPC.studioNoteDelete, async (event, id: unknown) => {
    requireSender(event);
    if (typeof id !== 'string' || !id) throw new Error('INVALID_STUDIO_NOTE_ID');
    await studioNotes.remove(id);
  });

  ipcMain.handle(AGENT_IPC.projectNotebookGet, async (event, value: unknown) => {
    void event;
    const target = assertProjectNotebookTarget(value);
    await projectNotebooks.assertActiveMembership(target.partnerId, target.projectId);
    return (await projectNotebooks.notebookStore(target.partnerId)).get(target.projectId);
  });

  ipcMain.handle(AGENT_IPC.projectNotebookReplace, async (event, value: unknown) => {
    void event;
    const request = assertProjectNotebookReplaceRequest(value);
    const project = await projectNotebooks.assertActiveMembership(request.partnerId, request.projectId);
    return (await projectNotebooks.notebookStore(request.partnerId)).replace({
      projectId: request.projectId,
      projectName: project.name,
      content: request.content,
      expectedRevision: request.expectedRevision,
    });
  });

  ipcMain.handle(AGENT_IPC.projectNotebookListArchived, async (event) => {
    void event;
    return projectNotebooks.listArchived();
  });

  ipcMain.handle(AGENT_IPC.projectNotebookExport, async (event, value: unknown) => {
    const target = assertProjectNotebookTarget(value);
    const notebook = await projectNotebooks.getArchived(target.partnerId, target.projectId);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('PROJECT_NOTEBOOK_EXPORT_WINDOW_UNAVAILABLE');
    const result = await dialog.showSaveDialog(window, {
      title: '导出项目工作笔记',
      defaultPath: archivedNotebookFileName(notebook.projectName),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, notebook.content, 'utf8');
    return true;
  });

  ipcMain.handle(AGENT_IPC.projectNotebookPurge, async (event, value: unknown) => {
    void event;
    const target = assertProjectNotebookTarget(value);
    return projectNotebooks.purgeArchived(target.partnerId, target.projectId);
  });

  ipcMain.handle(AGENT_IPC.studioGetRoom, async (event, roomId: unknown) => {
    requireSender(event);
    if (typeof roomId !== 'string' || !roomId) throw new Error('INVALID_STUDIO_ROOM_ID');
    return studioRooms.getRoom(roomId);
  });

  ipcMain.handle(AGENT_IPC.studioExportMarkdown, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roomId !== 'string' || !value.roomId.trim()
      || typeof value.content !== 'string' || Buffer.byteLength(value.content, 'utf8') > 10_000_000) {
      throw new Error('INVALID_STUDIO_MARKDOWN_EXPORT');
    }
    const room = await studioRooms.getRoom(value.roomId);
    if (!room) throw new Error('STUDIO_ROOM_NOT_FOUND');
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('STUDIO_EXPORT_WINDOW_UNAVAILABLE');
    const result = await dialog.showSaveDialog(window, {
      title: '导出群聊记录',
      defaultPath: archivedMarkdownFileName(room.metadata.name, '群聊记录'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, value.content, 'utf8');
    return true;
  });

  ipcMain.handle(AGENT_IPC.studioRemoveRoom, async (event, roomId: unknown) => {
    requireSender(event);
    if (typeof roomId !== 'string' || !roomId) throw new Error('INVALID_STUDIO_ROOM_ID');
    await projectService.removeRoom(roomId);
    await memoryFallbackInventory.refresh();
  });

  ipcMain.handle(AGENT_IPC.studioSetMuted, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roomId !== 'string' || !Array.isArray(value.partnerIds) || !value.partnerIds.every((id) => typeof id === 'string')) throw new Error('INVALID_STUDIO_MUTE_REQUEST');
    return studioRooms.setMuted(value.roomId, value.partnerIds);
  });

  ipcMain.handle(AGENT_IPC.studioSetSettings, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roomId !== 'string' || !isRecord(value.settings)
      || !['free_discussion', 'selected_partners', 'round_robin'].includes(String(value.settings.speakingMode))
      || !Array.isArray(value.settings.selectedPartnerIds) || !value.settings.selectedPartnerIds.every((id) => typeof id === 'string')
      || typeof value.settings.discussionProtectionEnabled !== 'boolean') throw new Error('INVALID_STUDIO_SETTINGS_REQUEST');
    return studioRooms.setSettings(value.roomId, {
      speakingMode: value.settings.speakingMode as 'free_discussion' | 'selected_partners' | 'round_robin',
      selectedPartnerIds: value.settings.selectedPartnerIds as string[],
      discussionProtectionEnabled: value.settings.discussionProtectionEnabled,
    });
  });

  ipcMain.handle(AGENT_IPC.studioResolveDiscussion, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roomId !== 'string' || !['continue', 'end'].includes(String(value.decision))) throw new Error('INVALID_STUDIO_DISCUSSION_DECISION');
    return studioRooms.resolveDiscussion(value.roomId, value.decision as 'continue' | 'end');
  });

  ipcMain.handle(AGENT_IPC.studioCancelRound, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roomId !== 'string' || !value.roomId) throw new Error('INVALID_STUDIO_CANCEL_REQUEST');
    return studioOrchestration.orchestrator ? studioOrchestration.orchestrator.cancelRound(value.roomId) : studioRooms.cancelRound(value.roomId);
  });

  ipcMain.handle(AGENT_IPC.studioWakeStatus, async (event) => {
    requireSender(event); return studioWakeControl.status();
  });
  ipcMain.handle(AGENT_IPC.studioWakeConfigure, async (event, value: unknown) => {
    requireSender(event); return studioWakeControl.configure(value as import('../shared/studioWakeControl').StudioWakeBinding);
  });
  ipcMain.handle(AGENT_IPC.studioWakeControl, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.partnerId !== 'string' || typeof value.action !== 'string'
      || (value.triggerId !== undefined && typeof value.triggerId !== 'string')) throw new Error('STUDIO_WAKE_CONTROL_INVALID');
    return studioWakeControl.control(value.partnerId, value.action as import('../shared/studioWakeControl').StudioWakeAction, value.triggerId as string | undefined);
  });

  ipcMain.handle(AGENT_IPC.studioMcpStatus, async (event) => {
    requireSender(event);
    await studioMcpStartup;
    return studioMcpHost.status();
  });
  ipcMain.handle(AGENT_IPC.studioMcpConfigure, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value)) throw new Error('STUDIO_MCP_CONFIGURATION_INVALID');
    const status = await studioMcpHost.configure(value as unknown as import('../shared/studioMcp').StudioMcpConfiguration);
    wakeReadinessChanged(); return status;
  });
  ipcMain.handle(AGENT_IPC.studioMcpIssueCredential, async (event, partnerId: unknown) => {
    requireSender(event);
    if (typeof partnerId !== 'string') throw new Error('STUDIO_MCP_PARTNER_REQUIRED');
    const issued = await projectCoordinator.run(async () => {
      if (studioRuntimeCatalog.partner(partnerId)?.sourceMode !== 'existing_thread') throw new Error('STUDIO_MCP_PARTNER_REQUIRED');
      return studioMcpAccess.issue(partnerId);
    });
    wakeReadinessChanged(); return issued;
  });
  ipcMain.handle(AGENT_IPC.studioMcpRevokeCredential, async (event, credentialId: unknown) => {
    requireSender(event);
    if (typeof credentialId !== 'string') throw new Error('STUDIO_MCP_CREDENTIAL_NOT_FOUND');
    await projectCoordinator.run(() => studioMcpAccess.revoke(credentialId));
    return studioMcpHost.status();
  });

  ipcMain.handle(AGENT_IPC.studioStartRound, async (event, value: unknown) => {
    requireSender(event);
    if (!isStudioStartRoundRequest(value)) throw new Error('INVALID_STUDIO_ROUND_REQUEST');
    if (!studioOrchestration.orchestrator) throw new Error('STUDIO_ORCHESTRATOR_NOT_READY');
    return studioOrchestration.orchestrator.startRound(value);
  });

  ipcMain.handle(AGENT_IPC.studioPrepareTurn, async (event, value: unknown) => {
    requireSender(event);
    if (!isStudioPrepareTurnRequest(value)) throw new Error('INVALID_STUDIO_TURN_REQUEST');
    return prepareStudioTurn(value);
  });

  ipcMain.handle(AGENT_IPC.studioFailTurn, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roomId !== 'string' || typeof value.roundId !== 'string' || typeof value.partnerId !== 'string') throw new Error('INVALID_STUDIO_FAIL_REQUEST');
    return studioRooms.failPreparedTurn(value.roomId, value.roundId, value.partnerId);
  });

  ipcMain.handle(AGENT_IPC.nativeSyncSingleBindings, async (event, value: unknown) => {
    requireSender(event);
    if (!Array.isArray(value)) throw new Error('INVALID_SINGLE_BINDING_SYNC');
    for (const item of value) {
      if (!isRecord(item) || typeof item.partnerId !== 'string' || typeof item.conversationId !== 'string' || typeof item.nativeThreadId !== 'string'
        || !['local_cli', 'api_partner'].includes(String(item.source))) throw new Error('INVALID_SINGLE_BINDING_SYNC');
      if (await conversationDeletions.isDeleted(item.conversationId)) continue;
      await nativeBindings.registerSingle({
        partnerId: item.partnerId,
        conversationId: item.conversationId,
        nativeThreadId: item.nativeThreadId,
        source: item.source as 'local_cli' | 'api_partner',
      });
    }
  });

  ipcMain.handle(AGENT_IPC.artifactInspect, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    return (await artifacts.inspectIfRegistered(artifactId)) ?? null;
  });
  ipcMain.handle(AGENT_IPC.artifactRead, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    return artifacts.read(artifactId);
  });
  ipcMain.handle(AGENT_IPC.artifactOpen, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    const error = await shell.openPath(await artifacts.pathFor(artifactId));
    if (error) throw new Error(error);
  });
  ipcMain.handle(AGENT_IPC.artifactReveal, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    shell.showItemInFolder(await artifacts.pathFor(artifactId));
  });
  ipcMain.handle(AGENT_IPC.artifactCopyPath, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    const originalPath = await artifacts.originalPathFor(artifactId);
    if (!originalPath) throw new Error('ARTIFACT_HAS_NO_ORIGINAL_PATH');
    clipboard.writeText(originalPath);
  });
  ipcMain.handle(AGENT_IPC.artifactSaveAs, async (event, artifactId: unknown) => {
    const window = requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    const info = await artifacts.inspect(artifactId);
    const source = await artifacts.pathFor(artifactId);
    const result = await dialog.showSaveDialog(window, { defaultPath: info.name });
    if (result.canceled || !result.filePath) return false;
    await copyFile(source, result.filePath);
    return true;
  });
  ipcMain.handle(AGENT_IPC.artifactSaveToProject, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.artifactId !== 'string' || typeof value.projectId !== 'string' || !value.projectId.trim()) throw new Error('INVALID_PROJECT_ARTIFACT_REQUEST');
    return saveArtifactToProject(value.artifactId, value.projectId.trim());
  });
  ipcMain.handle(AGENT_IPC.artifactInspectDeletion, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    return projectFileDeletions.inspect({ kind: 'artifact', artifactId });
  });
  ipcMain.handle(AGENT_IPC.artifactDelete, async (event, artifactId: unknown) => {
    requireSender(event);
    if (typeof artifactId !== 'string') throw new Error('INVALID_ARTIFACT_ID');
    const result = await projectFileDeletions.delete({ kind: 'artifact', artifactId });
    for (const snapshot of result.projectSnapshots) publishProjectFiles(snapshot);
    return result;
  });
  ipcMain.handle(AGENT_IPC.artifactCacheStats, async (event) => {
    requireSender(event);
    return artifacts.cacheStats();
  });
  ipcMain.handle(AGENT_IPC.artifactClearCache, async (event) => {
    requireSender(event);
    return artifacts.clearCache();
  });
  ipcMain.handle(AGENT_IPC.attachmentChoose, async (event, value: unknown) => {
    const window = requireSender(event);
    const remaining = isRecord(value) && Number.isSafeInteger(value.remaining) ? Number(value.remaining) : MAX_MESSAGE_ATTACHMENTS;
    if (remaining < 1 || remaining > MAX_MESSAGE_ATTACHMENTS) throw new Error('ATTACHMENT_COUNT_LIMIT');
    const result = await dialog.showOpenDialog(window, { title: '选择图片或文件', buttonLabel: '添加', properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return [];
    if (result.filePaths.length > remaining) throw new Error('ATTACHMENT_COUNT_LIMIT');
    return messageAttachments.stage(result.filePaths);
  });
  ipcMain.handle(AGENT_IPC.attachmentDiscard, async (event, value: unknown) => {
    requireSender(event);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('INVALID_ATTACHMENT_SELECTIONS');
    await messageAttachments.discard(value);
  });
  ipcMain.handle(AGENT_IPC.attachmentCommit, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.conversationId !== 'string' || typeof value.messageId !== 'string' || !Array.isArray(value.selectionIds)
      || value.selectionIds.some((item) => typeof item !== 'string')) throw new Error('INVALID_ATTACHMENT_COMMIT');
    return messageAttachments.commit(value.conversationId, value.selectionIds as string[], value.messageId);
  });
  ipcMain.handle(AGENT_IPC.attachmentList, async (event, conversationId: unknown) => {
    requireSender(event);
    if (typeof conversationId !== 'string') throw new Error('INVALID_CONVERSATION_ID');
    return messageAttachments.list(conversationId);
  });
  ipcMain.handle(AGENT_IPC.attachmentInspect, async (event, value: unknown) => {
    requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    return messageAttachments.inspect(attachmentId, conversationId);
  });
  ipcMain.handle(AGENT_IPC.attachmentRead, async (event, value: unknown) => {
    requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    const info = await messageAttachments.inspect(attachmentId, conversationId);
    const buffer = await messageAttachments.read(attachmentId, conversationId);
    const publicInfo = { ...info, previewKind: attachmentPreviewKind(info.name, info.mediaType) };
    if (isTextMime(info.mediaType)) return { info: publicInfo, text: buffer.toString('utf8') };
    return { info: publicInfo, dataUrl: `data:${info.mediaType};base64,${buffer.toString('base64')}` };
  });
  ipcMain.handle(AGENT_IPC.attachmentOpen, async (event, value: unknown) => {
    requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    const error = await shell.openPath(await messageAttachments.pathFor(attachmentId, conversationId));
    if (error) throw new Error(error);
  });
  ipcMain.handle(AGENT_IPC.attachmentReveal, async (event, value: unknown) => {
    requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    shell.showItemInFolder(await messageAttachments.sourcePathFor(attachmentId, conversationId));
  });
  ipcMain.handle(AGENT_IPC.attachmentCopyPath, async (event, value: unknown) => {
    requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    clipboard.writeText(await messageAttachments.sourcePathFor(attachmentId, conversationId));
  });
  ipcMain.handle(AGENT_IPC.attachmentExportAs, async (event, value: unknown) => {
    const window = requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    const info = await messageAttachments.inspect(attachmentId, conversationId);
    const result = await dialog.showSaveDialog(window, { defaultPath: info.name });
    if (result.canceled || !result.filePath) return false;
    await copyFile(await messageAttachments.pathFor(attachmentId, conversationId), result.filePath);
    return true;
  });
  ipcMain.handle(AGENT_IPC.attachmentSaveToProject, async (event, value: unknown) => {
    requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    if (!isRecord(value) || typeof value.projectId !== 'string' || !value.projectId.trim()) throw new Error('INVALID_PROJECT_ARTIFACT_REQUEST');
    const projectId = value.projectId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) throw new Error('ARTIFACT_PROJECT_ID_REJECTED');
    const info = await messageAttachments.inspect(attachmentId, conversationId);
    const registered = await artifacts.register(
      { kind: 'local_path', path: await messageAttachments.pathFor(attachmentId, conversationId) },
      { method: 'manual', conversationId, name: info.name, mediaType: info.mediaType },
    );
    return saveArtifactToProject(registered.id, projectId, 'user');
  });
  ipcMain.handle(AGENT_IPC.attachmentThumbnail, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.id !== 'string') throw new Error('INVALID_ATTACHMENT_REFERENCE');
    const sourcePath = value.id.startsWith('pending-attachment-')
      ? await messageAttachments.pendingPath(value.id)
      : typeof value.conversationId === 'string' ? await messageAttachments.pathFor(value.id, value.conversationId) : undefined;
    if (!sourcePath) throw new Error('ATTACHMENT_CONVERSATION_REQUIRED');
    const image = await nativeImage.createThumbnailFromPath(sourcePath, { width: 960, height: 720 });
    if (image.isEmpty()) throw new Error('ATTACHMENT_IMAGE_UNREADABLE');
    return image.toDataURL();
  });
  ipcMain.handle(AGENT_IPC.attachmentDeleteConversation, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string' || !value) throw new Error('INVALID_CONVERSATION_ID');
    await messageAttachments.deleteConversation(value);
  });
  ipcMain.handle(AGENT_IPC.conversationDelete, async (event, value: unknown) => {
    requireSender(event);
    const request = assertConversationDeleteRequest(value);
    const lease = writerLeases.tryAcquire({ kind: 'conversation', partnerId: request.partnerId, conversationId: request.conversationId }, `delete:${request.conversationId}`);
    if (!lease) throw new Error('COMPACT_CONVERSATION_BUSY');
    const result = await conversationDeletions.delete(request).finally(() => lease.release());
    await diarySettings.reconcileSources(); await diaryScheduler.changed();
    await memoryFallbackInventory.refresh();
    return result;
  });
  ipcMain.handle(AGENT_IPC.conversationListDeleted, async (event) => {
    requireSender(event);
    return conversationDeletions.listDeletedIds();
  });
  ipcMain.handle(AGENT_IPC.conversationSyncMessages, async (event, value: unknown) => {
    requireSender(event);
    assertSingleChatConversationSnapshots(value);
    await singleChatMessages.sync(value);
    await diarySettings.reconcileSources(); await diaryScheduler.changed();
    await memoryFallbackInventory.refresh();
  });
  const delivery = (command: SendMessageCommand, state: MessageDeliveryEvent['state'], error?: MessageDeliveryEvent['error']) => sendEvent({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'message.delivery',
    eventId: randomUUID(),
    partnerId: command.partnerId,
    conversationId: command.conversationId,
    connectionSource: command.connectionSource,
    clientMessageId: command.clientMessageId,
    state,
    occurredAt: new Date().toISOString(),
    error,
  });
  const projectTaskRuntimeRef: { current?: ProjectTaskRuntime } = {};
  const captureGuidanceSource = async (event: PartnerEvent, command: SendMessageCommand) => {
    if (event.type !== 'guidance.applied' || !event.sourceMessage) return;
    await singleChatMessages.upsertMessage(command.conversationId, command.partnerId, event.sourceMessage);
    // Runtime tools capture sources lazily from this Main-owned command.
    command.messageId = event.sourceMessage.messageId;
  };
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
    return createAsteriumRuntimeTools({
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
  };
  const transformRuntimeEvent = async (event: PartnerEvent, artifactBaseDirectory?: string) => {
    if (event.type !== 'file.produced') return event;
    const registered = await projectFileDelivery.registerRuntimeFile(event, artifactBaseDirectory);
    if (!registered?.emitArtifactEvent) {
      // Invalid claims stay hidden; a same-run duplicate keeps its original renderer card.
      return undefined;
    }
    const { info } = registered;
    if (info.registrationMethod === 'deliver_tool' && registered.delivery) {
      projectTaskRuntimeRef.current?.recordProjectFile(event, {
        fileId: registered.delivery.fileId,
        relativePath: registered.delivery.relativePath,
        revision: registered.delivery.revision,
        contentHash: registered.delivery.contentHash,
        sizeBytes: registered.delivery.sizeBytes,
      });
    }
    return { ...event, source: undefined, artifactId: info.id, artifactRef: info.id, name: info.name, mediaType: info.mediaType, sizeBytes: info.sizeBytes, sourceKind: info.sourceKind, registrationMethod: info.registrationMethod, availability: info.availability, cached: info.cached };
  };
  const runCoordinator = new RunCoordinator(host, {
    prepare: async (command) => {
      const automatic = automationHandles.runtime?.runFor(command);
      if (automatic && (automationHandles.runtime?.isAborted(command) || !(await checkAutomation(automatic, `runtime:${command.commandId}`)).available || automationRunExpired(automatic, Date.now()))) throw new Error('AUTOMATION_REVALIDATION_FAILED');
      if (command.sessionId) await hydrateManagedRuntimeProfile(command);
      await projectChanges.begin(command).catch((error) => { projectChanges.failedStart(command); console.error('Project change baseline unavailable', error); });
    },
    beforeEvent: async (event, command) => { await projectChanges.observe(event, command).catch((error) => console.error('Project change capture unavailable', error)); },
    deliver: delivery,
    emit: sendEvent,
    observe: (event) => studioRooms.observeEvent(event),
    validateFirstEvent: async (event, command) => {
      automationHandles.runtime?.validateFirst(command, event);
      await automationHandles.runtime?.observe(event);
      if (event.type !== 'session.bound') throw new Error('FIRST_EVENT_MUST_BIND_SESSION');
      await projectTaskRuntimeRef.current?.validateFirstEvent(event, command);
      await workflowGenerationRuntimeRef.current?.validateFirstEvent(event, command);
      if (command.route?.scope !== 'group') return;
      const binding = await nativeBindings.getForScope(command.partnerId, 'group', command.route.roomId);
      if (!binding || binding.conversationId !== command.conversationId || binding.generation !== command.route.bindingGeneration) throw new Error('NATIVE_BINDING_ROUTE_MISMATCH');
      if (binding.state === 'pending') await nativeBindings.activate(binding.bindingId, event.sessionId);
      else if (binding.nativeThreadId !== event.sessionId) throw new Error('NATIVE_THREAD_ROUTE_MISMATCH');
    },
    onBound: async (event, command) => {
      await automationHandles.runtime?.bound(command, { runId: event.runId, sessionId: event.sessionId });
      if (command.route?.scope === 'group') await studioRooms.bindRun(command.route.roomId, command.route.roundId, command.partnerId, event.runId, event.sessionId);
      await sessionBootstrapRecorder.onBound(event, command);
    },
    onEvent: async (event, command) => {
      await automationHandles.runtime?.observe(event);
      await captureGuidanceSource(event, command);
      await projectTaskRuntimeRef.current?.onEvent(event, command);
      await workflowGenerationRuntimeRef.current?.onEvent(event, command);
      await sessionBootstrapRecorder.onEvent(event, command);
      await markAcceptedStudioSpeakingMode(event, command);
      if (event.type === 'run.completed') await workflowGenerationRuntimeRef.current?.markCompleted(command, event.runId);
      if (command.route?.scope !== 'group' || event.type !== 'run.completed') return;
      const binding = await nativeBindings.getForScope(command.partnerId, 'group', command.route.roomId);
      if (binding?.generation === command.route.bindingGeneration) await nativeBindings.markCompleted(binding.bindingId, event.runId).catch(() => undefined);
    },
    transformEvent: transformRuntimeEvent,
    onStreamFailure: async (_error, context) => {
      await automationHandles.runtime?.fail(context.command);
      await projectChanges.finish(context.command, 'failed').catch(() => undefined);
      await projectTaskRuntimeRef.current?.invalidatePending(context.command);
      projectTaskRuntimeRef.current?.fail(context.command, _error);
      await workflowGenerationRuntimeRef.current?.failCommand(context.command, _error);
      if (context.command.route?.scope !== 'group') return;
      await nativeBindings.invalidateGroupTurn(context.command).catch(() => undefined);
      const failed = streamFailureEvent(context);
      await studioRooms.observeEvent(failed).catch(() => undefined);
      sendEvent(failed);
    },
    onStartFailure: async (_error, command) => {
      await automationHandles.runtime?.fail(command);
      await projectChanges.finish(command, 'failed').catch(() => undefined);
      projectChanges.failedStart(command);
      await projectTaskRuntimeRef.current?.invalidatePending(command);
      projectTaskRuntimeRef.current?.fail(command, _error);
      await workflowGenerationRuntimeRef.current?.failCommand(command, _error);
      if (command.route?.scope !== 'group') return;
      await nativeBindings.invalidateGroupTurn(command).catch(() => undefined);
      await studioRooms.failPreparedTurn(command.route.roomId, command.route.roundId, command.partnerId).catch(() => undefined);
    },
    onReleased: async ({ command, receipt }) => {
      await automationHandles.runtime?.fail(command);
      await projectChanges.finish(command, 'failed').catch(() => undefined);
      projectChanges.failedStart(command);
      projectTaskRuntimeRef.current?.released(command);
      if (command.route?.scope !== 'group' || !studioRooms.hasPendingPassRetry(receipt.runId)) return;
      studioOrchestration.orchestrator?.markPassCorrection(command.route.roomId, command.route.roundId, command.partnerId);
      await studioRooms.retryPassAfterRelease(receipt.runId).catch(() => undefined);
    },
  }, writerLeases);
  const useLegacyRunPath = process.env.ASTERIUM_USE_LEGACY_RUN_PATH === '1';
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
      const root = path.join(app.getPath('temp'), 'Asterium', 'workflow-planning');
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
  const studioOrchestrator = new StudioOrchestrator(studioRooms, studioRuntimeCatalog, partnerRuntimePort, projectCoordinator, projectExecutionPolicies);
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
  const existingThreadStatus = (connection: ExistingThreadConnection, session: { threadId?: string; workspaceRoot?: string }): ExistingThreadConnectionStatus => ({
    credentialRef: connection.credentialRef,
    configured: true,
    masked: '••••••••',
    authenticated: true,
    threadId: session.threadId ?? connection.threadId,
    ...(session.workspaceRoot ? { workspaceRoot: session.workspaceRoot } : {}),
    capabilities: { streamingText: true, cancellation: false, toolEvents: false, fileEvents: false, reconnect: true },
  });
  ipcMain.handle(AGENT_IPC.detectClaude, async (event) => {
    requireSender(event);
    claudeInstallation = await detectClaudeCode();
    return publicClaudeInstallation(claudeInstallation);
  });

  ipcMain.handle(AGENT_IPC.detectCodex, async (event) => {
    requireSender(event);
    codexInstallation = await detectCodexCli();
    return codexInstallation;
  });

  ipcMain.handle(AGENT_IPC.listCodexThreads, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.runtimeId !== 'string' || typeof value.workspaceGrantId !== 'string') throw new Error('INVALID_CODEX_THREAD_LIST_REQUEST');
    const workingDirectory = await resolveWorkspaceGrant(value.workspaceGrantId);
    if (!workingDirectory) throw new Error('WORKSPACE_GRANT_REQUIRED');
    if (!codexInstallation?.runtimes.length) codexInstallation = await detectCodexCli();
    const runtime = codexInstallation.runtimes.find((candidate) => candidate.runtimeId === value.runtimeId);
    if (!runtime) throw new Error('CODEX_RUNTIME_SELECTION_REQUIRED');
    if (!runtime.loggedIn) throw new Error('CODEX_NOT_LOGGED_IN');
    const threads = await listCodexThreads(runtime.executablePath, workingDirectory);
    const reserved = new Set(await nativeBindings.activeNativeThreadIds());
    return threads.filter((thread) => !reserved.has(thread.threadId));
  });

  ipcMain.handle(AGENT_IPC.getLocalThreadLifecycles, async (event, value: unknown): Promise<NativeThreadLifecycleResult[]> => {
    requireSender(event);
    if (!isLocalThreadLifecycleRequest(value)) throw new Error('INVALID_LOCAL_THREAD_LIFECYCLE_REQUEST');
    if (value.adapterType === 'claude_code') return value.threadIds.map((threadId) => ({
      threadId,
      state: 'unsupported',
      checkedAt: new Date().toISOString(),
      message: '当前 Claude Code 桥接尚未提供原生线程归档同步。',
    }));
    const { runtime, workingDirectory } = await resolveCodexLifecycleRuntime(value);
    return getCodexThreadLifecyclesSafely(runtime.executablePath, workingDirectory, value.threadIds);
  });

  ipcMain.handle(AGENT_IPC.changeLocalThreadLifecycle, async (event, value: unknown): Promise<NativeThreadLifecycleResult> => {
    requireSender(event);
    if (!isChangeLocalThreadLifecycleRequest(value)) throw new Error('INVALID_LOCAL_THREAD_LIFECYCLE_CHANGE_REQUEST');
    if (value.adapterType === 'claude_code') return {
      threadId: value.threadId,
      state: 'unsupported',
      checkedAt: new Date().toISOString(),
      message: '当前 Claude Code 桥接尚未提供原生线程归档、恢复或删除能力；星丛没有改动本地记录。',
    };
    const { runtime, workingDirectory } = await resolveCodexLifecycleRuntime(value);
    return changeCodexThreadLifecycle(runtime.executablePath, workingDirectory, value.threadId, value.action);
  });

  ipcMain.handle(AGENT_IPC.selectWorkspace, async (event, purpose: unknown) => {
    const window = requireSender(event);
    if (purpose !== undefined && purpose !== 'partner_root' && purpose !== 'workspace' && purpose !== 'mcp_workspace') throw new Error('INVALID_DIRECTORY_SELECTION_PURPOSE');
    const result = await dialog.showOpenDialog(window, {
      title: purpose === 'partner_root' ? '选择伙伴配置来源（原 CLI 项目根目录）' : purpose === 'mcp_workspace' ? '授权此 MCP 的测试工作区' : '授权伙伴额外工作区',
      buttonLabel: '授权此目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const displayPath = result.filePaths[0];
    await assertCanonicalPathOutsideProtectedRoots(displayPath, purpose === 'mcp_workspace' ? [...protectedRoots, app.getPath('userData')] : protectedRoots);
    const grant = await workspaceGrants.add(displayPath);
    grants.set(grant.grantId, displayPath);
    return grant;
  });

  ipcMain.handle(AGENT_IPC.importClaudeSession, async (event) => {
    const window = requireSender(event);
    const result = await dialog.showOpenDialog(window, {
      title: '选择要导入的 Claude Code 会话文件',
      buttonLabel: '导入此会话',
      defaultPath: path.join(os.homedir(), '.claude', 'projects'),
      properties: ['openFile'],
      filters: [{ name: 'Claude Code session', extensions: ['jsonl'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const imported = await readClaudeSessionFile(result.filePaths[0]);
    if (await nativeBindings.isBoundNativeThread(imported.sessionId)) throw new Error('NATIVE_THREAD_ALREADY_BOUND');
    const workspaceGrant = await workspaceGrants.add(imported.workingDirectory);
    grants.set(workspaceGrant.grantId, workspaceGrant.displayPath);
    return { sessionId: imported.sessionId, sessionFilePath: imported.sessionFilePath, workspaceGrant };
  });

  ipcMain.handle(AGENT_IPC.revokeWorkspaceGrants, async (event, value: unknown) => {
    requireSender(event);
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error('INVALID_WORKSPACE_GRANT_REVOKE');
    const paths = (await Promise.all(value.map(grantId => workspaceGrants.get(grantId)))).filter((folder): folder is string => Boolean(folder));
    const revokedPaths = [...paths, ...(await Promise.all(paths.map(folder => realpath(folder).catch(() => folder))))];
    for (const grantId of value) grants.delete(grantId);
    await workspaceGrants.deleteMany(value);
    await Promise.all([extensionLaunchBackend.invalidateWorkspaceRoots(revokedPaths), mcpConnections.invalidateWorkspaceRoots(revokedPaths)]);
    await mcpConnections.revalidateManagementWorkspaces();
  });

  ipcMain.handle(AGENT_IPC.syncPartnerWorkspace, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.partnerId !== 'string' || !value.partnerId
      || (value.cwdGrantId !== undefined && typeof value.cwdGrantId !== 'string')
      || !Array.isArray(value.workspaceGrantIds)
      || !value.workspaceGrantIds.every((item) => typeof item === 'string')
      || (value.expectedVersion !== undefined && !Number.isSafeInteger(value.expectedVersion))) throw new Error('INVALID_PARTNER_WORKSPACE_SYNC');
    return partnerWorkspaces.sync(value.partnerId, value.cwdGrantId as string | undefined, value.workspaceGrantIds as string[], value.expectedVersion as number | undefined);
  });

  ipcMain.handle(AGENT_IPC.getPartnerWorkspace, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string' || !value) throw new Error('INVALID_PARTNER_ID');
    return partnerWorkspaces.configuredState(value);
  });

  ipcMain.handle(AGENT_IPC.saveApiCredential, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.secret !== 'string' || !value.secret || (value.credentialRef !== undefined && typeof value.credentialRef !== 'string')) throw new Error('INVALID_CREDENTIAL_REQUEST');
    const credentialRef = await credentials.save(value.secret, value.credentialRef);
    return { credentialRef, configured: true, masked: '••••••••' };
  });

  ipcMain.handle(AGENT_IPC.apiCredentialStatus, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.credentialRef !== 'string' || !value.credentialRef) throw new Error('INVALID_CREDENTIAL_REQUEST');
    const configured = await credentials.has(value.credentialRef);
    return { credentialRef: value.credentialRef, configured, masked: configured ? '••••••••' : '' };
  });

  ipcMain.handle(AGENT_IPC.deleteApiCredential, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.credentialRef !== 'string' || !value.credentialRef) throw new Error('INVALID_CREDENTIAL_REQUEST');
    await apiConnections.assertCredentialUnreferenced(value.credentialRef);
    await credentials.delete(value.credentialRef);
  });

  ipcMain.handle(AGENT_IPC.apiConnectionsGet, async (event) => {
    requireSender(event); return apiConnections.snapshot();
  });
  ipcMain.handle(AGENT_IPC.apiConnectionsProbe, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.modelId !== 'string' || (value.tools !== undefined && typeof value.tools !== 'boolean')) throw new Error('INVALID_API_PROBE');
    if (value.cancel === true) { apiProbes.get(value.modelId)?.abort(); return; }
    if (apiProbes.has(value.modelId)) throw new Error('API_PROBE_BUSY');
    const probeController = new AbortController(); apiProbes.set(value.modelId, probeController);
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
    const data = await apiConnections.snapshot(); const model = data.models.find(m => m.id === value.modelId); const service = data.services.find(s => s.id === model?.serviceId);
    if (!model || !service) throw new Error('API_MODEL_NOT_FOUND');
    const provider = service.legacyDeepSeek ? 'deepseek' : ({ chat_completions: 'openai', responses: 'responses', anthropic_messages: 'anthropic', gemini: 'gemini' } as const)[service.protocol];
    const apiOptions = await configuredApiOptions({ provider, endpoint: service.endpoint, model: model.model, credentialRef: service.credentialRef, requestSettings: service.settings, modelSettings: model.settings });
    if (service.settings?.roundTimeoutMs) probeTimer = setTimeout(() => probeController.abort(), service.settings.roundTimeoutMs);
    let text = '', toolCall = false;
    try {
      const adapter = apiProviders.require(provider).createAdapter({ ...apiOptions, endpoint: service.endpoint, model: model.model });
      for await (const item of adapter.stream({ messages: [{ role: 'user', content: value.tools ? 'Call asterium_connection_probe once with value "ok". Do not call any other tool.' : 'This is a connection test. Reply briefly: OK.' }], tools: value.tools ? [{ name: 'asterium_connection_probe', description: 'Harmless synthetic connection probe; no operations are executed.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] : [], signal: probeController.signal })) {
        if (item.type === 'text.delta') text = (text + item.text).slice(0, 2000);
        if (item.type === 'tool.delta' && item.name === 'asterium_connection_probe') toolCall = true;
      }
      return { text, toolCall };
    } catch { throw new Error('API_PROBE_FAILED'); }
    } finally { if (probeTimer) clearTimeout(probeTimer); apiProbes.delete(value.modelId); }
  });
  ipcMain.handle(AGENT_IPC.apiConnectionsMutate, async (event, value: unknown) => {
    requireSender(event);
    const request = apiConfigurationMutationSchema.parse(value);
    if (request.action === 'service' && request.value.settings?.auth !== 'none' && !await credentials.has(request.value.credentialRef)) throw new Error('API_CREDENTIAL_REQUIRED');
    if (request.action === 'service') for (const header of request.value.settings?.headers ?? []) if (!await credentials.has(header.credentialRef)) throw new Error('API_HEADER_CREDENTIAL_REQUIRED');
    return apiConnections.mutate(request);
  });

  ipcMain.handle(AGENT_IPC.saveWebSearchCredential, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.secret !== 'string' || !value.secret.trim()) throw new Error('INVALID_WEB_SEARCH_CREDENTIAL_REQUEST');
    await credentials.save(value.secret.trim(), BRAVE_SEARCH_CREDENTIAL_REF);
    return { configured: true, masked: '••••••••' };
  });

  ipcMain.handle(AGENT_IPC.webSearchCredentialStatus, async (event) => {
    requireSender(event);
    const configured = await credentials.has(BRAVE_SEARCH_CREDENTIAL_REF);
    return { configured, masked: configured ? '••••••••' : '' };
  });

  ipcMain.handle(AGENT_IPC.deleteWebSearchCredential, async (event) => {
    requireSender(event);
    await credentials.delete(BRAVE_SEARCH_CREDENTIAL_REF);
  });

  ipcMain.handle(AGENT_IPC.extensionsGet, (event) => {
    requireSender(event); return apiExtensions.get();
  });
  ipcMain.handle(AGENT_IPC.extensionsUpsert, (event, value: unknown) => {
    requireSender(event); return apiExtensions.upsert(value);
  });
  ipcMain.handle(AGENT_IPC.extensionsRemove, (event, value: unknown) => {
    requireSender(event); return apiExtensions.remove(value);
  });
  ipcMain.handle(AGENT_IPC.extensionsSetBinding, (event, value: unknown) => {
    requireSender(event); return apiExtensions.setBinding(value);
  });
  ipcMain.handle(AGENT_IPC.extensionsSetTrust, (event, value: unknown) => {
    requireSender(event); return apiExtensions.setTrust(value);
  });
  ipcMain.handle(AGENT_IPC.extensionsConnectMcp, (event, value: unknown) => {
    requireSender(event); return mcpConnections.connectManagement(value);
  });
  ipcMain.handle(AGENT_IPC.extensionsDisconnectMcp, (event, value: unknown) => {
    requireSender(event); return mcpConnections.disconnectManagement(mcpDisconnectSchema.parse(value).id);
  });
  ipcMain.handle(AGENT_IPC.extensionsMcpStatus, (event) => {
    requireSender(event); return mcpConnections.managementStatus();
  });

  ipcMain.handle(AGENT_IPC.refreshPartnerProfiles, async (event) => {
    requireSender(event); return partnerProfiles.refresh();
  });

  ipcMain.handle(AGENT_IPC.syncPartnerProfiles, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || !isUserProfileSeed(value.user) || !Array.isArray(value.partners) || !value.partners.every(isPartnerProfileSeed)) throw new Error('INVALID_PARTNER_PROFILE_SYNC');
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
    await memoryFallbackInventory.activate();
    await memoryFallbackScheduler.start();
    await diaries.recover(); await diaryScheduler.start(); await diaryScheduler.changed();
    await projectTaskOrchestrator.activate(partnerRuntimePort);
    return profiles;
  });

  ipcMain.handle(AGENT_IPC.savePartnerProfile, async (event, value: unknown) => {
    requireSender(event);
    if (!isPartnerProfileSeed(value)) throw new Error('INVALID_PARTNER_PROFILE');
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
  });

  ipcMain.handle(AGENT_IPC.trashPartnerProfile, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.partnerId !== 'string' || !value.partnerId) throw new Error('INVALID_PARTNER_PROFILE_TRASH');
    await prepareMemoryStorage();
    return partnerProfiles.trashPartnerDirectory(value.partnerId, (directory) => shell.trashItem(directory));
  });

  ipcMain.handle(AGENT_IPC.saveUserProfile, async (event, value: unknown) => {
    requireSender(event);
    if (!isUserProfileSeed(value)) throw new Error('INVALID_USER_PROFILE');
    const saved = await partnerProfiles.saveUser(value);
    studioRuntimeCatalog.updateUser(saved);
    return saved;
  });

  ipcMain.handle(AGENT_IPC.openProfileDirectory, async (event) => {
    requireSender(event);
    await mkdir(profileDataRoot, { recursive: true });
    const error = await shell.openPath(profileDataRoot);
    if (error) throw new Error(error);
  });

  ipcMain.handle(AGENT_IPC.memoryFallbackGet, async (event) => {
    requireSender(event);
    await prepareMemoryStorage();
    return memoryFallbackScheduler.snapshot();
  });
  ipcMain.handle(AGENT_IPC.diaryGet, async (event) => {
    requireSender(event);
    const configs = await diarySettings.list(); const notices: Record<string, string> = {};
    for (const config of configs) {
      const source = await singleChatMessages.getConversation(config.conversationId); const owner = diaryCatalog.identity(config.partnerId);
      if (!owner?.available) notices[config.partnerId] = '伙伴已移除或运行时不可用，日记不会自动执行。';
      else if (!source || config.disabledReason === 'source_deleted') notices[config.partnerId] = '来源会话已永久删除，日记已停用，请重新选择来源后保存。';
      else if (config.upstreamThreadId && (owner.threadId !== config.upstreamThreadId || source.sessionId !== config.upstreamThreadId)) notices[config.partnerId] = '上游线程已变化，日记将跳过，请重新选择来源并确认后保存。';
    }
    return { configs, entries: await diaries.list(), notices };
  });
  ipcMain.handle(AGENT_IPC.diaryConfigure, async (event, value: unknown) => {
    requireSender(event); const config = await diarySettings.configure(value); await diaryScheduler.changed(); return config;
  });
  ipcMain.handle(AGENT_IPC.diaryRead, async (event, value: unknown) => {
    requireSender(event); const target = diaryTarget.parse(value); return (await diaries.store(target.partnerId)).read(target.date);
  });
  ipcMain.handle(AGENT_IPC.diaryExport, async (event, value: unknown) => {
    const window = requireSender(event); const target = diaryTarget.parse(value);
    const document = await (await diaries.store(target.partnerId)).read(target.date);
    if (document?.entry.state !== 'completed' || document.content === undefined) throw new Error('DIARY_NOT_COMPLETED');
    const result = await dialog.showSaveDialog(window, { title: '导出伙伴日记', defaultPath: `${target.date}-伙伴日记.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, document.content, 'utf8'); return true;
  });
  ipcMain.handle(AGENT_IPC.memoryFallbackListModels, async (event, value: unknown) => {
    requireSender(event);
    return memoryFallbackSettings.listModels(value, (endpoint, apiKey) => apiProviders.listModels('deepseek', endpoint, apiKey));
  });
  ipcMain.handle(AGENT_IPC.memoryFallbackConfigure, async (event, value: unknown) => {
    requireSender(event);
    await prepareMemoryStorage();
    await memoryFallbackSettings.configure(value);
    memoryFallbackScheduler.cancelCurrent();
    await memoryFallbackScheduler.reconfigure();
    return memoryFallbackScheduler.snapshot();
  });
  ipcMain.handle(AGENT_IPC.memoryFallbackSetPartner, async (event, value: unknown) => {
    requireSender(event);
    await prepareMemoryStorage();
    await memoryFallbackSettings.setPartner(value);
    memoryFallbackScheduler.cancelCurrent();
    await memoryFallbackInventory.refresh();
    return memoryFallbackScheduler.snapshot();
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveQuery, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.query(assertMemoryArchiveQuery(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveBriefing, async (event, partnerId: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.briefing(assertMemoryPartnerId(partnerId));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveCreate, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.create(assertMemoryArchiveCreate(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveUpdate, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.update(assertMemoryArchiveUpdate(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveComment, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.comment(assertMemoryArchiveComment(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveSoftDelete, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.softDelete(assertMemoryArchiveMutation(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveRestore, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.restore(assertMemoryArchiveMutation(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchivePurge, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.purge(assertMemoryArchiveMutation(value));
  });

  ipcMain.handle(AGENT_IPC.memoryArchiveReadSource, async (event, value: unknown) => {
    requireSender(event);
    return partnerMemoryManagement.readSource(assertMemoryArchiveSourceRead(value));
  });

  ipcMain.handle(AGENT_IPC.deleteApiSession, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.partnerId !== 'string' || !value.partnerId
      || (value.conversationId !== undefined && typeof value.conversationId !== 'string')) throw new Error('INVALID_API_SESSION_DELETE');
    if (typeof value.conversationId === 'string' && value.conversationId) await apiSessions.delete(value.partnerId, value.conversationId);
    else await apiSessions.deletePartner(value.partnerId);
  });

  ipcMain.handle(AGENT_IPC.getSessionStatus, async (event, value: unknown) => {
    requireSender(event); assertSessionCommandTarget(value);
    return sessionCommands.inspect(value);
  });
  ipcMain.handle(AGENT_IPC.executeSessionCommand, async (event, value: unknown) => {
    requireSender(event); assertSessionCommandTarget(value, true);
    return sessionCommands.execute(value);
  });

  ipcMain.handle(AGENT_IPC.compactSession, async (event, value: unknown) => {
    requireSender(event); assertSessionCompactRequest(value);
    return sessionCompactions.compact(value);
  });

  ipcMain.handle(AGENT_IPC.sendApiMessage, async (event, value: unknown) => {
    requireSender(event);
    if (!isApiSendRequest(value)) throw new Error('INVALID_API_SEND_REQUEST');
    assertAgentCommand(value.command);
    const request = value as ApiSendRequest;
    if (request.command.type !== 'message.send' || request.command.connectionSource !== 'api_partner') throw new Error('INVALID_API_SEND_COMMAND');
    return startApiRuntime(request);
  });

  ipcMain.handle(AGENT_IPC.listApiModels, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || !apiProviders.has(value.provider) || typeof value.endpoint !== 'string'
      || (value.credentialRef !== undefined && typeof value.credentialRef !== 'string')
      || (value.secret !== undefined && typeof value.secret !== 'string')) throw new Error('INVALID_API_MODEL_LIST_REQUEST');
    if (typeof value.serviceId === 'string') {
      const service = (await apiConnections.snapshot()).services.find(s => s.id === value.serviceId);
      if (!service) throw new Error('API_SERVICE_NOT_FOUND');
      const options = await configuredApiOptions({ provider: value.provider, endpoint: service.endpoint, model: '', credentialRef: service.credentialRef, requestSettings: service.settings }, typeof value.secret === 'string' ? value.secret : undefined);
      const url = service.settings?.modelsPath ? apiEndpoint(service.endpoint, service.protocol, service.settings.modelsPath) : apiModelsEndpoint(service.endpoint, service.protocol);
      return listApiSiteModels(url, service.protocol, apiHeaders({ ...options, apiKey: typeof value.secret === 'string' && value.secret ? value.secret : options.apiKey, endpoint: service.endpoint, model: '' }, service.protocol), service.settings?.headerTimeoutMs);
    }
    const endpoint = apiProviders.require(value.provider).normalizeEndpoint(value.endpoint);
    const apiKey = typeof value.secret === 'string' && value.secret ? value.secret
      : typeof value.credentialRef === 'string' ? await credentials.get(value.credentialRef) : undefined;
    if (!apiKey) throw new Error('API_CREDENTIAL_REQUIRED');
    const protocol = value.provider === 'responses' ? 'responses' : value.provider === 'anthropic' ? 'anthropic_messages' : value.provider === 'gemini' ? 'gemini' : 'chat_completions';
    return listApiSiteModels(apiModelsEndpoint(endpoint, protocol), protocol, apiHeaders({ endpoint, model: '', apiKey }, protocol));
  });

  ipcMain.handle(AGENT_IPC.saveBridgeCredential, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.secret !== 'string' || !value.secret) throw new Error('INVALID_CREDENTIAL_REQUEST');
    const credentialRef = await credentials.save(value.secret);
    return { credentialRef, configured: true, masked: '••••••••' };
  });

  ipcMain.handle(AGENT_IPC.bridgeCredentialStatus, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.credentialRef !== 'string' || !value.credentialRef) throw new Error('INVALID_CREDENTIAL_REQUEST');
    const configured = await credentials.has(value.credentialRef);
    return { credentialRef: value.credentialRef, configured, masked: configured ? '••••••••' : '' };
  });

  ipcMain.handle(AGENT_IPC.deleteBridgeCredential, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.credentialRef !== 'string' || !value.credentialRef) throw new Error('INVALID_CREDENTIAL_REQUEST');
    await credentials.delete(value.credentialRef);
  });

  ipcMain.handle(AGENT_IPC.testExistingThread, async (event, value: unknown) => {
    requireSender(event);
    const connection = assertExistingThreadConnection(value, true);
    const secret = await credentials.get(connection.credentialRef);
    if (!secret) throw new Error('CYBERBOSS_CREDENTIAL_REQUIRED');
    const client = new CyberBossBridgeClient({ serviceUrl: connection.serviceUrl, secret });
    const session = await client.checkSession();
    if (!session.threadId) throw new Error('CYBERBOSS_THREAD_ID_REQUIRED');
    return {
      credentialRef: connection.credentialRef,
      configured: true,
      masked: '••••••••',
      authenticated: true,
      threadId: session.threadId,
      ...(session.workspaceRoot ? { workspaceRoot: session.workspaceRoot } : {}),
        capabilities: { streamingText: true, cancellation: false, toolEvents: false, fileEvents: false, reconnect: true },
    } satisfies ExistingThreadConnectionStatus;
  });

  ipcMain.handle(AGENT_IPC.watchExistingThread, async (event, value: unknown) => {
    requireSender(event);
    const request = assertExistingThreadWatchRequest(value);
    const signature = JSON.stringify(request.connection);
    try {
      return await existingThreadWatches.watch(request.partnerId, signature, async (signal) => {
        const secret = await credentials.get(request.connection.credentialRef);
        if (signal.aborted) throw new Error('EXISTING_THREAD_WATCH_ABORTED');
        if (!secret) throw new Error('CYBERBOSS_CREDENTIAL_REQUIRED');
        const cursorKey = `${request.partnerId}:watch`;
        const initialLastEventId = await bridgeCursors.get(cursorKey);
        if (signal.aborted) throw new Error('EXISTING_THREAD_WATCH_ABORTED');
        const client = new CyberBossBridgeClient({
          serviceUrl: request.connection.serviceUrl,
          secret,
          initialLastEventId,
          onLastEventId: (eventId) => { void bridgeCursors.set(cursorKey, eventId); },
        });
        const session = await client.checkSession();
        if (signal.aborted) throw new Error('EXISTING_THREAD_WATCH_ABORTED');
        if (session.threadId && session.workspaceRoot && (session.threadId !== request.connection.threadId || session.workspaceRoot !== request.connection.workspaceRoot)) sendExistingThreadChanged(request.partnerId, {
          threadId: session.threadId,
          previousThreadId: session.threadId === request.connection.threadId ? undefined : request.connection.threadId,
          workspaceRoot: session.workspaceRoot,
          reason: 'session_sync',
        });
        void (async () => {
          try {
            for await (const incoming of client.events(signal)) {
              if (incoming.event !== 'thread_changed') continue;
              sendExistingThreadChanged(request.partnerId, incoming);
            }
          } catch {
            // The next renderer watch or application restart will re-authenticate.
          } finally {
            existingThreadWatches.release(request.partnerId, signal);
          }
        })();
        return existingThreadStatus(request.connection, session);
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'EXISTING_THREAD_WATCH_ABORTED') return existingThreadStatus(request.connection, {});
      throw error;
    }
  });

  ipcMain.handle(AGENT_IPC.stopExistingThreadWatch, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.partnerId !== 'string' || !value.partnerId) throw new Error('INVALID_EXISTING_THREAD_WATCH_REQUEST');
    existingThreadWatches.stop(value.partnerId);
  });

  ipcMain.handle(AGENT_IPC.sendExistingThreadMessage, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || !isRecord(value.connection) || !isRecord(value.command)) throw new Error('INVALID_EXISTING_THREAD_SEND_REQUEST');
    const request = value as unknown as ExistingThreadSendRequest;
    const connection = assertExistingThreadConnection(request.connection);
    assertAgentCommand(request.command);
    if (request.command.type !== 'message.send' || request.command.connectionSource !== 'existing_thread') throw new Error('INVALID_EXISTING_THREAD_SEND_COMMAND');
    request.command.attachments = await messageAttachments.canonicalize(request.command.conversationId, request.command.attachments);
    await hydrateManagedRuntimeProfile(request.command);
    const fingerprint = JSON.stringify({ connection, command: request.command });
    return runCoordinator.runIdempotent(request.command.clientMessageId, fingerprint, async () => {
      const adapter = await runtimeFactory.getExisting({
        partnerId: request.command.partnerId,
        credentialRef: connection.credentialRef,
        serviceUrl: connection.serviceUrl,
        threadId: connection.threadId,
      });
      return useLegacyRunPath ? startAdapterRun(adapter, request.command) : runCoordinator.start(adapter, request.command);
    });
  });

  ipcMain.handle(AGENT_IPC.sendMessage, async (event, value: unknown) => {
    requireSender(event);
    if (!isLocalSendRequest(value)) throw new Error('INVALID_LOCAL_CLI_SEND_REQUEST');
    assertAgentCommand(value.command);
    if (value.command.type !== 'message.send') throw new Error('INVALID_LOCAL_CLI_SEND_COMMAND');
    const request = value as LocalCliSendRequest;
    if (request.command.connectionSource !== 'local_cli') throw new Error('INVALID_LOCAL_CLI_CONNECTION_SOURCE');
    return startLocalRuntime(request);
  });

  ipcMain.handle(AGENT_IPC.cancelRun, async (event, value: unknown) => {
    requireSender(event);
    assertAgentCommand(value);
    if (value.type !== 'run.cancel') throw new Error('INVALID_CANCEL_COMMAND');
    automationConfirmations.cancelOwner(value.clientMessageId);
    await runCoordinator.cancel(value as CancelRunCommand);
  });

  ipcMain.handle(AGENT_IPC.sendGuidance, async (event, value: unknown): Promise<SendGuidanceResult> => {
    requireSender(event);
    assertAgentCommand(value);
    if (value.type !== 'guidance.send') throw new Error('INVALID_GUIDANCE_COMMAND');
    return runCoordinator.sendGuidance(value as SendGuidanceCommand);
  });

  ipcMain.handle(AGENT_IPC.resolveAuthorization, async (event, value: unknown) => {
    requireSender(event);
    assertAgentCommand(value);
    if (value.type !== 'authorization.resolve') throw new Error('INVALID_AUTHORIZATION_COMMAND');
    await runCoordinator.resolveAuthorization(value as ResolveAuthorizationCommand);
  });

  ipcMain.handle(AGENT_IPC.resolveUserInput, async (event, value: unknown) => {
    requireSender(event);
    assertAgentCommand(value);
    if (value.type !== 'user_input.resolve') throw new Error('INVALID_USER_INPUT_COMMAND');
    await runCoordinator.resolveUserInput(value as ResolveUserInputCommand);
  });

  ipcMain.handle(AGENT_IPC.resumeSession, async (event, value: unknown) => {
    requireSender(event);
    assertAgentCommand(value);
    if (value.type !== 'session.resume') throw new Error('INVALID_RESUME_COMMAND');
    await runCoordinator.resume(value as ResumeSessionCommand);
  });

  async function startApiRuntime(request: ApiSendRequest) {
    await attachAutomationCommand(request.command);
    request = { ...request, connection: await apiConnections.resolve(request.command.partnerId, request.connection) };
    request.command.attachments = await messageAttachments.canonicalize(request.command.conversationId, request.command.attachments);
    if (request.command.sourceMessage) await singleChatMessages.upsertMessage(request.command.conversationId, request.command.partnerId, request.command.sourceMessage);
    const storedProfile = await hydrateManagedRuntimeProfile(request.command);
    if (request.command.runtimeContext) request.command.runtimeContext = { ...request.command.runtimeContext, runtime: { ...request.command.runtimeContext?.runtime, source: 'api_partner', provider: request.connection.provider, model: request.connection.model } };
    apiProviders.require(request.connection.provider);
    const attachmentCapabilities = resolveApiAttachmentCapabilities(request.connection);
    const normalizedProvider = apiProviders.normalizeConnection(request.connection);
    const apiOptions = await configuredApiOptions(request.connection);
    const fingerprint = JSON.stringify({ connection: request.connection, command: { ...request.command, sessionBootstrap: undefined, sessionBootstrapVersion: undefined } });
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
        toolsEnabled: request.connection.toolsEnabled,
        thinkingMode: request.connection.thinkingMode ?? 'auto',
        reasoningEffort: request.connection.reasoningEffort ?? 'high',
        primaryDirectory,
        additionalDirectories,
        attachmentCapabilities,
        runtimeTools: runtimeToolsFor(request.command, storedProfile?.management.memoryMode),
      });
      return useLegacyRunPath
        ? startAdapterRun(adapter, request.command, true, primaryDirectory)
        : runCoordinator.start(adapter, request.command, { disposeAfter: true, artifactBaseDirectory: primaryDirectory });
    });
  }

  async function startLocalRuntime(request: LocalCliSendRequest) {
    await attachAutomationCommand(request.command);
    request.command.attachments = await messageAttachments.canonicalize(request.command.conversationId, request.command.attachments);
    if (request.command.sourceMessage) await singleChatMessages.upsertMessage(request.command.conversationId, request.command.partnerId, request.command.sourceMessage);
    const storedProfile = await hydrateManagedRuntimeProfile(request.command);
    let partnerRoot: string;
    let grantIds: string[] = [];
    let additionalDirectories: string[] = [];
    if (request.projectRootOverride) {
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
      let installation = await ensureCodexInstallation();
      let runtime = resolveCodexRuntime(installation.runtimes, request.codexRuntimeId, request.codexRuntimeEnvironment);
      if (!runtime) {
        codexInstallation = await detectCodexCli();
        installation = codexInstallation;
        runtime = resolveCodexRuntime(installation.runtimes, request.codexRuntimeId, request.codexRuntimeEnvironment);
      }
      if (!runtime) throw new Error('CODEX_RUNTIME_SELECTION_REQUIRED');
      if (!runtime.loggedIn) throw new Error('CODEX_NOT_LOGGED_IN');
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
      execution: request.command.execution,
      attachments: request.command.attachments,
      partnerRootGrantId: request.partnerRootGrantId,
      workspaceGrantIds: grantIds,
      projectRootOverride: request.projectRootOverride,
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
      const adapter = runtimeFactory.getLocal({
        adapterType: request.adapterType,
        adapterKey,
        executablePath,
        partnerRoot,
        additionalDirectories,
        runtimeTools: runtimeToolsFor(request.command, storedProfile?.management.memoryMode),
      });
      adapter.updateRuntimeContext?.(request.command);
      return useLegacyRunPath
        ? startAdapterRun(adapter, request.command, false, partnerRoot)
        : runCoordinator.start(adapter, request.command, { artifactBaseDirectory: partnerRoot });
    });
  }

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
    return studioRooms.prepareTurn(value.roomId, value.roundId, value.partnerId, binding.generation, binding.conversationId, binding.nativeThreadId, binding.studioSpeakingMode);
  }

  async function markAcceptedStudioSpeakingMode(event: PartnerEvent, command: SendMessageCommand) {
    if (event.type !== 'message.accepted' || command.route?.scope !== 'group') return;
    const speakingMode = command.runtimeContext?.conversation?.studio?.speakingMode;
    if (!speakingMode) return;
    try {
      const binding = await nativeBindings.getForScope(command.partnerId, 'group', command.route.roomId);
      if (binding?.generation === command.route.bindingGeneration && binding.conversationId === command.conversationId
        && binding.nativeThreadId === event.sessionId && binding.studioSpeakingMode !== speakingMode) await nativeBindings.markStudioSpeakingMode(binding.bindingId, speakingMode);
    } catch {
      // This bookkeeping must not fail an accepted Studio turn. If it cannot
      // be persisted, the next turn safely repeats the mode notice once.
    }
  }

  async function ensureCodexInstallation() {
    if (!codexInstallation?.runtimes.length) codexInstallation = await detectCodexCli();
    return codexInstallation;
  }

  async function resolveCodexLifecycleRuntime(value: Pick<LocalThreadLifecycleRequest, 'partnerRootGrantId' | 'codexRuntimeId' | 'codexRuntimeEnvironment'>) {
    if (!value.partnerRootGrantId) throw new Error('PARTNER_ROOT_GRANT_REQUIRED');
    const workingDirectory = await resolveWorkspaceGrant(value.partnerRootGrantId);
    if (!workingDirectory) throw new Error('PARTNER_ROOT_GRANT_REQUIRED');
    let installation = await ensureCodexInstallation();
    let runtime = resolveCodexRuntime(installation.runtimes, value.codexRuntimeId, value.codexRuntimeEnvironment);
    if (!runtime) {
      codexInstallation = await detectCodexCli();
      installation = codexInstallation;
      runtime = resolveCodexRuntime(installation.runtimes, value.codexRuntimeId, value.codexRuntimeEnvironment);
    }
    if (!runtime) throw new Error('CODEX_RUNTIME_SELECTION_REQUIRED');
    if (!runtime.loggedIn) throw new Error('CODEX_NOT_LOGGED_IN');
    return { runtime, workingDirectory };
  }

  async function resolveWorkspaceGrant(grantId: string) {
    const current = grants.get(grantId);
    if (current) {
      await assertCanonicalPathOutsideProtectedRoots(current, protectedRoots);
      return current;
    }
    const restored = await workspaceGrants.get(grantId);
    if (restored) {
      await assertCanonicalPathOutsideProtectedRoots(restored, protectedRoots);
      grants.set(grantId, restored);
    }
    return restored;
  }

  async function ensureClaudeInstallation() {
    if (!claudeInstallation?.executablePath || !claudeInstallation.loggedIn) claudeInstallation = await detectClaudeCode();
    return claudeInstallation;
  }

  async function startAdapterRun(adapter: PartnerAdapter, command: SendMessageCommand, disposeAfter = false, artifactBaseDirectory?: string) {
    if (/^(compact|reload):/.test(writerLeases.ownerFor({ kind: 'conversation', partnerId: command.partnerId, conversationId: command.conversationId }) ?? '')) throw new Error('COMPACT_CONVERSATION_BUSY');
    const lease = await writerLeases.acquire({ kind: 'conversation', partnerId: command.partnerId, conversationId: command.conversationId }, `legacy:${command.commandId}`);
    if (command.sessionId) { try { await hydrateManagedRuntimeProfile(command); } catch (error) { lease.release(); throw error; } }
    delivery(command, 'awaiting_confirmation');
    const iterator = adapter.sendMessage(command)[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      if (first.done || !isPartnerEvent(first.value) || first.value.type !== 'session.bound') throw new Error('ADAPTER_SESSION_NOT_BOUND');
      const firstEvent = withCommandRoute(first.value, command);
      if (!sameEventRoute(firstEvent, command)) throw new Error('ADAPTER_EVENT_ROUTE_MISMATCH');
      if (command.route?.scope === 'group') {
        const binding = await nativeBindings.getForScope(command.partnerId, 'group', command.route.roomId);
        if (!binding || binding.conversationId !== command.conversationId || binding.generation !== command.route.bindingGeneration) throw new Error('NATIVE_BINDING_ROUTE_MISMATCH');
        if (binding.state === 'pending') await nativeBindings.activate(binding.bindingId, firstEvent.sessionId);
        else if (binding.nativeThreadId !== firstEvent.sessionId) throw new Error('NATIVE_THREAD_ROUTE_MISMATCH');
      }
      await studioRooms.observeEvent(firstEvent);
      sendEvent(firstEvent);
      const receipt = { runId: firstEvent.runId, sessionId: firstEvent.sessionId };
      host.bindRun(receipt.runId, adapter);
      host.bindSession(command.partnerId, command.conversationId, receipt.sessionId, adapter);
      if (command.route?.scope === 'group') await studioRooms.bindRun(command.route.roomId, command.route.roundId, command.partnerId, receipt.runId, receipt.sessionId);
      await sessionBootstrapRecorder.onBound(firstEvent as Extract<PartnerEvent, { type: 'session.bound' }>, command);
      void (async () => {
        let lastSequence = firstEvent.sequence;
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            if (!isPartnerEvent(next.value)) continue;
            const routedEvent = withCommandRoute(next.value, command);
            if (!sameEventRoute(routedEvent, command) || routedEvent.sessionId !== receipt.sessionId || routedEvent.runId !== receipt.runId) throw new Error('ADAPTER_EVENT_ROUTE_MISMATCH');
            lastSequence = routedEvent.sequence;
            await studioRooms.observeEvent(routedEvent);
            if (command.route?.scope === 'group' && routedEvent.type === 'run.completed') {
              const binding = await nativeBindings.getForScope(command.partnerId, 'group', command.route.roomId);
              if (binding?.generation === command.route.bindingGeneration) await nativeBindings.markCompleted(binding.bindingId, routedEvent.runId).catch(() => undefined);
            }
            await captureGuidanceSource(routedEvent, command);
            await sessionBootstrapRecorder.onEvent(routedEvent, command);
            await markAcceptedStudioSpeakingMode(routedEvent, command);
            if (routedEvent.type === 'message.accepted') delivery(command, 'delivered');
            if (routedEvent.type === 'run.failed') delivery(command, 'failed', routedEvent.error);
            const outgoing = await transformRuntimeEvent(routedEvent, artifactBaseDirectory);
            if (outgoing) sendEvent(outgoing);
          }
        } catch (error) {
          if (command.route?.scope === 'group') {
            await nativeBindings.invalidateGroupTurn(command).catch(() => undefined);
            const failed: PartnerEvent = {
              protocolVersion: AGENT_PROTOCOL_VERSION,
              type: 'run.failed',
              eventId: randomUUID(),
              partnerId: command.partnerId,
              conversationId: command.conversationId,
              connectionSource: command.connectionSource,
              clientMessageId: command.clientMessageId,
              sessionId: receipt.sessionId,
              runId: receipt.runId,
              sequence: lastSequence + 1,
              occurredAt: new Date().toISOString(),
              route: command.route,
              error: { code: 'ADAPTER_STREAM_FAILED', message: '伙伴的事件流意外中断。', stage: 'transport', retryable: true },
            };
            await studioRooms.observeEvent(failed).catch(() => undefined);
            sendEvent(failed);
          }
          delivery(command, 'failed', {
            code: 'ADAPTER_STREAM_FAILED',
            message: '伙伴的事件流意外中断。',
            stage: 'transport',
            retryable: true,
            technicalDetail: error instanceof Error ? error.message.slice(0, 500) : undefined,
          });
        } finally {
          host.releaseRun(receipt.runId);
          lease.release();
          if (disposeAfter) await adapter.dispose?.();
          if (command.route?.scope === 'group' && studioRooms.hasPendingPassRetry(receipt.runId)) {
            studioOrchestration.orchestrator?.markPassCorrection(command.route.roomId, command.route.roundId, command.partnerId);
            await studioRooms.retryPassAfterRelease(receipt.runId).catch(() => undefined);
          }
        }
      })();
      return receipt;
    } catch (error) {
      lease.release();
      if (command.route?.scope === 'group') {
        await nativeBindings.invalidateGroupTurn(command).catch(() => undefined);
        await studioRooms.failPreparedTurn(command.route.roomId, command.route.roundId, command.partnerId).catch(() => undefined);
      }
      delivery(command, 'failed', {
        code: 'ADAPTER_START_FAILED',
        message: '无法启动伙伴会话。',
        stage: 'adapter',
        retryable: true,
        technicalDetail: error instanceof Error ? error.message.slice(0, 500) : undefined,
      });
      throw error;
    }
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
  const automationStartup = app.whenReady().then(() => automationHandles.scheduler!.start()).catch(() => console.error('Automation startup requires storage review; no automatic replay.'));
  const unsubscribeAutomationWriters = writerLeases.subscribeAvailable(() => { void automationHandles.scheduler?.tick(); });
  ipcMain.handle(AGENT_IPC.automationsGet, async event => { requireSender(event); return automationService.get(); });
  ipcMain.handle(AGENT_IPC.automationsConfirmationsGet, async event => { requireSender(event); return automationConfirmations.list(); });
  ipcMain.handle(AGENT_IPC.automationsConfirmationsResolve, async (event, request: unknown) => { requireSender(event); const reply = automationConfirmationReplySchema.parse(request); automationConfirmations.resolve(reply.id, reply.approved); });
  ipcMain.handle(AGENT_IPC.automationsMutate, async (event, request: unknown) => { requireSender(event); return automationService.mutate(request); });

  return async () => {
    notifications?.dispose();
    unsubscribeGeneralSettings();
    automationConfirmations.dispose();
    await automationStartup;
    await automationHandles.scheduler?.dispose();
    unsubscribeAutomationWriters();
    unsubscribeAutomations();
    for (const controller of apiProbes.values()) controller.abort(); apiProbes.clear();
    await studioWakeControl.dispose();
    await studioMcpStartup;
    await studioMcpHost.dispose();
    await studioWakeEvents.dispose();
    profileReloads.dispose();
    sessionCompactions.dispose();
    await mcpConnections.dispose();
    await diaryScheduler.dispose();
    unsubscribeFallbackInventory();
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
    grants.clear();
  };
}

function assertMemoryPartnerId(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_MEMORY_PARTNER_ID');
  return value;
}

function assertMemoryArchiveQuery(value: unknown): MemoryArchiveQuery {
  if (!isRecord(value)) throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  const partnerId = assertMemoryPartnerId(value.partnerId);
  if (value.includeDeleted !== undefined && typeof value.includeDeleted !== 'boolean') throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.text !== undefined && typeof value.text !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.tags !== undefined && (!Array.isArray(value.tags) || !value.tags.every((item) => typeof item === 'string'))) throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.types !== undefined && (!Array.isArray(value.types) || !value.types.every((item) => MEMORY_TYPES.includes(item as never)))) throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.statuses !== undefined && (!Array.isArray(value.statuses) || !value.statuses.every((item) => MEMORY_STATUSES.includes(item as never)))) throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.from !== undefined && typeof value.from !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.to !== undefined && typeof value.to !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  if (value.limit !== undefined && !Number.isSafeInteger(value.limit)) throw new Error('INVALID_MEMORY_ARCHIVE_QUERY');
  return { ...value, partnerId } as MemoryArchiveQuery;
}

function assertMemoryArchiveCreate(value: unknown): MemoryArchiveCreateRequest {
  if (!isRecord(value) || !MEMORY_TYPES.includes(value.type as never) || typeof value.body !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_CREATE');
  return { ...value, partnerId: assertMemoryPartnerId(value.partnerId) } as unknown as MemoryArchiveCreateRequest;
}

function assertMemoryArchiveUpdate(value: unknown): MemoryArchiveUpdateRequest {
  if (!isRecord(value) || typeof value.memoryId !== 'string' || !value.memoryId.trim() || typeof value.expectedUpdatedAt !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_UPDATE');
  if (value.type !== undefined && !MEMORY_TYPES.includes(value.type as never)) throw new Error('INVALID_MEMORY_ARCHIVE_UPDATE');
  if (value.status !== undefined && !MEMORY_STATUSES.includes(value.status as never)) throw new Error('INVALID_MEMORY_ARCHIVE_UPDATE');
  return { ...value, partnerId: assertMemoryPartnerId(value.partnerId) } as unknown as MemoryArchiveUpdateRequest;
}

function assertMemoryArchiveComment(value: unknown): MemoryArchiveCommentRequest {
  if (!isRecord(value) || typeof value.memoryId !== 'string' || !value.memoryId.trim()
    || typeof value.expectedUpdatedAt !== 'string' || typeof value.content !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_COMMENT');
  return { ...value, partnerId: assertMemoryPartnerId(value.partnerId) } as unknown as MemoryArchiveCommentRequest;
}

function assertMemoryArchiveMutation(value: unknown): MemoryArchiveMutationRequest {
  if (!isRecord(value) || typeof value.memoryId !== 'string' || !value.memoryId.trim() || typeof value.expectedUpdatedAt !== 'string') throw new Error('INVALID_MEMORY_ARCHIVE_MUTATION');
  return { partnerId: assertMemoryPartnerId(value.partnerId), memoryId: value.memoryId, expectedUpdatedAt: value.expectedUpdatedAt };
}

function assertMemoryArchiveSourceRead(value: unknown): MemoryArchiveSourceReadRequest {
  if (!isRecord(value) || typeof value.memoryId !== 'string' || !value.memoryId.trim()
    || (value.sourceIndex !== undefined && (!Number.isSafeInteger(value.sourceIndex) || Number(value.sourceIndex) < 0))) throw new Error('INVALID_MEMORY_ARCHIVE_SOURCE_READ');
  return {
    partnerId: assertMemoryPartnerId(value.partnerId),
    memoryId: value.memoryId,
    ...(value.sourceIndex !== undefined ? { sourceIndex: Number(value.sourceIndex) } : {}),
  };
}

function isApiSendRequest(value: unknown): value is ApiSendRequest {
  return isRecord(value)
    && isRecord(value.connection)
    && ['deepseek', 'openai', 'responses', 'anthropic', 'gemini', 'custom'].includes(String(value.connection.provider))
    && typeof value.connection.endpoint === 'string'
    && typeof value.connection.model === 'string'
    && typeof value.connection.credentialRef === 'string'
    && (value.connection.thinkingMode === undefined || ['auto', 'enabled', 'disabled'].includes(String(value.connection.thinkingMode)))
    && (value.connection.reasoningEffort === undefined || ['low', 'high', 'max'].includes(String(value.connection.reasoningEffort)))
    && (value.connection.primaryWorkspaceGrantId === undefined || typeof value.connection.primaryWorkspaceGrantId === 'string')
    && (value.connection.workspaceGrantIds === undefined || (Array.isArray(value.connection.workspaceGrantIds) && value.connection.workspaceGrantIds.every((item) => typeof item === 'string')))
    && (value.connection.attachmentCapabilities === undefined || isAttachmentCapabilities(value.connection.attachmentCapabilities))
    && isRecord(value.command);
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

function isAttachmentCapabilities(value: unknown) {
  return isRecord(value)
    && typeof value.supportsImageInput === 'boolean'
    && Array.isArray(value.acceptedMimeTypes)
    && value.acceptedMimeTypes.every((item) => typeof item === 'string' && item === item.trim().toLocaleLowerCase() && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(item))
    && Number.isSafeInteger(value.maxImageBytes) && Number(value.maxImageBytes) >= 0
    && ['local_path', 'native_multimodal', 'metadata_only'].includes(String(value.attachmentTransport));
}

function isStudioRoomMetadata(value: unknown): value is StudioRoomMetadata {
  return isRecord(value)
    && typeof value.roomId === 'string' && Boolean(value.roomId)
    && typeof value.projectId === 'string' && Boolean(value.projectId)
    && typeof value.name === 'string' && Boolean(value.name.trim())
    && (value.archived === undefined || typeof value.archived === 'boolean')
    && Array.isArray(value.memberIds) && value.memberIds.every((id) => typeof id === 'string' && Boolean(id));
}

function isStudioStartRoundRequest(value: unknown): value is StudioStartRoundRequest {
  return isRecord(value) && isStudioRoomMetadata(value.room)
    && typeof value.messageId === 'string' && Boolean(value.messageId)
    && typeof value.content === 'string' && Boolean(value.content.trim())
    && typeof value.authorId === 'string' && Boolean(value.authorId)
    && Array.isArray(value.speakerQueue) && value.speakerQueue.length > 0
    && value.speakerQueue.every((id) => typeof id === 'string' && Boolean(id))
    && (value.mentions === undefined || (Array.isArray(value.mentions) && value.mentions.every((mention) => isRecord(mention)
      && typeof mention.partnerId === 'string' && Boolean(mention.partnerId)
      && typeof mention.label === 'string' && Boolean(mention.label.trim())
      && mention.source === 'user'
      && (mention.start === undefined || Number.isSafeInteger(mention.start))
      && (mention.end === undefined || Number.isSafeInteger(mention.end)))));
}

function isStudioPrepareTurnRequest(value: unknown): value is StudioPrepareTurnRequest {
  return isRecord(value)
    && typeof value.roomId === 'string' && Boolean(value.roomId)
    && typeof value.roundId === 'string' && Boolean(value.roundId)
    && typeof value.partnerId === 'string' && Boolean(value.partnerId)
    && ['local_cli', 'api_partner', 'existing_thread'].includes(String(value.source))
    && (value.adapterType === undefined || ['codex_cli', 'claude_code'].includes(String(value.adapterType)))
    && (value.partnerRootGrantId === undefined || typeof value.partnerRootGrantId === 'string')
    && (value.codexRuntimeId === undefined || typeof value.codexRuntimeId === 'string')
    && (value.codexRuntimeEnvironment === undefined || ['global_cli', 'desktop_app', 'vscode_extension', 'path'].includes(String(value.codexRuntimeEnvironment)));
}

function resolveApiAttachmentCapabilities(connection: ApiPartnerConnection) {
  const defaults = {
    supportsImageInput: false,
    acceptedMimeTypes: [] as string[],
    maxImageBytes: 0,
    attachmentTransport: 'metadata_only' as const,
  };
  const requested = connection.attachmentCapabilities ?? defaults;
  if (!isAttachmentCapabilities(requested)) throw new Error('INVALID_ATTACHMENT_CAPABILITIES');
  if (requested.attachmentTransport === 'local_path' || (connection.provider === 'deepseek' && (requested.attachmentTransport !== defaults.attachmentTransport || requested.supportsImageInput))) throw new Error('API_ATTACHMENT_TRANSPORT_NOT_IMPLEMENTED');
  return { ...requested, acceptedMimeTypes: [...new Set(requested.acceptedMimeTypes)] };
}

function assertAttachmentContext(value: unknown) {
  if (!isRecord(value) || typeof value.attachmentId !== 'string' || typeof value.conversationId !== 'string') throw new Error('INVALID_ATTACHMENT_CONTEXT');
  return { attachmentId: value.attachmentId, conversationId: value.conversationId };
}

function assertConversationDeleteRequest(value: unknown): ConversationDeleteRequest {
  if (!isRecord(value) || typeof value.conversationId !== 'string' || typeof value.partnerId !== 'string'
    || !['existing_thread', 'local_cli', 'api_partner'].includes(String(value.source))) {
    throw new Error('INVALID_CONVERSATION_DELETE');
  }
  return value as unknown as ConversationDeleteRequest;
}

function assertProjectNotebookTarget(value: unknown): ProjectNotebookTarget {
  if (!isRecord(value) || typeof value.partnerId !== 'string' || !value.partnerId.trim()
    || typeof value.projectId !== 'string' || !value.projectId.trim()) throw new Error('INVALID_PROJECT_NOTEBOOK_TARGET');
  return { partnerId: value.partnerId, projectId: value.projectId };
}

function assertProjectNotebookReplaceRequest(value: unknown): ProjectNotebookUserReplaceRequest {
  const target = assertProjectNotebookTarget(value);
  if (!isRecord(value) || typeof value.content !== 'string'
    || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) throw new Error('INVALID_PROJECT_NOTEBOOK_REPLACE');
  return { ...target, content: value.content, expectedRevision: Number(value.expectedRevision) };
}

function archivedMarkdownFileName(name: string, suffix: string) {
  const withoutControlCharacters = [...name].map((character) => character.charCodeAt(0) < 32 ? '_' : character).join('');
  const safeName = withoutControlCharacters.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 120) || '项目';
  return `${safeName}-${suffix}.md`;
}

function archivedNotebookFileName(projectName: string) {
  return archivedMarkdownFileName(projectName, '工作笔记');
}

function isTextMime(mediaType: string) {
  return mediaType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mediaType);
}

async function resolveProjectRuntimeRoot(rootPath: string, protectedRoots: readonly string[]) {
  const resolved = path.resolve(rootPath);
  const value = await stat(resolved).catch(() => undefined);
  if (!value?.isDirectory()) throw new Error('PROJECT_WORKSPACE_NOT_READY');
  await assertCanonicalPathOutsideProtectedRoots(resolved, protectedRoots);
  return realpath(resolved);
}

function attachmentPreviewKind(name: string, mediaType: string) {
  const extension = path.extname(name).toLocaleLowerCase();
  if (mediaType.startsWith('image/')) return 'image' as const;
  if (mediaType === 'application/pdf') return 'pdf' as const;
  if (extension === '.md' || mediaType === 'text/markdown') return 'markdown' as const;
  if (extension === '.html' || extension === '.htm' || mediaType === 'text/html') return 'html' as const;
  if (['.doc', '.docx'].includes(extension)) return 'word' as const;
  if (['.xls', '.xlsx'].includes(extension)) return 'sheet' as const;
  if (['.ppt', '.pptx'].includes(extension)) return 'slides' as const;
  if (isTextMime(mediaType)) return 'text' as const;
  return 'unsupported' as const;
}

function assertExistingThreadConnection(value: unknown, allowEmptyThreadId = false): ExistingThreadConnection {
  if (!isRecord(value) || typeof value.serviceUrl !== 'string' || typeof value.threadId !== 'string' || typeof value.credentialRef !== 'string' || !value.credentialRef) throw new Error('INVALID_EXISTING_THREAD_CONNECTION');
  if (value.workspaceRoot !== undefined && typeof value.workspaceRoot !== 'string') throw new Error('INVALID_EXISTING_THREAD_CONNECTION');
  normalizeCyberBossServiceUrl(value.serviceUrl);
  const threadId = value.threadId.trim();
  if ((!threadId && !allowEmptyThreadId) || (threadId && !isSafeExistingThreadId(threadId))) throw new Error('INVALID_CYBERBOSS_THREAD_ID');
  return value as unknown as ExistingThreadConnection;
}

function assertExistingThreadWatchRequest(value: unknown): ExistingThreadWatchRequest {
  if (!isRecord(value) || typeof value.partnerId !== 'string' || !value.partnerId || !isRecord(value.connection)) throw new Error('INVALID_EXISTING_THREAD_WATCH_REQUEST');
  return { partnerId: value.partnerId, connection: assertExistingThreadConnection(value.connection) };
}

function isSafeExistingThreadId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value.trim());
}

function isLocalSendRequest(value: unknown): value is LocalCliSendRequest {
  return isRecord(value)
    && isLocalAdapterType(value.adapterType)
    && typeof value.partnerId === 'string'
    && (value.partnerRootGrantId === undefined || typeof value.partnerRootGrantId === 'string')
    && Array.isArray(value.workspaceGrantIds)
    && value.workspaceGrantIds.every((item) => typeof item === 'string')
    && (value.codexRuntimeId === undefined || typeof value.codexRuntimeId === 'string')
    && (value.codexRuntimeEnvironment === undefined || ['global_cli', 'desktop_app', 'vscode_extension', 'path'].includes(String(value.codexRuntimeEnvironment)))
    && isRecord(value.command);
}

function isLocalThreadLifecycleRequest(value: unknown): value is LocalThreadLifecycleRequest {
  return isRecord(value)
    && isLocalAdapterType(value.adapterType)
    && typeof value.partnerId === 'string'
    && value.partnerId.length > 0
    && (value.partnerRootGrantId === undefined || typeof value.partnerRootGrantId === 'string')
    && (value.codexRuntimeId === undefined || typeof value.codexRuntimeId === 'string')
    && (value.codexRuntimeEnvironment === undefined || ['global_cli', 'desktop_app', 'vscode_extension', 'path'].includes(String(value.codexRuntimeEnvironment)))
    && Array.isArray(value.threadIds)
    && value.threadIds.length > 0
    && value.threadIds.every((threadId) => typeof threadId === 'string' && threadId.length > 0);
}

function isChangeLocalThreadLifecycleRequest(value: unknown): value is ChangeLocalThreadLifecycleRequest {
  return isRecord(value)
    && isLocalAdapterType(value.adapterType)
    && typeof value.partnerId === 'string'
    && value.partnerId.length > 0
    && (value.partnerRootGrantId === undefined || typeof value.partnerRootGrantId === 'string')
    && (value.codexRuntimeId === undefined || typeof value.codexRuntimeId === 'string')
    && (value.codexRuntimeEnvironment === undefined || ['global_cli', 'desktop_app', 'vscode_extension', 'path'].includes(String(value.codexRuntimeEnvironment)))
    && typeof value.threadId === 'string'
    && value.threadId.length > 0
    && ['archive', 'restore', 'delete'].includes(String(value.action));
}

function publicClaudeInstallation(installation: ClaudeInstallation) {
  return {
    installed: installation.installed,
    loggedIn: installation.loggedIn,
    version: installation.version,
    authMethod: installation.authMethod,
    executableLabel: installation.executableLabel,
    error: installation.error,
  };
}
