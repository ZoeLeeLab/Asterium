import type {
  AttachmentCapabilities,
  CodexRuntimeInfo,
  PartnerProfileManagement,
  PermissionMode,
  RuntimeModelObservation,
} from '../../../shared/agentProtocol';

export type PartnerStatus =
  | 'online'
  | 'connecting'
  | 'busy'
  | 'awaiting_confirmation'
  | 'offline'
  | 'failed';

export interface PublicIdentity {
  displayName: string;
  avatarDataUrl?: string;
  introduction: string;
  expertise: string;
  mentionName: string;
}

export interface PartnerBase {
  id: string;
  publicIdentity: PublicIdentity;
  status: PartnerStatus;
  isPrototype: boolean;
  createdAt: string;
  accent: string;
  isRemoved?: boolean;
  removedAt?: string;
  managedDataDeletedAt?: string;
  attachmentCapabilities?: AttachmentCapabilities;
  defaultPermissionMode?: PermissionMode;
  workspaceVersion?: number;
  profileRevision?: string;
  profileManagement?: PartnerProfileManagement;
  managedPersonality?: string;
  managedSystemPrompt?: string;
  recentModel?: RuntimeModelObservation;
}

export interface ExistingThreadPartner extends PartnerBase {
  sourceMode: 'existing_thread';
  serviceType: 'cyberboss_server' | 'cyberboss_local' | 'custom';
  serviceUrl: string;
  threadId: string;
  workspaceRoot?: string;
  connectionLabel: string;
  connectionStatus: 'untested' | 'connected' | 'failed' | 'mock_connected';
  credentialRef?: string;
  configured: boolean;
  capabilities?: {
    streamingText: boolean;
    cancellation: boolean;
    toolEvents: boolean;
    fileEvents: boolean;
    reconnect: boolean;
  };
}

export interface LocalCliPartner extends PartnerBase {
  sourceMode: 'local_cli';
  adapterType: 'codex_cli' | 'claude_code';
  location: 'local' | 'remote';
  sessionMode: 'new' | 'resume';
  connectionLabel: string;
  connectionKind?: 'mock' | 'local_claude' | 'local_codex';
  cliVersion?: string;
  claudeVersion?: string;
  executableLabel?: string;
  codexRuntimeId?: string;
  codexRuntime?: Omit<Pick<CodexRuntimeInfo, 'executablePath' | 'executableLabel' | 'environment' | 'environmentLabel' | 'codexHome' | 'loggedIn' | 'version' | 'authMethod'>, 'executablePath'> & { executablePath?: string };
  resumeSessionId?: string;
  claudeSessionFilePath?: string;
  /** Stable launch root. Imported roots retain the CLI's native project settings; private roots stay empty. */
  partnerRootKind?: 'private' | 'imported';
  partnerRoot?: string;
  partnerRootGrantId?: string;
  /** Extra directories only. They never become the adapter cwd or redefine partner identity. */
  workingDirectories?: string[];
  workspaceGrantIds?: string[];
  activeWorkspaceGrantId?: string;
  /** Legacy primary-directory field retained for migration only. */
  primaryWorkspaceGrantId?: string;
  /** Legacy single-directory fields retained for v2 migration compatibility. */
  workingDirectory?: string;
  workspaceGrantId?: string;
}

export interface ApiPartner extends PartnerBase {
  modelId?: string;
  sourceMode: 'api_partner';
  provider: 'deepseek' | 'openai' | 'responses' | 'anthropic' | 'gemini' | 'custom';
  endpoint?: string;
  model: string;
  personality: string;
  systemPrompt?: string;
  apiSessionHistoryEnabled: boolean;
  thinkingMode: 'auto' | 'enabled' | 'disabled';
  reasoningEffort: 'low' | 'high' | 'max';
  primaryWorkspaceGrantId?: string;
  workingDirectories?: string[];
  workspaceGrantIds?: string[];
  credentialRef?: string;
  configured: boolean;
}

export type Partner = ExistingThreadPartner | LocalCliPartner | ApiPartner;
