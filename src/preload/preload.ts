import { contextBridge, ipcRenderer } from 'electron';
import type { ApiModelSummary, ApiPartnerConnection, CancelRunCommand, ChangeLocalThreadLifecycleRequest, ClaudeDetectionResult, ClaudeSessionImport, CodexDetectionResult, CodexRuntimeInfo, CodexThreadSummary, ConversationAttachmentInfo, CredentialStatus, ExistingThreadConnection, ExistingThreadConnectionStatus, LocalThreadLifecycleRequest, MessageAttachment, NativeThreadLifecycleResult, PartnerProfileSeed, PartnerProfileSnapshot, PartnerProfilesSyncResult, PartnerWorkspaceState, PendingMessageAttachment, RendererAgentEvent, ResolveAuthorizationCommand, ResolveUserInputCommand, ResumeSessionCommand, SendGuidanceCommand, SendGuidanceResult, SendMessageCommand, SendMessageReceipt, WorkspaceGrant } from '../shared/agentProtocol';
import type { StudioAnnouncementRequest, StudioCancelRoundRequest, StudioPrepareTurnRequest, StudioPreparedTurn, StudioResolveDiscussionRequest, StudioRoomMarkdownExportRequest, StudioRoomMetadata, StudioRoomSnapshot, StudioSetMutedRequest, StudioSetSettingsRequest, StudioStartRoundRequest } from '../shared/studioRuntime';
import type { SaveStudioNoteRequest, StudioNote, StudioNoteStatus } from '../shared/studioNotes';
import type { ProjectNotebook, ProjectNotebookTarget, ProjectNotebookUserReplaceRequest } from '../shared/projectNotebook';
import type { ConversationDeleteRequest, ConversationDeleteResult } from '../shared/conversationLifecycle';
import type { SingleChatConversationSnapshot } from '../shared/singleChatMessages';
import type { MemoryArchiveChange, MemoryArchiveCommentRequest, MemoryArchiveCreateRequest, MemoryArchiveMutationRequest, MemoryArchiveQuery, MemoryArchiveSourceReadRequest, MemoryArchiveUpdateRequest } from '../shared/memoryArchive';
import type { AsteriumAgentsApi, AsteriumAppearanceApi, AsteriumArtifactsApi, AsteriumAttachmentsApi, AsteriumConversationsApi, AsteriumMemoryApi, AsteriumNativeBindingsApi, AsteriumProjectsApi, AsteriumStudioApi, AsteriumStudioNotesApi } from '../shared/desktopBridge';
import { DESKTOP_IPC as AGENT_IPC } from '../shared/desktopIpc';

contextBridge.exposeInMainWorld('asteriumDesktopNavigation', {
  take: () => ipcRenderer.invoke(AGENT_IPC.desktopNavigationTake),
  onReady: listener => { const handler = () => listener(); ipcRenderer.on(AGENT_IPC.desktopNavigationReady, handler); return () => { ipcRenderer.removeListener(AGENT_IPC.desktopNavigationReady, handler); }; },
} satisfies import('../shared/desktopNotifications').AsteriumDesktopNavigationApi);

contextBridge.exposeInMainWorld('asteriumGeneralSettings', {
  get: () => ipcRenderer.invoke(AGENT_IPC.generalSettingsGet),
  update: patch => ipcRenderer.invoke(AGENT_IPC.generalSettingsUpdate, patch),
  onChanged: listener => { const handler = (_event: Electron.IpcRendererEvent, snapshot: import('../shared/generalSettings').GeneralSettingsSnapshot) => listener(snapshot); ipcRenderer.on(AGENT_IPC.generalSettingsChanged, handler); return () => { ipcRenderer.removeListener(AGENT_IPC.generalSettingsChanged, handler); }; },
} satisfies import('../shared/generalSettings').AsteriumGeneralSettingsApi);

contextBridge.exposeInMainWorld('asteriumStudioWake', {
  status: () => ipcRenderer.invoke(AGENT_IPC.studioWakeStatus),
  configure: (binding) => ipcRenderer.invoke(AGENT_IPC.studioWakeConfigure, binding),
  control: (partnerId, action, triggerId) => ipcRenderer.invoke(AGENT_IPC.studioWakeControl, { partnerId, action, triggerId }),
} satisfies import('../shared/studioWakeControl').AsteriumStudioWakeApi);

contextBridge.exposeInMainWorld('asteriumStudioMcp', {
  status: () => ipcRenderer.invoke(AGENT_IPC.studioMcpStatus),
  configure: (configuration) => ipcRenderer.invoke(AGENT_IPC.studioMcpConfigure, configuration),
  issueCredential: (partnerId) => ipcRenderer.invoke(AGENT_IPC.studioMcpIssueCredential, partnerId),
  revokeCredential: (credentialId) => ipcRenderer.invoke(AGENT_IPC.studioMcpRevokeCredential, credentialId),
} satisfies import('../shared/studioMcp').AsteriumStudioMcpApi);

