import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectWorkRoleStore } from '../../src/main/project/ProjectWorkRoleStore';
import { projectWorkRoleSnapshot } from '../../src/shared/projectRoles';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-roles-'));
  temporary.push(directory);
  const filePath = path.join(directory, 'project-work-roles.v1.json');
  return { filePath, store: new ProjectWorkRoleStore(filePath) };
}

describe('ProjectWorkRoleStore', () => {
  it('merges built-in, global, and project roles and restores custom roles after restart', async () => {
    const { filePath, store } = await fixture();
    const global = await store.create({ scope: 'global', name: '全局审计', responsibilities: ['检查边界'], prompt: '只报告证据。' });
    const project = await store.create({ scope: 'project', projectId: 'project-a', name: '项目实现', responsibilities: ['实现范围'] });
    await store.create({ scope: 'project', projectId: 'project-b', name: '其他项目', responsibilities: ['不应出现'] });

    const catalog = await store.catalog('project-a');
    expect(catalog.roles.some((role) => role.scope === 'builtin')).toBe(true);
    expect(catalog.roles.filter((role) => role.scope === 'builtin').map((role) => role.group)).toEqual(expect.arrayContaining(['项目准备', '项目前期', '项目中期', '项目收尾']));
    expect(catalog.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: global.id, scope: 'global' }),
      expect.objectContaining({ id: project.id, scope: 'project', projectId: 'project-a' }),
    ]));
    expect(catalog.roles.some((role) => role.name === '其他项目')).toBe(false);

    const restarted = new ProjectWorkRoleStore(filePath);
    expect((await restarted.catalog('project-a')).roles).toEqual(catalog.roles);
  });

  it('keeps selected snapshots immutable across edit, archive, and deletion', async () => {
    const { store } = await fixture();
    const created = await store.create({ scope: 'project', projectId: 'project-a', name: '实现角色', description: '旧说明', responsibilities: ['实现旧范围'], prompt: '旧 Prompt' });
    const snapshot = projectWorkRoleSnapshot(created);
    await expect(store.validateSnapshot('project-a', snapshot)).resolves.toEqual(snapshot);

    const updated = await store.update({
      roleId: created.id, expectedRevision: created.revision, name: '实现角色新版', description: '新说明', responsibilities: ['实现新范围'], prompt: '新 Prompt',
    });
    expect(snapshot).toMatchObject({ roleId: created.id, roleRevision: 1, name: '实现角色', description: '旧说明', responsibilities: ['实现旧范围'], prompt: '旧 Prompt' });
    await expect(store.validateSnapshot('project-a', snapshot)).rejects.toThrow('PROJECT_WORK_ROLE_SNAPSHOT_STALE');

    const archived = await store.setArchived({ roleId: updated.id, expectedRevision: updated.revision, archived: true });
    await expect(store.validateSnapshot('project-a', projectWorkRoleSnapshot(archived))).rejects.toThrow('PROJECT_WORK_ROLE_NOT_SELECTABLE');
    await store.remove({ roleId: archived.id, expectedRevision: archived.revision });
    expect((await store.catalog('project-a')).roles.some((role) => role.id === created.id)).toBe(false);
    expect(snapshot.name).toBe('实现角色');
  });

  it('persists preset and custom role groups while migrating older roles to 其他', async () => {
    const { filePath, store } = await fixture();
    await writeFile(filePath, JSON.stringify({ version: 1, roles: [{
      version: 1, id: 'legacy-role', scope: 'global', name: '旧角色', description: '', responsibilities: ['保留'], prompt: '', revision: 1,
      createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
    }] }), 'utf8');
    expect((await store.catalog('project-a')).roles).toContainEqual(expect.objectContaining({ id: 'legacy-role', group: '其他' }));

    const created = await store.create({ scope: 'project', projectId: 'project-a', group: '发布准备', name: '发布角色', responsibilities: ['准备发布'] });
    expect(created.group).toBe('发布准备');
    const updated = await store.update({ roleId: created.id, expectedRevision: created.revision, group: '项目收尾', name: created.name, responsibilities: created.responsibilities });
    expect(updated.group).toBe('项目收尾');
    expect((await new ProjectWorkRoleStore(filePath).catalog('project-a')).roles).toContainEqual(expect.objectContaining({ id: created.id, group: '项目收尾' }));
  });

  it('removes and restores only project roles while preserving global roles', async () => {
    const { store } = await fixture();
    const global = await store.create({ scope: 'global', name: '全局角色', responsibilities: ['跨项目可用'] });
    const project = await store.create({ scope: 'project', projectId: 'project-a', name: '项目角色', responsibilities: ['只属于项目'] });

    const removed = await store.removeProject('project-a');
    expect(removed).toEqual([project]);
    expect((await store.catalog('project-a')).roles.some((role) => role.id === global.id)).toBe(true);
    expect((await store.catalog('project-a')).roles.some((role) => role.id === project.id)).toBe(false);

    await store.restoreProject('project-a', removed);
    expect((await store.catalog('project-a')).roles).toEqual(expect.arrayContaining([expect.objectContaining({ id: global.id }), expect.objectContaining({ id: project.id })]));
  });
});
