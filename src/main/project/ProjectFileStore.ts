import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ProjectDeliveryResult,
  ProjectFileRecordSnapshot,
  ProjectFileVersionRef,
  ProjectWorkspaceFileEntry,
  ProjectWorkspaceSnapshot,
} from '../../shared/projectWorkspace';

interface ProjectFileIndex {
  version: 1;
  files: ProjectFileRecordSnapshot[];
  migratedProjectIds?: string[];
}

export interface LegacyProjectFileCandidate {
  artifactId: string;
  relativePath: string;
  originalPath?: string;
  sourcePartnerId?: string;
  sourcePartnerName?: string;
}

export interface RegisterProjectFileInput {
  projectId: string;
  sourcePath: string;
  name: string;
  artifactId?: string;
  sourcePartnerId?: string;
  sourcePartnerName?: string;
}

const EMPTY_INDEX: ProjectFileIndex = { version: 1, files: [] };

/** Main-owned identity index for the one current disk file represented in the project UI. */
export class ProjectFileStore {
  private loaded = false;
  private loading?: Promise<void>;
  private mutation = Promise.resolve();
  private readonly files = new Map<string, ProjectFileRecordSnapshot>();
  private readonly migratedProjects = new Set<string>();

  constructor(
    private readonly indexPath: string | (() => string),
    private readonly workspaces: { get(projectId: string): Promise<ProjectWorkspaceSnapshot | undefined> },
    private readonly readIndexFile: (filePath: string) => Promise<string> = (filePath) => readFile(filePath, 'utf8'),
  ) {}

  initializeProject(workspace: ProjectWorkspaceSnapshot, legacy: LegacyProjectFileCandidate[] = []) {
    return this.mutate(async () => {
      await this.load();
      const previous = [...this.files.values()].filter((item) => item.projectId === workspace.projectId);
      const wasMigrated = this.migratedProjects.has(workspace.projectId);
      try {
        for (const template of workspace.templateFiles) {
          await this.upsertExisting(workspace, path.join(workspace.rootPath, template.relativePath), 'template');
        }
        if (!wasMigrated) for (const candidate of legacy) {
          const original = candidate.originalPath && await this.isExistingProjectFile(workspace, candidate.originalPath)
            ? candidate.originalPath
            : undefined;
          const legacyPath = path.resolve(workspace.rootPath, candidate.relativePath);
          const selected = original ?? (await this.isExistingProjectFile(workspace, legacyPath) ? legacyPath : undefined);
          if (!selected) continue;
          await this.upsertExisting(workspace, selected, 'delivery', {
            artifactId: candidate.artifactId,
            sourcePartnerId: candidate.sourcePartnerId,
            sourcePartnerName: candidate.sourcePartnerName,
          });
        }
        this.migratedProjects.add(workspace.projectId);
        await this.persist();
      } catch (error) {
        for (const [fileId, record] of this.files) if (record.projectId === workspace.projectId) this.files.delete(fileId);
        for (const record of previous) this.files.set(record.fileId, record);
        if (!wasMigrated) this.migratedProjects.delete(workspace.projectId);
        throw error;
      }
    });
  }

