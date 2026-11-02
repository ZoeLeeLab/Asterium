import type { ProjectRunChange, ProjectRunChangeRead, ProjectRunChangeContent } from './projectRunChanges';
import type { ProjectBrowseRequest, ProjectBrowseResult } from './projectBrowser';
import type {
  ApiModelSummary,
  ApiPartnerConnection,
  ArtifactAvailability,
  ArtifactRegistrationMethod,
  ArtifactSourceKind,
  CancelRunCommand,
  ChangeLocalThreadLifecycleRequest,
  ClaudeDetectionResult,
  ClaudeSessionImport,
  CodexDetectionResult,
  CodexRuntimeInfo,
  CodexThreadSummary,
  ConversationAttachmentInfo,
  CredentialStatus,
  ExistingThreadConnection,
  ExistingThreadConnectionStatus,
  LocalThreadLifecycleRequest,
  MessageAttachment,
  NativeThreadLifecycleResult,
  PartnerProfileSeed,
  PartnerProfileSnapshot,
  PartnerProfilesSyncResult,
  PartnerWorkspaceState,
  PendingMessageAttachment,
  RendererAgentEvent,
  ResolveAuthorizationCommand,
  ResolveUserInputCommand,
  ResumeSessionCommand,
  SendGuidanceCommand,
  SendGuidanceResult,
  SendMessageCommand,
  SendMessageReceipt,
  WorkspaceGrant,
} from './agentProtocol';
import type { FileDeletionInspection, FileDeletionResult, ProjectDeliveryResult, ProjectFilesSnapshot, ProjectLocationSelection, ProjectMembershipChangeRequest, ProjectMembershipChangeResult, ProjectWorkspaceCreateRequest, ProjectWorkspaceFileEntry, ProjectWorkspaceSnapshot } from './projectWorkspace';
import type { ProjectExecutionPolicy, ProjectExecutionPolicyUpdateRequest } from './projectExecutionPolicy';
import type {
  ProjectCreateRequest,
  ProjectCreateResult,
  ProjectDomainChange,
  ProjectDomainInitializeRequest,
  ProjectDomainSnapshot,
  ProjectRecord,
  ProjectTask,
  ProjectTaskCreateRequest,
  ProjectTaskRemoveRequest,
  ProjectTaskUpdateRequest,
  ProjectUpdateRequest,
} from './projectDomain';
import type {
  ProjectWorkRoleArchiveRequest,
  ProjectWorkRoleCatalog,
  ProjectWorkRoleChange,
  ProjectWorkRoleCreateRequest,
  ProjectWorkRoleDefinition,
  ProjectWorkRoleRemoveRequest,
  ProjectWorkRoleUpdateRequest,
} from './projectRoles';
import type {
  ProjectWorkflow,
  ProjectWorkflowActivateRequest,
  ProjectWorkflowActivationResult,
  ProjectWorkflowCatalog,
  ProjectWorkflowChange,
  ProjectWorkflowCreateRequest,
  ProjectWorkflowRemoveRequest,
  ProjectWorkflowTemplate,
  ProjectWorkflowTemplateRemoveRequest,
  ProjectWorkflowTemplateSaveRequest,
  ProjectWorkflowTemplateUpdateRequest,
  ProjectWorkflowUpdateRequest,
} from './projectWorkflows';
import type {
  ProjectWorkflowGeneration,
  ProjectWorkflowGenerationCancelRequest,
  ProjectWorkflowGenerationChange,
  ProjectWorkflowGenerationRetryRequest,
  ProjectWorkflowGenerationStartRequest,
} from './projectWorkflowGeneration';
import type {
  ProjectTaskExecutionChange,
  ProjectTaskExecutionSnapshot,
  TaskAttempt,
  TaskAttemptControlRequest,
  TaskAttemptRequest,
  TaskGateResolutionRequest,
} from './projectTaskExecution';
import type {
  StudioAnnouncementRequest,
  StudioCancelRoundRequest,
  StudioPrepareTurnRequest,
  StudioPreparedTurn,
  StudioResolveDiscussionRequest,
  StudioRoomMetadata,
  StudioRoomMarkdownExportRequest,
  StudioRoomSnapshot,
  StudioSetMutedRequest,
  StudioSetSettingsRequest,
  StudioStartRoundRequest,
} from './studioRuntime';
import type { SaveStudioNoteRequest, StudioNote, StudioNoteStatus } from './studioNotes';
import type { ProjectNotebook, ProjectNotebookTarget, ProjectNotebookUserReplaceRequest } from './projectNotebook';
import type { ConversationDeleteRequest, ConversationDeleteResult } from './conversationLifecycle';
import type { SingleChatConversationSnapshot } from './singleChatMessages';
import type {
  MemoryArchiveBriefing,
  MemoryArchiveChange,
  MemoryArchiveCommentRequest,
  MemoryArchiveCreateRequest,
  MemoryArchiveMutationRequest,
  MemoryArchiveQuery,
  MemoryArchiveQueryResult,
  MemoryArchiveSourceReadRequest,
  MemoryArchiveUpdateRequest,
  MemoryRecord,
  MemorySourceReadResult,
} from './memoryArchive';