contextBridge.exposeInMainWorld('asteriumExtensions', {
  get: () => ipcRenderer.invoke(AGENT_IPC.extensionsGet),
  upsert: (input) => ipcRenderer.invoke(AGENT_IPC.extensionsUpsert, input),
  remove: (input) => ipcRenderer.invoke(AGENT_IPC.extensionsRemove, input),
  setBinding: (input) => ipcRenderer.invoke(AGENT_IPC.extensionsSetBinding, input),
  setTrust: (input) => ipcRenderer.invoke(AGENT_IPC.extensionsSetTrust, input),
  connectMcp: (input) => ipcRenderer.invoke(AGENT_IPC.extensionsConnectMcp, input),
  disconnectMcp: (input) => ipcRenderer.invoke(AGENT_IPC.extensionsDisconnectMcp, input),
  mcpStatus: () => ipcRenderer.invoke(AGENT_IPC.extensionsMcpStatus),
} satisfies import('../shared/apiExtensions').AsteriumExtensionsApi);

contextBridge.exposeInMainWorld('asteriumAutomations', {
  confirmations: () => ipcRenderer.invoke(AGENT_IPC.automationsConfirmationsGet),
  resolveConfirmation: reply => ipcRenderer.invoke(AGENT_IPC.automationsConfirmationsResolve, reply),
  onConfirmationsChanged(listener) { const handler = () => listener(); ipcRenderer.on(AGENT_IPC.automationsConfirmationsChanged, handler); return () => ipcRenderer.removeListener(AGENT_IPC.automationsConfirmationsChanged, handler); },
  onEvent(listener) { const handler = (_event: unknown, payload: { run: import('../shared/automations').AutomationRun; event: import('../shared/agentProtocol').PartnerEvent }) => listener(payload); ipcRenderer.on(AGENT_IPC.automationsEvent, handler); return () => ipcRenderer.removeListener(AGENT_IPC.automationsEvent, handler); },
  get: () => ipcRenderer.invoke(AGENT_IPC.automationsGet),
  mutate: request => ipcRenderer.invoke(AGENT_IPC.automationsMutate, request),
  onChanged(listener) { const handler = () => listener(); ipcRenderer.on(AGENT_IPC.automationsChanged, handler); return () => ipcRenderer.removeListener(AGENT_IPC.automationsChanged, handler); },
} satisfies import('../shared/automations').AsteriumAutomationsApi);

contextBridge.exposeInMainWorld('asteriumAppearance', {
  onRecovery(listener) {
    const handler = () => listener();
    ipcRenderer.on(AGENT_IPC.appearanceRecovery, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.appearanceRecovery, handler);
  },
  setTitlebarTheme(theme: 'light' | 'dark') {
    if (theme === 'light' || theme === 'dark') {
      ipcRenderer.send(AGENT_IPC.titlebarTheme, theme);
    }
  },
} satisfies AsteriumAppearanceApi);

