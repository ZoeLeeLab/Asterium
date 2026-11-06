import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectFileStore } from '../../src/main/project/ProjectFileStore';
import { ProjectWorkspaceStore } from '../../src/main/project/ProjectWorkspaceStore';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-files-'));
  temporary.push(root);
  const workspaceRoot = path.join(root, 'project');
  const workspaceIndex = path.join(root, 'state', 'workspaces.json');
  const fileIndex = path.join(root, 'state', 'files.json');
  const workspaces = new ProjectWorkspaceStore(workspaceIndex, () => path.join(root, 'projects'));
  const workspace = await workspaces.create({ projectId: 'project-a', name: '项目 A', selectedRoot: workspaceRoot });
  const files = new ProjectFileStore(fileIndex, workspaces);
  return { root, workspaceRoot, workspaceIndex, fileIndex, workspaces, workspace, files };
}

describe('ProjectFileStore', () => {
  it('migrates the original in-project file as the only visible identity and ignores the old snapshot copy', async () => {
    const value = await fixture();
    const current = path.join(value.workspaceRoot, 'workflow-smoke.md');
    const legacy = path.join(value.workspaceRoot, 'deliverables', 'partner', 'workflow-smoke.md');
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(current, 'current\n', 'utf8');
    await writeFile(legacy, 'old\n', 'utf8');

    await value.files.initializeProject(value.workspace, [{
      artifactId: 'artifact-workflow',
      relativePath: path.relative(value.workspaceRoot, legacy),
      originalPath: current,
      sourcePartnerId: 'partner-a',
      sourcePartnerName: '伙伴 A',
    }]);

    const listed = await value.files.list('project-a');
    expect(listed.filter((item) => item.name === 'workflow-smoke.md')).toEqual([
      expect.objectContaining({ relativePath: 'workflow-smoke.md', category: 'delivery', availability: 'available', artifactId: 'artifact-workflow' }),
    ]);
    expect(listed.some((item) => item.relativePath.includes('deliverables'))).toBe(false);
  });

  it('keeps fileId stable, advances the revision for the same canonical file, and persists across restart', async () => {
    const value = await fixture();
    const target = path.join(value.workspaceRoot, 'result.md');
    await writeFile(target, 'v1\n', 'utf8');
    await value.files.initializeProject(value.workspace, [{ artifactId: 'artifact-result', relativePath: 'legacy/result.md', originalPath: target }]);
    const first = (await value.files.list('project-a')).find((item) => item.name === 'result.md')!;

    await writeFile(target, 'v2\n', 'utf8');
    const [ref] = await value.files.captureChangedPaths('project-a', ['result.md']);
    expect(ref).toMatchObject({ fileId: first.fileId, relativePath: 'result.md', revision: 2 });

    const restartedWorkspaces = new ProjectWorkspaceStore(value.workspaceIndex, () => path.join(value.root, 'projects'));
    const restarted = new ProjectFileStore(value.fileIndex, restartedWorkspaces);
    expect(await restarted.list('project-a')).toContainEqual(expect.objectContaining({ fileId: first.fileId, revision: 2 }));
  });

  it('retains a missing record but refuses to open it after Windows removes the real file', async () => {
    const value = await fixture();
    const target = path.join(value.workspaceRoot, 'result.md');
    const legacy = path.join(value.workspaceRoot, 'deliverables', 'partner', 'result.md');
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(target, 'current\n', 'utf8');
    await writeFile(legacy, 'old snapshot\n', 'utf8');
    const migration = [{ artifactId: 'artifact-result', relativePath: path.relative(value.workspaceRoot, legacy), originalPath: target }];
    await value.files.initializeProject(value.workspace, migration);
    const record = (await value.files.list('project-a')).find((item) => item.name === 'result.md')!;

    await unlink(target);
    const restartedWorkspaces = new ProjectWorkspaceStore(value.workspaceIndex, () => path.join(value.root, 'projects'));
    const restarted = new ProjectFileStore(value.fileIndex, restartedWorkspaces);
    await restarted.initializeProject(value.workspace, migration);
    const listed = (await restarted.list('project-a')).filter((item) => item.name === 'result.md');
    expect(listed).toEqual([expect.objectContaining({ fileId: record.fileId, relativePath: 'result.md', availability: 'missing' })]);
    await expect(restarted.resolve('project-a', record.fileId)).rejects.toThrow('PROJECT_FILE_NOT_FOUND');

    await writeFile(target, 'current\n', 'utf8');
    expect(await restarted.list('project-a')).toContainEqual(expect.objectContaining({ fileId: record.fileId, availability: 'available' }));
    expect(await restarted.resolve('project-a', record.fileId)).toBe(await realpath(target));
    await expect(restarted.validateRefs('project-a', [{
      fileId: record.fileId,
      relativePath: record.relativePath,
      revision: record.revision,
      contentHash: record.contentHash!,
      sizeBytes: record.sizeBytes,
    }])).resolves.toBeUndefined();
  });

  it('hides an explicitly removed record while retaining its stable identity for history and restart', async () => {
    const value = await fixture();
    const target = path.join(value.workspaceRoot, 'obsolete.md');
    await writeFile(target, 'obsolete\n', 'utf8');
    await value.files.initializeProject(value.workspace, [{ artifactId: 'artifact-obsolete', relativePath: 'obsolete.md', originalPath: target }]);
    const record = (await value.files.list('project-a')).find((item) => item.name === 'obsolete.md')!;

    await value.files.markRemoved('project-a', record.fileId, '2026-10-17T00:00:00.000Z');
    expect(await value.files.list('project-a')).not.toContainEqual(expect.objectContaining({ fileId: record.fileId }));
    expect(await value.files.allSnapshots()).toContainEqual(expect.objectContaining({ fileId: record.fileId, removedAt: '2026-10-17T00:00:00.000Z' }));

    const restartedWorkspaces = new ProjectWorkspaceStore(value.workspaceIndex, () => path.join(value.root, 'projects'));
    const restarted = new ProjectFileStore(value.fileIndex, restartedWorkspaces);
    expect(await restarted.list('project-a')).not.toContainEqual(expect.objectContaining({ fileId: record.fileId }));
    expect(await restarted.allSnapshots()).toContainEqual(expect.objectContaining({ fileId: record.fileId, removedAt: '2026-10-17T00:00:00.000Z' }));
  });
});
