import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectTaskHandoffValidator } from '../../src/main/project/ProjectTaskHandoffValidator';
import type { FrozenTaskContract, TaskHandoffSubmission } from '../../src/shared/projectTaskExecution';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-handoff-'));
  temporary.push(root);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
  const contract: FrozenTaskContract = {
    version: 1, projectId: 'project-a', projectName: '项目', projectDescription: '', taskId: 'task-a', taskCode: 'TSK-001', taskRevision: 2,
    purpose: 'execution', actorPartnerId: 'partner-a',
    title: '任务', description: '', assigneeId: 'partner-a', workRole: { name: '执行者', responsibilities: ['完成任务'], scope: 'inline' },
    acceptanceCriteria: [{ criterionId: 'r2:c1', text: '实现可验证' }], completionRule: { type: 'executor_submit' }, dependencyHandoffs: [],
    workspace: { projectRoot: root, executionMode: 'shared_serial' }, frozenAt: '2026-10-15T00:00:00.000Z',
  };
  const validator = new ProjectTaskHandoffValidator({ validateFileRefs: async () => undefined });
  const submitted: TaskHandoffSubmission = {
    disposition: 'submitted', summary: '实现完成并通过检查。',
    criterionEvidence: [{ criterionId: 'r2:c1', result: 'satisfied', evidence: ['单元测试通过'] }],
    changedPaths: ['src/index.ts'], verification: [{ commandOrCheck: 'npm test', result: 'passed', evidence: '全部通过' }],
    deliveryRefs: [], unresolvedIssues: [],
  };
  return { root, contract, validator, submitted };
}

describe('ProjectTaskHandoffValidator', () => {
  it('normalizes project paths and accepts only complete submitted handoffs', async () => {
    const value = await fixture();
    await expect(value.validator.validate(value.contract, value.submitted)).resolves.toMatchObject({ changedPaths: ['src/index.ts'], deliveryRefs: [], fileRefs: [] });
    await expect(value.validator.validate(value.contract, { ...value.submitted, criterionEvidence: [] })).rejects.toThrow('TASK_HANDOFF_CRITERIA_INCOMPLETE');
    await expect(value.validator.validate(value.contract, { ...value.submitted, criterionEvidence: [{ criterionId: 'r2:c1', result: 'satisfied', evidence: [] }] })).rejects.toThrow('TASK_HANDOFF_CRITERIA_EVIDENCE_REQUIRED');
    await expect(value.validator.validate(value.contract, { ...value.submitted, unresolvedIssues: ['还有问题'] })).rejects.toThrow('TASK_HANDOFF_SUBMITTED_NOT_READY');
  });

  it('rejects paths outside the project and delivery references not formally registered to it', async () => {
    const value = await fixture();
    await expect(value.validator.validate(value.contract, { ...value.submitted, changedPaths: [path.join(value.root, '..', 'outside.txt')] })).rejects.toThrow('TASK_HANDOFF_PATH_OUTSIDE_PROJECT');
    await expect(value.validator.validate(value.contract, { ...value.submitted, deliveryRefs: ['artifact-other'] })).rejects.toThrow('TASK_HANDOFF_DELIVERY_REF_INVALID');
  });

  it('requires a scoped question when handing a decision back to the user', async () => {
    const value = await fixture();
    await expect(value.validator.validate(value.contract, { ...value.submitted, disposition: 'needs_user_decision', criterionEvidence: [{ criterionId: 'r2:c1', result: 'unverified', evidence: [] }], deliveryRefs: [] })).rejects.toThrow('TASK_HANDOFF_USER_DECISION_REQUIRED');
    await expect(value.validator.validate(value.contract, {
      ...value.submitted,
      disposition: 'needs_user_decision',
      criterionEvidence: [{ criterionId: 'r2:c1', result: 'unverified', evidence: ['需要用户选择'] }],
      deliveryRefs: [],
      unresolvedIssues: ['等待用户选择'],
      userDecisionRequest: { question: '是否采用方案 A？', reason: '两种方案取舍不同。', affectedCriteria: ['r2:c1'] },
    })).resolves.toMatchObject({ disposition: 'needs_user_decision', userDecisionRequest: { affectedCriteria: ['r2:c1'] } });
  });
});
