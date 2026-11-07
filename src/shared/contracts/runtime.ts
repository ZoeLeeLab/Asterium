import type { ArtifactSourceClaim, MessageAttachment } from './attachments';
import type { ExistingThreadChangedEvent, ExistingThreadReplyEvent } from './connections';
import type { SingleChatIndexedMessage } from '../singleChatMessages';
import {
  AGENT_PROTOCOL_VERSION,
  type ArtifactAvailability,
  type ArtifactRegistrationMethod,
  type ArtifactSourceKind,
  type AuthorizationPurpose,
  type ClientMessageId,
  type CommandId,
  type ConnectionSource,
  type ConversationId,
  type EventId,
  type JsonValue,
  type MessageDeliveryState,
  type PartnerId,
  type PermissionMode,
  type PlanMode,
  type ProtocolError,
  type RunId,
  type SessionId,
} from './core';

export type AgentExecutionRoute =
  | { scope: 'single' }
  | {
      scope: 'group';
      roomId: string;
      roundId: string;
      bindingGeneration: number;
      /** Highest canonical room message made available when this partner started its turn. */
      inputThroughSeq: number;
    }
  | { scope: 'workspace'; projectId: string }
  | {
      scope: 'workflow_planning';
      projectId: string;
      roomId: string;
      generationId: string;
      bindingGeneration: number;
    };

/** Dynamic-tool contract installed when Asterium starts a new Codex thread. */
export const CODEX_NATIVE_TOOL_PROTOCOL_VERSION = 4;

/** Main assembles this snapshot after discarding any renderer-supplied copy. */
export interface SessionBootstrapDocument {
  version: 1;
  content: string;
  /** Same Main-owned sections rendered with explicit reference-data boundaries for native developer instructions. */
  developerContent?: string;
  createdAt: string;
  timeZone: string;
  personaVersion?: string;
  appliedProfiles?: AppliedSessionProfiles;
  profileSections?: { user?: string; persona?: string };
}

export interface AppliedSessionProfiles {
  user?: { enabled: boolean; version: string; displayName?: string; introduction?: string };
  persona?: { enabled: boolean; version: string; personality?: string; systemPrompt?: string };
}

interface CommandBase {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  commandId: CommandId;
  partnerId: PartnerId;
  conversationId: ConversationId;
  connectionSource: ConnectionSource;
  route?: AgentExecutionRoute;
}

export interface ApiTextContext {
  systemPrompt?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  apiSessionHistoryEnabled?: boolean;
  /** @deprecated Compatibility alias for commands created before profile schema v2. */
  memoryEnabled?: boolean;
  /** Regeneration-only: remove this turn and every later structured API turn before sending. */
  replaceTurnClientMessageId?: string;
  /** User information allowed for this partner; main combines it with the persisted API partner profile. */
  userProfileContext?: string;
}

export interface AsteriumRuntimeContextInput {
  partner: {
    displayName: string;
    introduction: string;
    expertise: string;
    mentionName: string;
    avatarAvailable: boolean;
    personality?: string;
    systemPrompt?: string;
  };
  user?: { displayName: string; introduction: string };
  /** Main-owned structured-memory briefing, present only on an eligible first runtime turn. */
  memoryBriefing?: string;
  runtime: {
    source: ConnectionSource;
    adapter?: 'claude_code' | 'codex_cli';
    provider?: string;
    model?: string;
  };
  conversation?: {
    title: string;
    studio?: {
      roomId: string;
      projectId: string;
      explicitDeliveryTarget: 'room_project';
      speakingMode: 'free_discussion' | 'selected_partners' | 'round_robin';
      speakingModeLabel: string;
      passAllowed: boolean;
      mentionPartnerAvailable: boolean;
      mentionPartnerReason: string;
      discussionProtectionEnabled: boolean;
      selectedPartnerIds: string[];
      mutedPartnerIds: string[];
      speakerQueue: string[];
    };
  };
  partners?: Array<{
    partnerId?: string;
    displayName: string;
    mentionName?: string;
    expertise: string;
    model: string;
    modelStatus: 'current' | 'recent' | 'unknown';
    /** Whether this member can currently be invited into a real Studio round. */
    groupMentionAvailable?: boolean;
  }>;
}

