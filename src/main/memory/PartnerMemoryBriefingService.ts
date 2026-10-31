import type { MemoryArchiveBriefing, MemoryRecord } from '../../shared/memoryArchive';
import type { PartnerMemoryService } from './PartnerMemoryService';

const MAX_RECORDS_TOTAL = 18;
const MAX_RECORDS_PER_SECTION = 8;
const MAX_BODY_CHARACTERS = 500;
const MAX_COMMENT_CHARACTERS = 240;

export type PartnerMemoryBriefing = MemoryArchiveBriefing;

export interface PartnerMemoryBriefingServiceOptions {
  now?: () => Date;
}

export class PartnerMemoryBriefingService {
  private readonly now: () => Date;

  constructor(
    private readonly memories: PartnerMemoryService,
    options: PartnerMemoryBriefingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async get(partnerId: string): Promise<PartnerMemoryBriefing> {
    const snapshot = await this.memories.snapshot(partnerId);
    const now = this.now();
    const logicalDate = localDate(now);
    const candidate = await this.memories.cachedBriefing(partnerId);
    const cached = isBriefing(candidate) ? candidate : undefined;
    if (cached
      && cached.partnerId === partnerId
      && cached.archiveVersion === snapshot.archiveVersion
      && cached.logicalDate === logicalDate) {
      return cached;
    }

    const briefing: PartnerMemoryBriefing = {
      schemaVersion: 1,
      partnerId,
      archiveVersion: snapshot.archiveVersion,
      logicalDate,
      generatedAt: now.toISOString(),
      content: generatePartnerMemoryBriefing(snapshot.records, logicalDate),
    };
    await this.memories.cacheBriefing(partnerId, briefing);
    return briefing;
  }
}

export function generatePartnerMemoryBriefing(records: MemoryRecord[], logicalDate: string) {
  const eligible = records.filter((record) => !record.deletedAt && record.status !== 'obsolete' && record.status !== 'superseded');
  const claimed = new Set<string>();
  const sections: Array<{ title: string; records: MemoryRecord[] }> = [];

  sections.push(section('自我认知', takeByType(eligible, claimed, ['self_summary'])));
  sections.push(section('与用户的关系', takeByType(eligible, claimed, ['relationship_with_user'])));
  sections.push(section('今天发生的事情', takeByDate(eligible, claimed, logicalDate, logicalDate)));
  sections.push(section('最近几天的情况', takeByDate(eligible, claimed, shiftLogicalDate(logicalDate, -6), shiftLogicalDate(logicalDate, -1))));
  sections.push(section('长期稳定的信息', takeByType(eligible, claimed, [
    'stable_fact',
    'long_term_project',
    'recurring_behavior_pattern',
    'preference_and_collaboration',
  ])));
  sections.push(section('长期未闭合的问题和后续', eligible.filter((record) => (
    !claimed.has(record.memoryId)
    && record.type === 'open_question_and_follow_up'
    && record.status === 'active'
  ))));

  let remainingRecords = MAX_RECORDS_TOTAL;
  const rendered = sections.map(({ title, records: sectionRecords }) => {
    const renderedSection = renderSection(title, sectionRecords, remainingRecords);
    remainingRecords -= renderedSection.used;
    return renderedSection.content;
  });
  return [
    '[星丛会话记忆简报]',
    `逻辑日期：${logicalDate}`,
    '说明：本简报仅由结构化记忆档案确定性生成；如需完整检索，请使用 search_memory。',
    '',
    ...rendered,
  ].join('\n').trimEnd();
}

function section(title: string, records: MemoryRecord[]) {
  return { title, records };
}

function takeByType(records: MemoryRecord[], claimed: Set<string>, types: MemoryRecord['type'][]) {
  const typeSet = new Set(types);
  const selected = records.filter((record) => !claimed.has(record.memoryId) && typeSet.has(record.type));
  for (const record of selected) claimed.add(record.memoryId);
  return selected;
}

function takeByDate(records: MemoryRecord[], claimed: Set<string>, from: string, to: string) {
  const selected = records.filter((record) => {
    if (claimed.has(record.memoryId) || !record.occurredAt) return false;
    const date = localDate(new Date(record.occurredAt));
    return date >= from && date <= to;
  });
  for (const record of selected) claimed.add(record.memoryId);
  return selected;
}

function renderSection(title: string, records: MemoryRecord[], remainingRecords: number) {
  const ordered = [...records].sort(compareBriefingRecords);
  const visible = ordered.slice(0, Math.min(MAX_RECORDS_PER_SECTION, remainingRecords));
  const lines = [`## ${title}`];
  if (ordered.length === 0) {
    lines.push('- 暂无');
  } else {
    lines.push(...visible.map(renderRecord));
    if (ordered.length > visible.length) lines.push(`- 另有 ${ordered.length - visible.length} 条，请使用 search_memory 查看。`);
  }
  lines.push('');
  return { content: lines.join('\n'), used: visible.length };
}

function renderRecord(record: MemoryRecord) {
  const details = [
    `权重 ${record.weight}`,
    record.occurredAt ? `发生于 ${record.occurredAt}` : undefined,
    record.status === 'completed' ? '已完成' : undefined,
    record.tags.length > 0 ? `标签：${record.tags.join('、')}` : undefined,
  ].filter((item): item is string => Boolean(item));
  const latestComment = [...record.comments].sort((left, right) => compareText(right.createdAt, left.createdAt))[0];
  const comment = latestComment ? `；最近补充：${truncate(normalizeInline(latestComment.content), MAX_COMMENT_CHARACTERS)}` : '';
  return `- ${truncate(normalizeInline(record.body), MAX_BODY_CHARACTERS)}（${details.join('；')}）${comment}`;
}

function compareBriefingRecords(left: MemoryRecord, right: MemoryRecord) {
  return right.weight - left.weight
    || compareText(right.occurredAt ?? '', left.occurredAt ?? '')
    || compareText(right.updatedAt, left.updatedAt)
    || compareText(left.memoryId, right.memoryId);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeInline(value: string) {
  return value.trim().replace(/\s+/gu, ' ');
}

function truncate(value: string, maximum: number) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function localDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftLogicalDate(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function isBriefing(value: unknown): value is PartnerMemoryBriefing {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && hasText(value.partnerId)
    && hasText(value.archiveVersion)
    && /^\d{4}-\d{2}-\d{2}$/u.test(String(value.logicalDate))
    && isIsoTimestamp(value.generatedAt)
    && typeof value.content === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