export interface AsteriumAppearanceApi {
  setTitlebarTheme: (theme: 'light' | 'dark') => void;
  onRecovery?: (listener: () => void) => () => void;
}

export interface AsteriumAgentsApi {
  getSessionStatus?: (target: import('./sessionCommands').SessionCommandTarget) => Promise<import('./sessionCommands').SessionStatus>;
  executeSessionCommand?: (request: import('./sessionCommands').SessionCommandRequest) => Promise<import('./sessionCommands').SessionCommandResult>;
  compactSession?: (request: import('./sessionCompaction').SessionCompactRequest) => Promise<import('./sessionCompaction').SessionCompactResult>;
  detectClaude: () => Promise<ClaudeDetectionResult>;
  detectCodex?: () => Promise<CodexDetectionResult>;
  listCodexThreads?: (runtimeId: string, workspaceGrantId: string) => Promise<CodexThreadSummary[]>;
  getLocalThreadLifecycles?: (request: LocalThreadLifecycleRequest) => Promise<NativeThreadLifecycleResult[]>;
  changeLocalThreadLifecycle?: (request: ChangeLocalThreadLifecycleRequest) => Promise<NativeThreadLifecycleResult>;
  importClaudeSession?: () => Promise<ClaudeSessionImport | null>;
  selectWorkspace: (purpose?: 'partner_root' | 'workspace' | 'mcp_workspace') => Promise<WorkspaceGrant | null>;
  revokeWorkspaceGrants?: (grantIds: string[]) => Promise<void>;
  syncPartnerWorkspace?: (partnerId: string, cwdGrantId: string | undefined, workspaceGrantIds: string[], expectedVersion?: number) => Promise<PartnerWorkspaceState>;
  getPartnerWorkspace?: (partnerId: string) => Promise<PartnerWorkspaceState>;
  onPartnerWorkspaceChanged?: (listener: (state: PartnerWorkspaceState) => void) => () => void;
  sendClaudeMessage: (partnerId: string, partnerRootGrantId: string | undefined, workspaceGrantIds: string[], command: SendMessageCommand) => Promise<SendMessageReceipt>;
  sendLocalCliMessage?: (adapterType: 'claude_code' | 'codex_cli', partnerId: string, partnerRootGrantId: string | undefined, workspaceGrantIds: string[], command: SendMessageCommand, codexRuntimeId?: string, codexRuntimeEnvironment?: CodexRuntimeInfo['environment']) => Promise<SendMessageReceipt>;
  cancelRun: (command: CancelRunCommand) => Promise<void>;
  sendGuidance?: (command: SendGuidanceCommand) => Promise<SendGuidanceResult>;
  resumeSession: (command: ResumeSessionCommand) => Promise<void>;
  resolveAuthorization?: (command: ResolveAuthorizationCommand) => Promise<void>;
  resolveUserInput?: (command: ResolveUserInputCommand) => Promise<void>;
  apiConnectionsGet?: () => Promise<import('./apiConnections').ApiConfiguration>;
  apiConnectionsProbe?: (modelId: string, tools?: boolean) => Promise<{ text: string; toolCall: boolean }>;
  apiConnectionsCancelProbe?: (modelId: string) => Promise<void>;
  apiConnectionsMutate?: (request: import('./apiConnections').ApiConfigurationMutation) => Promise<import('./apiConnections').ApiConfiguration>;
  saveApiCredential?: (secret: string, credentialRef?: string) => Promise<CredentialStatus>;
  refreshPartnerProfiles?: () => Promise<PartnerProfilesSyncResult>;
  syncPartnerProfiles?: (user: { displayName: string; introduction: string; updatedAt: string; revision?: string }, partners: PartnerProfileSeed[]) => Promise<PartnerProfilesSyncResult>;
  savePartnerProfile?: (profile: PartnerProfileSeed) => Promise<PartnerProfileSnapshot>;
    trashPartnerProfile?: (partnerId: string) => Promise<boolean>;
  saveUserProfile?: (profile: { displayName: string; introduction: string; updatedAt: string; revision?: string }) => Promise<{ displayName: string; introduction: string; updatedAt: string; revision?: string }>;
  openProfileDirectory?: () => Promise<void>;
  onPartnerProfilesChanged?: (listener: (profiles: PartnerProfilesSyncResult) => void) => () => void;
  apiCredentialStatus?: (credentialRef: string) => Promise<CredentialStatus>;
  deleteApiCredential?: (credentialRef: string) => Promise<void>;
  saveWebSearchCredential?: (secret: string) => Promise<{ configured: boolean; masked: string }>;
  webSearchCredentialStatus?: () => Promise<{ configured: boolean; masked: string }>;
  deleteWebSearchCredential?: () => Promise<void>;
  deleteApiSession?: (partnerId: string, conversationId?: string) => Promise<void>;
  sendApiMessage?: (connection: ApiPartnerConnection, command: SendMessageCommand) => Promise<SendMessageReceipt>;
  listApiModels?: (provider: ApiPartnerConnection['provider'], endpoint: string, credentialRef?: string, secret?: string, serviceId?: string) => Promise<ApiModelSummary[]>;
  saveBridgeCredential?: (secret: string) => Promise<CredentialStatus>;
  bridgeCredentialStatus?: (credentialRef: string) => Promise<CredentialStatus>;
  deleteBridgeCredential?: (credentialRef: string) => Promise<void>;
  testExistingThread?: (connection: ExistingThreadConnection) => Promise<ExistingThreadConnectionStatus>;
  watchExistingThread?: (partnerId: string, connection: ExistingThreadConnection) => Promise<ExistingThreadConnectionStatus>;
  stopExistingThreadWatch?: (partnerId: string) => Promise<void>;
  sendExistingThreadMessage?: (connection: ExistingThreadConnection, command: SendMessageCommand) => Promise<SendMessageReceipt>;
  onEvent: (listener: (event: RendererAgentEvent) => void) => () => void;
}

