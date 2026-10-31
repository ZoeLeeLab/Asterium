import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertMemoryArchiveRecords, assertMemoryRecord, assertMemorySources, memoryWeightOrDefault, type MemoryArchiveBriefing, type MemoryRecord, type MemorySourceAnchor } from '../../shared/memoryArchive';
import type { MemoryArchiveListOptions, MemoryArchiveSnapshot, MemoryArchiveStore, MemoryArchiveStoreOptions, ReviseMemoryRecordInput } from './MemoryArchiveStore';

const APPLICATION_ID = 0x4153544d;

/** One owner per file. Connections never survive an operation or contain async work. */
export class SqliteMemoryArchiveStore implements MemoryArchiveStore {
  constructor(private readonly file: string, private readonly partnerId: string, private readonly options: MemoryArchiveStoreOptions = {}) {}

  async list(options: MemoryArchiveListOptions = {}) { return this.run((db) => this.visible(this.records(db), options)); }
  async get(id: string, options: MemoryArchiveListOptions = {}) { return (await this.list(options)).find((record) => record.memoryId === id); }
  async snapshot(options: MemoryArchiveListOptions = {}): Promise<MemoryArchiveSnapshot> {
    return this.run((db) => ({ partnerId: this.partnerId, archiveVersion: this.version(db), records: this.visible(this.records(db), options) }));
  }
  async create(record: MemoryRecord) {
    return this.run((db) => {
      this.owned(record);
      const records = this.records(db);
      if (records.some((item) => item.memoryId === record.memoryId)) throw new Error('MEMORY_RECORD_CONFLICT');
      assertMemoryArchiveRecords([...records, record], this.partnerId);
      this.write(db, record); this.bump(db); return structuredClone(record);
    }, true);
  }
  async update(record: MemoryRecord) {
    return this.run((db) => {
      this.owned(record);
      const records = this.records(db);
      const previous = this.require(records, record.memoryId);
      if (previous.deletedAt) throw new Error('MEMORY_RECORD_DELETED');
      assertMemoryArchiveRecords(records.map((item) => item.memoryId === record.memoryId ? record : item), this.partnerId);
      if (JSON.stringify(previous) !== JSON.stringify(record)) { this.write(db, record); this.bump(db); }
      return structuredClone(record);
    }, true);
  }
  async revise(id: string, input: ReviseMemoryRecordInput, expected?: string) {
    return this.change(id, (record) => {
      const next = structuredClone(record);
      for (const key of ['type', 'status', 'body', 'tags', 'sources'] as const) {
        if (input[key] !== undefined) Object.assign(next, { [key]: structuredClone(input[key]) });
      }
      if (input.status !== undefined && input.status !== 'superseded') delete next.supersededByMemoryId;
      if (input.weight !== undefined) next.weight = memoryWeightOrDefault(input.weight);
      if (input.occurredAt === null) delete next.occurredAt;
      else if (input.occurredAt !== undefined) next.occurredAt = input.occurredAt;
      if (input.supersededByMemoryId === null) delete next.supersededByMemoryId;
      else if (input.supersededByMemoryId !== undefined) next.supersededByMemoryId = input.supersededByMemoryId;
      return next;
    }, false, expected);
  }
  async appendComment(id: string, content: string, sources: MemorySourceAnchor[] = [], expected?: string) {
    return this.change(id, (record, now) => ({ ...record,
      sources: [...record.sources, ...structuredClone(sources)],
      comments: [...record.comments, { commentId: (this.options.createCommentId ?? randomUUID)(), content, createdAt: now }],
    }), false, expected);
  }
  async addSource(id: string, source: MemorySourceAnchor) {
    return this.change(id, (record) => ({ ...record, sources: [...record.sources, structuredClone(source)] }));
  }
  async softDelete(id: string, expected?: string) {
    return this.change(id, (record, now) => record.deletedAt ? record : { ...record, deletedAt: now }, true, expected);
  }
  async restore(id: string, expected?: string) {
    return this.change(id, (record) => { delete record.deletedAt; return record; }, true, expected);
  }
  async purge(id: string, expected?: string) {
    return this.run((db) => {
      const records = this.records(db); const record = this.require(records, id, expected);
      if (!record.deletedAt) throw new Error('MEMORY_PURGE_REQUIRES_SOFT_DELETE');
      assertMemoryArchiveRecords(records.filter((item) => item.memoryId !== id), this.partnerId);
      db.prepare('DELETE FROM memories WHERE memory_id = ?').run(id);
      db.prepare('DELETE FROM fallback_memories WHERE memory_id = ?').run(id);
      this.bump(db); return record;
    }, true);
  }
  async fallbackMemoryIds() { return this.run((db) => db.prepare('SELECT memory_id FROM fallback_memories ORDER BY memory_id').all().map((row) => row.memory_id as string)); }
  async fallbackReceipt(operationId: string) { return this.run((db) => this.receipt(db, operationId)); }
  async applyFallback(operationId: string, expectedVersion: string, after: MemoryRecord[], receipt: string) {
    return this.run((db) => {
      const previous = this.receipt(db, operationId); if (previous !== undefined) return previous;
      if (this.version(db) !== expectedVersion) throw new Error('MEMORY_ARCHIVE_STALE');
      const records = this.records(db); const ids = new Set<string>();
      for (const record of after) {
        this.owned(record);
        if (ids.has(record.memoryId)) throw new Error('MEMORY_FALLBACK_DUPLICATE_OPERATION');
        ids.add(record.memoryId);
        if (record.deletedAt || records.find((item) => item.memoryId === record.memoryId)?.deletedAt) throw new Error('MEMORY_RECORD_DELETED');
      }
      assertMemoryArchiveRecords([...records.filter((record) => !ids.has(record.memoryId)), ...after], this.partnerId);
      let changed = false;
      for (const record of after) {
        if (JSON.stringify(records.find((item) => item.memoryId === record.memoryId)) !== JSON.stringify(record)) changed = true;
        this.write(db, record);
        db.prepare('INSERT OR IGNORE INTO fallback_memories VALUES (?)').run(record.memoryId);
        this.options.afterFallbackRecordWrite?.();
      }
      db.prepare('INSERT INTO fallback_receipts VALUES (?, ?)').run(operationId, receipt);
      if (changed) this.bump(db);
      return receipt;
    }, true);
  }
  async getBriefing() {
    return this.run((db) => { const row = db.prepare('SELECT data FROM briefing_cache WHERE id = 1').get(); return row ? JSON.parse(row.data as string) as MemoryArchiveBriefing : undefined; });
  }
  async putBriefing(briefing: MemoryArchiveBriefing) {
    this.run((db) => {
      if (briefing.partnerId !== this.partnerId) throw new Error('MEMORY_ARCHIVE_INVALID');
      if (briefing.archiveVersion === this.version(db)) db.prepare('INSERT OR REPLACE INTO briefing_cache VALUES (1, ?)').run(JSON.stringify(briefing));
    }, true);
  }
  private change(id: string, transform: (record: MemoryRecord, now: string) => MemoryRecord, allowDeleted = false, expected?: string) {
    return this.run((db) => {
      const records = this.records(db); const record = this.require(records, id, expected);
      if (record.deletedAt && !allowDeleted) throw new Error('MEMORY_RECORD_DELETED');
      const now = (this.options.now ?? (() => new Date().toISOString()))();
      const next = transform(structuredClone(record), now); this.owned(next); assertMemorySources(next.sources);
      if (JSON.stringify(next) === JSON.stringify(record)) return record;
      next.updatedAt = now;
      assertMemoryArchiveRecords(records.map((item) => item.memoryId === id ? next : item), this.partnerId);
      this.write(db, next); this.bump(db); return next;
    }, true);
  }
  private require(records: MemoryRecord[], id: string, expected?: string) {
    const record = records.find((item) => item.memoryId === id);
    if (!record) throw new Error('MEMORY_RECORD_NOT_FOUND');
    if (expected !== undefined && expected !== record.updatedAt) throw new Error('MEMORY_RECORD_STALE');
    return record;
  }
  private owned(record: MemoryRecord) { assertMemoryRecord(record); if (record.partnerId !== this.partnerId) throw new Error('MEMORY_ARCHIVE_INVALID'); }
  private records(db: DatabaseSync) {
    const records = db.prepare('SELECT memory_id, data FROM memories ORDER BY memory_id').all().map((row) => {
      const record = JSON.parse(row.data as string) as MemoryRecord;
      if (record.memoryId !== row.memory_id) throw new Error('MEMORY_ARCHIVE_INVALID');
      return record;
    });
    assertMemoryArchiveRecords(records, this.partnerId); return records;
  }
  private write(db: DatabaseSync, record: MemoryRecord) { db.prepare('INSERT OR REPLACE INTO memories VALUES (?, ?)').run(record.memoryId, JSON.stringify(record)); }
  private bump(db: DatabaseSync) { db.exec('UPDATE archive_meta SET revision = revision + 1'); }
  private version(db: DatabaseSync) { const row = db.prepare('SELECT instance_id, revision FROM archive_meta').get()!; return `sqlite-v1:${row.instance_id}:${row.revision}`; }
  private receipt(db: DatabaseSync, id: string) { return db.prepare('SELECT receipt FROM fallback_receipts WHERE operation_id = ?').get(id)?.receipt as string | undefined; }
  private visible(records: MemoryRecord[], options: MemoryArchiveListOptions) { return options.includeDeleted ? records : records.filter((record) => !record.deletedAt); }
  private run<T>(operation: (db: DatabaseSync) => T, write = false): T {
    if (!this.partnerId.trim()) throw new Error('MEMORY_ARCHIVE_INVALID');
    let ancestor = path.dirname(path.resolve(this.file));
    while (path.dirname(ancestor) !== ancestor) {
      if (existsSync(ancestor) && (lstatSync(ancestor).isSymbolicLink() || !lstatSync(ancestor).isDirectory())) throw new Error('MEMORY_DATABASE_PATH_INVALID');
      ancestor = path.dirname(ancestor);
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    const existed = existsSync(this.file);
    if (existed && (!lstatSync(this.file).isFile() || lstatSync(this.file).isSymbolicLink())) throw new Error('MEMORY_DATABASE_PATH_INVALID');
    const db = new DatabaseSync(this.file);
    let initialized = existed;
    try {
      db.exec('PRAGMA busy_timeout = 250; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
      if (!existed) {
        db.exec(`PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE;
          CREATE TABLE archive_meta (partner_id TEXT NOT NULL, instance_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0));
          CREATE TABLE memories (memory_id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
          CREATE TABLE fallback_memories (memory_id TEXT PRIMARY KEY REFERENCES memories(memory_id) ON DELETE CASCADE);
          CREATE TABLE fallback_receipts (operation_id TEXT PRIMARY KEY, receipt TEXT NOT NULL);
          CREATE TABLE briefing_cache (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL CHECK(json_valid(data)));
          PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1;`);
        db.prepare('INSERT INTO archive_meta VALUES (?, ?, 0)').run(this.partnerId, randomUUID());
        db.exec('COMMIT'); initialized = true;
      }
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 1 || db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID) throw new Error('MEMORY_DATABASE_VERSION_UNSUPPORTED');
      const owners = db.prepare('SELECT partner_id FROM archive_meta').all();
      if (owners.length !== 1 || owners[0].partner_id !== this.partnerId) throw new Error('MEMORY_ARCHIVE_INVALID');
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      const result = operation(db); db.exec('COMMIT'); return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally {
      db.close();
      if (!initialized && !existed) unlinkSync(this.file);
    }
  }
}
