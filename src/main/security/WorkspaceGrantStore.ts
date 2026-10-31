import { randomUUID } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceGrant } from '../../shared/agentProtocol';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';

interface WorkspaceGrantFile {
  version: 1;
  grants: Record<string, string>;
}

export class WorkspaceGrantStore {
  private readonly storage: AtomicJsonStore<WorkspaceGrantFile>;

  constructor(filePath: string | (() => string)) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 1, grants: {} }),
      decode: decodeWorkspaceGrantFile,
    });
  }

  async add(displayPath: string): Promise<WorkspaceGrant> {
    const directory = path.resolve(displayPath);
    await ensureDirectory(directory);
    const grant = { grantId: `workspace-${randomUUID()}`, displayPath: directory };
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      data.grants[grant.grantId] = directory;
      await this.writeUnlocked(data);
    });
    return grant;
  }

  async get(grantId: string) {
    const directory = (await this.storage.read()).grants[grantId];
    if (!directory) return undefined;
    try {
      await ensureDirectory(directory);
      return directory;
    } catch {
      return undefined;
    }
  }

  async deleteMany(grantIds: string[]) {
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      let changed = false;
      for (const grantId of grantIds) {
        if (!data.grants[grantId]) continue;
        delete data.grants[grantId];
        changed = true;
      }
      if (changed) await this.writeUnlocked(data);
    });
  }

  private readUnlocked() { return this.storage.readNow(); }
  private writeUnlocked(data: WorkspaceGrantFile) { return this.storage.writeNow(data); }

  private mutate<T>(operation: () => Promise<T>) {
    return this.storage.runExclusive(operation);
  }
}

function decodeWorkspaceGrantFile(parsed: unknown): WorkspaceGrantFile {
  if (!isRecord(parsed) || parsed.version !== 1 || !isStringRecord(parsed.grants)) throw new Error('WORKSPACE_GRANT_STORE_INVALID');
  return { version: 1, grants: { ...parsed.grants } };
}

async function ensureDirectory(directory: string) {
  await access(directory);
  if (!(await stat(directory)).isDirectory()) throw new Error('WORKSPACE_NOT_DIRECTORY');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}
