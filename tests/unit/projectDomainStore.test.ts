import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectDomainStore } from '../../src/main/project/ProjectDomainStore';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function storeFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-domain-'));
  temporary.push(directory);
  const filePath = path.join(directory, 'project-domain.v1.json');
  return { filePath, store: new ProjectDomainStore(filePath) };
}

describe('ProjectDomainStore', () => {
  it('migrates legacy Renderer projects once and restores the Main snapshot after restart', async () => {
    const { filePath, store } = await storeFixture();
    const migrated = await store.initialize([{
      id: 'project-one',
      name: '项目一',
      description: '从 Renderer 迁移',
      memberIds: ['partner-a'],
      tasks: [{
        id: 'task-one', title: '首个任务', ownerId: 'partner-a', status: 'handoff',
        acceptanceCriteria: ['可以重启恢复'], note: '旧任务备注',
      }],
    }]);

    expect(migrated.projects[0]).toMatchObject({ id: 'project-one', revision: 1, memberIds: ['partner-a'] });
    expect(migrated.tasks[0]).toMatchObject({
      id: 'task-one', projectId: 'project-one', assigneeId: 'partner-a', status: 'todo',
      acceptanceCriteria: ['可以重启恢复'], revision: 1,
    });

    const restarted = new ProjectDomainStore(filePath);
    expect(await restarted.snapshot()).toEqual(migrated);
    expect(await restarted.initialize([{ id: 'project-ignored', name: '不会二次迁移' }])).toEqual(migrated);
  });

  it('persists task assignment, status, dependencies, acceptance criteria, and optimistic revisions', async () => {
    const { filePath, store } = await storeFixture();
    await store.createProject({ id: 'project-one', name: '项目一', memberIds: ['partner-a', 'partner-b'] });
    const foundation = await store.createTask({
      projectId: 'project-one', title: '基础任务', assigneeId: 'partner-a',
      acceptanceCriteria: ['产物存在'], description: '先完成基础能力',
    });
    const dependent = await store.createTask({
      projectId: 'project-one', title: '依赖任务', assigneeId: 'partner-b',
      dependencyIds: [foundation.id], acceptanceCriteria: ['依赖关系可恢复'],
    });
    const updated = await store.updateTask({
      projectId: 'project-one', taskId: dependent.id, expectedRevision: dependent.revision,
      title: dependent.title, code: dependent.code, description: '已经开始', assigneeId: 'partner-b',
      status: 'in_progress', dependencyIds: [foundation.id], acceptanceCriteria: ['依赖关系可恢复', '状态可恢复'], note: '执行中',
    });

    expect(updated).toMatchObject({ status: 'in_progress', revision: 2, dependencyIds: [foundation.id], note: '执行中' });
    const projected = await store.setTaskStatusForExecution('project-one', dependent.id, 'blocked');
    expect(projected).toMatchObject({ status: 'blocked', revision: 3 });
    const restoredProjection = await store.setTaskStatusForExecution('project-one', dependent.id, 'in_progress');
    expect(restoredProjection).toMatchObject({ status: 'in_progress', revision: 4 });
    await expect(store.updateTask({
      projectId: 'project-one', taskId: dependent.id, expectedRevision: dependent.revision,
      title: dependent.title, status: 'completed', dependencyIds: [foundation.id],
    })).rejects.toThrow('PROJECT_TASK_REVISION_CONFLICT');

    const restarted = new ProjectDomainStore(filePath);
    expect((await restarted.projectSnapshot('project-one'))?.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: foundation.id, assigneeId: 'partner-a' }),
      expect.objectContaining({ id: dependent.id, status: 'in_progress', acceptanceCriteria: ['依赖关系可恢复', '状态可恢复'] }),
    ]));
  });

  it('keeps legacy role snapshots without revisions readable during the additive 5A migration', async () => {
    const { filePath, store } = await storeFixture();
    await store.createProject({ id: 'project-one', name: '项目一', memberIds: ['partner-a', 'partner-b'] });
    const task = await store.createTask({
      projectId: 'project-one', title: '旧角色任务', assigneeId: 'partner-a', acceptanceCriteria: ['保持兼容'],
      execution: {
        workRole: { roleId: 'legacy-role', name: '旧角色', responsibilities: ['保持旧快照'], scope: 'project' },
        completionRule: { type: 'partner_review', reviewerPartnerId: 'partner-b', autoReworkLimit: 2 },
      },
    });

    const restarted = new ProjectDomainStore(filePath);
    expect((await restarted.projectSnapshot('project-one'))?.tasks[0]).toMatchObject({
      id: task.id,
      execution: { workRole: { roleId: 'legacy-role', name: '旧角色' } },
    });
    expect((await restarted.projectSnapshot('project-one'))?.tasks[0].execution?.workRole?.roleRevision).toBeUndefined();
  });

  it('rejects invalid assignees, dependency cycles, and deletion of a depended-on task', async () => {
    const { store } = await storeFixture();
    await store.createProject({ id: 'project-one', name: '项目一', memberIds: ['partner-a', 'partner-b'] });
    await expect(store.createTask({
      projectId: 'project-one', title: '越权分配', assigneeId: 'partner-outside',
    })).rejects.toThrow('PROJECT_TASK_ASSIGNEE_NOT_MEMBER');
    await expect(store.createTask({
      projectId: 'project-one', title: '越权复核',
      execution: { completionRule: { type: 'partner_review', reviewerPartnerId: 'partner-outside', autoReworkLimit: 2 } },
    })).rejects.toThrow('PROJECT_TASK_REVIEWER_NOT_MEMBER');

    const reviewed = await store.createTask({
      projectId: 'project-one', title: '复核任务', assigneeId: 'partner-a', acceptanceCriteria: ['可复核'],
      execution: { completionRule: { type: 'partner_review', reviewerPartnerId: 'partner-b', autoReworkLimit: 2 } },
    });
    const first = await store.createTask({ projectId: 'project-one', title: '任务一' });
    const second = await store.createTask({ projectId: 'project-one', title: '任务二', dependencyIds: [first.id] });
    await expect(store.updateTask({
      projectId: 'project-one', taskId: first.id, expectedRevision: first.revision,
      title: first.title, status: first.status, dependencyIds: [second.id],
    })).rejects.toThrow('PROJECT_TASK_DEPENDENCY_CYCLE');
    await expect(store.removeTask('project-one', first.id, first.revision)).rejects.toThrow('PROJECT_TASK_HAS_DEPENDENTS');

    await store.updateMembers('project-one', []);
    const snapshot = await store.projectSnapshot('project-one');
    expect(snapshot?.tasks.every((task) => task.assigneeId === undefined)).toBe(true);
    expect(snapshot?.tasks.find((task) => task.id === reviewed.id)?.execution?.completionRule).toEqual({ type: 'user_confirm' });
  });
});
