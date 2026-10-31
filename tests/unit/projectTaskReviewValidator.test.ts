import { describe, expect, it } from 'vitest';
import { ProjectTaskReviewValidator } from '../../src/main/project/ProjectTaskReviewValidator';
import type { FrozenTaskContract } from '../../src/shared/projectTaskExecution';

function contract(): FrozenTaskContract {
  return {
    version: 1, purpose: 'review', actorPartnerId: 'partner-b',
    projectId: 'project-a', projectName: '项目', projectDescription: '', taskId: 'task-a', taskCode: 'TSK-001', taskRevision: 1,
    title: '复核任务', description: '', assigneeId: 'partner-a',
    workRole: { name: '独立复核', responsibilities: ['只按标准检查'], scope: 'inline' },
    acceptanceCriteria: [{ criterionId: 'r1:c1', text: '功能通过' }, { criterionId: 'r1:c2', text: '测试通过' }],
    completionRule: { type: 'partner_review', reviewerPartnerId: 'partner-b', autoReworkLimit: 2 }, dependencyHandoffs: [],
    stageContext: { type: 'review', reviewRound: 0, candidateHandoffs: [] },
    workspace: { projectRoot: 'K:\\project', executionMode: 'shared_serial' }, frozenAt: '2026-10-16T00:00:00.000Z',
  };
}

describe('ProjectTaskReviewValidator', () => {
  it('accepts PASS only when every frozen criterion passes exactly once', () => {
    const validator = new ProjectTaskReviewValidator();
    expect(validator.validate(contract(), {
      decision: 'pass', summary: '全部冻结验收标准通过。',
      criteria: [
        { criterionId: 'r1:c1', verdict: 'pass', evidence: ['功能证据'] },
        { criterionId: 'r1:c2', verdict: 'pass', evidence: ['测试证据'] },
      ],
    })).toMatchObject({ decision: 'pass' });
    expect(() => validator.validate(contract(), {
      decision: 'pass', summary: '错误地声明全部通过。',
      criteria: [
        { criterionId: 'r1:c1', verdict: 'pass', evidence: ['功能证据'] },
        { criterionId: 'r1:c2', verdict: 'unverified', evidence: ['无法确认测试结果'] },
      ],
    })).toThrow('TASK_REVIEW_PASS_INVALID');
    expect(() => validator.validate(contract(), {
      decision: 'pass', summary: '缺少复核证据。',
      criteria: [
        { criterionId: 'r1:c1', verdict: 'pass', evidence: [] },
        { criterionId: 'r1:c2', verdict: 'pass', evidence: ['测试证据'] },
      ],
    })).toThrow('TASK_REVIEW_CRITERIA_EVIDENCE_REQUIRED');
  });

  it('rejects missing, duplicate, or invented criteria and requires a scoped user question', () => {
    const validator = new ProjectTaskReviewValidator();
    expect(() => validator.validate(contract(), {
      decision: 'changes_required', summary: '缺少一个标准。',
      criteria: [{ criterionId: 'r1:c1', verdict: 'fail', evidence: ['失败证据'], feedback: '修复。' }],
    })).toThrow('TASK_REVIEW_CRITERIA_INCOMPLETE');
    expect(() => validator.validate(contract(), {
      decision: 'changes_required', summary: '包含虚构标准。',
      criteria: [
        { criterionId: 'r1:c1', verdict: 'fail', evidence: ['失败证据'] },
        { criterionId: 'invented', verdict: 'fail', evidence: ['虚构证据'] },
      ],
    })).toThrow('TASK_REVIEW_CRITERIA_INVALID');
    expect(() => validator.validate(contract(), {
      decision: 'needs_user_decision', summary: '需要用户决定。',
      criteria: [
        { criterionId: 'r1:c1', verdict: 'pass', evidence: ['功能证据'] },
        { criterionId: 'r1:c2', verdict: 'unverified', evidence: ['范围不明确'] },
      ],
    })).toThrow('TASK_REVIEW_USER_DECISION_REQUIRED');
    expect(validator.validate(contract(), {
      decision: 'needs_user_decision', summary: '存在范围争议，需要用户决定。',
      criteria: [
        { criterionId: 'r1:c1', verdict: 'pass', evidence: ['功能证据'] },
        { criterionId: 'r1:c2', verdict: 'unverified', evidence: ['范围不明确'] },
      ],
      userDecisionRequest: { question: '是否接受现有测试范围？', reason: '冻结标准未说明该平台。', affectedCriteria: ['r1:c2'] },
    })).toMatchObject({ decision: 'needs_user_decision', userDecisionRequest: { affectedCriteria: ['r1:c2'] } });
  });
});