contextBridge.exposeInMainWorld('asteriumAgents', {
  refreshPartnerProfiles: () => ipcRenderer.invoke(AGENT_IPC.refreshPartnerProfiles),
  compactSession: (request: import('../shared/sessionCompaction').SessionCompactRequest) => ipcRenderer.invoke(AGENT_IPC.compactSession, request),
  getSessionStatus: (target: import('../shared/sessionCommands').SessionCommandTarget) => ipcRenderer.invoke(AGENT_IPC.getSessionStatus, target),
  executeSessionCommand: (request: import('../shared/sessionCommands').SessionCommandRequest) => ipcRenderer.invoke(AGENT_IPC.executeSessionCommand, request),
  detectClaude: (): Promise<ClaudeDetectionResult> => ipcRenderer.invoke(AGENT_IPC.detectClaude),
  detectCodex: (): Promise<CodexDetectionResult> => ipcRenderer.invoke(AGENT_IPC.detectCodex),
  listCodexThreads: (runtimeId: string, workspaceGrantId: string): Promise<CodexThreadSummary[]> => ipcRenderer.invoke(AGENT_IPC.listCodexThreads, { runtimeId, workspaceGrantId }),
  getLocalThreadLifecycles: (request: LocalThreadLifecycleRequest): Promise<NativeThreadLifecycleResult[]> => ipcRenderer.invoke(AGENT_IPC.getLocalThreadLifecycles, request),
  changeLocalThreadLifecycle: (request: ChangeLocalThreadLifecycleRequest): Promise<NativeThreadLifecycleResult> => ipcRenderer.invoke(AGENT_IPC.changeLocalThreadLifecycle, request),
  importClaudeSession: (): Promise<ClaudeSessionImport | null> => ipcRenderer.invoke(AGENT_IPC.importClaudeSession),
  selectWorkspace: (purpose?: 'partner_root' | 'workspace' | 'mcp_workspace'): Promise<WorkspaceGrant | null> => ipcRenderer.invoke(AGENT_IPC.selectWorkspace, purpose),
  revokeWorkspaceGrants: (grantIds: string[]): Promise<void> => ipcRenderer.invoke(AGENT_IPC.revokeWorkspaceGrants, grantIds),
  syncPartnerWorkspace: (partnerId: string, cwdGrantId: string | undefined, workspaceGrantIds: string[], expectedVersion?: number): Promise<PartnerWorkspaceState> => ipcRenderer.invoke(AGENT_IPC.syncPartnerWorkspace, { partnerId, cwdGrantId, workspaceGrantIds, expectedVersion }),
  getPartnerWorkspace: (partnerId: string): Promise<PartnerWorkspaceState> => ipcRenderer.invoke(AGENT_IPC.getPartnerWorkspace, partnerId),
  sendClaudeMessage: (partnerId: string, partnerRootGrantId: string | undefined, workspaceGrantIds: string[], command: SendMessageCommand): Promise<SendMessageReceipt> => ipcRenderer.invoke(AGENT_IPC.sendMessage, { adapterType: 'claude_code', partnerId, partnerRootGrantId, workspaceGrantIds, command }),
  sendLocalCliMessage: (adapterType: 'claude_code' | 'codex_cli', partnerId: string, partnerRootGrantId: string | undefined, workspaceGrantIds: string[], command: SendMessageCommand, codexRuntimeId?: string, codexRuntimeEnvironment?: CodexRuntimeInfo['environment']): Promise<SendMessageReceipt> => ipcRenderer.invoke(AGENT_IPC.sendMessage, { adapterType, partnerId, partnerRootGrantId, codexRuntimeId, codexRuntimeEnvironment, workspaceGrantIds, command }),
  cancelRun: (command: CancelRunCommand): Promise<void> => ipcRenderer.invoke(AGENT_IPC.cancelRun, command),
  sendGuidance: (command: SendGuidanceCommand): Promise<SendGuidanceResult> => ipcRenderer.invoke(AGENT_IPC.sendGuidance, command),
  resumeSession: (command: ResumeSessionCommand): Promise<void> => ipcRenderer.invoke(AGENT_IPC.resumeSession, command),
  resolveAuthorization: (command: ResolveAuthorizationCommand): Promise<void> => ipcRenderer.invoke(AGENT_IPC.resolveAuthorization, command),
  resolveUserInput: (command: ResolveUserInputCommand): Promise<void> => ipcRenderer.invoke(AGENT_IPC.resolveUserInput, command),
  saveApiCredential: (secret: string, credentialRef?: string): Promise<CredentialStatus> => ipcRenderer.invoke(AGENT_IPC.saveApiCredential, { secret, credentialRef }),
  syncPartnerProfiles: (user: { displayName: string; introduction: string; updatedAt: string }, partners: PartnerProfileSeed[]): Promise<PartnerProfilesSyncResult> => ipcRenderer.invoke(AGENT_IPC.syncPartnerProfiles, { user, partners }),
  savePartnerProfile: (profile: PartnerProfileSeed): Promise<PartnerProfileSnapshot> => ipcRenderer.invoke(AGENT_IPC.savePartnerProfile, profile),
  trashPartnerProfile: (partnerId: string): Promise<boolean> => ipcRenderer.invoke(AGENT_IPC.trashPartnerProfile, { partnerId }),
  saveUserProfile: (profile: { displayName: string; introduction: string; updatedAt: string }): Promise<{ displayName: string; introduction: string; updatedAt: string }> => ipcRenderer.invoke(AGENT_IPC.saveUserProfile, profile),
  openProfileDirectory: (): Promise<void> => ipcRenderer.invoke(AGENT_IPC.openProfileDirectory),
  apiCredentialStatus: (credentialRef: string): Promise<CredentialStatus> => ipcRenderer.invoke(AGENT_IPC.apiCredentialStatus, { credentialRef }),
  deleteApiCredential: (credentialRef: string): Promise<void> => ipcRenderer.invoke(AGENT_IPC.deleteApiCredential, { credentialRef }),
  saveWebSearchCredential: (secret: string): Promise<{ configured: boolean; masked: string }> => ipcRenderer.invoke(AGENT_IPC.saveWebSearchCredential, { secret }),
  webSearchCredentialStatus: (): Promise<{ configured: boolean; masked: string }> => ipcRenderer.invoke(AGENT_IPC.webSearchCredentialStatus),
  deleteWebSearchCredential: (): Promise<void> => ipcRenderer.invoke(AGENT_IPC.deleteWebSearchCredential),
  deleteApiSession: (partnerId: string, conversationId?: string): Promise<void> => ipcRenderer.invoke(AGENT_IPC.deleteApiSession, { partnerId, conversationId }),
  sendApiMessage: (connection: ApiPartnerConnection, command: SendMessageCommand): Promise<SendMessageReceipt> => ipcRenderer.invoke(AGENT_IPC.sendApiMessage, { connection, command }),
  apiConnectionsGet: () => ipcRenderer.invoke(AGENT_IPC.apiConnectionsGet),
  apiConnectionsProbe: (modelId, tools) => ipcRenderer.invoke(AGENT_IPC.apiConnectionsProbe, { modelId, tools }),
  apiConnectionsCancelProbe: (modelId) => ipcRenderer.invoke(AGENT_IPC.apiConnectionsProbe, { modelId, cancel: true }),
  apiConnectionsMutate: (request) => ipcRenderer.invoke(AGENT_IPC.apiConnectionsMutate, request),
  listApiModels: (provider: ApiPartnerConnection['provider'], endpoint: string, credentialRef?: string, secret?: string, serviceId?: string): Promise<ApiModelSummary[]> => ipcRenderer.invoke(AGENT_IPC.listApiModels, { provider, endpoint, credentialRef, secret, serviceId }),
  saveBridgeCredential: (secret: string): Promise<CredentialStatus> => ipcRenderer.invoke(AGENT_IPC.saveBridgeCredential, { secret }),
  bridgeCredentialStatus: (credentialRef: string): Promise<CredentialStatus> => ipcRenderer.invoke(AGENT_IPC.bridgeCredentialStatus, { credentialRef }),
  deleteBridgeCredential: (credentialRef: string): Promise<void> => ipcRenderer.invoke(AGENT_IPC.deleteBridgeCredential, { credentialRef }),
  testExistingThread: (connection: ExistingThreadConnection): Promise<ExistingThreadConnectionStatus> => ipcRenderer.invoke(AGENT_IPC.testExistingThread, connection),
  watchExistingThread: (partnerId: string, connection: ExistingThreadConnection): Promise<ExistingThreadConnectionStatus> => ipcRenderer.invoke(AGENT_IPC.watchExistingThread, { partnerId, connection }),
  stopExistingThreadWatch: (partnerId: string): Promise<void> => ipcRenderer.invoke(AGENT_IPC.stopExistingThreadWatch, { partnerId }),
  sendExistingThreadMessage: (connection: ExistingThreadConnection, command: SendMessageCommand): Promise<SendMessageReceipt> => ipcRenderer.invoke(AGENT_IPC.sendExistingThreadMessage, { connection, command }),
  onEvent: (listener: (event: RendererAgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: RendererAgentEvent) => listener(value);
    ipcRenderer.on(AGENT_IPC.event, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.event, handler);
  },
  onPartnerWorkspaceChanged: (listener: (state: PartnerWorkspaceState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: PartnerWorkspaceState) => listener(value);
    ipcRenderer.on(AGENT_IPC.partnerWorkspaceChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.partnerWorkspaceChanged, handler);
  },
  onPartnerProfilesChanged: (listener: (profiles: PartnerProfilesSyncResult) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: PartnerProfilesSyncResult) => listener(value);
    ipcRenderer.on(AGENT_IPC.partnerProfilesChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.partnerProfilesChanged, handler);
  },
} satisfies AsteriumAgentsApi);

