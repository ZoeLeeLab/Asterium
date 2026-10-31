import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FrozenTaskContract, TaskHandoffSubmission } from '../../shared/projectTaskExecution';
import type { ProjectFileVersionRef } from '../../shared/projectWorkspace';

interface HandoffValidationDependencies {
  validateFileRefs: (projectId: string, refs: ProjectFileVersionRef[]) => Promise<void>;
}

export class ProjectTaskHandoffValidator {
  constructor(private readonly dependencies: HandoffValidationDependencies) {}

  validateDependencyFileRefs(projectId: string, refs: ProjectFileVersionRef[]) {
    return this.dependencies.validateFileRefs(projectId, refs);
  }

  async validate(contract: FrozenTaskContract, value: TaskHandoffSubmission): Promise<TaskHandoffSubmission> {
    if (!value || !['submitted', 'needs_user_decision', 'blocked'].includes(value.disposition)) throw new Error('TASK_HANDOFF_DISPOSITION_INVALID');
    const summary = requiredText(value.summary, 8_000, 'TASK_HANDOFF_SUMMARY_REQUIRED');
    const criterionEvidence = normalizeCriterionEvidence(value, contract);
    const changedPaths = await Promise.all(stringList(value.changedPaths, 256, 1_024, 'TASK_HANDOFF_CHANGED_PATH_INVALID')
      .map((item) => normalizeProjectPath(contract.workspace.projectRoot, item)));
    const verification = normalizeVerification(value.verification);
    const deliveryRefs = stringList(value.deliveryRefs, 128, 512, 'TASK_HANDOFF_DELIVERY_REF_INVALID');
    if (deliveryRefs.length) throw new Error('TASK_HANDOFF_DELIVERY_REF_INVALID');
    const fileRefs = normalizeFileRefs(value.fileRefs);
    await this.dependencies.validateFileRefs(contract.projectId, fileRefs);
    const unresolvedIssues = stringList(value.unresolvedIssues, 64, 2_000, 'TASK_HANDOFF_UNRESOLVED_INVALID');
    const userDecisionRequest = normalizeUserDecision(value.userDecisionRequest, contract);

    if (value.disposition === 'submitted') {
      if (criterionEvidence.some((item) => item.result !== 'satisfied') || unresolvedIssues.length || userDecisionRequest) {
        throw new Error('TASK_HANDOFF_SUBMITTED_NOT_READY');
      }
    }
    if (value.disposition === 'needs_user_decision' && !userDecisionRequest) throw new Error('TASK_HANDOFF_USER_DECISION_REQUIRED');
    if (value.disposition !== 'needs_user_decision' && userDecisionRequest) throw new Error('TASK_HANDOFF_USER_DECISION_UNEXPECTED');

    return {
      disposition: value.disposition,
      summary,
      criterionEvidence,
      changedPaths: unique(changedPaths),
      verification,
      deliveryRefs,
      fileRefs,
      unresolvedIssues,
      ...(userDecisionRequest ? { userDecisionRequest } : {}),
    };
  }
}

function normalizeFileRefs(value: TaskHandoffSubmission['fileRefs']): ProjectFileVersionRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) throw new Error('TASK_HANDOFF_FILE_REF_INVALID');
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item.fileId !== 'string' || typeof item.relativePath !== 'string'
      || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.contentHash !== 'string'
      || typeof item.sizeBytes !== 'number' || item.sizeBytes < 0 || seen.has(item.fileId)) throw new Error('TASK_HANDOFF_FILE_REF_INVALID');
    seen.add(item.fileId);
    return { fileId: item.fileId, relativePath: item.relativePath, revision: item.revision, contentHash: item.contentHash, sizeBytes: item.sizeBytes };
  });
}

