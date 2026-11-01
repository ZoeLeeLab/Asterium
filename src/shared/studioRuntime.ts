import type { CodexRuntimeInfo, ConnectionSource, NativeThreadScope, RuntimeModelObservation } from './agentProtocol';
import type { ProjectPermissionMode } from './projectExecutionPolicy';
import type { MessageAttachment } from './contracts/attachments';

/** Separate from single-chat attachment storage; no user-supplied filesystem paths. */
export function studioAttachmentConversationId(roomId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,139}$/.test(roomId)) throw new Error('INVALID_STUDIO_ATTACHMENT_ROOM');
  return `studio-attachments-${roomId}`;
}

/** Exact internal response used when a queued partner deliberately has nothing to add. */
export const STUDIO_PASS_MARKER = '<asterium_group_pass />';

/** Single source for Studio context and external MCP bootstrap budgets. */
export const STUDIO_PUBLIC_HISTORY_BUDGET = {
  maxMessages: 160,
  maxCharacters: 80_000,
} as const;

export const STUDIO_DISCUSSION_LIMITS = {
  summarizeAfterRepliesPerParticipant: 3,
  pauseAfterRepliesPerParticipant: 5,
  repliesPerParticipantAfterContinue: 2,
} as const;

export type StudioMessageStatus = 'completed' | 'interrupted';
export type StudioAuthorType = 'user' | 'partner' | 'system';
export type StudioRoundState = 'queued' | 'running' | 'waiting_authorization' | 'waiting_user_input' | 'waiting_discussion_decision' | 'completed' | 'failed' | 'cancelled';
export type StudioSpeakingMode = 'free_discussion' | 'selected_partners' | 'round_robin';
export const DEFAULT_STUDIO_SPEAKING_MODE: StudioSpeakingMode = 'free_discussion';

export interface StudioMention {
  partnerId: string;
  label: string;
  start?: number;
  end?: number;
  source: 'user' | 'partner';
}

export interface StudioRoomSettings {
  speakingMode: StudioSpeakingMode;
  selectedPartnerIds: string[];
  discussionProtectionEnabled: boolean;
}

export interface StudioRoomMetadata {
  roomId: string;
  projectId: string;
  name: string;
  memberIds: string[];
  archived?: boolean;
}

export interface StudioRoomMessage {
  attachments?: MessageAttachment[];
  automation?: { automationId: string; runId: string; name: string };
  roomId: string;
  messageId: string;
  seq: number;
  roundId: string;
  authorType: StudioAuthorType;
  authorId: string;
  content: string;
  createdAt: string;
  status: StudioMessageStatus;
  mentions?: StudioMention[];
  /** Main-owned publication audience for asynchronous external participants. */
  externalParticipantIds?: string[];
}

export interface StudioMemberCursor {
  roomId: string;
  partnerId: string;
  bindingGeneration: number;
  processedThroughSeq: number;
  updatedAt: string;
}

export interface StudioRoundMember {
  turnId: string;
  partnerId: string;
  conversationId?: string;
  state: 'queued' | 'running' | 'completed' | 'passed' | 'failed' | 'cancelled';
  inputThroughSeq?: number;
  bindingGeneration?: number;
  runId?: string;
  sessionId?: string;
  mentions?: StudioMention[];
}

