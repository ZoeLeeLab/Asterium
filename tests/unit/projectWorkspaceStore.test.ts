import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkspaceStore } from '../../src/main/project/ProjectWorkspaceStore';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ProjectWorkspaceStore', () => {
  it('uses the previewed location, changes only future defaults and refuses an unavailable custom root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-default-change-')); temporaryDirectories.push(root);
    let defaultRoot = path.join(root, 'first');
    let unavailable = false;
    const store = new ProjectWorkspaceStore(path.join(root, 'index.json'), async () => { if (unavailable) throw new Error('CUSTOM_ROOT_UNAVAILABLE'); return defaultRoot; });
    const input = { projectId: 'project-first-12345678', name: '测试项目' };
    const preview = await store.preview(input);
    const first = await store.create(input); expect(first.rootPath).toBe(preview);
    defaultRoot = path.join(root, 'second');
    const second = await store.create({ projectId: 'project-second', name: '新位置' });
    expect(second.rootPath.startsWith(defaultRoot + path.sep)).toBe(true);
    expect((await store.get(input.projectId))?.rootPath).toBe(first.rootPath);
    unavailable = true;
    await expect(store.create({ projectId: 'project-missing', name: '无法创建' })).rejects.toThrow('CUSTOM_ROOT_UNAVAILABLE');
    expect(await store.get('project-missing')).toBeUndefined();
    expect((await store.create(input)).rootPath).toBe(first.rootPath);
  });
  it('creates a visible project folder with three non-destructive starter documents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-'));
    temporaryDirectories.push(root);
    const store = new ProjectWorkspaceStore(path.join(root, '.state', 'projects.json'), () => path.join(root, 'Asterium Projects'));

    const project = await store.create({ projectId: 'project-autumn-12345678', name: '秋季示例项目 B', description: '为十月旅行整理路线。' });

    expect(project.rootPath).toContain('Asterium Projects');
    expect(project.templateFiles.map((item) => item.name)).toEqual(['project-plan.md', 'progress.md', 'design-guide.md']);
    expect(await readFile(path.join(project.rootPath, 'project-plan.md'), 'utf8')).toContain('为十月旅行整理路线。');
    expect(await readdir(project.rootPath)).toEqual(expect.arrayContaining(['project-plan.md', 'progress.md', 'design-guide.md', 'deliverables']));

    await writeFile(path.join(project.rootPath, 'project-plan.md'), '# 用户已经修改', 'utf8');
    await store.create({ projectId: 'project-autumn-12345678', name: '秋季示例项目 B', description: '新的描述不应覆盖文件。' });
    expect(await readFile(path.join(project.rootPath, 'project-plan.md'), 'utf8')).toBe('# 用户已经修改');
  });

  it('uses an explicitly selected folder and persists its registration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-selected-'));
    temporaryDirectories.push(root);
    const selected = path.join(root, 'my-project');
    const index = path.join(root, '.state', 'projects.json');
    const store = new ProjectWorkspaceStore(index, () => path.join(root, 'default'));
    const project = await store.create({ projectId: 'project-selected', name: '指定目录', selectedRoot: selected });

    expect(project.rootPath).toBe(path.resolve(selected));
    const restored = new ProjectWorkspaceStore(index, () => path.join(root, 'default'));
    expect((await restored.get(project.projectId))?.rootPath).toBe(path.resolve(selected));
  });

  it('rejects one selected directory being shared by two projects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-duplicate-'));
    temporaryDirectories.push(root);
    const selected = path.join(root, 'shared');
    const store = new ProjectWorkspaceStore(path.join(root, '.state', 'projects.json'), () => path.join(root, 'default'));
    await store.create({ projectId: 'project-one', name: '项目一', selectedRoot: selected });
    await expect(store.create({ projectId: 'project-two', name: '项目二', selectedRoot: selected })).rejects.toThrow('PROJECT_DIRECTORY_ALREADY_USED');
  });

  it('shares one in-flight index load across concurrent startup scans', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-concurrent-load-'));
    temporaryDirectories.push(root);
    const index = path.join(root, '.state', 'projects.json');
    const created = new ProjectWorkspaceStore(index, () => path.join(root, 'projects'));
    const project = await created.create({ projectId: 'project-concurrent', name: '并发启动' });
    const serialized = await readFile(index, 'utf8');
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readIndex = vi.fn(async () => {
      await readGate;
      return serialized;
    });
    const restored = new ProjectWorkspaceStore(index, () => path.join(root, 'projects'), readIndex);

    const workspacePending = restored.get(project.projectId);
    const secondPending = restored.get(project.projectId);
    await vi.waitFor(() => expect(readIndex).toHaveBeenCalledTimes(1));
    releaseRead();

    await expect(workspacePending).resolves.toMatchObject({ projectId: project.projectId });
    await expect(secondPending).resolves.toMatchObject({ projectId: project.projectId });
    expect(readIndex).toHaveBeenCalledTimes(1);
  });

  it('removes only the Asterium project registration and preserves the project directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-remove-'));
    temporaryDirectories.push(root);
    const index = path.join(root, '.state', 'projects.json');
    const store = new ProjectWorkspaceStore(index, () => path.join(root, 'projects'));
    const project = await store.create({ projectId: 'project-remove', name: '保留文件项目' });

    await store.remove(project.projectId);

    expect(await store.get(project.projectId)).toBeUndefined();
    expect(await readdir(project.rootPath)).toEqual(expect.arrayContaining(['project-plan.md', 'progress.md', 'design-guide.md', 'deliverables']));
    expect(JSON.parse(await readFile(index, 'utf8')).projects).toEqual([]);
  });

  it('rolls its in-memory registration back when the workspace index cannot be committed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-index-failure-'));
    temporaryDirectories.push(root);
    const index = path.join(root, '.state', 'projects.json');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(index, { recursive: true }));
    const store = new ProjectWorkspaceStore(index, () => path.join(root, 'projects'));

    await expect(store.create({ projectId: 'project-index-failure', name: '索引失败' })).rejects.toThrow();

    expect(await store.get('project-index-failure')).toBeUndefined();
    const [preservedDirectory] = await readdir(path.join(root, 'projects'));
    expect(await readdir(path.join(root, 'projects', preservedDirectory))).toEqual(expect.arrayContaining([
      'project-plan.md', 'progress.md', 'design-guide.md', 'deliverables',
    ]));
  });

});