  register(input: RegisterProjectFileInput): Promise<ProjectDeliveryResult & { created: boolean }> {
    return this.mutate(async () => {
      await this.load();
      const workspace = await this.requireWorkspace(input.projectId);
      const source = path.resolve(input.sourcePath);
      const sourceStats = await stat(source).catch(() => undefined);
      if (!sourceStats?.isFile()) throw new Error('PROJECT_DELIVERY_SOURCE_INVALID');

      let destination = source;
      let created = false;
      if (!await this.isExistingProjectFile(workspace, source)) {
        const existingArtifact = input.artifactId
          ? [...this.files.values()].find((item) => item.projectId === input.projectId && item.artifactId === input.artifactId)
          : undefined;
        destination = existingArtifact
          ? path.resolve(workspace.rootPath, existingArtifact.relativePath)
          : path.join(workspace.rootPath, safeFileName(input.name));
        const occupied = await lstat(destination).catch(() => undefined);
        const indexed = this.findByPath(input.projectId, path.relative(workspace.rootPath, destination));
        if (occupied || indexed) {
          if (!existingArtifact || !occupied?.isFile()) throw new Error('PROJECT_FILE_TARGET_CONFLICT');
          const [sourceHash, destinationHash] = await Promise.all([hashFile(source), hashFile(destination)]);
          if (sourceHash !== destinationHash) throw new Error('PROJECT_FILE_UPDATE_REQUIRES_CANONICAL_PATH');
        } else {
          const temporary = `${destination}.${randomUUID()}.tmp`;
          try {
            await copyFile(source, temporary, constants.COPYFILE_EXCL);
            const [copied, sourceHash, copiedHash] = await Promise.all([stat(temporary), hashFile(source), hashFile(temporary)]);
            if (!copied.isFile() || copied.size !== sourceStats.size || sourceHash !== copiedHash) throw new Error('PROJECT_DELIVERY_VERIFICATION_FAILED');
            await rename(temporary, destination);
            created = true;
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
          }
        }
      }

      const previous = this.findByPath(input.projectId, path.relative(workspace.rootPath, destination));
      let registered: ProjectFileRecordSnapshot | undefined;
      try {
        const record = await this.upsertExisting(workspace, destination, 'delivery', {
          artifactId: input.artifactId,
          sourcePartnerId: input.sourcePartnerId,
          sourcePartnerName: input.sourcePartnerName,
        });
        registered = record;
        await this.persist();
        return { ...deliveryResult(workspace, record), created };
      } catch (error) {
        if (registered) {
          if (previous) this.files.set(previous.fileId, previous);
          else this.files.delete(registered.fileId);
        }
        if (created) await rm(destination, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  captureChangedPaths(projectId: string, relativePaths: string[]): Promise<ProjectFileVersionRef[]> {
    return this.mutate(async () => {
      await this.load();
      const workspace = await this.requireWorkspace(projectId);
      const refs: ProjectFileVersionRef[] = [];
      const previous = new Map<string, ProjectFileRecordSnapshot>();
      try {
        for (const relativePath of relativePaths) {
          const normalized = normalizeRelativePath(relativePath);
          const record = this.findByPath(projectId, normalized);
          if (!record) continue;
          previous.set(record.fileId, record);
          const candidate = path.resolve(workspace.rootPath, normalized);
          if (!await this.isExistingProjectFile(workspace, candidate)) continue;
          refs.push(toVersionRef(await this.upsertExisting(workspace, candidate, record.category, record)));
        }
        await this.persist();
        return refs;
      } catch (error) {
        for (const [fileId, record] of previous) this.files.set(fileId, record);
        throw error;
      }
    });
  }

  async list(projectId: string): Promise<ProjectWorkspaceFileEntry[]> {
    await this.mutation;
    await this.load();
    const workspace = await this.requireWorkspace(projectId);
    const records = [...this.files.values()].filter((item) => item.projectId === projectId && !item.removedAt);
    return Promise.all(records.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN')).map(async (record) => {
      const candidate = path.resolve(workspace.rootPath, record.relativePath);
      const value = await lstat(candidate).catch(() => undefined);
      const available = Boolean(value?.isFile() && !value.isSymbolicLink() && await this.isExistingProjectFile(workspace, candidate));
      return {
        fileId: record.fileId,
        name: path.basename(record.relativePath),
        relativePath: record.relativePath,
        revision: record.revision,
        category: record.category,
        availability: available ? 'available' as const : 'missing' as const,
        sizeBytes: available && value ? value.size : record.sizeBytes,
        modifiedAt: available && value ? value.mtime.toISOString() : record.modifiedAt,
        artifactId: record.artifactId,
        contentHash: record.contentHash,
        savedAt: record.updatedAt,
        sourcePartnerId: record.sourcePartnerId,
        sourcePartnerName: record.sourcePartnerName,
      };
    }));
  }

  async resolve(projectId: string, fileId: string) {
    await this.mutation;
    await this.load();
    const workspace = await this.requireWorkspace(projectId);
    const record = this.files.get(fileId);
    if (!record || record.projectId !== projectId || record.removedAt) throw new Error('PROJECT_FILE_NOT_FOUND');
    const candidate = path.resolve(workspace.rootPath, record.relativePath);
    if (!await this.isExistingProjectFile(workspace, candidate)) throw new Error('PROJECT_FILE_NOT_FOUND');
    return realpath(candidate);
  }

  async validateRefs(projectId: string, refs: ProjectFileVersionRef[]) {
    await this.mutation;
    await this.load();
    const workspace = await this.requireWorkspace(projectId);
    for (const ref of refs) {
      const record = this.files.get(ref.fileId);
      if (!record || record.projectId !== projectId || record.removedAt || pathKey(record.relativePath) !== pathKey(ref.relativePath)) throw new Error('TASK_HANDOFF_FILE_REF_INVALID');
      const candidate = path.resolve(workspace.rootPath, record.relativePath);
      if (!await this.isExistingProjectFile(workspace, candidate)) throw new Error('TASK_HANDOFF_FILE_REF_INVALID');
      const [value, contentHash] = await Promise.all([stat(candidate), hashFile(candidate)]);
      if (record.revision !== ref.revision || contentHash !== ref.contentHash || value.size !== ref.sizeBytes) throw new Error('TASK_HANDOFF_FILE_REF_STALE');
    }
  }

  async removeProject(projectId: string) {
    return this.mutate(async () => {
      await this.load();
      for (const [fileId, record] of this.files) if (record.projectId === projectId) this.files.delete(fileId);
      this.migratedProjects.delete(projectId);
      await this.persist();
    });
  }

  async projectSnapshot(projectId: string) {
    await this.mutation;
    await this.load();
    return [...this.files.values()].filter((item) => item.projectId === projectId).map((item) => structuredClone(item));
  }

  async allSnapshots() {
    await this.mutation;
    await this.load();
    return [...this.files.values()].map((item) => structuredClone(item));
  }

  async deletionSnapshot(projectId: string, fileId: string) {
    await this.mutation;
    await this.load();
    const workspace = await this.requireWorkspace(projectId);
    const record = this.files.get(fileId);
    if (!record || record.projectId !== projectId || record.removedAt) throw new Error('PROJECT_FILE_NOT_FOUND');
    const absolutePath = path.resolve(workspace.rootPath, record.relativePath);
    const value = await lstat(absolutePath).catch(() => undefined);
    const available = Boolean(value?.isFile() && !value.isSymbolicLink() && await this.isExistingProjectFile(workspace, absolutePath));
    return { record: structuredClone(record), absolutePath, available };
  }

  markRemoved(projectId: string, fileId: string, removedAt = new Date().toISOString()) {
    return this.mutate(async () => {
      await this.load();
      const record = this.files.get(fileId);
      if (!record || record.projectId !== projectId) throw new Error('PROJECT_FILE_NOT_FOUND');
      if (record.removedAt) return structuredClone(record);
      const updated = { ...record, removedAt, updatedAt: removedAt };
      this.files.set(fileId, updated);
      try {
        await this.persist();
      } catch (error) {
        this.files.set(fileId, record);
        throw error;
      }
      return structuredClone(updated);
    });
  }

  restoreProject(records: ProjectFileRecordSnapshot[]) {
    return this.mutate(async () => {
      await this.load();
      for (const record of records) if (validRecord(record)) this.files.set(record.fileId, structuredClone(record));
      if (records[0]?.projectId) this.migratedProjects.add(records[0].projectId);
      await this.persist();
    });
  }

  private async upsertExisting(
    workspace: ProjectWorkspaceSnapshot,
    absolutePath: string,
    category: ProjectFileRecordSnapshot['category'],
    metadata: Partial<Pick<ProjectFileRecordSnapshot, 'artifactId' | 'sourcePartnerId' | 'sourcePartnerName'>> = {},
  ) {
    const canonical = await realpath(absolutePath);
    const canonicalRoot = await realpath(workspace.rootPath);
    if (!isContained(canonicalRoot, canonical)) throw new Error('PROJECT_FILE_PATH_REJECTED');
    const value = await lstat(canonical);
    if (!value.isFile() || value.isSymbolicLink()) throw new Error('PROJECT_DELIVERY_SOURCE_INVALID');
    const relativePath = path.relative(canonicalRoot, canonical);
    const contentHash = await hashFile(canonical);
    const existing = this.findByPath(workspace.projectId, relativePath);
    const now = new Date().toISOString();
    const record: ProjectFileRecordSnapshot = {
      version: 1,
      fileId: existing?.fileId ?? randomUUID(),
      projectId: workspace.projectId,
      relativePath,
      category: existing?.category === 'template' ? 'template' : category,
      revision: existing ? existing.revision + (existing.contentHash === contentHash ? 0 : 1) : 1,
      contentHash,
      sizeBytes: value.size,
      modifiedAt: value.mtime.toISOString(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      artifactId: metadata.artifactId ?? existing?.artifactId,
      sourcePartnerId: metadata.sourcePartnerId ?? existing?.sourcePartnerId,
      sourcePartnerName: metadata.sourcePartnerName ?? existing?.sourcePartnerName,
    };
    this.files.set(record.fileId, record);
    return record;
  }

  private async isExistingProjectFile(workspace: ProjectWorkspaceSnapshot, candidate: string) {
    const value = await lstat(candidate).catch(() => undefined);
    if (!value?.isFile() || value.isSymbolicLink()) return false;
    const [root, file] = await Promise.all([realpath(workspace.rootPath), realpath(candidate)]);
    return isContained(root, file);
  }

  private findByPath(projectId: string, relativePath: string) {
    const key = pathKey(relativePath);
    return [...this.files.values()].find((item) => item.projectId === projectId && pathKey(item.relativePath) === key);
  }

  private async requireWorkspace(projectId: string) {
    const workspace = await this.workspaces.get(projectId);
    if (!workspace) throw new Error('PROJECT_WORKSPACE_NOT_READY');
    return workspace;
  }

  private async load() {
    if (this.loaded) return;
    this.loading ??= (async () => {
      const target = this.resolvedPath();
      const value = await this.readIndexFile(target).then((raw) => JSON.parse(raw) as ProjectFileIndex).catch(() => EMPTY_INDEX);
      if (value.version === 1 && Array.isArray(value.files)) {
        for (const item of value.files) if (validRecord(item)) this.files.set(item.fileId, item);
        for (const projectId of value.migratedProjectIds ?? []) if (typeof projectId === 'string') this.migratedProjects.add(projectId);
      }
      this.loaded = true;
    })();
    try { await this.loading; } finally { if (!this.loaded) this.loading = undefined; }
  }

  private async persist() {
    const target = this.resolvedPath();
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, files: [...this.files.values()], migratedProjectIds: [...this.migratedProjects] }, null, 2)}\n`, 'utf8');
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private resolvedPath() { return typeof this.indexPath === 'function' ? this.indexPath() : this.indexPath; }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function deliveryResult(workspace: ProjectWorkspaceSnapshot, record: ProjectFileRecordSnapshot): ProjectDeliveryResult {
  return {
    fileId: record.fileId,
    absolutePath: path.join(workspace.rootPath, record.relativePath),
    relativePath: record.relativePath,
    revision: record.revision,
    contentHash: record.contentHash,
    sizeBytes: record.sizeBytes,
    savedAt: record.updatedAt,
    sourcePartnerId: record.sourcePartnerId,
    sourcePartnerName: record.sourcePartnerName,
  };
}

function toVersionRef(record: ProjectFileRecordSnapshot): ProjectFileVersionRef {
  return { fileId: record.fileId, relativePath: record.relativePath, revision: record.revision, contentHash: record.contentHash, sizeBytes: record.sizeBytes };
}

function normalizeRelativePath(value: string) {
  if (!value || path.isAbsolute(value) || value.includes('\0')) throw new Error('PROJECT_FILE_PATH_REJECTED');
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error('PROJECT_FILE_PATH_REJECTED');
  return normalized;
}

function safeFileName(value: string) {
  const raw = path.basename(value).normalize('NFKC').replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').trim();
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(path.parse(raw).name);
  return (!raw || reserved ? 'delivery' : raw).slice(0, 160);
}

function pathKey(value: string) { return value.replaceAll('\\', '/').toLocaleLowerCase('en-US'); }

function isContained(rootPath: string, candidate: string) {
  const relative = path.relative(rootPath, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function hashFile(filePath: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function validRecord(value: unknown): value is ProjectFileRecordSnapshot {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ProjectFileRecordSnapshot>;
  return item.version === 1 && typeof item.fileId === 'string' && typeof item.projectId === 'string'
    && typeof item.relativePath === 'string' && (item.category === 'template' || item.category === 'delivery')
    && Number.isSafeInteger(item.revision) && Number(item.revision) > 0 && typeof item.contentHash === 'string'
    && typeof item.sizeBytes === 'number' && typeof item.modifiedAt === 'string'
    && typeof item.createdAt === 'string' && typeof item.updatedAt === 'string'
    && (item.removedAt === undefined || typeof item.removedAt === 'string');
}