export interface SendMessageCommand extends CommandBase {
  type: 'message.send';
  clientMessageId: ClientMessageId;
  /** Stable visible user-message identity. Present for ordinary single-chat sends. */
  messageId?: string;
  /** Exact visible user message used to make current-turn source capture race-free. */
  sourceMessage?: SingleChatIndexedMessage;
  sessionId?: SessionId;
  /** Codex-only: fork the current thread through this completed turn before sending. */
  forkFromTurnId?: string;
  content: { type: 'text'; text: string };
  attachments?: MessageAttachment[];
  contextHandoff?: import('../contextHandoff').ContextHandoff | import('../contextHandoff').ResolvedContextHandoff;
  apiContext?: ApiTextContext;
  runtimeContext?: AsteriumRuntimeContextInput;
  sessionBootstrap?: SessionBootstrapDocument;
  /** Accepted bootstrap version for a resumed native thread. */
  sessionBootstrapVersion?: number;
  /** Main-only persona synchronization; never part of the visible/user input. */
  managedPersonaUpdate?: { version: string; content: string };
  execution?: {
    permissionMode: PermissionMode;
    planMode: PlanMode;
    codexModel?: import('../codexModels').CodexModelSelection;
  };
}

export interface CancelRunCommand extends CommandBase {
  type: 'run.cancel';
  clientMessageId: ClientMessageId;
  runId: RunId;
  sessionId: SessionId;
  reason?: string;
}

export interface SendGuidanceCommand extends CommandBase {
  type: 'guidance.send';
  clientMessageId: ClientMessageId;
  runId: RunId;
  sessionId: SessionId;
  content: { type: 'text'; text: string };
  /** Visible single-chat source, indexed at the ordered application boundary. */
  sourceMessage?: SingleChatIndexedMessage;
}

export interface SendGuidanceResult {
  /** The partner either accepted the guidance into the active turn or needs it sent as the next turn. */
  disposition: 'accepted' | 'deferred';
}

export interface ResumeSessionCommand extends CommandBase {
  type: 'session.resume';
  sessionId: SessionId;
  afterSequence: number;
}

export interface ResolveAuthorizationCommand extends CommandBase {
  type: 'authorization.resolve';
  clientMessageId: ClientMessageId;
  runId: RunId;
  sessionId: SessionId;
  authorizationId: string;
  decision: 'allow_once' | 'deny';
  /** API-only, explicit opt-in for a Main-offered pending extension approval. */
  persistExtensionTrust?: boolean;
  message?: string;
}

export interface UserInputResponse {
  answers: Record<string, string[]>;
  /** Selected free-form text, kept separate from option labels. Never sent as a tool option. */
  customAnswers?: Record<string, string>;
}

export interface ResolveUserInputCommand extends CommandBase, UserInputResponse {
  type: 'user_input.resolve';
  clientMessageId: ClientMessageId;
  runId: RunId;
  sessionId: SessionId;
  requestId: string;
}

export type AgentCommand =
  | SendMessageCommand
  | SendGuidanceCommand
  | CancelRunCommand
  | ResumeSessionCommand
  | ResolveAuthorizationCommand
  | ResolveUserInputCommand;

export interface AdapterEventBase {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  eventId: EventId;
  partnerId: PartnerId;
  conversationId: ConversationId;
  connectionSource: ConnectionSource;
  clientMessageId: ClientMessageId;
  sessionId: SessionId;
  runId: RunId;
  sequence: number;
  occurredAt: string;
  route?: AgentExecutionRoute;
}

export interface SessionBoundEvent extends AdapterEventBase {
  type: 'session.bound';
  isNew: boolean;
  /** Present only when this newly started Codex thread received that tool contract. */
  toolProtocolVersion?: number;
  model?: string;
  modelSource?: 'runtime' | 'native_thread';
}

export interface MessageAcceptedEvent extends AdapterEventBase {
  type: 'message.accepted';
}

/** Ordered boundary: queued guidance has entered the active API task. */
export interface GuidanceAppliedEvent extends AdapterEventBase {
  type: 'guidance.applied';
  guidanceClientMessageId: ClientMessageId;
  sourceMessage?: SingleChatIndexedMessage;
}

export interface TextDeltaEvent extends AdapterEventBase {
  type: 'text.delta';
  text: string;
}

export interface WorkStatusEvent extends AdapterEventBase {
  type: 'work.status';
  state: 'thinking' | 'working' | 'waiting_authorization' | 'waiting_user_input' | 'idle';
  summary: string;
  detail?: string;
}

export interface ToolStartedEvent extends AdapterEventBase {
  type: 'tool.started';
  toolCallId: string;
  toolName: string;
  /** Presentation-only classification name supplied by Main; never used for execution or authorization. */
  presentationName?: string;
  summary: string;
  mutatesExternalState: boolean;
  detail?: string;
}

export interface ToolProgressEvent extends AdapterEventBase {
  type: 'tool.progress';
  toolCallId: string;
  summary: string;
  detail?: string;
}

export interface ToolCompletedEvent extends AdapterEventBase {
  type: 'tool.completed';
  toolCallId: string;
  outcome: 'success' | 'failure';
  summary: string;
  detail?: string;
}

