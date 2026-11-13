export const MEMORY_TYPES = [
  'self_summary',
  'relationship_with_user',
  'stable_fact',
  'long_term_project',
  'recurring_behavior_pattern',
  'preference_and_collaboration',
  'open_question_and_follow_up',
] as const;

export const MEMORY_STATUSES = ['active', 'completed', 'obsolete', 'superseded'] as const;
export const DEFAULT_MEMORY_WEIGHT = 3 as const;

export type MemoryType = typeof MEMORY_TYPES[number];
export type MemoryStatus = typeof MEMORY_STATUSES[number];
export type MemoryWeight = 1 | 2 | 3 | 4 | 5;

export type MemorySourceExcerptOffset = -2 | -1 | 0 | 1 | 2;

export interface MemorySourceExcerptMessage {
  messageId: string;
  authorType: 'user' | 'partner' | 'system';
  authorId: string;
  content: string;
  createdAt: string;
  contentHash: string;
  offset: MemorySourceExcerptOffset;
}

export interface MemorySourceFrozenExcerpt {
  capturedAt: string;
  messages: MemorySourceExcerptMessage[];
}

interface MemorySourceEvidence {
  /** SHA-256 of the exact UTF-8 target message content. */
  contentHash?: string;
  /** Immutable context available when the source was captured. */
  frozenExcerpt?: MemorySourceFrozenExcerpt;
}

export interface SingleChatMemorySource extends MemorySourceEvidence {
  kind: 'single_chat';
  conversationId: string;
  messageId: string;
}

export interface StudioMemorySource extends MemorySourceEvidence {
  kind: 'studio';
  roomId: string;
  messageId: string;
}

export interface ImportedTextMemorySource {
  contentHash?: never;
  frozenExcerpt?: never;
  kind: 'imported_text';
  messageId: string;
  label: string;
  documentHash: string;
  excerpt: string;
}

export type MemorySourceAnchor = SingleChatMemorySource | StudioMemorySource | ImportedTextMemorySource;

export interface MemoryComment {
  commentId: string;
  content: string;
  createdAt: string;
}

export interface MemoryRecord {
  schemaVersion: 1;
  memoryId: string;
  partnerId: string;
  type: MemoryType;
  status: MemoryStatus;
  body: string;
  tags: string[];
  weight: MemoryWeight;
  occurredAt?: string;
  createdAt: string;
  updatedAt: string;
  comments: MemoryComment[];
  sources: MemorySourceAnchor[];
  supersededByMemoryId?: string;
  deletedAt?: string;
}

export interface MemoryArchiveQuery {
  partnerId: string;
  includeDeleted?: boolean;
  archivedOnly?: boolean;
  text?: string;
  tags?: string[];
  types?: MemoryType[];
  statuses?: MemoryStatus[];
  from?: string;
  to?: string;
  limit?: number;
}

export interface MemoryArchiveQueryResult {
  partnerId: string;
  archiveVersion: string;
  records: MemoryRecord[];
  /** Memories created or updated by the fallback consolidator. */
  fallbackMemoryIds?: string[];
}

export interface MemoryArchiveBriefing {
  schemaVersion: 1;
  partnerId: string;
  archiveVersion: string;
  logicalDate: string;
  generatedAt: string;
  content: string;
}

export interface MemoryArchiveCreateRequest {
  partnerId: string;
  type: MemoryType;
  body: string;
  tags?: string[];
  weight?: number;
  occurredAt?: string;
}

export interface MemoryArchiveUpdateRequest {
  partnerId: string;
  memoryId: string;
  expectedUpdatedAt: string;
  type?: MemoryType;
  status?: MemoryStatus;
  body?: string;
  tags?: string[];
  weight?: number;
  occurredAt?: string | null;
  supersededByMemoryId?: string | null;
}

export interface MemoryArchiveCommentRequest {
  partnerId: string;
  memoryId: string;
  expectedUpdatedAt: string;
  content: string;
}

export interface MemoryArchiveMutationRequest {
  partnerId: string;
  memoryId: string;
  expectedUpdatedAt: string;
}

export interface MemoryArchiveBulkPurgeRequest {
  partnerId: string;
  records: Array<Pick<MemoryArchiveMutationRequest, 'memoryId' | 'expectedUpdatedAt'>>;
}

export interface MemoryArchiveSourceReadRequest {
  partnerId: string;
  memoryId: string;
  sourceIndex?: number;
}

export interface MemorySourceReadResult {
  state: 'live' | 'changed' | 'frozen' | 'unavailable';
  source: MemorySourceAnchor;
  messages: MemorySourceExcerptMessage[];
  reason?: 'source_missing' | 'content_changed' | 'source_access_denied' | 'legacy_source_missing';
}

export interface MemoryArchiveChange {
  partnerId: string;
}

export function memoryWeightOrDefault(value?: number): MemoryWeight {
  const weight = value ?? DEFAULT_MEMORY_WEIGHT;
  if (!Number.isSafeInteger(weight) || weight < 1 || weight > 5) throw new Error('MEMORY_WEIGHT_INVALID');
  return weight as MemoryWeight;
}

export function memorySourceKey(source: MemorySourceAnchor) {
  if (source.kind === 'imported_text') return JSON.stringify([source.kind, source.documentHash, source.messageId]);
  return JSON.stringify(source.kind === 'single_chat'
    ? [source.kind, source.conversationId, source.messageId]
    : [source.kind, source.roomId, source.messageId]);
}

