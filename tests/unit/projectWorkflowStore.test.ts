import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectWorkflowStore } from '../../src/main/project/ProjectWorkflowStore';
import type { ProjectTask } from '../../src/shared/projectDomain';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-workflow-store-'));
  temporary.push(root);
  const storePath = path.join(root, 'workflows.json');
  return { storePath, store: new ProjectWorkflowStore(storePath) };
}

const node = (id: string, position: number, dependencyNodeIds: string[] = []) => ({
  id, position, title: `步骤 ${position + 1}`, description: '', assigneeId: 'partner-a', dependencyNodeIds,
  acceptanceCriteria: ['完成'], note: '', execution: { completionRule: { type: 'executor_submit' as const } },
});

const task = (id: string, status: ProjectTask['status']): ProjectTask => ({
  version: 1, id, projectId: 'project-a', code: id, title: id, description: '', status,
  dependencyIds: [], acceptanceCriteria: [], note: '', revision: 1,
  createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
});

describe('ProjectWorkflowStore', () => {
  it('persists an editable DAG and restores it after restart', async () => {
    const { storePath, store } = await fixture();
    const created = await store.createDraft({ projectId: 'project-a', name: '持久流程', nodes: [node('step-a', 0), node('step-b', 1, ['step-a'])] });
    const restarted = new ProjectWorkflowStore(storePath);
    expect(await restarted.get('project-a', created.id)).toEqual(created);

    const updated = await restarted.updateDraft({
      projectId: 'project-a', workflowId: created.id, expectedRevision: created.revision,
      name: '更新流程', description: '仍是草稿', nodes: [node('step-b', 0), node('step-a', 1)],
    });
    expect(updated).toMatchObject({ name: '更新流程', revision: 2, status: 'draft' });
  });

  it('rejects invalid and cyclic dependency graphs before persistence', async () => {
    const { store } = await fixture();
    await expect(store.createDraft({ projectId: 'project-a', name: '无效引用', nodes: [node('step-a', 0, ['missing'])] })).rejects.toThrow('PROJECT_WORKFLOW_DEPENDENCY_INVALID');
    await expect(store.createDraft({ projectId: 'project-a', name: '循环', nodes: [node('step-a', 0, ['step-b']), node('step-b', 1, ['step-a'])] })).rejects.toThrow('PROJECT_WORKFLOW_DEPENDENCY_CYCLE');
    expect(await store.listProject('project-a')).toEqual([]);
  });

  it('marks an active workflow completed only after every mapped task completes', async () => {
    const { store } = await fixture();
    const draft = await store.createDraft({ projectId: 'project-a', name: '完成投影', nodes: [node('step-a', 0), node('step-b', 1, ['step-a'])] });
    const activating = await store.markActivating('project-a', draft.id, draft.revision, 'activation-a');
    const active = await store.markActive('project-a', draft.id, 'activation-a', [{ draftNodeId: 'step-a', taskId: 'task-a' }, { draftNodeId: 'step-b', taskId: 'task-b' }]);
    expect(activating.status).toBe('activating');
    expect(active.status).toBe('active');

    await store.reconcileProject('project-a', [task('task-a', 'completed'), task('task-b', 'in_progress')]);
    expect((await store.get('project-a', draft.id))?.status).toBe('active');
    await store.reconcileProject('project-a', [task('task-a', 'completed'), task('task-b', 'completed')]);
    expect(await store.get('project-a', draft.id)).toMatchObject({ status: 'completed', revision: 4 });
  });

  it('terminates legacy active workflows whose mapped task disappeared and persists the repair', async () => {
    const { storePath, store } = await fixture();
    const draft = await store.createDraft({ projectId: 'project-a', name: '悬空流程', nodes: [node('step-a', 0), node('step-b', 1)] });
    await store.markActivating('project-a', draft.id, draft.revision, 'activation-orphaned');
    await store.markActive('project-a', draft.id, 'activation-orphaned', [
      { draftNodeId: 'step-a', taskId: 'task-a' },
      { draftNodeId: 'step-b', taskId: 'task-missing' },
    ]);

    await store.reconcileProject('project-a', [task('task-a', 'completed')]);

    const repaired = await store.get('project-a', draft.id);
    expect(repaired).toMatchObject({
      status: 'cancelled', cancellationReason: 'referenced_task_missing', revision: 4,
      cancelledAt: expect.any(String),
    });
    expect(await new ProjectWorkflowStore(storePath).get('project-a', draft.id)).toEqual(repaired);
    await store.remove('project-a', draft.id, repaired!.revision);
    expect(await store.get('project-a', draft.id)).toBeUndefined();
  });

  it('protects active mapped tasks and terminates a workflow when one task is cancelled', async () => {
    const { store } = await fixture();
    const draft = await store.createDraft({ projectId: 'project-a', name: '取消流程', nodes: [node('step-a', 0)] });
    await store.markActivating('project-a', draft.id, draft.revision, 'activation-cancelled');
    const active = await store.markActive('project-a', draft.id, 'activation-cancelled', [{ draftNodeId: 'step-a', taskId: 'task-a' }]);

    await expect(store.assertTaskRemovable('project-a', 'task-a')).rejects.toThrow('PROJECT_TASK_BELONGS_TO_ACTIVE_WORKFLOW');
    await expect(store.remove('project-a', draft.id, active.revision)).rejects.toThrow('PROJECT_WORKFLOW_ACTIVE');

    await store.reconcileProject('project-a', [task('task-a', 'cancelled')]);
    const cancelled = await store.get('project-a', draft.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancellationReason: 'task_cancelled' });
    await expect(store.assertTaskRemovable('project-a', 'task-a')).resolves.toBeUndefined();
  });
});
