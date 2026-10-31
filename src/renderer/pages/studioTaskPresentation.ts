import type { ProjectTask } from '../../shared/projectDomain';
import type { TaskAttempt } from '../../shared/projectTaskExecution';
import { friendlyRuntimeErrorMessage } from '../app/runtimeErrorPresentation';

const STATUS_LABELS: Record<ProjectTask['status'], string> = {
  todo: '待处理',
  in_progress: '进行中',
  blocked: '受阻',
  review: '已提交/待处理',
  completed: '已完成',
  cancelled: '已取消',
};

export function projectTaskStatusLabel(task: ProjectTask) {
  if (task.status === 'review' && task.execution?.completionRule?.type === 'partner_review') return '待复核';
  return STATUS_LABELS[task.status];
}

export function taskAttemptFailureLabel(attempt: TaskAttempt) {
  if (attempt.status !== 'failed' || !attempt.failure) return '';
  return `${friendlyRuntimeErrorMessage(attempt.failure.message)}（${attempt.failure.code}）`;
}

export function taskStageVoiceItems(attempts: TaskAttempt[], partnerName: (partnerId: string) => string) {
  return attempts.flatMap((attempt) => {
    const name = partnerName(attempt.actorPartnerId);
    const voices: Array<{ id: string; label: string; summary: string }> = [];
    if (attempt.handoff?.summary) voices.push({ id: `${attempt.id}:handoff`, label: attempt.purpose === 'rework' ? `返工 ${name}` : `负责人 ${name}`, summary: attempt.handoff.summary });
    if (attempt.review?.summary) voices.push({ id: `${attempt.id}:review`, label: `复审 ${name}`, summary: attempt.review.summary });
    return voices;
  });
}
