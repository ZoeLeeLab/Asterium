import type { ProjectPermissionMode } from './projectExecutionPolicy';
import type { ProjectTaskCompletionRule, ProjectTaskMethodTemplate, ProjectTaskWorkRole } from './projectDomain';
import type { ProjectFileVersionRef } from './projectWorkspace';

export interface FrozenTaskCriterion {
  criterionId: string;
  text: string;
}

export interface FrozenDependencyHandoff {
  taskId: string;
  handoffId?: string;
  summary: string;
  deliveryRefs: string[];
  fileRefs?: ProjectFileVersionRef[];
  unresolvedIssues: string[];
}

export interface FrozenTaskContract {
  version: 1;
  purpose: TaskAttemptPurpose;
  actorPartnerId: string;
  projectId: string;
  projectName: string;
  projectDescription: string;
  taskId: string;
  taskCode: string;
  taskRevision: number;
  title: string;
  description: string;
  assigneeId: string;
  workRole: ProjectTaskWorkRole;
  reviewWorkRole?: ProjectTaskWorkRole;
  acceptanceCriteria: FrozenTaskCriterion[];
  completionRule: ProjectTaskCompletionRule;
  dependencyHandoffs: FrozenDependencyHandoff[];
  methodTemplate?: ProjectTaskMethodTemplate;
  stageContext?: FrozenTaskStageContext;
  workspace: { projectRoot: string; executionMode: 'shared_serial' };
  frozenAt: string;
}

export type TaskAttemptPurpose = 'execution' | 'review' | 'rework';

export type FrozenTaskStageContext =
  | {
    type: 'review';
    reviewRound: number;
    candidateHandoffs: TaskHandoff[];
  }
  | {
    type: 'rework';
    reworkRound: number;
    requestedBy: 'review' | 'user';
    feedback: string;
    failedCriterionIds: string[];
    lockedCriteria: TaskHandoffCriterionEvidence[];
    previousHandoffs: TaskHandoff[];
  };

export type TaskHandoffDisposition = 'submitted' | 'needs_user_decision' | 'blocked';
export type TaskCriterionResult = 'satisfied' | 'not_satisfied' | 'unverified';

export interface TaskHandoffCriterionEvidence {
  criterionId: string;
  result: TaskCriterionResult;
  evidence: string[];
}

export interface TaskHandoffVerification {
  commandOrCheck: string;
  result: 'passed' | 'failed' | 'not_run';
  evidence?: string;
}

export interface TaskHandoffSubmission {
  disposition: TaskHandoffDisposition;
  summary: string;
  criterionEvidence: TaskHandoffCriterionEvidence[];
  changedPaths: string[];
  verification: TaskHandoffVerification[];
  deliveryRefs: string[];
  fileRefs?: ProjectFileVersionRef[];
  unresolvedIssues: string[];
  userDecisionRequest?: {
    question: string;
    reason: string;
    affectedCriteria: string[];
  };
}

export interface TaskHandoff extends TaskHandoffSubmission {
  version: 1;
  id: string;
  attemptId: string;
  projectId: string;
  taskId: string;
  taskRevision: number;
  submittedAt: string;
}

export type TaskReviewDecision = 'pass' | 'changes_required' | 'needs_user_decision';
export type TaskReviewCriterionVerdict = 'pass' | 'fail' | 'unverified';

export interface TaskReviewCriterion {
  criterionId: string;
  verdict: TaskReviewCriterionVerdict;
  evidence: string[];
  feedback?: string;
}

export interface TaskReviewSubmission {
  decision: TaskReviewDecision;
  summary: string;
  criteria: TaskReviewCriterion[];
  userDecisionRequest?: TaskHandoffSubmission['userDecisionRequest'];
}

export interface TaskReview extends TaskReviewSubmission {
  version: 1;
  id: string;
  attemptId: string;
  projectId: string;
  taskId: string;
  taskRevision: number;
  submittedAt: string;
}

export type TaskAttemptStatus =
  | 'waiting_dependencies'
  | 'queued'
  | 'starting'
  | 'running'
  | 'pause_requested'
  | 'paused'
  | 'cancel_requested'
  | 'cancelled'
  | 'failed'
  | 'succeeded';