contextBridge.exposeInMainWorld('asteriumArtifacts', {
  inspect: (artifactId: string) => ipcRenderer.invoke(AGENT_IPC.artifactInspect, artifactId),
  read: (artifactId: string) => ipcRenderer.invoke(AGENT_IPC.artifactRead, artifactId),
  open: (artifactId: string) => ipcRenderer.invoke(AGENT_IPC.artifactOpen, artifactId),
  reveal: (artifactId: string) => ipcRenderer.invoke(AGENT_IPC.artifactReveal, artifactId),
  copyPath: (artifactId: string) => ipcRenderer.invoke(AGENT_IPC.artifactCopyPath, artifactId),
  saveAs: (artifactId: string) => ipcRenderer.invoke(AGENT_IPC.artifactSaveAs, artifactId),
  exportAs: (artifactId: string) => ipcRenderer.invoke(AGENT_IPC.artifactSaveAs, artifactId),
  saveToProject: (artifactId: string, projectId: string) => ipcRenderer.invoke(AGENT_IPC.artifactSaveToProject, { artifactId, projectId }),
  inspectDeletion: (artifactId: string) => ipcRenderer.invoke(AGENT_IPC.artifactInspectDeletion, artifactId),
  delete: (artifactId: string) => ipcRenderer.invoke(AGENT_IPC.artifactDelete, artifactId),
  cacheStats: () => ipcRenderer.invoke(AGENT_IPC.artifactCacheStats),
  clearCache: () => ipcRenderer.invoke(AGENT_IPC.artifactClearCache),
} satisfies AsteriumArtifactsApi);