function normalizeCriterionEvidence(value: TaskHandoffSubmission, contract: FrozenTaskContract) {
  if (!Array.isArray(value.criterionEvidence)) throw new Error('TASK_HANDOFF_CRITERIA_INVALID');
  const required = contract.acceptanceCriteria.map((item) => item.criterionId);
  const seen = new Set<string>();
  const normalized = value.criterionEvidence.map((item) => {
    if (!item || typeof item.criterionId !== 'string' || !['satisfied', 'not_satisfied', 'unverified'].includes(item.result)) throw new Error('TASK_HANDOFF_CRITERIA_INVALID');
    if (!required.includes(item.criterionId) || seen.has(item.criterionId)) throw new Error('TASK_HANDOFF_CRITERIA_INVALID');
    seen.add(item.criterionId);
    const evidence = stringList(item.evidence, 32, 2_000, 'TASK_HANDOFF_CRITERIA_INVALID');
    if (item.result === 'satisfied' && !evidence.length) throw new Error('TASK_HANDOFF_CRITERIA_EVIDENCE_REQUIRED');
    return {
      criterionId: item.criterionId,
      result: item.result,
      evidence,
    };
  });
  if (seen.size !== required.length || required.some((criterionId) => !seen.has(criterionId))) throw new Error('TASK_HANDOFF_CRITERIA_INCOMPLETE');
  return normalized;
}

function normalizeVerification(value: TaskHandoffSubmission['verification']) {
  if (!Array.isArray(value) || value.length > 128) throw new Error('TASK_HANDOFF_VERIFICATION_INVALID');
  return value.map((item) => {
    if (!item || !['passed', 'failed', 'not_run'].includes(item.result)) throw new Error('TASK_HANDOFF_VERIFICATION_INVALID');
    return {
      commandOrCheck: requiredText(item.commandOrCheck, 2_000, 'TASK_HANDOFF_VERIFICATION_INVALID'),
      ...(optionalText(item.evidence, 4_000) ? { evidence: optionalText(item.evidence, 4_000) } : {}),
      result: item.result,
    };
  });
}

function normalizeUserDecision(value: TaskHandoffSubmission['userDecisionRequest'], contract: FrozenTaskContract) {
  if (!value) return undefined;
  const allowed = new Set(contract.acceptanceCriteria.map((item) => item.criterionId));
  const affectedCriteria = stringList(value.affectedCriteria, 64, 128, 'TASK_HANDOFF_USER_DECISION_INVALID');
  if (affectedCriteria.some((item) => !allowed.has(item))) throw new Error('TASK_HANDOFF_USER_DECISION_INVALID');
  return {
    question: requiredText(value.question, 4_000, 'TASK_HANDOFF_USER_DECISION_INVALID'),
    reason: requiredText(value.reason, 4_000, 'TASK_HANDOFF_USER_DECISION_INVALID'),
    affectedCriteria,
  };
}

async function normalizeProjectPath(rootPath: string, value: string) {
  const root = await realpath(rootPath);
  const candidate = path.resolve(path.isAbsolute(value) ? value : path.join(rootPath, value));
  const resolved = await resolveExistingOrFuture(candidate);
  if (!contains(root, resolved)) throw new Error('TASK_HANDOFF_PATH_OUTSIDE_PROJECT');
  const relative = path.relative(root, resolved);
  if (!relative) throw new Error('TASK_HANDOFF_CHANGED_PATH_INVALID');
  return relative.replaceAll(path.sep, '/');
}

async function resolveExistingOrFuture(target: string) {
  let cursor = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const value = await stat(cursor);
      if (tail.length === 0 && value.isDirectory()) throw new Error('TASK_HANDOFF_CHANGED_PATH_INVALID');
      return path.join(await realpath(cursor), ...tail.reverse());
    } catch (error) {
      if (error instanceof Error && error.message === 'TASK_HANDOFF_CHANGED_PATH_INVALID') throw error;
      if (!isNodeError(error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
        throw new Error('TASK_HANDOFF_CHANGED_PATH_INVALID', { cause: error });
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error('TASK_HANDOFF_CHANGED_PATH_INVALID', { cause: error });
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function contains(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function stringList(value: unknown, maxItems: number, maxLength: number, error: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string') || value.length > maxItems) throw new Error(error);
  return unique(value.map((item) => requiredText(item, maxLength, error)));
}

function requiredText(value: unknown, maxLength: number, error: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || value.includes('\0')) throw new Error(error);
  return value.trim();
}

function optionalText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
