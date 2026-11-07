import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_TEMPLATE_FILES,
  type ProjectWorkspaceSnapshot,
} from '../../shared/projectWorkspace';

interface ProjectWorkspaceIndex {
  version: 1;
  projects: ProjectWorkspaceSnapshot[];
}

export interface CreateProjectWorkspaceInput {
  projectId: string;
  name: string;
  description?: string;
  selectedRoot?: string;
}

const EMPTY_INDEX: ProjectWorkspaceIndex = { version: 1, projects: [] };

export class ProjectWorkspaceStore {
  private loaded = false;
  private loading?: Promise<void>;
  private readonly projects = new Map<string, ProjectWorkspaceSnapshot>();
  private mutation = Promise.resolve();
  constructor(
    private readonly indexPath: string,
    private readonly defaultRoot: () => string | Promise<string>,
    private readonly readIndexFile: (filePath: string) => Promise<string> = (filePath) => readFile(filePath, 'utf8'),
  ) {}

  async preview(input: Pick<CreateProjectWorkspaceInput, 'projectId' | 'name' | 'selectedRoot'>) {
    validateProjectId(input.projectId);
    const name = cleanText(input.name, 80, 'PROJECT_NAME_INVALID');
    return input.selectedRoot ? assertAbsolutePath(input.selectedRoot)
      : path.join(await this.defaultRoot(), `${safeSegment(name, 'project')}__${shortId(input.projectId)}`);
  }

