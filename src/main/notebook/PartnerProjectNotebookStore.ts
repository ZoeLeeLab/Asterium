import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ProjectNotebook,
  ProjectNotebookAppendInput,
  ProjectNotebookListOptions,
  ProjectNotebookReplaceInput,
  ProjectNotebookState,
} from '../../shared/projectNotebook';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';

interface ProjectNotebookIndexEntry {
  partnerId: string;
  projectId: string;
  projectName: string;
  fileName: string;
  state: ProjectNotebookState;
  revision: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

interface ProjectNotebookIndexFile {
  version: 1;
  notebooks: ProjectNotebookIndexEntry[];
}

export interface PartnerProjectNotebookStoreOptions {
  now?: () => string;
}

const MAX_NOTEBOOK_BYTES = 200_000;

export class PartnerProjectNotebookStore {
  private readonly directory: string;
  private readonly index: AtomicJsonStore<ProjectNotebookIndexFile>;
  private readonly now: () => string;

  constructor(workMemoryDirectory: string, private readonly partnerId: string, options: PartnerProjectNotebookStoreOptions = {}) {
    this.directory = path.join(workMemoryDirectory, 'project-notebooks-v1');
    this.index = new AtomicJsonStore({
      filePath: path.join(this.directory, 'index.json'),
      empty: () => ({ version: 1, notebooks: [] }),
      decode: decodeIndex,
      encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
    });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  list(options: ProjectNotebookListOptions = {}) {
    return this.index.runExclusive(async () => {
      const current = await this.reconcileIndex(await this.index.readNow());
      return Promise.all(current.notebooks
        .filter((entry) => visible(entry, options))
        .map((entry) => this.readNotebook(entry)));
    });
  }

  get(projectId: string, options: ProjectNotebookListOptions = {}) {
    assertIdentifier(projectId, 'PROJECT_NOTEBOOK_PROJECT_INVALID');
    return this.index.runExclusive(async () => {
      const current = await this.reconcileIndex(await this.index.readNow());
      const entry = current.notebooks.find((item) => item.projectId === projectId);
      return entry && visible(entry, options) ? this.readNotebook(entry) : undefined;
    });
  }

  append(input: ProjectNotebookAppendInput) {
    validateWriteInput(input);
    return this.index.runExclusive(async () => {
      const current = await this.reconcileIndex(await this.index.readNow());
      const existing = current.notebooks.find((item) => item.projectId === input.projectId);
      if (existing?.state === 'archived') throw new Error('PROJECT_NOTEBOOK_ARCHIVED');
      const previousContent = existing ? await this.readContent(existing) : '';
      const content = appendMarkdown(previousContent, input.content);
      assertContent(content);
      return this.saveContent(current, existing, input.projectId, input.projectName, content);
    });
  }

  replace(input: ProjectNotebookReplaceInput) {
    validateWriteInput(input);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('PROJECT_NOTEBOOK_REVISION_INVALID');
    return this.index.runExclusive(async () => {
      const current = await this.reconcileIndex(await this.index.readNow());
      const existing = current.notebooks.find((item) => item.projectId === input.projectId);
      if (existing?.state === 'archived') throw new Error('PROJECT_NOTEBOOK_ARCHIVED');
      const revision = existing?.revision ?? 0;
      if (revision !== input.expectedRevision) throw new Error('PROJECT_NOTEBOOK_REVISION_CONFLICT');
      assertContent(input.content);
      return this.saveContent(current, existing, input.projectId, input.projectName, input.content);
    });
  }

  setState(projectId: string, state: ProjectNotebookState, projectName?: string) {
    assertIdentifier(projectId, 'PROJECT_NOTEBOOK_PROJECT_INVALID');
    if (!['active', 'inactive', 'archived'].includes(state)) throw new Error('PROJECT_NOTEBOOK_STATE_INVALID');
    return this.index.runExclusive(async () => {
      const current = await this.reconcileIndex(await this.index.readNow());
      const existing = current.notebooks.find((item) => item.projectId === projectId);
      if (!existing) return undefined;
      const now = this.now();
      const entry: ProjectNotebookIndexEntry = {
        ...existing,
        ...(projectName ? { projectName: normalizedProjectName(projectName) } : {}),
        state,
        updatedAt: existing.state === state && (!projectName || existing.projectName === projectName.trim()) ? existing.updatedAt : now,
        ...(state === 'archived' ? { archivedAt: existing.archivedAt ?? now } : {}),
      };
      if (state !== 'archived') delete entry.archivedAt;
      if (JSON.stringify(entry) !== JSON.stringify(existing)) {
        await this.index.writeNow({
          version: 1,
          notebooks: current.notebooks.map((item) => item.projectId === projectId ? entry : item),
        });
      }
      return this.readNotebook(entry);
    });
  }

  restore(notebook: ProjectNotebook) {
    validateNotebook(notebook);
    if (notebook.partnerId !== this.partnerId) throw new Error('PROJECT_NOTEBOOK_OWNER_INVALID');
    return this.index.runExclusive(async () => {
      const current = await this.index.readNow();
      const fileName = notebookFileName(notebook.projectId);
      await writeAtomic(path.join(this.directory, fileName), notebook.content);
      const entry: ProjectNotebookIndexEntry = {
        partnerId: notebook.partnerId,
        projectId: notebook.projectId,
        projectName: notebook.projectName,
        fileName,
        state: notebook.state,
        revision: notebook.revision,
        contentHash: notebook.contentHash,
        createdAt: notebook.createdAt,
        updatedAt: notebook.updatedAt,
        ...(notebook.archivedAt ? { archivedAt: notebook.archivedAt } : {}),
      };
      const exists = current.notebooks.some((item) => item.projectId === notebook.projectId);
      const notebooks = exists
        ? current.notebooks.map((item) => item.projectId === notebook.projectId ? entry : item)
        : [...current.notebooks, entry];
      notebooks.sort((left, right) => left.projectId.localeCompare(right.projectId));
      await this.index.writeNow({ version: 1, notebooks });
      return this.readNotebook(entry);
    });
  }

  purgeArchived(projectId: string) {
    assertIdentifier(projectId, 'PROJECT_NOTEBOOK_PROJECT_INVALID');
    return this.index.runExclusive(async () => {
      const current = await this.reconcileIndex(await this.index.readNow());
      const existing = current.notebooks.find((item) => item.projectId === projectId);
      if (!existing) throw new Error('PROJECT_NOTEBOOK_NOT_FOUND');
      if (existing.state !== 'archived') throw new Error('PROJECT_NOTEBOOK_PURGE_REQUIRES_ARCHIVED');
      const content = await this.readContent(existing);
      await this.index.writeNow({ version: 1, notebooks: current.notebooks.filter((item) => item.projectId !== projectId) });
      await rm(path.join(this.directory, existing.fileName));
      return this.readNotebookContent(existing, content);
    });
  }

  private async reconcileIndex(current: ProjectNotebookIndexFile) {
    let changed = false;
    const notebooks: ProjectNotebookIndexEntry[] = [];
    for (const entry of current.notebooks) {
      this.assertOwned(entry);
      const content = await this.readContent(entry);
      const contentHash = hashContent(content);
      if (contentHash === entry.contentHash) {
        notebooks.push(entry);
        continue;
      }
      changed = true;
      notebooks.push({ ...entry, revision: entry.revision + 1, contentHash, updatedAt: this.now() });
    }
    const next = changed ? { version: 1 as const, notebooks } : current;
    if (changed) await this.index.writeNow(next);
    return next;
  }

  private async saveContent(
    current: ProjectNotebookIndexFile,
    existing: ProjectNotebookIndexEntry | undefined,
    projectId: string,
    projectName: string,
    content: string,
  ) {
    const now = this.now();
    const fileName = existing?.fileName ?? notebookFileName(projectId);
    await writeAtomic(path.join(this.directory, fileName), content);
    const entry: ProjectNotebookIndexEntry = {
      partnerId: this.partnerId,
      projectId,
      projectName: normalizedProjectName(projectName),
      fileName,
      state: existing?.state ?? 'active',
      revision: (existing?.revision ?? 0) + 1,
      contentHash: hashContent(content),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.archivedAt ? { archivedAt: existing.archivedAt } : {}),
    };
    const notebooks = existing
      ? current.notebooks.map((item) => item.projectId === projectId ? entry : item)
      : [...current.notebooks, entry];
    notebooks.sort((left, right) => left.projectId.localeCompare(right.projectId));
    await this.index.writeNow({ version: 1, notebooks });
    return this.readNotebook(entry);
  }

