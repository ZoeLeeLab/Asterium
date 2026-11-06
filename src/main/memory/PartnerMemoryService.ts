import path from 'node:path';
import type { PartnerProfileStore } from '../partner/PartnerProfileStore';
import type { MemoryArchiveBriefing, MemoryRecord, MemorySourceAnchor } from '../../shared/memoryArchive';
import type { MemoryArchiveListOptions, MemoryArchiveStoreOptions, ReviseMemoryRecordInput } from './MemoryArchiveStore';
import type { MemoryArchiveStore } from './MemoryArchiveStore';
import { SqliteMemoryArchiveStore } from './SqliteMemoryArchiveStore';

type ManagedMemoryDirectoryProvider = Pick<PartnerProfileStore, 'withManagedMemoryStorage'>;

export class PartnerMemoryService {
  private readonly listeners = new Set<(change: { partnerId: string }) => void>();

  constructor(
    private readonly profiles: ManagedMemoryDirectoryProvider,
    private readonly storeOptions: MemoryArchiveStoreOptions & { ready?: () => Promise<unknown> } = {},
  ) {}

  async list(partnerId: string, options: MemoryArchiveListOptions = {}) {
    return this.withArchive(partnerId, (store) => store.list(options));
  }

  async get(partnerId: string, memoryId: string, options: MemoryArchiveListOptions = {}) {
    return this.withArchive(partnerId, (store) => store.get(memoryId, options));
  }

  async snapshot(partnerId: string, options: MemoryArchiveListOptions = {}) {
    return this.withArchive(partnerId, (store) => store.snapshot(options));
  }

  async cachedBriefing(partnerId: string) { return this.withArchive(partnerId, (store) => store.getBriefing?.() ?? Promise.resolve(undefined)); }
  async cacheBriefing(partnerId: string, briefing: MemoryArchiveBriefing) { return this.withArchive(partnerId, (store) => store.putBriefing?.(briefing) ?? Promise.resolve()); }
  async fallbackMemoryIds(partnerId: string) { return this.withArchive(partnerId, (store) => store.fallbackMemoryIds()); }
  async fallbackReceipt(partnerId: string, operationId: string) { return this.withArchive(partnerId, (store) => store.fallbackReceipt(operationId)); }
  async applyFallback(partnerId: string, operationId: string, expectedVersion: string, after: MemoryRecord[], receipt: string) {
    return this.changed(partnerId, this.withArchive(partnerId, (store) => store.applyFallback(operationId, expectedVersion, after, receipt)));
  }

  importReceipt(partnerId: string, batchId: string) {
    return this.withArchive(partnerId, store => store.importReceipt(batchId));
  }

  confirmImport(partnerId: string, batchId: string, records: MemoryRecord[]) {
    return this.changed(partnerId, this.withArchive(partnerId, store => store.confirmImport(batchId, records)));
  }

  undoImport(partnerId: string, batchId: string) {
    return this.changed(partnerId, this.withArchive(partnerId, store => store.undoImport(batchId)));
  }

  async create(partnerId: string, record: MemoryRecord) {
    return this.changed(partnerId, this.withArchive(partnerId, (store) => store.create(record)));
  }

  async update(partnerId: string, record: MemoryRecord) {
    return this.changed(partnerId, this.withArchive(partnerId, (store) => store.update(record)));
  }

  async revise(partnerId: string, memoryId: string, input: ReviseMemoryRecordInput, expectedUpdatedAt?: string) {
    return this.changed(partnerId, this.withArchive(partnerId, (store) => store.revise(memoryId, input, expectedUpdatedAt)));
  }

  async appendComment(partnerId: string, memoryId: string, content: string, sources: MemorySourceAnchor[] = [], expectedUpdatedAt?: string) {
    return this.changed(partnerId, this.withArchive(partnerId, (store) => store.appendComment(memoryId, content, sources, expectedUpdatedAt)));
  }

  async addSource(partnerId: string, memoryId: string, source: MemorySourceAnchor) {
    return this.changed(partnerId, this.withArchive(partnerId, (store) => store.addSource(memoryId, source)));
  }

  async softDelete(partnerId: string, memoryId: string, expectedUpdatedAt?: string) {
    return this.changed(partnerId, this.withArchive(partnerId, (store) => store.softDelete(memoryId, expectedUpdatedAt)));
  }

  async restore(partnerId: string, memoryId: string, expectedUpdatedAt?: string) {
    return this.changed(partnerId, this.withArchive(partnerId, (store) => store.restore(memoryId, expectedUpdatedAt)));
  }

  async purge(partnerId: string, memoryId: string, expectedUpdatedAt?: string) {
    return this.changed(partnerId, this.withArchive(partnerId, (store) => store.purge(memoryId, expectedUpdatedAt)));
  }

  subscribe(listener: (change: { partnerId: string }) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async withArchive<T>(partnerId: string, operation: (store: MemoryArchiveStore) => Promise<T>) {
    await this.storeOptions.ready?.();
    if (!this.profiles.withManagedMemoryStorage) throw new Error('MEMORY_STORAGE_PROVIDER_REQUIRED');
    return this.profiles.withManagedMemoryStorage(partnerId, (directory) => operation(new SqliteMemoryArchiveStore(path.join(directory, 'memory.sqlite'), partnerId, this.storeOptions)));
  }

  private async changed<T>(partnerId: string, operation: Promise<T>) {
    const result = await operation;
    for (const listener of this.listeners) listener({ partnerId });
    return result;
  }
}
