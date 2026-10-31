import { randomUUID } from 'node:crypto';
import {
  MEMORY_STATUSES,
  MEMORY_TYPES,
  assertMemorySources,
  memorySourceKey,
  memoryWeightOrDefault,
  type MemoryRecord,
  type MemorySourceAnchor,
  type MemorySourceReadResult,
  type MemoryStatus,
  type MemoryType,
} from '../../shared/memoryArchive';
import type { MemorySourceService } from './MemorySourceService';
import type { PartnerMemoryService } from './PartnerMemoryService';

export interface MemoryToolContext {
  partnerId: string;
  currentSource?: MemorySourceAnchor;
}

export interface HoldMemoryInput {
  type: MemoryType;
  body: string;
  tags?: string[];
  weight?: number;
  occurredAt?: string;
  sources?: MemorySourceAnchor[];
}

export interface SearchMemoryInput {
  text?: string;
  tags?: string[];
  types?: MemoryType[];
  statuses?: MemoryStatus[];
  from?: string;
  to?: string;
  limit?: number;
}

export interface CommentMemoryInput {
  memoryId: string;
  content: string;
  sources?: MemorySourceAnchor[];
}

export interface UpdateMemoryInput {
  memoryId: string;
  type?: MemoryType;
  status?: MemoryStatus;
  body?: string;
  tags?: string[];
  weight?: number;
  occurredAt?: string | null;
  supersededByMemoryId?: string | null;
}

export interface ReadMemorySourceInput {
  memoryId: string;
  sourceIndex?: number;
}

export class PartnerMemoryToolService {
  constructor(
    private readonly memories: PartnerMemoryService,
    private readonly sources: MemorySourceService,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createMemoryId: () => string = randomUUID,
  ) {}

  async hold(context: MemoryToolContext, input: HoldMemoryInput) {
    assertText(input.body, 'MEMORY_BODY_REQUIRED');
    if (!MEMORY_TYPES.includes(input.type)) throw new Error('MEMORY_TYPE_INVALID');
    const tags = normalizeTags(input.tags ?? []);
    const occurredAt = optionalTimestamp(input.occurredAt);
    const capturedSources = await this.captureSources(context, input.sources ?? [], true);
    const createdAt = this.now();
    const record: MemoryRecord = {
      schemaVersion: 1,
      memoryId: this.createMemoryId(),
      partnerId: context.partnerId,
      type: input.type,
      status: 'active',
      body: input.body.trim(),
      tags,
      weight: memoryWeightOrDefault(input.weight),
      ...(occurredAt ? { occurredAt } : {}),
      createdAt,
      updatedAt: createdAt,
      comments: [],
      sources: capturedSources,
    };
    return this.memories.create(context.partnerId, record);
  }

  async search(context: MemoryToolContext, input: SearchMemoryInput) {
    return searchMemoryRecords(await this.memories.list(context.partnerId), input);
  }

  async comment(context: MemoryToolContext, input: CommentMemoryInput, expectedUpdatedAt?: string) {
    assertText(input.memoryId, 'MEMORY_ID_REQUIRED');
    assertText(input.content, 'MEMORY_COMMENT_REQUIRED');
    const record = await this.requireMemory(context.partnerId, input.memoryId);
    const captured = await this.captureSources(context, input.sources ?? [], true);
    const existing = new Set(record.sources.map(memorySourceKey));
    const additions = captured.filter((source) => !existing.has(memorySourceKey(source)));
    return this.memories.appendComment(context.partnerId, input.memoryId, input.content.trim(), additions, expectedUpdatedAt);
  }

  async update(context: MemoryToolContext, input: UpdateMemoryInput, expectedUpdatedAt?: string) {
    assertText(input.memoryId, 'MEMORY_ID_REQUIRED');
    await this.requireMemory(context.partnerId, input.memoryId);
    if (input.type !== undefined && !MEMORY_TYPES.includes(input.type)) throw new Error('MEMORY_TYPE_INVALID');
    if (input.status !== undefined && !MEMORY_STATUSES.includes(input.status)) throw new Error('MEMORY_STATUS_INVALID');
    if (input.body !== undefined) assertText(input.body, 'MEMORY_BODY_REQUIRED');
    const tags = input.tags === undefined ? undefined : normalizeTags(input.tags);
    const occurredAt = input.occurredAt === null ? null : optionalTimestamp(input.occurredAt);
    const weight = input.weight === undefined ? undefined : memoryWeightOrDefault(input.weight);
    return this.memories.revise(context.partnerId, input.memoryId, {
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.body !== undefined ? { body: input.body.trim() } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(weight !== undefined ? { weight } : {}),
      ...(input.occurredAt !== undefined ? { occurredAt } : {}),
      ...(input.supersededByMemoryId !== undefined ? { supersededByMemoryId: input.supersededByMemoryId } : {}),
    }, expectedUpdatedAt);
  }