contextBridge.exposeInMainWorld('asteriumAttachments', {
  choose: (remaining: number): Promise<PendingMessageAttachment[]> => ipcRenderer.invoke(AGENT_IPC.attachmentChoose, { remaining }),
  discard: (selectionIds: string[]): Promise<void> => ipcRenderer.invoke(AGENT_IPC.attachmentDiscard, selectionIds),
  commit: (conversationId: string, selectionIds: string[], messageId: string): Promise<MessageAttachment[]> => ipcRenderer.invoke(AGENT_IPC.attachmentCommit, { conversationId, selectionIds, messageId }),
  list: (conversationId: string): Promise<ConversationAttachmentInfo[]> => ipcRenderer.invoke(AGENT_IPC.attachmentList, conversationId),
  inspect: (attachmentId: string, conversationId: string): Promise<ConversationAttachmentInfo> => ipcRenderer.invoke(AGENT_IPC.attachmentInspect, { attachmentId, conversationId }),
  read: (attachmentId: string, conversationId: string) => ipcRenderer.invoke(AGENT_IPC.attachmentRead, { attachmentId, conversationId }),
  open: (attachmentId: string, conversationId: string): Promise<void> => ipcRenderer.invoke(AGENT_IPC.attachmentOpen, { attachmentId, conversationId }),
  reveal: (attachmentId: string, conversationId: string): Promise<void> => ipcRenderer.invoke(AGENT_IPC.attachmentReveal, { attachmentId, conversationId }),
  copyPath: (attachmentId: string, conversationId: string): Promise<void> => ipcRenderer.invoke(AGENT_IPC.attachmentCopyPath, { attachmentId, conversationId }),
  exportAs: (attachmentId: string, conversationId: string): Promise<boolean> => ipcRenderer.invoke(AGENT_IPC.attachmentExportAs, { attachmentId, conversationId }),
  saveToProject: (attachmentId: string, conversationId: string, projectId: string) => ipcRenderer.invoke(AGENT_IPC.attachmentSaveToProject, { attachmentId, conversationId, projectId }),
  thumbnail: (id: string, conversationId?: string): Promise<string> => ipcRenderer.invoke(AGENT_IPC.attachmentThumbnail, { id, conversationId }),
  deleteConversation: (conversationId: string): Promise<void> => ipcRenderer.invoke(AGENT_IPC.attachmentDeleteConversation, conversationId),
} satisfies AsteriumAttachmentsApi);

contextBridge.exposeInMainWorld('asteriumConversations', {
  delete: (request: ConversationDeleteRequest): Promise<ConversationDeleteResult> => ipcRenderer.invoke(AGENT_IPC.conversationDelete, request),
  listDeleted: (): Promise<string[]> => ipcRenderer.invoke(AGENT_IPC.conversationListDeleted),
  syncMessages: (snapshots: SingleChatConversationSnapshot[]): Promise<void> => ipcRenderer.invoke(AGENT_IPC.conversationSyncMessages, snapshots),
} satisfies AsteriumConversationsApi);

