import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';

interface ProjectDeletionFile {
  version: 1;
  projectIds: string[];
}

export class ProjectDeletionStore {
  private readonly storage: AtomicJsonStore<ProjectDeletionFile>;

  constructor(filePath: AtomicJsonStorePath) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 1, projectIds: [] }),
      decode: decodeProjectDeletions,
      encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
    });
  }

  async list() {
    return [...(await this.storage.read()).projectIds];
  }

  markDeleted(projectId: string) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      if (current.projectIds.includes(projectId)) return;
      await this.storage.writeNow({ version: 1, projectIds: [...current.projectIds, projectId] });
    });
  }

  markActive(projectId: string) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      if (!current.projectIds.includes(projectId)) return;
      await this.storage.writeNow({ version: 1, projectIds: current.projectIds.filter((id) => id !== projectId) });
    });
  }
}

function decodeProjectDeletions(value: unknown): ProjectDeletionFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projectIds)
    || value.projectIds.some((projectId) => typeof projectId !== 'string' || !projectId)) {
    throw new Error('PROJECT_DELETION_STORE_INVALID');
  }
  return { version: 1, projectIds: [...new Set(value.projectIds)] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
