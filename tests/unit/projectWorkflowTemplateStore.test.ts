import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectWorkflowTemplateStore } from '../../src/main/project/ProjectWorkflowTemplateStore';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-workflow-template-store-'));
  temporary.push(root);
  const storePath = path.join(root, 'templates.json');
  return { storePath, store: new ProjectWorkflowTemplateStore(storePath) };
}

const nodes = [{
  id: 'step-a', position: 0, title: '实现', description: '完成实现', assigneeId: 'partner-a',
  dependencyNodeIds: [], acceptanceCriteria: ['功能可用'], note: '',
  execution: { completionRule: { type: 'executor_submit' as const } },
}];

describe('ProjectWorkflowTemplateStore', () => {
  it('persists project templates and revisions across restart', async () => {
    const { storePath, store } = await fixture();
    const created = await store.create({ projectId: 'project-a', name: '我的模板', description: '项目内复用', nodes });
    expect(created).toMatchObject({ projectId: 'project-a', revision: 1, name: '我的模板' });

    const restarted = new ProjectWorkflowTemplateStore(storePath);
    expect(await restarted.get('project-a', created.id)).toEqual(created);
    const updated = await restarted.update({
      projectId: 'project-a', templateId: created.id, expectedRevision: 1,
      name: '更新模板', description: '新说明', nodes: [{ ...nodes[0], title: '更新实现' }],
    });
    expect(updated).toMatchObject({ revision: 2, name: '更新模板', nodes: [{ title: '更新实现' }] });
    await expect(restarted.update({
      projectId: 'project-a', templateId: created.id, expectedRevision: 1,
      name: '过期更新', nodes,
    })).rejects.toThrow('PROJECT_WORKFLOW_TEMPLATE_REVISION_CONFLICT');
  });

  it('removes and restores only the requested project templates', async () => {
    const { store } = await fixture();
    const projectA = await store.create({ projectId: 'project-a', name: 'A 模板', nodes });
    const projectB = await store.create({ projectId: 'project-b', name: 'B 模板', nodes });
    const removed = await store.removeProject('project-a');
    expect(removed).toEqual([projectA]);
    expect(await store.listProject('project-a')).toEqual([]);
    expect(await store.listProject('project-b')).toEqual([projectB]);
    await store.restoreProject('project-a', removed);
    expect(await store.listProject('project-a')).toEqual([projectA]);
  });
});
