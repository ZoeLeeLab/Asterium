import type { MemoryArchiveBriefing, MemoryRecord, MemorySourceAnchor, MemoryStatus, MemoryType, MemoryWeight } from '../../shared/memoryArchive';

export interface MemoryArchiveListOptions { includeDeleted?: boolean; }
export interface MemoryArchiveStoreOptions {
  now?: () => string;
  createCommentId?: () => string;
  /** Fault injection only; runs inside the SQLite transaction. */
  afterFallbackRecordWrite?: () => void;
}
export interface ReviseMemoryRecordInput {
  type?: MemoryType; status?: MemoryStatus; body?: string; tags?: string[]; weight?: MemoryWeight;
  occurredAt?: string | null; sources?: MemorySourceAnchor[]; supersededByMemoryId?: string | null;
}
export interface MemoryArchiveSnapshot { partnerId: string; archiveVersion: string; records: MemoryRecord[]; }
export interface MemoryArchiveStore {
  list(options?: MemoryArchiveListOptions): Promise<MemoryRecord[]>;
  get(id: string, options?: MemoryArchiveListOptions): Promise<MemoryRecord | undefined>;
  snapshot(options?: MemoryArchiveListOptions): Promise<MemoryArchiveSnapshot>;
  create(record: MemoryRecord): Promise<MemoryRecord>;
  update(record: MemoryRecord): Promise<MemoryRecord>;
  revise(id: string, input: ReviseMemoryRecordInput, expected?: string): Promise<MemoryRecord>;
  appendComment(id: string, content: string, sources?: MemorySourceAnchor[], expected?: string): Promise<MemoryRecord>;
  addSource(id: string, source: MemorySourceAnchor): Promise<MemoryRecord>;
  softDelete(id: string, expected?: string): Promise<MemoryRecord>;
  restore(id: string, expected?: string): Promise<MemoryRecord>;
  purge(id: string, expected?: string): Promise<MemoryRecord>;
  fallbackMemoryIds(): Promise<string[]>;
  fallbackReceipt(operationId: string): Promise<string | undefined>;
  applyFallback(operationId: string, expectedVersion: string, after: MemoryRecord[], receipt: string): Promise<string>;
  getBriefing?(): Promise<MemoryArchiveBriefing | undefined>;
  putBriefing?(briefing: MemoryArchiveBriefing): Promise<void>;
}