export interface StudioRound {
  roundId: string;
  roomId: string;
  triggerMessageId: string;
  speakerQueue: string[];
  members: StudioRoundMember[];
  currentPartnerId?: string;
  state: StudioRoundState;
  participantIds: string[];
  /** Project execution policy captured once when this round starts. */
  permissionMode: ProjectPermissionMode;
  discussionWarningIssued?: boolean;
  discussionPauseCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudioRoomSnapshot {
  metadata: StudioRoomMetadata;
  messages: StudioRoomMessage[];
  cursors: StudioMemberCursor[];
  activeRound?: StudioRound;
  mutedPartnerIds: string[];
  settings: StudioRoomSettings;
  rotationOffset: number;
  models: Record<string, RuntimeModelObservation>;
  /** Main-owned state, preserved by project rollback. Never export this as an MCP DTO. */
  externalState?: StudioExternalRoomState;
  streaming?: { partnerId: string; runId: string; content: string };
}

export interface StudioRoomMembership {
  partnerId: string;
  membershipGeneration: number;
  active: boolean;
}

/** Internal authority context. The transport must derive partnerId from credentials. */
export interface StudioExternalMemberContext {
  roomId: string;
  partnerId: string;
  membershipGeneration: number;
}

export interface StudioExternalRoomState {
  memberships: StudioRoomMembership[];
  reads: Array<StudioExternalMemberContext & { readId: string; throughSeq: number; content?: { messageId: string; nextOffset: number; lastOffset: number; lastLimit: number } }>;
  processed: Array<StudioExternalMemberContext & { processedThroughSeq: number }>;
  sends: Array<StudioExternalMemberContext & { requestId: string; contentHash: string; messageId: string }>;
}

export interface StudioExternalHistoryRequest {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
}

export interface StudioExternalHistoryPage {
  messages: StudioRoomMessage[];
  readId: string;
  /** Frozen scan boundary; forward pages can scan past omitted own messages, even on an empty page. */
  throughSeq: number;
  latestSeq: number;
  processedThroughSeq: number;
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface StudioRoomMarkdownExportRequest {
  roomId: string;
  content: string;
}

export interface NativeThreadBinding {
  bindingId: string;
  partnerId: string;
  source: ConnectionSource;
  scope: NativeThreadScope;
  conversationId: string;
  roomId?: string;
  projectId?: string;
  workflowGenerationId?: string;
  nativeThreadId?: string;
  /** Last native turn known to have completed through Asterium. */
  lastCompletedRunId?: string;
  /** Last Main-managed persona state accepted by this native thread. */
  personaVersion?: string;
  bootstrapVersion?: number;
  bootstrap?: import('./agentProtocol').SessionBootstrapDocument;
  /** Native profile mutation was not yet committed or successfully compensated. */
  profileRecoveryRequired?: boolean;
  /** Last Studio speaking mode accepted by this native thread. */
  studioSpeakingMode?: StudioSpeakingMode;
  generation: number;
  state: 'pending' | 'active' | 'invalid';
  createdAt: string;
  updatedAt: string;
}

export interface StudioStartRoundRequest {
  /** Renderer supplies staged selections; Main supplies canonical attachments. */
  attachmentSelectionIds?: string[];
  attachments?: MessageAttachment[];
  room: StudioRoomMetadata;
  messageId: string;
  content: string;
  authorId: string;
  mentions?: StudioMention[];
  /** Compatibility candidate list; Main recomputes the authoritative queue. */
  speakerQueue: string[];
}

export interface StudioPrepareTurnRequest {
  roomId: string;
  roundId: string;
  partnerId: string;
  source: ConnectionSource;
  adapterType?: 'codex_cli' | 'claude_code';
  partnerRootGrantId?: string;
  codexRuntimeId?: string;
  codexRuntimeEnvironment?: CodexRuntimeInfo['environment'];
}

export interface StudioPreparedTurn {
  attachments?: MessageAttachment[];
  room: StudioRoomMetadata;
  round: StudioRound;
  settings: StudioRoomSettings;
  mutedPartnerIds: string[];
  conversationId: string;
  bindingGeneration: number;
  nativeThreadId?: string;
  previousSpeakingMode?: StudioSpeakingMode;
  inputThroughSeq: number;
  processedAfterSeq: number;
  messages: StudioRoomMessage[];
  models: Record<string, RuntimeModelObservation>;
  omittedRange?: { fromSeq: number; throughSeq: number };
}

export interface StudioSetMutedRequest {
  roomId: string;
  partnerIds: string[];
}

export interface StudioSetSettingsRequest {
  roomId: string;
  settings: StudioRoomSettings;
}

export interface StudioResolveDiscussionRequest {
  roomId: string;
  decision: 'continue' | 'end';
}

export interface StudioCancelRoundRequest {
  roomId: string;
}

export interface StudioAnnouncementRequest {
  roomId: string;
  content: string;
}
