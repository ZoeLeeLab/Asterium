import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PartnerProjectNotebookService } from '../../src/main/notebook/PartnerProjectNotebookService';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-notebook-service-'));
  temporaryDirectories.push(root);
  const partnerIds = ['partner-a', 'partner-b'];
  let project = { id: 'project-a', name: '项目 A', memberIds: [...partnerIds] };
  const profiles = {
    partnerIds: async () => [...partnerIds],
    workMemoryDirectory: async (partnerId: string) => path.join(root, partnerId, 'work-memory'),
  };
  const domain = {
    getProject: async (projectId: string) => projectId === project.id ? structuredClone(project) : undefined,
    snapshot: async () => ({ version: 1 as const, projects: [structuredClone(project)], tasks: [] }),
  };
  const service = new PartnerProjectNotebookService(profiles, domain as never);
  return { service, setMembers: (memberIds: string[]) => { project = { ...project, memberIds }; } };
}

describe('PartnerProjectNotebookService', () => {
  it('marks removed members inactive and restores access state when they rejoin', async () => {
    const value = await fixture();
    const store = await value.service.notebookStore('partner-b');
    await store.append({ projectId: 'project-a', projectName: '项目 A', content: '伙伴 B 的笔记' });

    value.setMembers(['partner-a']);
    await value.service.applyProjectMembership('project-a', '项目 A', ['partner-a']);
    await expect(value.service.assertActiveMembership('partner-b', 'project-a')).rejects.toThrow('PROJECT_NOTEBOOK_ACCESS_DENIED');
    await expect(store.get('project-a', { includeInactive: true })).resolves.toMatchObject({ state: 'inactive' });

    value.setMembers(['partner-a', 'partner-b']);
    await value.service.applyProjectMembership('project-a', '项目 A', ['partner-a', 'partner-b']);
    await expect(value.service.assertActiveMembership('partner-b', 'project-a')).resolves.toMatchObject({ id: 'project-a' });
    await expect(store.get('project-a')).resolves.toMatchObject({ state: 'active', content: '伙伴 B 的笔记' });
    await expect(value.service.listAccessibleProjects('partner-b')).resolves.toEqual([{ projectId: 'project-a', name: '项目 A', status: undefined }]);
  });

  it('archives every historical partner notebook, restores snapshots, and only purges archives', async () => {
    const value = await fixture();
    const firstStore = await value.service.notebookStore('partner-a');
    const secondStore = await value.service.notebookStore('partner-b');
    await firstStore.append({ projectId: 'project-a', projectName: '旧项目名', content: 'A' });
    await secondStore.append({ projectId: 'project-a', projectName: '旧项目名', content: 'B' });
    await value.service.applyProjectMembership('project-a', '项目 A', ['partner-a']);
    const snapshot = await value.service.snapshotProject('project-a');

    await value.service.archiveProject('project-a', '项目归档名');
    await expect(value.service.getArchived('partner-a', 'project-a')).resolves.toMatchObject({ content: 'A', state: 'archived' });
    await expect(value.service.listArchived()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ partnerId: 'partner-a', state: 'archived', projectName: '项目归档名' }),
      expect.objectContaining({ partnerId: 'partner-b', state: 'archived', projectName: '项目归档名' }),
    ]));
    await expect(firstStore.append({ projectId: 'project-a', projectName: '项目 A', content: '不可写' })).rejects.toThrow('PROJECT_NOTEBOOK_ARCHIVED');

    await value.service.restoreProject(snapshot);
    await expect(value.service.getArchived('partner-a', 'project-a')).rejects.toThrow('PROJECT_NOTEBOOK_ARCHIVED_NOT_FOUND');
    await expect(firstStore.get('project-a')).resolves.toMatchObject({ state: 'active', content: 'A' });
    await expect(secondStore.get('project-a', { includeInactive: true })).resolves.toMatchObject({ state: 'inactive', content: 'B' });
    await expect(value.service.purgeArchived('partner-a', 'project-a')).rejects.toThrow('PROJECT_NOTEBOOK_PURGE_REQUIRES_ARCHIVED');

    await value.service.archiveProject('project-a', '项目 A');
    await expect(value.service.purgeArchived('partner-a', 'project-a')).resolves.toMatchObject({ content: 'A', state: 'archived' });
    await expect(firstStore.get('project-a', { includeArchived: true })).resolves.toBeUndefined();
  });
});