  async readSource(context: MemoryToolContext, input: ReadMemorySourceInput): Promise<Array<{ index: number; result: MemorySourceReadResult }>> {
    assertText(input.memoryId, 'MEMORY_ID_REQUIRED');
    const record = await this.requireMemory(context.partnerId, input.memoryId);
    if (input.sourceIndex !== undefined && (!Number.isSafeInteger(input.sourceIndex) || input.sourceIndex < 0 || input.sourceIndex >= record.sources.length)) {
      throw new Error('MEMORY_SOURCE_INDEX_INVALID');
    }
    const entries = input.sourceIndex === undefined
      ? record.sources.map((source, index) => ({ source, index }))
      : [{ source: record.sources[input.sourceIndex], index: input.sourceIndex }];
    return Promise.all(entries.map(async ({ source, index }) => ({ index, result: await this.sources.read(context.partnerId, source) })));
  }

  private async requireMemory(partnerId: string, memoryId: string) {
    const record = await this.memories.get(partnerId, memoryId);
    if (!record) throw new Error('MEMORY_RECORD_NOT_FOUND');
    return record;
  }

  private async captureSources(context: MemoryToolContext, requested: MemorySourceAnchor[], includeCurrent: boolean) {
    assertMemorySources(requested);
    const locators = [...requested];
    if (includeCurrent && context.currentSource && !locators.some((source) => memorySourceKey(source) === memorySourceKey(context.currentSource!))) {
      locators.push(context.currentSource);
    }
    const captured: MemorySourceAnchor[] = [];
    for (const source of locators) captured.push(await this.sources.capture(context.partnerId, source));
    return captured;
  }
}

export function searchMemoryRecords(records: MemoryRecord[], input: SearchMemoryInput) {
  const tags = normalizeTags(input.tags ?? []);
  const types = uniqueEnum(input.types ?? [], MEMORY_TYPES, 'MEMORY_TYPE_INVALID');
  const statuses = uniqueEnum(input.statuses ?? [], MEMORY_STATUSES, 'MEMORY_STATUS_INVALID');
  const from = optionalTimestamp(input.from);
  const to = optionalTimestamp(input.to);
  if (from && to && from > to) throw new Error('MEMORY_TIME_RANGE_INVALID');
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('MEMORY_SEARCH_LIMIT_INVALID');
  const text = input.text?.trim().toLocaleLowerCase();
  return records
    .filter((record) => !types.length || types.includes(record.type))
    .filter((record) => !statuses.length || statuses.includes(record.status))
    .filter((record) => tags.every((tag) => record.tags.includes(tag)))
    .filter((record) => {
      const timestamp = record.occurredAt ?? record.createdAt;
      return (!from || timestamp >= from) && (!to || timestamp <= to);
    })
    .filter((record) => !text || [record.body, ...record.tags, ...record.comments.map((comment) => comment.content)]
      .some((value) => value.toLocaleLowerCase().includes(text)))
    .sort(compareSearchResults)
    .slice(0, limit);
}

function normalizeTags(tags: string[]) {
  if (!Array.isArray(tags)) throw new Error('MEMORY_TAGS_INVALID');
  const normalized = tags.map((tag) => typeof tag === 'string' ? tag.trim() : '');
  if (normalized.some((tag) => !tag) || new Set(normalized).size !== normalized.length) throw new Error('MEMORY_TAGS_INVALID');
  return normalized;
}

function uniqueEnum<T extends string>(values: T[], allowed: readonly T[], error: string) {
  if (!Array.isArray(values) || values.some((value) => !allowed.includes(value)) || new Set(values).size !== values.length) throw new Error(error);
  return values;
}

function optionalTimestamp(value: string | undefined) {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!value || Number.isNaN(date.valueOf()) || date.toISOString() !== value) throw new Error('MEMORY_TIMESTAMP_INVALID');
  return value;
}

function assertText(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error);
}

function compareSearchResults(left: MemoryRecord, right: MemoryRecord) {
  if (left.weight !== right.weight) return right.weight - left.weight;
  const leftTime = left.occurredAt ?? left.createdAt;
  const rightTime = right.occurredAt ?? right.createdAt;
  return rightTime.localeCompare(leftTime) || left.memoryId.localeCompare(right.memoryId);
}