export interface ArtifactInfo {
  id: string;
  name: string;
  extension: string;
  mediaType: string;
  sizeBytes?: number;
  previewKind: 'markdown' | 'text' | 'html' | 'pdf' | 'image' | 'word' | 'sheet' | 'slides' | 'unsupported';
  sourceKind: ArtifactSourceKind;
  registrationMethod: ArtifactRegistrationMethod;
  availability: ArtifactAvailability;
  cached: boolean;
  createdAt: string;
  partnerId?: string;
  conversationId?: string;
}

export interface ArtifactReadResult {
  info: ArtifactInfo;
  text?: string;
  dataUrl?: string;
}

export interface AsteriumArtifactsApi {
  inspect: (artifactId: string) => Promise<ArtifactInfo | null>;
  read: (artifactId: string) => Promise<ArtifactReadResult>;
  open: (artifactId: string) => Promise<void>;
  reveal: (artifactId: string) => Promise<void>;
  copyPath: (artifactId: string) => Promise<void>;
  saveAs: (artifactId: string) => Promise<boolean>;
  exportAs: (artifactId: string) => Promise<boolean>;
  saveToProject: (artifactId: string, projectId: string) => Promise<{ artifactId: string; projectId: string; name: string } & ProjectDeliveryResult>;
  inspectDeletion?: (artifactId: string) => Promise<FileDeletionInspection>;
  delete?: (artifactId: string) => Promise<FileDeletionResult>;
  cacheStats: () => Promise<{ sizeBytes: number; itemCount: number; limitBytes: number }>;
  clearCache: () => Promise<{ sizeBytes: number; itemCount: number; limitBytes: number }>;
}