contextBridge.exposeInMainWorld('asteriumProjects', {
  chooseLocation: () => ipcRenderer.invoke(AGENT_IPC.projectChooseLocation),
  initializeDomain: (request: import('../shared/projectDomain').ProjectDomainInitializeRequest) => ipcRenderer.invoke(AGENT_IPC.projectDomainInitialize, request),
  create: (request: import('../shared/projectDomain').ProjectCreateRequest) => ipcRenderer.invoke(AGENT_IPC.projectCreate, request),
  update: (request: import('../shared/projectDomain').ProjectUpdateRequest) => ipcRenderer.invoke(AGENT_IPC.projectUpdate, request),
  createTask: (request: import('../shared/projectDomain').ProjectTaskCreateRequest) => ipcRenderer.invoke(AGENT_IPC.projectTaskCreate, request),
  updateTask: (request: import('../shared/projectDomain').ProjectTaskUpdateRequest) => ipcRenderer.invoke(AGENT_IPC.projectTaskUpdate, request),
  removeTask: (request: import('../shared/projectDomain').ProjectTaskRemoveRequest): Promise<void> => ipcRenderer.invoke(AGENT_IPC.projectTaskRemove, request),
  listRoles: (projectId: string) => ipcRenderer.invoke(AGENT_IPC.projectRoleList, projectId),
  createRole: (request: import('../shared/projectRoles').ProjectWorkRoleCreateRequest) => ipcRenderer.invoke(AGENT_IPC.projectRoleCreate, request),
  updateRole: (request: import('../shared/projectRoles').ProjectWorkRoleUpdateRequest) => ipcRenderer.invoke(AGENT_IPC.projectRoleUpdate, request),
  archiveRole: (request: import('../shared/projectRoles').ProjectWorkRoleArchiveRequest) => ipcRenderer.invoke(AGENT_IPC.projectRoleArchive, request),
  removeRole: (request: import('../shared/projectRoles').ProjectWorkRoleRemoveRequest): Promise<void> => ipcRenderer.invoke(AGENT_IPC.projectRoleRemove, request),
  onRolesChanged: (listener: (change: import('../shared/projectRoles').ProjectWorkRoleChange) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: import('../shared/projectRoles').ProjectWorkRoleChange) => listener(value);
    ipcRenderer.on(AGENT_IPC.projectRolesChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.projectRolesChanged, handler);
  },
  workflowCatalog: (projectId: string) => ipcRenderer.invoke(AGENT_IPC.projectWorkflowCatalog, projectId),
  listWorkflows: (projectId: string) => ipcRenderer.invoke(AGENT_IPC.projectWorkflowList, projectId),
  createWorkflow: (request: import('../shared/projectWorkflows').ProjectWorkflowCreateRequest) => ipcRenderer.invoke(AGENT_IPC.projectWorkflowCreate, request),
  updateWorkflow: (request: import('../shared/projectWorkflows').ProjectWorkflowUpdateRequest) => ipcRenderer.invoke(AGENT_IPC.projectWorkflowUpdate, request),
  removeWorkflow: (request: import('../shared/projectWorkflows').ProjectWorkflowRemoveRequest): Promise<void> => ipcRenderer.invoke(AGENT_IPC.projectWorkflowRemove, request),
  activateWorkflow: (request: import('../shared/projectWorkflows').ProjectWorkflowActivateRequest) => ipcRenderer.invoke(AGENT_IPC.projectWorkflowActivate, request),
  saveWorkflowTemplate: (request: import('../shared/projectWorkflows').ProjectWorkflowTemplateSaveRequest) => ipcRenderer.invoke(AGENT_IPC.projectWorkflowTemplateSave, request),
  updateWorkflowTemplate: (request: import('../shared/projectWorkflows').ProjectWorkflowTemplateUpdateRequest) => ipcRenderer.invoke(AGENT_IPC.projectWorkflowTemplateUpdate, request),
  removeWorkflowTemplate: (request: import('../shared/projectWorkflows').ProjectWorkflowTemplateRemoveRequest): Promise<void> => ipcRenderer.invoke(AGENT_IPC.projectWorkflowTemplateRemove, request),
  onWorkflowsChanged: (listener: (change: import('../shared/projectWorkflows').ProjectWorkflowChange) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: import('../shared/projectWorkflows').ProjectWorkflowChange) => listener(value);
    ipcRenderer.on(AGENT_IPC.projectWorkflowsChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.projectWorkflowsChanged, handler);
  },
  listWorkflowGenerations: (projectId: string) => ipcRenderer.invoke(AGENT_IPC.projectWorkflowGenerationList, projectId),
  startWorkflowGeneration: (request: import('../shared/projectWorkflowGeneration').ProjectWorkflowGenerationStartRequest) => ipcRenderer.invoke(AGENT_IPC.projectWorkflowGenerationStart, request),
  cancelWorkflowGeneration: (request: import('../shared/projectWorkflowGeneration').ProjectWorkflowGenerationCancelRequest) => ipcRenderer.invoke(AGENT_IPC.projectWorkflowGenerationCancel, request),
  retryWorkflowGeneration: (request: import('../shared/projectWorkflowGeneration').ProjectWorkflowGenerationRetryRequest) => ipcRenderer.invoke(AGENT_IPC.projectWorkflowGenerationRetry, request),
  onWorkflowGenerationChanged: (listener: (change: import('../shared/projectWorkflowGeneration').ProjectWorkflowGenerationChange) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, change: import('../shared/projectWorkflowGeneration').ProjectWorkflowGenerationChange) => listener(change);
    ipcRenderer.on(AGENT_IPC.projectWorkflowGenerationChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.projectWorkflowGenerationChanged, handler);
  },
  onDomainChanged: (listener: (change: import('../shared/projectDomain').ProjectDomainChange) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: import('../shared/projectDomain').ProjectDomainChange) => listener(value);
    ipcRenderer.on(AGENT_IPC.projectDomainChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.projectDomainChanged, handler);
  },
  getTaskExecution: (projectId?: string) => ipcRenderer.invoke(AGENT_IPC.projectTaskExecutionGet, projectId),
  enqueueTaskAttempt: (request: import('../shared/projectTaskExecution').TaskAttemptRequest) => ipcRenderer.invoke(AGENT_IPC.projectTaskExecutionEnqueue, request),
  pauseTaskAttempt: (request: import('../shared/projectTaskExecution').TaskAttemptControlRequest) => ipcRenderer.invoke(AGENT_IPC.projectTaskExecutionPause, request),
  resumeTaskAttempt: (request: import('../shared/projectTaskExecution').TaskAttemptControlRequest) => ipcRenderer.invoke(AGENT_IPC.projectTaskExecutionResume, request),
  cancelTaskAttempt: (request: import('../shared/projectTaskExecution').TaskAttemptControlRequest) => ipcRenderer.invoke(AGENT_IPC.projectTaskExecutionCancel, request),
  retryTaskAttempt: (request: import('../shared/projectTaskExecution').TaskAttemptControlRequest) => ipcRenderer.invoke(AGENT_IPC.projectTaskExecutionRetry, request),
  resolveTaskGate: (request: import('../shared/projectTaskExecution').TaskGateResolutionRequest) => ipcRenderer.invoke(AGENT_IPC.projectTaskExecutionResolve, request),
  onTaskExecutionChanged: (listener: (change: import('../shared/projectTaskExecution').ProjectTaskExecutionChange) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: import('../shared/projectTaskExecution').ProjectTaskExecutionChange) => listener(value);
    ipcRenderer.on(AGENT_IPC.projectTaskExecutionChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.projectTaskExecutionChanged, handler);
  },
  createWorkspace: (request: import('../shared/projectWorkspace').ProjectWorkspaceCreateRequest) => ipcRenderer.invoke(AGENT_IPC.projectCreateWorkspace, request),
  get: (projectId: string) => ipcRenderer.invoke(AGENT_IPC.projectGetWorkspace, projectId),
  open: (projectId: string): Promise<void> => ipcRenderer.invoke(AGENT_IPC.projectOpenWorkspace, projectId),
  openFile: (projectId: string, fileId: string): Promise<void> => ipcRenderer.invoke(AGENT_IPC.projectOpenFile, { projectId, fileId }),
  listRunChanges: (projectId: string) => ipcRenderer.invoke(AGENT_IPC.projectRunChangesList, projectId),
  readRunChange: (request: import('../shared/projectRunChanges').ProjectRunChangeRead) => ipcRenderer.invoke(AGENT_IPC.projectRunChangesRead, request),
  onRunChangesChanged: (listener: (projectId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, projectId: string) => listener(projectId);
    ipcRenderer.on(AGENT_IPC.projectRunChangesChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.projectRunChangesChanged, handler);
  },
  browse: (request: import('../shared/projectBrowser').ProjectBrowseRequest) => ipcRenderer.invoke(AGENT_IPC.projectBrowse, request),
  listFiles: (projectId: string) => ipcRenderer.invoke(AGENT_IPC.projectListFiles, projectId),
  inspectFileDeletion: (projectId: string, fileId: string) => ipcRenderer.invoke(AGENT_IPC.projectInspectFileDeletion, { projectId, fileId }),
  deleteFile: (projectId: string, fileId: string) => ipcRenderer.invoke(AGENT_IPC.projectDeleteFile, { projectId, fileId }),
  onFilesChanged: (listener: (snapshot: import('../shared/projectWorkspace').ProjectFilesSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: import('../shared/projectWorkspace').ProjectFilesSnapshot) => listener(value);
    ipcRenderer.on(AGENT_IPC.projectFilesChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.projectFilesChanged, handler);
  },
  getExecutionPolicy: (projectId: string) => ipcRenderer.invoke(AGENT_IPC.projectGetExecutionPolicy, projectId),
  setExecutionPolicy: (request: import('../shared/projectExecutionPolicy').ProjectExecutionPolicyUpdateRequest) => ipcRenderer.invoke(AGENT_IPC.projectSetExecutionPolicy, request),
  onExecutionPolicyChanged: (listener: (policy: import('../shared/projectExecutionPolicy').ProjectExecutionPolicy) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: import('../shared/projectExecutionPolicy').ProjectExecutionPolicy) => listener(value);
    ipcRenderer.on(AGENT_IPC.projectExecutionPolicyChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.projectExecutionPolicyChanged, handler);
  },
  syncMembers: (projects: Array<{ projectId: string; partnerIds: string[] }>): Promise<PartnerWorkspaceState[]> => ipcRenderer.invoke(AGENT_IPC.projectSyncMembers, projects),
  changeMembers: (request: import('../shared/projectWorkspace').ProjectMembershipChangeRequest) => ipcRenderer.invoke(AGENT_IPC.projectChangeMembers, request),
  remove: (projectId: string, roomIds: string[]): Promise<void> => ipcRenderer.invoke(AGENT_IPC.projectRemove, { projectId, roomIds }),
} satisfies AsteriumProjectsApi);

