import { describe, expect, it } from 'vitest';
import { projectTaskStatusLabel, taskAttemptFailureLabel, taskStageVoiceItems } from '../../src/renderer/pages/studioTaskPresentation';
import type { TaskItem } from '../../src/renderer/types/domain';

function task(completionRule?: NonNullable<TaskItem['execution']>['completionRule']): TaskItem {
  return {
    version: 1, id: 'task-a', projectId: 'project-a', code: 'TSK-001', title: '任务', description: '', status: 'review', dependencyIds: [],
    acceptanceCriteria: [], note: '', revision: 1, createdAt: '', updatedAt: '', ...(completionRule ? { execution: { completionRule } } : {}),
  };
}

describe('studio task presentation', () => {
  it('shows review as pending review only when a review partner is really configured', () => {
    expect(projectTaskStatusLabel(task())).toBe('已提交/待处理');
    expect(projectTaskStatusLabel(task({ type: 'executor_submit' }))).toBe('已提交/待处理');
    expect(projectTaskStatusLabel(task({ type: 'user_confirm' }))).toBe('已提交/待处理');
    expect(projectTaskStatusLabel(task({ type: 'partner_review', reviewerPartnerId: 'partner-b', autoReworkLimit: 2 }))).toBe('待复核');
  });

  it('shows the persisted failure code and message for a failed attempt', () => {
    expect(taskAttemptFailureLabel({
      version: 1, id: 'attempt-a', projectId: 'project-a', taskId: 'task-a', attemptNumber: 2, taskRevision: 1, completionFlowVersion: 2,
      purpose: 'execution', actorPartnerId: 'partner-a', rootAttemptId: 'attempt-a', reworkRound: 0,
      assigneeId: 'partner-a', permissionMode: 'full', status: 'failed', blockedByTaskIds: [], createdAt: '', updatedAt: '',
      failure: { code: 'TASK_HANDOFF_CRITERIA_INCOMPLETE', message: '结构化 handoff 提交失败。', retryable: true },
    })).toBe('结构化 handoff 提交失败。（TASK_HANDOFF_CRITERIA_INCOMPLETE）');
  });

  it('turns a shared Codex active-writer conflict into a neutral ownership hint', () => {
    expect(taskAttemptFailureLabel({
      version: 1, id: 'attempt-writer', projectId: 'project-a', taskId: 'task-a', attemptNumber: 1, taskRevision: 1, completionFlowVersion: 2,
      purpose: 'execution', actorPartnerId: 'partner-a', rootAttemptId: 'attempt-writer', reworkRound: 0,
      assigneeId: 'partner-a', permissionMode: 'full', status: 'failed', blockedByTaskIds: [], createdAt: '', updatedAt: '',
      failure: { code: 'TASK_RUNTIME_FAILED', message: 'CODEX_RPC_ERROR: thread thread-a already has an active writer', retryable: true },
    })).toBe('这个 Codex 线程正被另一个连接使用。请关闭对应的 Codex 桌面对话；若刚调整过工作区或项目成员，请重启星丛后重试。（TASK_RUNTIME_FAILED）');
  });

  it('presents execution, review, and rework submissions as ordered stage voices', () => {
    const base = {
      version: 1 as const, projectId: 'project-a', taskId: 'task-a', taskRevision: 1, completionFlowVersion: 2 as const,
      assigneeId: 'partner-a', rootAttemptId: 'attempt-a', reworkRound: 0, permissionMode: 'manual' as const,
      status: 'succeeded' as const, blockedByTaskIds: [], createdAt: '', updatedAt: '',
    };
    const voices = taskStageVoiceItems([{
      ...base, id: 'attempt-a', attemptNumber: 1, purpose: 'execution', actorPartnerId: 'partner-a',
      handoff: { version: 1, id: 'handoff-a', attemptId: 'attempt-a', projectId: 'project-a', taskId: 'task-a', taskRevision: 1, submittedAt: '', disposition: 'submitted', summary: '实现完成', criterionEvidence: [], changedPaths: [], verification: [], deliveryRefs: [], unresolvedIssues: [] },
    }, {
      ...base, id: 'attempt-b', attemptNumber: 2, purpose: 'review', actorPartnerId: 'partner-b',
      review: { version: 1, id: 'review-b', attemptId: 'attempt-b', projectId: 'project-a', taskId: 'task-a', taskRevision: 1, submittedAt: '', decision: 'pass', summary: '复审通过', criteria: [] },
    }], (id) => id === 'partner-a' ? '测试助手' : '测试伙伴');

    expect(voices).toEqual([
      { id: 'attempt-a:handoff', label: '负责人 测试助手', summary: '实现完成' },
      { id: 'attempt-b:review', label: '复审 测试伙伴', summary: '复审通过' },
    ]);
  });
});