  async create(input: CreateProjectWorkspaceInput): Promise<ProjectWorkspaceSnapshot> {
    return this.mutate(async () => {
      await this.load();
      validateProjectId(input.projectId);
      const name = cleanText(input.name, 80, 'PROJECT_NAME_INVALID');
      const description = cleanOptionalText(input.description, 20_000, 'PROJECT_DESCRIPTION_INVALID');
      const existing = this.projects.get(input.projectId);
      const rootPath = existing?.rootPath ?? await this.preview(input);
      const duplicate = [...this.projects.values()].find((item) => item.projectId !== input.projectId && samePath(item.rootPath, rootPath));
      if (duplicate) throw new Error('PROJECT_DIRECTORY_ALREADY_USED');

      await mkdir(rootPath, { recursive: true });
      const rootStats = await lstat(rootPath);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('PROJECT_DIRECTORY_REJECTED');

      const templates = projectTemplates(name, description);
      for (const template of templates) await writeOnce(path.join(rootPath, template.name), template.content);

      const now = new Date().toISOString();
      const snapshot: ProjectWorkspaceSnapshot = {
        version: 1,
        projectId: input.projectId,
        name,
        rootPath,
        ...(existing?.deliverablesPath ? { deliverablesPath: existing.deliverablesPath } : {}),
        templateFiles: PROJECT_TEMPLATE_FILES.map((item) => ({ name: item.name, label: item.label, relativePath: item.name })),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const previous = existing ? structuredClone(existing) : undefined;
      this.projects.set(input.projectId, snapshot);
      try {
        await this.persist();
      } catch (error) {
        if (previous) this.projects.set(input.projectId, previous);
        else this.projects.delete(input.projectId);
        throw error;
      }
      return structuredClone(snapshot);
    });
  }

  async get(projectId: string): Promise<ProjectWorkspaceSnapshot | undefined> {
    await this.load();
    return this.projects.has(projectId) ? structuredClone(this.projects.get(projectId)) : undefined;
  }

  archiveUpload(projectId: string, sourcePath: string, name: string) {
    return this.mutate(async () => {
      await this.load();
      const workspace = this.projects.get(projectId);
      if (!workspace) throw new Error('PROJECT_WORKSPACE_NOT_READY');
      const rootStats = await lstat(workspace.rootPath);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('PROJECT_DIRECTORY_REJECTED');
      const root = await realpath(workspace.rootPath);
      const uploads = path.join(root, 'uploads');
      await mkdir(uploads, { recursive: true });
      const stats = await lstat(uploads);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('PROJECT_DIRECTORY_REJECTED');
      await assertContainedDirectory(root, uploads);

      const parsed = path.parse(path.basename(name));
      const stem = safeSegment(parsed.name, 'attachment');
      const extension = safeSegment(parsed.ext, '');
      let bytes: Buffer | undefined;
      for (let index = 1; index <= 1000; index++) {
        const suffix = index === 1 ? '' : ` (${index})`;
        const target = path.join(uploads, stem + suffix + extension);
        try {
          await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const occupied = await lstat(target);
        if (!occupied.isFile() || occupied.isSymbolicLink()) continue;
        bytes ??= await readFile(sourcePath);
        if (occupied.size === bytes.length && bytes.equals(await readFile(target))) return;
      }
      throw new Error('PROJECT_UPLOAD_TARGET_CONFLICT');
    });
  }

  async remove(projectId: string): Promise<void> {
    await this.mutate(async () => {
      await this.load();
      validateProjectId(projectId);
      const previous = this.projects.get(projectId);
      if (!previous || !this.projects.delete(projectId)) return;
      try {
        await this.persist();
      } catch (error) {
        this.projects.set(projectId, previous);
        throw error;
      }
    });
  }

  async restore(snapshot: ProjectWorkspaceSnapshot): Promise<void> {
    await this.mutate(async () => {
      await this.load();
      validateProjectId(snapshot.projectId);
      const previous = this.projects.get(snapshot.projectId);
      this.projects.set(snapshot.projectId, structuredClone(snapshot));
      try {
        await this.persist();
      } catch (error) {
        if (previous) this.projects.set(snapshot.projectId, previous);
        else this.projects.delete(snapshot.projectId);
        throw error;
      }
    });
  }

  private async load() {
    if (this.loaded) return;
    this.loading ??= (async () => {
      const value = await this.readIndexFile(this.indexPath).then((raw) => JSON.parse(raw) as ProjectWorkspaceIndex).catch(() => EMPTY_INDEX);
      if (value.version === 1 && Array.isArray(value.projects)) {
        for (const item of value.projects) {
          if (!item || item.version !== 1 || typeof item.projectId !== 'string' || typeof item.rootPath !== 'string') continue;
          this.projects.set(item.projectId, item);
        }
      }
      this.loaded = true;
    })();
    try {
      await this.loading;
    } finally {
      if (!this.loaded) this.loading = undefined;
    }
  }

  private async persist() {
    await mkdir(path.dirname(this.indexPath), { recursive: true });
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, projects: [...this.projects.values()] }, null, 2)}\n`, 'utf8');
      await rename(temporary, this.indexPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function projectTemplates(name: string, description: string) {
  const background = description || '待补充项目背景与缘起。';
  return [
    {
      name: 'project-plan.md',
      content: `# ${name} · 项目方案计划\n\n## 目标\n\n- 待补充\n\n## 范围\n\n### 包含\n\n- 待补充\n\n### 不包含\n\n- 待补充\n\n## 背景\n\n${background}\n\n## 人员安排\n\n| 成员 | 项目身份 | 职责 |\n| --- | --- | --- |\n| 待安排 | 待补充 | 待补充 |\n`,
    },
    {
      name: 'progress.md',
      content: `# ${name} · 项目进度\n\n## 当前阶段\n\n项目初始化\n\n## 已完成\n\n- [x] 创建项目文件夹与基础资料\n\n## 阻塞\n\n- 暂无\n\n## 任务\n\n- [ ] 补充项目目标与范围\n- [ ] 确认参与伙伴及职责\n`,
    },
    {
      name: 'design-guide.md',
      content: `# ${name} · 界面风格设计\n\n## 界面\n\n- 待补充视觉方向、颜色、排版与组件规则。\n\n## 交互\n\n- 待补充关键流程、状态反馈与异常处理。\n\n## 文案风格\n\n- 待补充语气、称呼、术语与提示规则。\n`,
    },
  ];
}

async function writeOnce(filePath: string, content: string) {
  await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
}

async function assertContainedDirectory(rootPath: string, directory: string) {
  const [realRoot, realDirectory] = await Promise.all([realpath(rootPath), realpath(directory)]);
  if (!isContained(realRoot, realDirectory)) throw new Error('PROJECT_DIRECTORY_REJECTED');
}

function isContained(rootPath: string, candidate: string) {
  const relative = path.relative(rootPath, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(left: string, right: string) {
  return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase();
}

function assertAbsolutePath(value: string) {
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error('PROJECT_DIRECTORY_REJECTED');
  return path.resolve(value);
}

function validateProjectId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error('PROJECT_ID_REJECTED');
}

function cleanText(value: string, limit: number, error: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > limit) throw new Error(error);
  return normalized;
}

function cleanOptionalText(value: string | undefined, limit: number, error: string) {
  const normalized = value?.trim() ?? '';
  if (normalized.length > limit) throw new Error(error);
  return normalized;
}

function safeSegment(value: string, fallback: string) {
  const withoutControls = [...value].map((character) => character.charCodeAt(0) < 32 ? '-' : character).join('');
  const cleaned = withoutControls.normalize('NFKC').replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').trim();
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(path.parse(cleaned).name);
  return (!cleaned || reserved ? fallback : cleaned).slice(0, 80);
}

function shortId(value: string) {
  return value.replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'unknown';
}