contextBridge.exposeInMainWorld('asteriumStudio', {
  syncRoom: (room: StudioRoomMetadata): Promise<StudioRoomSnapshot> => ipcRenderer.invoke(AGENT_IPC.studioSyncRoom, room),
  getRoom: (roomId: string): Promise<StudioRoomSnapshot | undefined> => ipcRenderer.invoke(AGENT_IPC.studioGetRoom, roomId),
  exportMarkdown: (request: StudioRoomMarkdownExportRequest): Promise<boolean> => ipcRenderer.invoke(AGENT_IPC.studioExportMarkdown, request),
  removeRoom: (roomId: string): Promise<void> => ipcRenderer.invoke(AGENT_IPC.studioRemoveRoom, roomId),
  setMuted: (request: StudioSetMutedRequest): Promise<StudioRoomSnapshot> => ipcRenderer.invoke(AGENT_IPC.studioSetMuted, request),
  setSettings: (request: StudioSetSettingsRequest): Promise<StudioRoomSnapshot> => ipcRenderer.invoke(AGENT_IPC.studioSetSettings, request),
  resolveDiscussion: (request: StudioResolveDiscussionRequest): Promise<StudioRoomSnapshot> => ipcRenderer.invoke(AGENT_IPC.studioResolveDiscussion, request),
  cancelRound: (request: StudioCancelRoundRequest): Promise<StudioRoomSnapshot> => ipcRenderer.invoke(AGENT_IPC.studioCancelRound, request),
  startRound: (request: StudioStartRoundRequest): Promise<StudioRoomSnapshot> => ipcRenderer.invoke(AGENT_IPC.studioStartRound, request),
  prepareTurn: (request: StudioPrepareTurnRequest): Promise<StudioPreparedTurn> => ipcRenderer.invoke(AGENT_IPC.studioPrepareTurn, request),
  failTurn: (request: { roomId: string; roundId: string; partnerId: string }): Promise<StudioRoomSnapshot> => ipcRenderer.invoke(AGENT_IPC.studioFailTurn, request),
  announce: (request: StudioAnnouncementRequest): Promise<StudioRoomSnapshot> => ipcRenderer.invoke(AGENT_IPC.studioAnnounce, request),
  onRoomChanged: (listener: (snapshot: StudioRoomSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: StudioRoomSnapshot) => listener(value);
    ipcRenderer.on(AGENT_IPC.studioRoomChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.studioRoomChanged, handler);
  },
} satisfies AsteriumStudioApi);