export interface AsteriumAttachmentsApi {
  choose: (remaining: number) => Promise<PendingMessageAttachment[]>;
  discard: (selectionIds: string[]) => Promise<void>;
  commit: (conversationId: string, selectionIds: string[], messageId: string) => Promise<MessageAttachment[]>;
  list: (conversationId: string) => Promise<ConversationAttachmentInfo[]>;
  inspect: (attachmentId: string, conversationId: string) => Promise<ConversationAttachmentInfo>;
  read: (attachmentId: string, conversationId: string) => Promise<{ info: ConversationAttachmentInfo & { previewKind: 'markdown' | 'text' | 'html' | 'pdf' | 'image' | 'word' | 'sheet' | 'slides' | 'unsupported' }; text?: string; dataUrl?: string }>;
  open: (attachmentId: string, conversationId: string) => Promise<void>;
  reveal: (attachmentId: string, conversationId: string) => Promise<void>;
  copyPath: (attachmentId: string, conversationId: string) => Promise<void>;
  exportAs: (attachmentId: string, conversationId: string) => Promise<boolean>;
  saveToProject: (attachmentId: string, conversationId: string, projectId: string) => Promise<{ artifactId: string; projectId: string; name: string } & ProjectDeliveryResult>;
  thumbnail: (id: string, conversationId?: string) => Promise<string>;
  deleteConversation: (conversationId: string) => Promise<void>;
}