  private async readNotebook(entry: ProjectNotebookIndexEntry): Promise<ProjectNotebook> {
    this.assertOwned(entry);
    return this.readNotebookContent(entry, await this.readContent(entry));
  }

  private readNotebookContent(entry: ProjectNotebookIndexEntry, content: string): ProjectNotebook {
    return {
      partnerId: entry.partnerId,
      projectId: entry.projectId,
      projectName: entry.projectName,
      content,
      state: entry.state,
      revision: entry.revision,
      contentHash: entry.contentHash,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(entry.archivedAt ? { archivedAt: entry.archivedAt } : {}),
    };
  }

  private async readContent(entry: ProjectNotebookIndexEntry) {
    try {
      return await readFile(path.join(this.directory, entry.fileName), 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') throw new Error('PROJECT_NOTEBOOK_CONTENT_MISSING', { cause: error });
      throw error;
    }
  }

  private assertOwned(entry: ProjectNotebookIndexEntry) {
    if (entry.partnerId !== this.partnerId) throw new Error('PROJECT_NOTEBOOK_OWNER_INVALID');
  }
}

function decodeIndex(value: unknown): ProjectNotebookIndexFile {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { notebooks?: unknown }).notebooks)) {
    throw new Error('PROJECT_NOTEBOOK_INDEX_INVALID');
  }
  const notebooks = (value as { notebooks: unknown[] }).notebooks;
  if (!notebooks.every(isIndexEntry)) throw new Error('PROJECT_NOTEBOOK_INDEX_INVALID');
  const identities = new Set<string>();
  const fileNames = new Set<string>();
  for (const entry of notebooks) {
    if (identities.has(entry.projectId) || fileNames.has(entry.fileName)) throw new Error('PROJECT_NOTEBOOK_INDEX_INVALID');
    identities.add(entry.projectId);
    fileNames.add(entry.fileName);
  }
  return { version: 1, notebooks: structuredClone(notebooks) };
}