export interface TaskAttemptFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface TaskAttempt {
  version: 1;
  id: string;
  projectId: string;
  taskId: string;
  attemptNumber: number;
  taskRevision: number;
  contractSourceFingerprint?: string;
  completionFlowVersion: 1 | 2;
  purpose: TaskAttemptPurpose;
  assigneeId: string;
  actorPartnerId: string;
  rootAttemptId: string;
  sourceAttemptId?: string;
  reworkRound: number;
  reworkRequest?: {
    requestedBy: 'review' | 'user';
    feedback: string;
    criterionIds: string[];
  };
  permissionMode: ProjectPermissionMode;
  status: TaskAttemptStatus;
  blockedByTaskIds: string[];
  retryOfAttemptId?: string;
  runtimeRunId?: string;
  failure?: TaskAttemptFailure;
  contract?: FrozenTaskContract;
  handoff?: TaskHandoff;
  review?: TaskReview;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export type TaskEventType =
  | 'attempt_created'
  | 'dependencies_blocked'
  | 'dependencies_satisfied'
  | 'runtime_starting'
  | 'runtime_started'
  | 'contract_frozen'
  | 'handoff_submitted'
  | 'review_submitted'
  | 'rework_requested'
  | 'user_confirmed'
  | 'workflow_completed'
  | 'pause_requested'
  | 'paused'
  | 'resume_requested'
  | 'cancel_requested'
  | 'cancelled'
  | 'failed'
  | 'succeeded'
  | 'recovered_paused'
  | 'recovered_cancelled';

export interface TaskEvent {
  version: 1;
  id: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  sequence: number;
  type: TaskEventType;
  occurredAt: string;
  blockedByTaskIds?: string[];
  reason?: string;
  failure?: TaskAttemptFailure;
  contractRevision?: number;
  handoffId?: string;
  reviewId?: string;
}

export interface ProjectTaskExecutionSnapshot {
  version: 1;
  attempts: TaskAttempt[];
  events: TaskEvent[];
}

export interface ProjectTaskExecutionProjectSnapshot {
  version: 1;
  projectId: string;
  attempts: TaskAttempt[];
  events: TaskEvent[];
}

export interface TaskAttemptRequest {
  projectId: string;
  taskId: string;
}

export interface TaskAttemptControlRequest {
  attemptId: string;
  reason?: string;
}

export interface TaskGateResolutionRequest {
  projectId: string;
  taskId: string;
  action: 'accept' | 'request_changes';
  feedback?: string;
  affectedCriteria?: string[];
}

export type ProjectTaskExecutionChange =
  | { type: 'snapshot'; snapshot: ProjectTaskExecutionSnapshot }
  | { type: 'project_removed'; projectId: string };

export const ACTIVE_TASK_ATTEMPT_STATUSES: readonly TaskAttemptStatus[] = [
  'waiting_dependencies',
  'queued',
  'starting',
  'running',
  'pause_requested',
  'paused',
  'cancel_requested',
];

export function isTaskAttemptStatus(value: unknown): value is TaskAttemptStatus {
  return value === 'waiting_dependencies' || value === 'queued' || value === 'starting'
    || value === 'running' || value === 'pause_requested' || value === 'paused'
    || value === 'cancel_requested' || value === 'cancelled' || value === 'failed'
    || value === 'succeeded';
}

export function isTaskEventType(value: unknown): value is TaskEventType {
  return value === 'attempt_created' || value === 'dependencies_blocked' || value === 'dependencies_satisfied'
    || value === 'contract_frozen' || value === 'runtime_starting' || value === 'runtime_started' || value === 'handoff_submitted' || value === 'pause_requested'
    || value === 'paused' || value === 'resume_requested' || value === 'cancel_requested'
    || value === 'cancelled' || value === 'failed' || value === 'succeeded'
    || value === 'review_submitted' || value === 'rework_requested' || value === 'user_confirmed' || value === 'workflow_completed'
    || value === 'recovered_paused' || value === 'recovered_cancelled';
}

export function isTaskAttemptPurpose(value: unknown): value is TaskAttemptPurpose {
  return value === 'execution' || value === 'review' || value === 'rework';
}
