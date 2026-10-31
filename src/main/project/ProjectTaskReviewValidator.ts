import type { FrozenTaskContract, TaskReviewSubmission } from '../../shared/projectTaskExecution';

export class ProjectTaskReviewValidator {
  validate(contract: FrozenTaskContract, value: TaskReviewSubmission): TaskReviewSubmission {
    if (contract.purpose !== 'review' || contract.stageContext?.type !== 'review') throw new Error('TASK_REVIEW_CONTRACT_INVALID');
    if (!value || !['pass', 'changes_required', 'needs_user_decision'].includes(value.decision)) throw new Error('TASK_REVIEW_DECISION_INVALID');
    const summary = requiredText(value.summary, 8_000, 'TASK_REVIEW_SUMMARY_REQUIRED');
    if (!Array.isArray(value.criteria)) throw new Error('TASK_REVIEW_CRITERIA_INVALID');
    const required = contract.acceptanceCriteria.map((item) => item.criterionId);
    const seen = new Set<string>();
    const criteria = value.criteria.map((item) => {
      if (!item || typeof item.criterionId !== 'string' || !['pass', 'fail', 'unverified'].includes(item.verdict)) throw new Error('TASK_REVIEW_CRITERIA_INVALID');
      if (!required.includes(item.criterionId) || seen.has(item.criterionId)) throw new Error('TASK_REVIEW_CRITERIA_INVALID');
      seen.add(item.criterionId);
      const evidence = stringList(item.evidence, 32, 2_000, 'TASK_REVIEW_CRITERIA_INVALID');
      if (!evidence.length) throw new Error('TASK_REVIEW_CRITERIA_EVIDENCE_REQUIRED');
      return {
        criterionId: item.criterionId,
        verdict: item.verdict,
        evidence,
        ...(optionalText(item.feedback, 4_000) ? { feedback: optionalText(item.feedback, 4_000) } : {}),
      };
    });
    if (seen.size !== required.length || required.some((criterionId) => !seen.has(criterionId))) throw new Error('TASK_REVIEW_CRITERIA_INCOMPLETE');
    const userDecisionRequest = normalizeUserDecision(value.userDecisionRequest, required);
    if (value.decision === 'pass' && (criteria.some((item) => item.verdict !== 'pass') || userDecisionRequest)) throw new Error('TASK_REVIEW_PASS_INVALID');
    if (value.decision === 'changes_required' && (!criteria.some((item) => item.verdict !== 'pass') || userDecisionRequest)) throw new Error('TASK_REVIEW_CHANGES_INVALID');
    if (value.decision === 'needs_user_decision' && !userDecisionRequest) throw new Error('TASK_REVIEW_USER_DECISION_REQUIRED');
    if (value.decision !== 'needs_user_decision' && userDecisionRequest) throw new Error('TASK_REVIEW_USER_DECISION_UNEXPECTED');
    return { decision: value.decision, summary, criteria, ...(userDecisionRequest ? { userDecisionRequest } : {}) };
  }
}

function normalizeUserDecision(value: TaskReviewSubmission['userDecisionRequest'], allowedIds: string[]) {
  if (!value) return undefined;
  const affectedCriteria = stringList(value.affectedCriteria, 64, 128, 'TASK_REVIEW_USER_DECISION_INVALID');
  if (affectedCriteria.some((item) => !allowedIds.includes(item))) throw new Error('TASK_REVIEW_USER_DECISION_INVALID');
  return {
    question: requiredText(value.question, 4_000, 'TASK_REVIEW_USER_DECISION_INVALID'),
    reason: requiredText(value.reason, 4_000, 'TASK_REVIEW_USER_DECISION_INVALID'),
    affectedCriteria,
  };
}

function stringList(value: unknown, maxItems: number, maxLength: number, error: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string') || value.length > maxItems) throw new Error(error);
  return [...new Set(value.map((item) => requiredText(item, maxLength, error)))];
}

function requiredText(value: unknown, maxLength: number, error: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || value.includes('\0')) throw new Error(error);
  return value.trim();
}

function optionalText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}
