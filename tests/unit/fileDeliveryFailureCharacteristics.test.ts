import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactRegistry } from '../../src/main/security/ArtifactRegistry';
import { ArtifactDeliveryService } from '../../src/main/project/ArtifactDeliveryService';
import { ProjectWorkspaceStore } from '../../src/main/project/ProjectWorkspaceStore';
import { ProjectFileStore } from '../../src/main/project/ProjectFileStore';
import { prototypeReducer } from '../../src/renderer/app/PrototypeProvider';
import { createTestState } from '../fixtures/applicationState';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-delivery-characterization-'));
  temporaryDirectories.push(root);
  const source = path.join(root, 'result.md');
  const registryStore = path.join(root, 'state', 'artifacts.json');
  const workspaceStore = path.join(root, 'state', 'projects.json');
  const registry = new ArtifactRegistry({ storePath: registryStore });
  const workspaces = new ProjectWorkspaceStore(workspaceStore, () => path.join(root, 'visible-projects'));
  const fileStore = path.join(root, 'state', 'project-files.json');
  const files = new ProjectFileStore(fileStore, workspaces);
  const delivery = new ArtifactDeliveryService({ artifacts: registry, workspaces, files, partnerName: async () => '伙伴 A' });
  await writeFile(source, '# deliverable', 'utf8');
  await registry.register({ kind: 'local_path', path: source }, { id: 'artifact-result', name: 'result.md', method: 'automatic', partnerId: 'partner-a' });
  return { root, source, registry, workspaces, files, delivery, registryStore, workspaceStore, fileStore };
}

describe('file delivery failure characteristics', () => {
  it('creates no project file when source validation fails', async () => {
    const { source, delivery, workspaces, root } = await fixture();
    await workspaces.create({ projectId: 'project-one', name: '项目一', selectedRoot: path.join(root, 'visible-project') });
    await unlink(source);

    await expect(delivery.deliver({ artifactId: 'artifact-result', projectId: 'project-one', source: 'partner' })).rejects.toThrow('ARTIFACT_SOURCE_MISSING');
    expect(await readdir(path.join(root, 'visible-project', 'deliverables'))).toEqual([]);
  });

  it('does not create an internal backup when the project destination is unavailable', async () => {
    const { delivery, registryStore, workspaces } = await fixture();

    await expect(delivery.deliver({ artifactId: 'artifact-result', projectId: 'project-missing', source: 'partner' })).rejects.toThrow('PROJECT_WORKSPACE_NOT_READY');
    expect(await workspaces.get('project-missing')).toBeUndefined();
    expect(await readFile(registryStore, 'utf8')).not.toContain('projectCopies');
  });

  it('treats the project directory as the only formal copy and rediscovers an unindexed delivery', async () => {
    const { root, delivery, workspaces, files } = await fixture();
    const state = createTestState();
    const project = state.projects[0];
    await workspaces.create({ projectId: project.id, name: project.name, selectedRoot: path.join(root, 'visible-project') });
    const delivered = await delivery.deliver({ artifactId: 'artifact-result', projectId: project.id, source: 'partner' });

    expect(await readFile(delivered.absolutePath, 'utf8')).toBe('# deliverable');
    expect(delivered.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state.projects.find((item) => item.id === project.id)?.files.some((file) => file.name === 'result.md')).toBe(false);

    const discovered = prototypeReducer(state, {
      type: 'syncProjectFiles',
      projectId: project.id,
      files: await delivery.listProjectFiles(project.id),
    });
    expect(discovered.projects.find((item) => item.id === project.id)?.files).toContainEqual(expect.objectContaining({
      name: 'result.md', relativePath: delivered.relativePath, availability: 'available',
    }));

    await unlink(delivered.absolutePath);
    const removed = prototypeReducer(discovered, { type: 'syncProjectFiles', projectId: project.id, files: await delivery.listProjectFiles(project.id) });
    expect(removed.projects.find((item) => item.id === project.id)?.files).toContainEqual(expect.objectContaining({
      name: 'result.md', relativePath: delivered.relativePath, availability: 'missing',
    }));
    await expect(files.resolve(project.id, delivered.fileId)).rejects.toThrow('PROJECT_FILE_NOT_FOUND');
  });

  it('deduplicates an exact retry and preserves provenance for restart index repair', async () => {
    const { root, delivery, workspaces, registry, registryStore, workspaceStore, fileStore } = await fixture();
    await workspaces.create({ projectId: 'project-one', name: '项目一', selectedRoot: path.join(root, 'visible-project') });

    const first = await delivery.deliver({ artifactId: 'artifact-result', projectId: 'project-one', source: 'partner' });
    const retry = await delivery.deliver({ artifactId: 'artifact-result', projectId: 'project-one', source: 'partner' });
    const restartedRegistry = new ArtifactRegistry({ storePath: registryStore });
    const restartedWorkspaces = new ProjectWorkspaceStore(workspaceStore, () => path.join(root, 'visible-projects'));
    const restartedFiles = new ProjectFileStore(fileStore, restartedWorkspaces);
    const restartedDelivery = new ArtifactDeliveryService({ artifacts: restartedRegistry, workspaces: restartedWorkspaces, files: restartedFiles, partnerName: async () => '伙伴 A' });
    const files = await restartedDelivery.listProjectFiles('project-one');

    expect(retry.relativePath).toBe(first.relativePath);
    expect(await readdir(path.dirname(first.absolutePath))).toEqual(expect.arrayContaining(['result.md']));
    expect(retry.fileId).toBe(first.fileId);
    expect(await registry.listProjectDeliveries('project-one')).toEqual([]);
    expect(files).toEqual(expect.arrayContaining([expect.objectContaining({ artifactId: 'artifact-result', contentHash: first.contentHash, sourcePartnerId: 'partner-a' })]));
  });

  it('imports an external source once into the project root without creating a deliverables snapshot', async () => {
    const { root, delivery, workspaces } = await fixture();
    await workspaces.create({ projectId: 'project-one', name: '项目一', selectedRoot: path.join(root, 'visible-project') });
    const result = await delivery.deliver({ artifactId: 'artifact-result', projectId: 'project-one', source: 'partner' });
    expect(result.relativePath).toBe('result.md');
    expect(await readdir(path.join(root, 'visible-project', 'deliverables'))).toEqual([]);
  });

  it('does not overwrite a current project file from a changed external source without matching canonical identity', async () => {
    const { delivery, workspaces, source, root } = await fixture();
    await workspaces.create({ projectId: 'project-one', name: '项目一', selectedRoot: path.join(root, 'visible-project') });
    const first = await delivery.deliver({ artifactId: 'artifact-result', projectId: 'project-one', source: 'partner' });
    await writeFile(source, '# changed outside', 'utf8');
    await expect(delivery.deliver({ artifactId: 'artifact-result', projectId: 'project-one', source: 'partner' })).rejects.toThrow('PROJECT_FILE_UPDATE_REQUIRES_CANONICAL_PATH');
    expect(await readFile(first.absolutePath, 'utf8')).toBe('# deliverable');
  });
});