contextBridge.exposeInMainWorld('asteriumStudioNotes', {
  list: (projectId?: string): Promise<StudioNote[]> => ipcRenderer.invoke(AGENT_IPC.studioNoteList, projectId),
  save: (request: SaveStudioNoteRequest): Promise<StudioNote> => ipcRenderer.invoke(AGENT_IPC.studioNoteSave, request),
  setStatus: (id: string, status: StudioNoteStatus): Promise<StudioNote> => ipcRenderer.invoke(AGENT_IPC.studioNoteSetStatus, { id, status }),
  delete: (id: string): Promise<void> => ipcRenderer.invoke(AGENT_IPC.studioNoteDelete, id),
} satisfies AsteriumStudioNotesApi);

contextBridge.exposeInMainWorld('asteriumProjectNotebooks', {
  get: (target: ProjectNotebookTarget): Promise<ProjectNotebook | undefined> => ipcRenderer.invoke(AGENT_IPC.projectNotebookGet, target),
  replace: (request: ProjectNotebookUserReplaceRequest): Promise<ProjectNotebook> => ipcRenderer.invoke(AGENT_IPC.projectNotebookReplace, request),
  listArchived: (): Promise<ProjectNotebook[]> => ipcRenderer.invoke(AGENT_IPC.projectNotebookListArchived),
  exportMarkdown: (target: ProjectNotebookTarget): Promise<boolean> => ipcRenderer.invoke(AGENT_IPC.projectNotebookExport, target),
  purge: (target: ProjectNotebookTarget): Promise<ProjectNotebook> => ipcRenderer.invoke(AGENT_IPC.projectNotebookPurge, target),
} satisfies import('../shared/desktopBridge').AsteriumProjectNotebooksApi);

contextBridge.exposeInMainWorld('asteriumMemoryFallback', {
  listModels: (input) => ipcRenderer.invoke(AGENT_IPC.memoryFallbackListModels, input),
  get: () => ipcRenderer.invoke(AGENT_IPC.memoryFallbackGet),
  configure: (input) => ipcRenderer.invoke(AGENT_IPC.memoryFallbackConfigure, input),
  setPartner: (input) => ipcRenderer.invoke(AGENT_IPC.memoryFallbackSetPartner, input),
} satisfies import('../shared/memoryFallback').AsteriumMemoryFallbackApi);

contextBridge.exposeInMainWorld('asteriumPartnerDiary', {
  get: () => ipcRenderer.invoke(AGENT_IPC.diaryGet),
  configure: (input) => ipcRenderer.invoke(AGENT_IPC.diaryConfigure, input),
  read: (input) => ipcRenderer.invoke(AGENT_IPC.diaryRead, input),
  exportMarkdown: (input) => ipcRenderer.invoke(AGENT_IPC.diaryExport, input),
} satisfies import('../shared/partnerDiary').AsteriumPartnerDiaryApi);

contextBridge.exposeInMainWorld('asteriumMemory', {
  query: (request: MemoryArchiveQuery) => ipcRenderer.invoke(AGENT_IPC.memoryArchiveQuery, request),
  briefing: (partnerId: string) => ipcRenderer.invoke(AGENT_IPC.memoryArchiveBriefing, partnerId),
  create: (request: MemoryArchiveCreateRequest) => ipcRenderer.invoke(AGENT_IPC.memoryArchiveCreate, request),
  update: (request: MemoryArchiveUpdateRequest) => ipcRenderer.invoke(AGENT_IPC.memoryArchiveUpdate, request),
  comment: (request: MemoryArchiveCommentRequest) => ipcRenderer.invoke(AGENT_IPC.memoryArchiveComment, request),
  softDelete: (request: MemoryArchiveMutationRequest) => ipcRenderer.invoke(AGENT_IPC.memoryArchiveSoftDelete, request),
  restore: (request: MemoryArchiveMutationRequest) => ipcRenderer.invoke(AGENT_IPC.memoryArchiveRestore, request),
  purge: (request: MemoryArchiveMutationRequest) => ipcRenderer.invoke(AGENT_IPC.memoryArchivePurge, request),
  readSource: (request: MemoryArchiveSourceReadRequest) => ipcRenderer.invoke(AGENT_IPC.memoryArchiveReadSource, request),
  onChanged: (listener: (change: MemoryArchiveChange) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: MemoryArchiveChange) => listener(value);
    ipcRenderer.on(AGENT_IPC.memoryArchiveChanged, handler);
    return () => ipcRenderer.removeListener(AGENT_IPC.memoryArchiveChanged, handler);
  },
} satisfies AsteriumMemoryApi);

contextBridge.exposeInMainWorld('asteriumNativeBindings', {
  syncSingle: (bindings: Array<{ partnerId: string; source: 'local_cli' | 'api_partner'; conversationId: string; nativeThreadId: string }>): Promise<void> => ipcRenderer.invoke(AGENT_IPC.nativeSyncSingleBindings, bindings),
} satisfies AsteriumNativeBindingsApi);
