import type {
  ArtifactAvailability,
  ArtifactRegistrationMethod,
  ArtifactSourceKind,
  AuthorizationPurpose,
  MessageAttachment,
  MessageDeliveryState,
  NativeThreadLifecycleState,
  PermissionMode,
  PlanMode,
  ProtocolError,
  RunId,
  RunState,
  RuntimeModelObservation,
  SessionId,
  UserInputQuestion,
} from '../../../shared/agentProtocol';
import type { StudioMention } from '../../../shared/studioRuntime';

export interface MessageQuote {
  sourceMessageId: string;
  sourcePartnerId: string;
  sourcePartnerName: string;
  kind: 'full' | 'selection';
  text: string;
}

export interface Message {
  automation?: { automationId: string; runId: string; name: string };
  id: string;
  authorId: string;
  content: string;
  attachments?: MessageAttachment[];
  quote?: MessageQuote;
  createdAt: string;
  occurredAt?: string;
  status?: MessageDeliveryState;
  clientMessageId?: string;
  runId?: RunId;
  /** User guidance submitted into an already-running task. */
  isGuidance?: boolean;
  guidanceState?: 'queued' | 'applied';
  runState?: RunState;
  isStreaming?: boolean;
  startedAt?: string;
  completedAt?: string;
  error?: ProtocolError;
  toolNote?: string;
  toolEvents?: Array<{ id: string; label: string; state: 'running' | 'success' | 'failure' }>;
  /** Ordered, append-only events observed during this assistant turn. */
  timeline?: TurnTimelineItem[];
  studioSeq?: number;
  studioMentions?: StudioMention[];
}

export type TurnOperationCategory = 'tool' | 'command' | 'mcp' | 'file_read' | 'file_write' | 'web' | 'computer';

export type TurnTimelineItem =
  | { id: string; sequence: number; kind: 'text'; text: string }
  | { id: string; sequence: number; kind: 'reasoning'; reasoningId?: string; summary: string; state: 'running' | 'success' | 'failure'; detail?: string; truncated?: boolean }
  | { id: string; sequence: number; kind: 'status'; summary: string; state: 'running' | 'success' | 'failure'; detail?: string }
  | { id: string; sequence: number; kind: 'tool'; toolCallId: string; toolName?: string; presentationName?: string; category?: TurnOperationCategory; summary: string; state: 'running' | 'success' | 'failure'; detail?: string; mutatesExternalState?: boolean }
  | { id: string; sequence: number; kind: 'computer'; toolCallId: string; summary: string; state: 'running' | 'success' | 'failure'; detail?: string }
  | { id: string; sequence: number; kind: 'file'; artifactId: string; toolCallId?: string; name: string; summary: string; state: 'success'; mediaType?: string; sizeBytes?: number; changeKind?: 'create' | 'modify' }
  | { id: string; sequence: number; kind: 'authorization'; authorizationId: string; toolCallId?: string; summary: string; state: 'running' | 'success' | 'failure'; detail?: string; action?: 'read_file' | 'write_file' | 'delete_file' | 'run_command' | 'computer_control' | 'external_side_effect'; risk?: 'low' | 'medium' | 'high'; decision?: 'allow_once' | 'deny'; extensionTrustGranted?: boolean; purpose?: AuthorizationPurpose }
  | { id: string; sequence: number; kind: 'user_input'; requestId: string; questions: UserInputQuestion[]; state: 'running' | 'success' | 'failure'; answers?: Record<string, string[]>; customAnswers?: Record<string, string> }
  | { id: string; sequence: number; kind: 'plan'; status: 'planning' | 'waiting_user' | 'ready' | 'executing' | 'completed'; summary: string; state: 'running' | 'success' | 'failure'; detail?: string }
  | { id: string; sequence: number; kind: 'error'; summary: string; state: 'failure'; detail?: string };

export interface ConversationArtifact {
  id: string;
  name: string;
  artifactRef: string;
  mediaType?: string;
  sizeBytes?: number;
  createdAt: string;
  runId?: RunId;
  sourceKind?: ArtifactSourceKind;
  registrationMethod?: ArtifactRegistrationMethod;
  availability?: ArtifactAvailability;
  cached?: boolean;
}

export interface Conversation {
  id: string;
  partnerId: string;
  title: string;
  isPinned?: boolean;
  isArchived?: boolean;
  archivedAt?: string;
  messages: Message[];
  artifacts?: ConversationArtifact[];
  updatedAt: string;
  /** Successful assistant completion received while this conversation was not visible. */
  unreadCompletedAt?: string;
  sessionId?: SessionId;
  runtimeModel?: RuntimeModelObservation;
  nativeThreadState?: NativeThreadLifecycleState;
  nativeThreadStateCheckedAt?: string;
  nativeThreadNotice?: { state: 'info' | 'warning' | 'error'; message: string };
  /** Native sessions previously used by this visible conversation, keyed by normalized cwd. */
  nativeSessionBindings?: Record<string, {
    sessionId: SessionId;
    partnerRoot: string;
    partnerRootGrantId?: string;
    toolProtocolVersion?: number;
  }>;
  /** Codex dynamic tools are registered at thread creation and cannot be added on resume. */
  nativeToolProtocolVersion?: number;
  /** Superseded native sessions are retained for audit/recovery and are never deleted here. */
  legacyNativeSessions?: Array<{ sessionId: SessionId; partnerRoot?: string; replacedAt: string }>;
  /** Snapshot of the partner root used when this conversation was created. */
  partnerRootKind?: 'private' | 'imported';
  partnerRoot?: string;
  partnerRootGrantId?: string;
  /** Conversation-scoped snapshot of the partner's default additional workspaces. */
  workspaceGrantIds?: string[];
  isPrimaryThread?: boolean;
  isDisabled?: boolean;
  disabledReason?: 'partner_root_changed';
  activeRun?: { runId: RunId; clientMessageId: string };
  workStatus?: string;
  awaitingFirstResponse?: { clientMessageId: string; startedAt: string };
  pendingAuthorization?: {
    authorizationId: string;
    toolCallId?: string;
    action: 'read_file' | 'write_file' | 'delete_file' | 'run_command' | 'computer_control' | 'external_side_effect';
    risk: 'low' | 'medium' | 'high';
    summary: string;
    targets: string[];
    extensionTrust?: { extensionId: string; name: string; generation: number; kind?: 'mcp' | 'skill' };
    resolution?: 'interactive' | 'display_only';
    purpose?: AuthorizationPurpose;
  };
  permissionMode?: PermissionMode;
  planMode?: PlanMode;
  pendingUserInput?: {
    requestId: string;
    questions: UserInputQuestion[];
  };
  planStatus?: 'planning' | 'waiting_user' | 'ready' | 'executing' | 'completed';
  runNotice?: { state: 'failed' | 'cancelled'; message: string; restored?: boolean };
  /** Transient snapshot used to restore a turn when regeneration fails or is cancelled. */
  regenerationBackup?: { messages: Message[]; sessionId?: SessionId };
  /** Prevents the run.failed following a delivery failure from creating a duplicate error bubble. */
  failedRegenerationClientMessageId?: string;
  lastRunId?: RunId;
  lastSequence?: number;
  /** Highest accepted sequence for each run, persisted to make replay idempotent after restart. */
  eventSequences?: Record<RunId, number>;
}