export interface AsteriumProjectsApi {
  listRunChanges?: (projectId: string) => Promise<ProjectRunChange[]>;
  readRunChange?: (request: ProjectRunChangeRead) => Promise<ProjectRunChangeContent>;
  onRunChangesChanged?: (listener: (projectId: string) => void) => () => void;
  browse?: (request: ProjectBrowseRequest) => Promise<ProjectBrowseResult>;
  chooseLocation: () => Promise<ProjectLocationSelection | null>;
  initializeDomain: (request: ProjectDomainInitializeRequest) => Promise<ProjectDomainSnapshot>;
  create: (request: ProjectCreateRequest) => Promise<ProjectCreateResult>;
  update: (request: ProjectUpdateRequest) => Promise<ProjectRecord>;
  createTask: (request: ProjectTaskCreateRequest) => Promise<ProjectTask>;
  updateTask: (request: ProjectTaskUpdateRequest) => Promise<ProjectTask>;
  removeTask: (request: ProjectTaskRemoveRequest) => Promise<void>;
  listRoles: (projectId: string) => Promise<ProjectWorkRoleCatalog>;
  createRole: (request: ProjectWorkRoleCreateRequest) => Promise<ProjectWorkRoleDefinition>;
  updateRole: (request: ProjectWorkRoleUpdateRequest) => Promise<ProjectWorkRoleDefinition>;
  archiveRole: (request: ProjectWorkRoleArchiveRequest) => Promise<ProjectWorkRoleDefinition>;
  removeRole: (request: ProjectWorkRoleRemoveRequest) => Promise<void>;
  onRolesChanged: (listener: (change: ProjectWorkRoleChange) => void) => () => void;
  workflowCatalog: (projectId: string) => Promise<ProjectWorkflowCatalog>;
  listWorkflows: (projectId: string) => Promise<ProjectWorkflow[]>;
  createWorkflow: (request: ProjectWorkflowCreateRequest) => Promise<ProjectWorkflow>;
  updateWorkflow: (request: ProjectWorkflowUpdateRequest) => Promise<ProjectWorkflow>;
  removeWorkflow: (request: ProjectWorkflowRemoveRequest) => Promise<void>;
  activateWorkflow: (request: ProjectWorkflowActivateRequest) => Promise<ProjectWorkflowActivationResult>;
  saveWorkflowTemplate?: (request: ProjectWorkflowTemplateSaveRequest) => Promise<ProjectWorkflowTemplate>;
  updateWorkflowTemplate?: (request: ProjectWorkflowTemplateUpdateRequest) => Promise<ProjectWorkflowTemplate>;
  removeWorkflowTemplate?: (request: ProjectWorkflowTemplateRemoveRequest) => Promise<void>;
  onWorkflowsChanged: (listener: (change: ProjectWorkflowChange) => void) => () => void;
  listWorkflowGenerations?: (projectId: string) => Promise<ProjectWorkflowGeneration[]>;
  startWorkflowGeneration?: (request: ProjectWorkflowGenerationStartRequest) => Promise<ProjectWorkflowGeneration>;
  cancelWorkflowGeneration?: (request: ProjectWorkflowGenerationCancelRequest) => Promise<ProjectWorkflowGeneration>;
  retryWorkflowGeneration?: (request: ProjectWorkflowGenerationRetryRequest) => Promise<ProjectWorkflowGeneration>;
  onWorkflowGenerationChanged?: (listener: (change: ProjectWorkflowGenerationChange) => void) => () => void;
  onDomainChanged: (listener: (change: ProjectDomainChange) => void) => () => void;
  getTaskExecution: (projectId?: string) => Promise<ProjectTaskExecutionSnapshot>;
  enqueueTaskAttempt: (request: TaskAttemptRequest) => Promise<TaskAttempt>;
  pauseTaskAttempt: (request: TaskAttemptControlRequest) => Promise<TaskAttempt>;
  resumeTaskAttempt: (request: TaskAttemptControlRequest) => Promise<TaskAttempt>;
  cancelTaskAttempt: (request: TaskAttemptControlRequest) => Promise<TaskAttempt>;
  retryTaskAttempt: (request: TaskAttemptControlRequest) => Promise<TaskAttempt>;
  resolveTaskGate: (request: TaskGateResolutionRequest) => Promise<TaskAttempt>;
  onTaskExecutionChanged: (listener: (change: ProjectTaskExecutionChange) => void) => () => void;
  createWorkspace: (request: ProjectWorkspaceCreateRequest) => Promise<ProjectWorkspaceSnapshot>;
  get: (projectId: string) => Promise<ProjectWorkspaceSnapshot | null>;
  open: (projectId: string) => Promise<void>;
  openFile: (projectId: string, fileId: string) => Promise<void>;
  listFiles: (projectId: string) => Promise<ProjectWorkspaceFileEntry[]>;
  inspectFileDeletion?: (projectId: string, fileId: string) => Promise<FileDeletionInspection>;
  deleteFile?: (projectId: string, fileId: string) => Promise<FileDeletionResult>;
  onFilesChanged: (listener: (snapshot: ProjectFilesSnapshot) => void) => () => void;
  getExecutionPolicy: (projectId: string) => Promise<ProjectExecutionPolicy>;
  setExecutionPolicy: (request: ProjectExecutionPolicyUpdateRequest) => Promise<ProjectExecutionPolicy>;
  onExecutionPolicyChanged: (listener: (policy: ProjectExecutionPolicy) => void) => () => void;
  syncMembers: (projects: Array<{ projectId: string; partnerIds: string[] }>) => Promise<PartnerWorkspaceState[]>;
  changeMembers: (request: ProjectMembershipChangeRequest) => Promise<ProjectMembershipChangeResult>;
  remove: (projectId: string, roomIds: string[]) => Promise<void>;
}

export interface AsteriumStudioApi {
  syncRoom: (room: StudioRoomMetadata) => Promise<StudioRoomSnapshot>;
  getRoom: (roomId: string) => Promise<StudioRoomSnapshot | undefined>;
  exportMarkdown?: (request: StudioRoomMarkdownExportRequest) => Promise<boolean>;
  removeRoom: (roomId: string) => Promise<void>;
  setMuted: (request: StudioSetMutedRequest) => Promise<StudioRoomSnapshot>;
  setSettings: (request: StudioSetSettingsRequest) => Promise<StudioRoomSnapshot>;
  resolveDiscussion: (request: StudioResolveDiscussionRequest) => Promise<StudioRoomSnapshot>;
  cancelRound: (request: StudioCancelRoundRequest) => Promise<StudioRoomSnapshot>;
  startRound: (request: StudioStartRoundRequest) => Promise<StudioRoomSnapshot>;
  prepareTurn: (request: StudioPrepareTurnRequest) => Promise<StudioPreparedTurn>;
  failTurn: (request: { roomId: string; roundId: string; partnerId: string }) => Promise<StudioRoomSnapshot>;
  announce: (request: StudioAnnouncementRequest) => Promise<StudioRoomSnapshot>;
  onRoomChanged: (listener: (snapshot: StudioRoomSnapshot) => void) => () => void;
}

