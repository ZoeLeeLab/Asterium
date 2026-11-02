import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectTaskExecutionStore } from '../../src/main/project/ProjectTaskExecutionStore';
import type { FrozenTaskContract } from '../../src/shared/projectTaskExecution';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ProjectTaskExecutionStore role migration', () => {
  it('restores legacy frozen roles and new review-role snapshots without rewriting attempts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-task-executions-'));
    temporary.push(directory);
    const filePath = path.join(directory, 'project-task-executions.v1.json');
    const store = new ProjectTaskExecutionStore(filePath);
    const attempt = await store.createAttempt({
      projectId: 'project-a', taskId: 'task-a', taskRevision: 3, assigneeId: 'partner-a', permissionMode: 'manual', blockedByTaskIds: [],
    });
    const contract: FrozenTaskContract = {
      version: 1, purpose: 'execution', actorPartnerId: 'partner-a', projectId: 'project-a', projectName: '项目 A', projectDescription: '',
      taskId: 'task-a', taskCode: 'TSK-001', taskRevision: 3, title: '迁移测试', description: '', assigneeId: 'partner-a',
      workRole: { roleId: 'legacy-role', name: '旧执行角色', responsibilities: ['保持旧快照'], scope: 'project' },
      reviewWorkRole: { roleId: 'review-role', roleRevision: 4, name: '架构审计', description: '检查系统边界', responsibilities: ['检查边界'], prompt: '只报告证据。', scope: 'global' },
      acceptanceCriteria: [], completionRule: { type: 'executor_submit' }, dependencyHandoffs: [],
      workspace: { projectRoot: 'K:\\project-a', executionMode: 'shared_serial' }, frozenAt: '2026-10-16T00:00:00.000Z',
    };
    await store.freezeContract(attempt.id, contract);

    const restarted = new ProjectTaskExecutionStore(filePath);
    const restored = (await restarted.snapshot('project-a')).attempts[0];
    expect(restored.id).toBe(attempt.id);
    expect(restored.contract?.workRole).toMatchObject({ roleId: 'legacy-role', name: '旧执行角色' });
    expect(restored.contract?.workRole.roleRevision).toBeUndefined();
    expect(restored.contract?.reviewWorkRole).toEqual(contract.reviewWorkRole);
  });
});