export interface FileProducedEvent extends AdapterEventBase {
  type: 'file.produced';
  artifactId: string;
  toolCallId?: string;
  name: string;
  artifactRef: string;
  mediaType?: string;
  sizeBytes?: number;
  /** Whether this artifact came from creating a new file or changing an existing one. */
  changeKind?: 'create' | 'modify';
  /** Adapter-only source claim. Main removes this before forwarding to renderer. */
  source?: ArtifactSourceClaim;
  sourceKind?: ArtifactSourceKind;
  registrationMethod?: ArtifactRegistrationMethod;
  availability?: ArtifactAvailability;
  cached?: boolean;
  /** Opaque local file identity assigned by Main for the delivery list. */
  localSourceKey?: string;
}

export interface ReasoningStartedEvent extends AdapterEventBase {
  type: 'reasoning.started';
  reasoningId: string;
  summary: string;
}

export interface ReasoningDeltaEvent extends AdapterEventBase {
  type: 'reasoning.delta';
  reasoningId: string;
  text: string;
}

export interface ReasoningCompletedEvent extends AdapterEventBase {
  type: 'reasoning.completed';
  reasoningId: string;
  outcome: 'completed' | 'interrupted';
  truncated: boolean;
}

export interface AuthorizationRequestedEvent extends AdapterEventBase {
  type: 'authorization.requested';
  authorizationId: string;
  toolCallId?: string;
  action: 'read_file' | 'write_file' | 'delete_file' | 'run_command' | 'computer_control' | 'external_side_effect';
  risk: 'low' | 'medium' | 'high';
  summary: string;
  targets: string[];
  resolution?: 'interactive' | 'display_only';
  /** Distinguishes one operation from a persistent partner-workspace change. */
  purpose?: AuthorizationPurpose;
  extensionTrust?: { extensionId: string; name: string; generation: number; kind?: 'mcp' | 'skill' };
}

export interface AuthorizationResolvedEvent extends AdapterEventBase {
  type: 'authorization.resolved';
  authorizationId: string;
  decision: 'allow_once' | 'deny';
  extensionTrustGranted?: boolean;
}

export interface UserInputQuestion {
  id: string;
  header?: string;
  prompt: string;
  options?: Array<{ label: string; description?: string }>;
  multiple?: boolean;
}

export interface UserInputRequestedEvent extends AdapterEventBase {
  type: 'user_input.requested';
  requestId: string;
  questions: UserInputQuestion[];
}

export interface UserInputResolvedEvent extends AdapterEventBase, UserInputResponse {
  type: 'user_input.resolved';
  requestId: string;
}

export interface PlanUpdatedEvent extends AdapterEventBase {
  type: 'plan.updated';
  status: 'planning' | 'waiting_user' | 'ready' | 'executing' | 'completed';
  planMode?: PlanMode;
  explanation?: string;
  steps?: Array<{ id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }>;
}

export interface RunCompletedEvent extends AdapterEventBase {
  type: 'run.completed';
  finishReason: 'completed' | 'end_turn';
}

export interface RunFailedEvent extends AdapterEventBase {
  type: 'run.failed';
  error: ProtocolError;
}

export interface RunCancelledEvent extends AdapterEventBase {
  type: 'run.cancelled';
  reason: string;
}

/**
 * Vendor and workspace-specific events travel through this open envelope.
 * Names are intentionally not part of the core union: consumers must opt in by
 * namespace and schema version before interpreting the payload.
 */
export interface ExtensionEvent extends AdapterEventBase {
  type: 'extension.event';
  namespace: string;
  name: string;
  schemaVersion: number;
  payload: JsonValue;
  correlationId?: string;
}

export type PartnerEvent =
  | SessionBoundEvent
  | MessageAcceptedEvent
  | GuidanceAppliedEvent
  | TextDeltaEvent
  | WorkStatusEvent
  | ReasoningStartedEvent
  | ReasoningDeltaEvent
  | ReasoningCompletedEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolCompletedEvent
  | FileProducedEvent
  | AuthorizationRequestedEvent
  | AuthorizationResolvedEvent
  | UserInputRequestedEvent
  | UserInputResolvedEvent
  | PlanUpdatedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | ExtensionEvent;

export interface MessageDeliveryEvent {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  type: 'message.delivery';
  eventId: EventId;
  partnerId: PartnerId;
  conversationId: ConversationId;
  connectionSource: ConnectionSource;
  clientMessageId: ClientMessageId;
  state: MessageDeliveryState;
  occurredAt: string;
  error?: ProtocolError;
}

export type RendererAgentEvent = PartnerEvent | MessageDeliveryEvent | ExistingThreadChangedEvent | ExistingThreadReplyEvent;

export interface SendMessageReceipt {
  runId: RunId;
  sessionId: SessionId;
}

export const TERMINAL_EVENT_TYPES = ['run.completed', 'run.failed', 'run.cancelled'] as const;

export function isTerminalEvent(event: PartnerEvent): event is RunCompletedEvent | RunFailedEvent | RunCancelledEvent {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(event.type);
}