export function assertMemorySources(value: unknown): asserts value is MemorySourceAnchor[] {
  if (!Array.isArray(value)) throw new Error('MEMORY_SOURCES_INVALID');
  const keys = new Set<string>();
  for (const source of value) {
    if (!isMemorySourceAnchor(source)) throw new Error('MEMORY_SOURCES_INVALID');
    const key = memorySourceKey(source);
    if (keys.has(key)) throw new Error('MEMORY_SOURCE_DUPLICATE');
    keys.add(key);
  }
}

export function assertMemoryRecord(value: unknown): asserts value is MemoryRecord {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !hasText(value.memoryId)
    || !hasText(value.partnerId)
    || !MEMORY_TYPES.includes(value.type as MemoryType)
    || !MEMORY_STATUSES.includes(value.status as MemoryStatus)
    || !hasText(value.body)
    || !isTags(value.tags)
    || !isMemoryWeight(value.weight)
    || !isOptionalTimestamp(value.occurredAt)
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.updatedAt)
    || !isComments(value.comments)
    || !isOptionalTimestamp(value.deletedAt)) {
    throw new Error('MEMORY_RECORD_INVALID');
  }

  assertMemorySources(value.sources);

  if (value.status === 'superseded') {
    if (!hasText(value.supersededByMemoryId) || value.supersededByMemoryId === value.memoryId) {
      throw new Error('MEMORY_SUPERSESSION_INVALID');
    }
  } else if (value.supersededByMemoryId !== undefined) {
    throw new Error('MEMORY_SUPERSESSION_INVALID');
  }
}

export function isMemoryRecord(value: unknown): value is MemoryRecord {
  try {
    assertMemoryRecord(value);
    return true;
  } catch {
    return false;
  }
}

export function assertMemoryArchiveRecords(value: unknown, partnerId: string): asserts value is MemoryRecord[] {
  if (!Array.isArray(value) || !hasText(partnerId)) throw new Error('MEMORY_ARCHIVE_INVALID');

  const records = new Map<string, MemoryRecord>();
  for (const record of value) {
    assertMemoryRecord(record);
    if (record.partnerId !== partnerId || records.has(record.memoryId)) throw new Error('MEMORY_ARCHIVE_INVALID');
    records.set(record.memoryId, record);
  }

  for (const record of records.values()) {
    const replacementId = record.supersededByMemoryId;
    if (record.status === 'superseded' && (!replacementId || !records.has(replacementId))) {
      throw new Error('MEMORY_SUPERSESSION_INVALID');
    }
  }

  assertNoSupersessionCycles(records);
}

function isMemorySourceAnchor(value: unknown): value is MemorySourceAnchor {
  if (!isRecord(value) || !hasText(value.messageId)) return false;
  if (value.kind === 'imported_text') return /^[1-9]\d{0,5}$/.test(String(value.messageId))
    && typeof value.label === 'string' && value.label.trim().length > 0 && value.label.length <= 255
    && isSha256(value.documentHash) && typeof value.excerpt === 'string' && value.excerpt.length > 0 && value.excerpt.length <= 480;
  if (!isMemorySourceEvidence(value)) return false;
  if (value.kind === 'single_chat') return hasText(value.conversationId);
  return value.kind === 'studio' && hasText(value.roomId);
}

function isMemorySourceEvidence(value: Record<string, unknown>) {
  const hasHash = value.contentHash !== undefined;
  const hasExcerpt = value.frozenExcerpt !== undefined;
  if (hasHash !== hasExcerpt) return false;
  if (!hasHash) return true;
  if (!isSha256(value.contentHash) || !isRecord(value.frozenExcerpt) || !isTimestamp(value.frozenExcerpt.capturedAt) || !Array.isArray(value.frozenExcerpt.messages)) return false;
  const offsets = new Set<number>();
  let previousOffset = -3;
  let targetMatches = false;
  for (const message of value.frozenExcerpt.messages) {
    if (!isRecord(message)
      || !hasText(message.messageId)
      || !['user', 'partner', 'system'].includes(String(message.authorType))
      || !hasText(message.authorId)
      || typeof message.content !== 'string'
      || !hasText(message.createdAt)
      || !isSha256(message.contentHash)
      || ![-2, -1, 0, 1, 2].includes(Number(message.offset))
      || offsets.has(Number(message.offset))
      || Number(message.offset) <= previousOffset) return false;
    offsets.add(Number(message.offset));
    previousOffset = Number(message.offset);
    if (message.offset === 0) targetMatches = message.messageId === value.messageId && message.contentHash === value.contentHash;
  }
  return targetMatches;
}

function isMemoryWeight(value: unknown): value is MemoryWeight {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 5;
}

function isTags(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string' && tag.trim() === tag && tag.length > 0)) return false;
  return new Set(value).size === value.length;
}

function isComments(value: unknown): value is MemoryComment[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const comment of value) {
    if (!isRecord(comment) || !hasText(comment.commentId) || !hasText(comment.content) || !isTimestamp(comment.createdAt) || ids.has(comment.commentId)) return false;
    ids.add(comment.commentId);
  }
  return true;
}

function assertNoSupersessionCycles(records: Map<string, MemoryRecord>) {
  for (const record of records.values()) {
    const visited = new Set<string>();
    let current: MemoryRecord | undefined = record;
    while (current?.status === 'superseded') {
      if (visited.has(current.memoryId)) throw new Error('MEMORY_SUPERSESSION_INVALID');
      visited.add(current.memoryId);
      const replacementId = current.supersededByMemoryId;
      if (!replacementId) throw new Error('MEMORY_SUPERSESSION_INVALID');
      current = records.get(replacementId);
    }
  }
}

function isOptionalTimestamp(value: unknown) {
  return value === undefined || isTimestamp(value);
}

function isTimestamp(value: unknown) {
  if (typeof value !== 'string' || !value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSha256(value: unknown) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