export interface AsteriumStudioNotesApi {
  list: (projectId?: string) => Promise<StudioNote[]>;
  save: (request: SaveStudioNoteRequest) => Promise<StudioNote>;
  setStatus: (id: string, status: StudioNoteStatus) => Promise<StudioNote>;
  delete: (id: string) => Promise<void>;
}

export interface AsteriumProjectNotebooksApi {
  get: (target: ProjectNotebookTarget) => Promise<ProjectNotebook | undefined>;
  replace: (request: ProjectNotebookUserReplaceRequest) => Promise<ProjectNotebook>;
  listArchived: () => Promise<ProjectNotebook[]>;
  exportMarkdown: (target: ProjectNotebookTarget) => Promise<boolean>;
  purge: (target: ProjectNotebookTarget) => Promise<ProjectNotebook>;
}

export interface AsteriumMemoryApi {
  query: (request: MemoryArchiveQuery) => Promise<MemoryArchiveQueryResult>;
  briefing: (partnerId: string) => Promise<MemoryArchiveBriefing>;
  create: (request: MemoryArchiveCreateRequest) => Promise<MemoryRecord>;
  update: (request: MemoryArchiveUpdateRequest) => Promise<MemoryRecord>;
  comment: (request: MemoryArchiveCommentRequest) => Promise<MemoryRecord>;
  softDelete: (request: MemoryArchiveMutationRequest) => Promise<MemoryRecord>;
  restore: (request: MemoryArchiveMutationRequest) => Promise<MemoryRecord>;
  purge: (request: MemoryArchiveMutationRequest) => Promise<MemoryRecord>;
  readSource: (request: MemoryArchiveSourceReadRequest) => Promise<Array<{ index: number; result: MemorySourceReadResult }>>;
  onChanged: (listener: (change: MemoryArchiveChange) => void) => () => void;
}

export interface AsteriumNativeBindingsApi {
  syncSingle: (bindings: Array<{ partnerId: string; source: 'local_cli' | 'api_partner'; conversationId: string; nativeThreadId: string }>) => Promise<void>;
}

export interface AsteriumConversationsApi {
  delete: (request: ConversationDeleteRequest) => Promise<ConversationDeleteResult>;
  listDeleted: () => Promise<string[]>;
  syncMessages?: (snapshots: SingleChatConversationSnapshot[]) => Promise<void>;
}

export interface DesktopBridge {
  asteriumEnvironment?: import('./runtimeEnvironment').AsteriumEnvironmentApi;
  asteriumUpdates?: import('./appUpdates').AsteriumUpdatesApi;
  asteriumDesktopNavigation?: import('./desktopNotifications').AsteriumDesktopNavigationApi;
  asteriumGeneralSettings?: import('./generalSettings').AsteriumGeneralSettingsApi;
  asteriumAutomations?: import('./automations').AsteriumAutomationsApi;
  asteriumStudioMcp?: import('./studioMcp').AsteriumStudioMcpApi;
  asteriumStudioWake?: import('./studioWakeControl').AsteriumStudioWakeApi;
  asteriumExtensions?: import('./apiExtensions').AsteriumExtensionsApi;
  asteriumPartnerDiary?: import('./partnerDiary').AsteriumPartnerDiaryApi;
  asteriumMemoryFallback?: import('./memoryFallback').AsteriumMemoryFallbackApi;
  asteriumAppearance?: AsteriumAppearanceApi;
  asteriumAgents?: AsteriumAgentsApi;
  asteriumArtifacts?: AsteriumArtifactsApi;
  asteriumAttachments?: AsteriumAttachmentsApi;
  asteriumProjects?: AsteriumProjectsApi;
  asteriumStudio?: AsteriumStudioApi;
  asteriumStudioNotes?: AsteriumStudioNotesApi;
  asteriumProjectNotebooks?: AsteriumProjectNotebooksApi;
  asteriumMemory?: AsteriumMemoryApi;
  asteriumNativeBindings?: AsteriumNativeBindingsApi;
  asteriumConversations?: AsteriumConversationsApi;
}
