import type { AutomationRun } from '../../../shared/automations';
import type { PartnerEvent } from '../../../shared/agentProtocol';
import type {
  NativeThreadLifecycleState,
  PartnerProfilesSyncResult,
  PartnerWorkspaceState,
  PermissionMode,
  PlanMode,
  ProtocolError,
  RendererAgentEvent,
  RunId,
  SessionId,
  WorkspaceGrant,
} from '../../../shared/agentProtocol';
import type { ProjectWorkspaceFileEntry } from '../../../shared/projectWorkspace';
import type { ProjectDomainSnapshot } from '../../../shared/projectDomain';
import type { Conversation, ConversationArtifact, Message } from './conversation';
import type { Partner } from './partner';
import type { Project, ProjectFile, ProjectWorkspaceInfo } from './project';
import type { TaskItem } from './project';
import type { GroupChat } from './studio';
import type { UserProfile } from './user';

export interface PrototypeState {
  version: 7;
  userProfile: UserProfile;
  partners: Partner[];
  conversations: Conversation[];
  projects: Project[];
  groupChats: GroupChat[];
  activePartnerId: string;
  activeConversationId: string;
  activeProjectId: string;
  activeGroupChatId: string;
}

export type PrototypeAction =
  | { type: 'automationEvent'; run: AutomationRun; event: PartnerEvent }
  | { type: 'automationHydrate'; runs: AutomationRun[] }
  | { type: 'updateUserProfile'; profile: UserProfile }
  | { type: 'hydratePartnerProfiles'; profiles: PartnerProfilesSyncResult }
  | { type: 'selectPartner'; partnerId: string }
  | { type: 'selectConversation'; conversationId: string }
  | { type: 'selectProject'; projectId: string }
  | { type: 'addPartner'; partner: Partner }
  | { type: 'updatePartner'; partner: Partner; previous?: Partner }
  | { type: 'removePartner'; partnerId: string; removedAt: string }
  | { type: 'markPartnerDataDeleted'; partnerId: string; deletedAt: string }
  | { type: 'createConversation'; conversation: Conversation }
  | { type: 'renameConversation'; conversationId: string; title: string }
  | { type: 'archiveConversation'; conversationId: string; archivedAt: string }
  | { type: 'archivePartnerConversations'; partnerId: string; archivedAt: string }
  | { type: 'restoreConversation'; conversationId: string }
  | { type: 'deleteConversationPermanently'; conversationId: string }
  | { type: 'reconcileDeletedConversations'; conversationIds: string[] }
  | { type: 'syncNativeThreadLifecycle'; conversationId: string; state: NativeThreadLifecycleState; checkedAt: string; message?: string }
  | { type: 'toggleConversationPin'; conversationId: string }
  | { type: 'setConversationPermissionMode'; conversationId: string; mode: PermissionMode }
  | { type: 'setConversationCodexModel'; conversationId: string; selection: import('../../../shared/codexModels').CodexModelSelection }
  | { type: 'setConversationPlanMode'; conversationId: string; mode: PlanMode }
  | { type: 'switchConversationWorkspace'; conversationId: string; conversation: Conversation }
  | { type: 'createProject'; project: Project }
  | { type: 'hydrateProjectDomain'; snapshot: ProjectDomainSnapshot }
  | { type: 'updateProject'; project: Project }
  | { type: 'upsertProjectTask'; task: TaskItem }
  | { type: 'removeProjectTask'; projectId: string; taskId: string }
  | { type: 'removeProject'; projectId: string; archivedAt: string }
  | { type: 'setProjectMembers'; projectId: string; memberIds: string[] }
  | { type: 'updateProjectWorkspace'; projectId: string; workspace: ProjectWorkspaceInfo; files: ProjectFile[] }
  | { type: 'addProjectFile'; projectId: string; file: ProjectFile }
  | { type: 'syncProjectFiles'; projectId: string; files: ProjectWorkspaceFileEntry[] }
  | { type: 'selectGroupChat'; groupChatId: string }
  | { type: 'createGroupChat'; groupChat: GroupChat }
  | { type: 'updateGroupChat'; groupChat: GroupChat }
  | { type: 'setGroupMembers'; groupChatId: string; memberIds: string[] }
  | { type: 'archiveGroupChat'; groupChatId: string; archivedAt: string }
  | { type: 'restoreGroupChat'; groupChatId: string }
  | { type: 'removeGroupChat'; groupChatId: string }
  | { type: 'toggleGroupMember'; groupChatId: string; partnerId: string }
  | { type: 'sendChatMessage'; conversationId: string; message: Message; historySaved?: boolean }
  | { type: 'sendChatGuidance'; conversationId: string; runId: RunId; message: Message; waitForApplication?: boolean }
  | { type: 'rejectChatGuidance'; conversationId: string; clientMessageId: string }
  | { type: 'addConversationArtifact'; conversationId: string; artifact: ConversationArtifact }
  | { type: 'removeConversationArtifact'; conversationId: string; artifactId: string }
  | { type: 'replaceLastTurn'; conversationId: string; messages: Message[]; sessionId?: SessionId; restoreOnFailure?: boolean }
  | { type: 'sendStudioMessage'; groupChatId: string; message: Message }
  | { type: 'hydrateStudioMessages'; groupChatId: string; messages: Message[]; unreadCompletedAt?: string }
  | { type: 'addProjectMember'; projectId: string; partnerId: string }
  | { type: 'updatePartnerWorkspaceGrants'; partnerId: string; grants: WorkspaceGrant[]; preferredGrantId?: string }
  | { type: 'syncPartnerWorkspaceState'; workspace: PartnerWorkspaceState }
  | { type: 'rebindPartnerRoot'; partnerId: string; conversation: Conversation }
  | { type: 'bindRunReceipt'; conversationId: string; clientMessageId: string; runId: RunId; sessionId: SessionId }
  | { type: 'agentEvent'; event: RendererAgentEvent; unreadOnCompletion?: boolean }
  | { type: 'messageSendFailed'; conversationId: string; clientMessageId: string; error: ProtocolError }
  | { type: 'reset'; state: PrototypeState };
