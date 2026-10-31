import type { AttachmentCapabilities } from './attachments';
import { AGENT_PROTOCOL_VERSION, type EventId, type PartnerId, type ProtocolError } from './core';

export interface ApiPartnerConnection {
  provider: 'deepseek' | 'openai' | 'responses' | 'anthropic' | 'gemini' | 'custom';
  serviceId?: string;
  modelId?: string;
  bindingKey?: string;
  toolsEnabled?: boolean;
  requestSettings?: import('../apiConnections').ApiRequestSettings;
  modelSettings?: import('../apiConnections').ApiModelSettings;
  endpoint: string;
  model: string;
  credentialRef: string;
  thinkingMode?: 'auto' | 'enabled' | 'disabled';
  reasoningEffort?: 'low' | 'high' | 'max';
  primaryWorkspaceGrantId?: string;
  workspaceGrantIds?: string[];
  attachmentCapabilities?: AttachmentCapabilities;
}

export interface ExistingThreadConnection {
  serviceUrl: string;
  threadId: string;
  workspaceRoot?: string;
  credentialRef: string;
}

export interface CredentialStatus {
  credentialRef: string;
  configured: boolean;
  masked: string;
}

export interface ExistingThreadConnectionStatus extends CredentialStatus {
  authenticated: boolean;
  threadId: string;
  workspaceRoot?: string;
  capabilities: {
    streamingText: boolean;
    cancellation: boolean;
    toolEvents: boolean;
    fileEvents: boolean;
    reconnect: boolean;
  };
}

export interface ExistingThreadChangedEvent {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  type: 'existing_thread.changed';
  eventId: EventId;
  partnerId: PartnerId;
  connectionSource: 'existing_thread';
  threadId: string;
  previousThreadId?: string;
  workspaceRoot: string;
  reason: string;
  occurredAt: string;
}

export interface ApiModelSummary {
  id: string;
  ownedBy?: string;
}

export interface CliDetectionResult {
  installed: boolean;
  loggedIn: boolean;
  version?: string;
  authMethod?: string;
  executableLabel?: string;
  error?: ProtocolError;
}

export type ClaudeDetectionResult = CliDetectionResult;

export interface CodexRuntimeInfo {
  runtimeId: string;
  executablePath: string;
  executableLabel: string;
  environment: 'global_cli' | 'desktop_app' | 'vscode_extension' | 'path';
  environmentLabel: string;
  codexHome: string;
  installed: boolean;
  loggedIn: boolean;
  version?: string;
  authMethod?: string;
  error?: ProtocolError;
}

export interface CodexDetectionResult extends CliDetectionResult {
  runtimes: CodexRuntimeInfo[];
  recommendedRuntimeId?: string;
}

export interface CodexThreadSummary {
  threadId: string;
  title: string;
  cwd: string;
  updatedAt?: string;
}

export type NativeThreadLifecycleAction = 'archive' | 'restore' | 'delete';
export type NativeThreadLifecycleState = 'active' | 'archived' | 'deleted' | 'unavailable' | 'unsupported';

export interface NativeThreadLifecycleResult {
  threadId: string;
  state: NativeThreadLifecycleState;
  checkedAt: string;
  message?: string;
  reason?: 'outside_workspace' | 'runtime_unavailable';
}

export interface LocalThreadLifecycleRequest {
  adapterType: 'codex_cli' | 'claude_code';
  partnerId: string;
  partnerRootGrantId?: string;
  codexRuntimeId?: string;
  codexRuntimeEnvironment?: CodexRuntimeInfo['environment'];
  threadIds: string[];
}

export interface ChangeLocalThreadLifecycleRequest extends Omit<LocalThreadLifecycleRequest, 'threadIds'> {
  threadId: string;
  action: NativeThreadLifecycleAction;
}

export interface WorkspaceGrant {
  grantId: string;
  displayPath: string;
  source?: 'manual' | 'project';
  projectId?: string;
}

export interface ClaudeSessionImport {
  sessionId: string;
  sessionFilePath: string;
  workspaceGrant: WorkspaceGrant;
}

export interface PartnerWorkspaceState {
  partnerId: string;
  cwd?: WorkspaceGrant;
  workspaces: WorkspaceGrant[];
  version: number;
  unavailableGrantIds: string[];
}