function isIndexEntry(value: unknown): value is ProjectNotebookIndexEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.partnerId === 'string' && Boolean(entry.partnerId)
    && typeof entry.projectId === 'string' && Boolean(entry.projectId)
    && typeof entry.projectName === 'string' && Boolean(entry.projectName)
    && typeof entry.fileName === 'string' && /^[a-f0-9]{64}\.md$/.test(entry.fileName)
    && ['active', 'inactive', 'archived'].includes(String(entry.state))
    && Number.isSafeInteger(entry.revision) && Number(entry.revision) > 0
    && typeof entry.contentHash === 'string' && /^[a-f0-9]{64}$/.test(entry.contentHash)
    && isIsoDate(entry.createdAt) && isIsoDate(entry.updatedAt)
    && (entry.archivedAt === undefined || isIsoDate(entry.archivedAt));
}

function visible(entry: ProjectNotebookIndexEntry, options: ProjectNotebookListOptions) {
  if (entry.state === 'archived') return Boolean(options.includeArchived);
  if (entry.state === 'inactive') return Boolean(options.includeInactive);
  return true;
}

function validateWriteInput(input: ProjectNotebookAppendInput | ProjectNotebookReplaceInput) {
  assertIdentifier(input.projectId, 'PROJECT_NOTEBOOK_PROJECT_INVALID');
  normalizedProjectName(input.projectName);
  assertContent(input.content);
}

function assertIdentifier(value: string, code: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(code);
}

function normalizedProjectName(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new Error('PROJECT_NOTEBOOK_PROJECT_INVALID');
  return value.trim();
}

function assertContent(content: string) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_NOTEBOOK_BYTES) throw new Error('PROJECT_NOTEBOOK_CONTENT_INVALID');
}

function validateNotebook(notebook: ProjectNotebook) {
  assertIdentifier(notebook.partnerId, 'PROJECT_NOTEBOOK_OWNER_INVALID');
  assertIdentifier(notebook.projectId, 'PROJECT_NOTEBOOK_PROJECT_INVALID');
  normalizedProjectName(notebook.projectName);
  assertContent(notebook.content);
  if (!['active', 'inactive', 'archived'].includes(notebook.state)
    || !Number.isSafeInteger(notebook.revision) || notebook.revision < 1
    || notebook.contentHash !== hashContent(notebook.content)
    || !isIsoDate(notebook.createdAt) || !isIsoDate(notebook.updatedAt)
    || (notebook.archivedAt !== undefined && !isIsoDate(notebook.archivedAt))) throw new Error('PROJECT_NOTEBOOK_INVALID');
}

function appendMarkdown(current: string, addition: string) {
  if (!current) return addition;
  if (!addition) return current;
  return `${current.replace(/\s+$/u, '')}\n\n${addition.replace(/^\s+/u, '')}`;
}

function notebookFileName(projectId: string) {
  return `${createHash('sha256').update(projectId).digest('hex')}.md`;
}

function hashContent(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

function isIsoDate(value: unknown) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

async function writeAtomic(target: string, content: string) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
