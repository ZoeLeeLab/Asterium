import { randomUUID } from 'node:crypto';
import type { ProjectPermissionMode } from '../../shared/projectExecutionPolicy';
import {
  ACTIVE_TASK_ATTEMPT_STATUSES,
  isTaskAttemptPurpose,
  isTaskAttemptStatus,
  isTaskEventType,
  type ProjectTaskExecutionProjectSnapshot,
  type ProjectTaskExecutionSnapshot,
  type FrozenTaskContract,
  type TaskAttempt,
  type TaskAttemptFailure,
  type TaskAttemptStatus,
  type TaskEvent,
  type TaskEventType,
  type TaskHandoff,
  type TaskReview,
} from '../../shared/projectTaskExecution';
import { isProjectPermissionMode } from '../../shared/projectExecutionPolicy';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';

interface AttemptTransition {
  status: TaskAttemptStatus;
  eventType: TaskEventType;
  reason?: string;
  blockedByTaskIds?: string[];
  runtimeRunId?: string;
  failure?: TaskAttemptFailure;
  started?: boolean;
  finished?: boolean;
  clearRuntime?: boolean;
  clearFailure?: boolean;
}

export interface ProjectTaskAttemptCreateInput {
  projectId: string;
  taskId: string;
  taskRevision: number;
  contractSourceFingerprint?: string;
  assigneeId: string;
  actorPartnerId?: string;
  purpose?: TaskAttempt['purpose'];
  rootAttemptId?: string;
  sourceAttemptId?: string;
  reworkRound?: number;
  reworkRequest?: TaskAttempt['reworkRequest'];
  permissionMode: ProjectPermissionMode;
  blockedByTaskIds: string[];
  retryOfAttemptId?: string;
}

export class ProjectTaskExecutionStore {
  private readonly storage: AtomicJsonStore<ProjectTaskExecutionSnapshot>;
  private readonly listeners = new Set<(snapshot: ProjectTaskExecutionSnapshot) => void>();

  constructor(filePath: AtomicJsonStorePath) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 1, attempts: [], events: [] }),
      decode: decodeSnapshot,
      encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
    });
  }

  subscribe(listener: (snapshot: ProjectTaskExecutionSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async snapshot(projectId?: string) {
    const current = await this.storage.read();
    return clone(projectId ? filterProject(current, projectId) : current);
  }

  async projectSnapshot(projectId: string): Promise<ProjectTaskExecutionProjectSnapshot> {
    const current = await this.storage.read();
    const filtered = filterProject(current, projectId);
    return { version: 1, projectId, attempts: clone(filtered.attempts), events: clone(filtered.events) };
  }

  async findAttempt(attemptId: string) {
    const attempt = (await this.storage.read()).attempts.find((item) => item.id === attemptId);
    return attempt ? clone(attempt) : undefined;
  }

  async activeForTask(projectId: string, taskId: string) {
    const attempt = (await this.storage.read()).attempts.find((item) => item.projectId === projectId
      && item.taskId === taskId && isActive(item.status));
    return attempt ? clone(attempt) : undefined;
  }

  async activeForProject(projectId: string) {
    return (await this.storage.read()).attempts.filter((attempt) => attempt.projectId === projectId && isActive(attempt.status)).map(clone);
  }

  async pendingCompletionForTask(projectId: string, taskId: string) {
    const current = await this.storage.read();
    const attempts = current.attempts.filter((item) => item.projectId === projectId && item.taskId === taskId);
    const latest = attempts.sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
    if (!latest || latest.status !== 'succeeded') return undefined;
    const completed = current.events.some((event) => event.attemptId === latest.id && event.type === 'workflow_completed')
      || current.events.some((event) => event.taskId === taskId && event.projectId === projectId && event.type === 'workflow_completed'
        && attempts.some((attempt) => attempt.id === event.attemptId && attempt.rootAttemptId === latest.rootAttemptId));
    return completed ? undefined : clone(latest);
  }

  createAttempt(input: ProjectTaskAttemptCreateInput) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      if (current.attempts.some((attempt) => attempt.projectId === input.projectId && attempt.taskId === input.taskId && isActive(attempt.status))) {
        throw new Error('TASK_ATTEMPT_ALREADY_ACTIVE');
      }
      const { attempt, events } = createAttemptRecord(current, input, new Date().toISOString());
      const next = { version: 1 as const, attempts: [...current.attempts, attempt], events: [...current.events, ...events] };
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(attempt);
    });
  }

  createAttemptBatch(inputs: ProjectTaskAttemptCreateInput[]) {
    return this.storage.runExclusive(async () => {
      if (!inputs.length) throw new Error('TASK_ATTEMPT_BATCH_EMPTY');
      const current = await this.storage.readNow();
      const keys = inputs.map((input) => `${input.projectId}\0${input.taskId}`);
      if (new Set(keys).size !== keys.length) throw new Error('TASK_ATTEMPT_BATCH_DUPLICATE');
      if (inputs.some((input) => current.attempts.some((attempt) => attempt.projectId === input.projectId
        && attempt.taskId === input.taskId && isActive(attempt.status)))) throw new Error('TASK_ATTEMPT_ALREADY_ACTIVE');
      const now = new Date().toISOString();
      const working: ProjectTaskExecutionSnapshot = clone(current);
      const created: TaskAttempt[] = [];
      for (const input of inputs) {
        const record = createAttemptRecord(working, input, now);
        working.attempts.push(record.attempt);
        working.events.push(...record.events);
        created.push(record.attempt);
      }
      await this.storage.writeNow(working);
      this.notify(working);
      return clone(created);
    });
  }

  transition(attemptId: string, allowed: readonly TaskAttemptStatus[], transition: AttemptTransition) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = current.attempts.find((attempt) => attempt.id === attemptId);
      if (!existing) throw new Error('TASK_ATTEMPT_NOT_FOUND');
      if (!allowed.includes(existing.status)) throw new Error('TASK_ATTEMPT_STATE_CONFLICT');
      const now = new Date().toISOString();
      const updated: TaskAttempt = {
        ...existing,
        status: transition.status,
        updatedAt: now,
        ...(transition.runtimeRunId ? { runtimeRunId: transition.runtimeRunId } : {}),
        ...(transition.started && !existing.startedAt ? { startedAt: now } : {}),
        ...(transition.finished ? { finishedAt: now } : {}),
        ...(transition.failure ? { failure: transition.failure } : {}),
      };
      if (transition.clearRuntime) delete updated.runtimeRunId;
      if (transition.clearFailure) delete updated.failure;
      const event = eventFor(updated, nextSequence(current.events, attemptId), transition.eventType, now, transition);
      const next = {
        version: 1 as const,
        attempts: current.attempts.map((attempt) => attempt.id === attemptId ? updated : attempt),
        events: [...current.events, event],
      };
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(updated);
    });
  }

  freezeContract(attemptId: string, contract: FrozenTaskContract) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = current.attempts.find((attempt) => attempt.id === attemptId);
      if (!existing) throw new Error('TASK_ATTEMPT_NOT_FOUND');
      if (existing.status !== 'queued') throw new Error('TASK_ATTEMPT_STATE_CONFLICT');
      if (existing.contract) return clone(existing);
      if (contract.projectId !== existing.projectId || contract.taskId !== existing.taskId
        || contract.taskRevision !== existing.taskRevision || contract.assigneeId !== existing.assigneeId
        || contract.purpose !== existing.purpose || contract.actorPartnerId !== existing.actorPartnerId) {
        throw new Error('TASK_CONTRACT_SCOPE_MISMATCH');
      }
      const now = new Date().toISOString();
      const updated: TaskAttempt = { ...existing, contract: clone(contract), updatedAt: now };
      const event = eventFor(updated, nextSequence(current.events, attemptId), 'contract_frozen', now, { contractRevision: contract.taskRevision });
      const next = {
        version: 1 as const,
        attempts: current.attempts.map((attempt) => attempt.id === attemptId ? updated : attempt),
        events: [...current.events, event],
      };
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(updated);
    });
  }

  submitHandoff(attemptId: string, handoff: TaskHandoff) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = current.attempts.find((attempt) => attempt.id === attemptId);
      if (!existing) throw new Error('TASK_ATTEMPT_NOT_FOUND');
      if (existing.status !== 'running') throw new Error('TASK_ATTEMPT_STATE_CONFLICT');
      if (!existing.contract) throw new Error('TASK_CONTRACT_NOT_FROZEN');
      if (existing.handoff?.disposition === 'submitted') throw new Error('TASK_HANDOFF_ALREADY_SUBMITTED');
      if (handoff.attemptId !== existing.id || handoff.projectId !== existing.projectId
        || handoff.taskId !== existing.taskId || handoff.taskRevision !== existing.taskRevision) {
        throw new Error('TASK_HANDOFF_SCOPE_MISMATCH');
      }
      const updated: TaskAttempt = { ...existing, handoff: clone(handoff), updatedAt: handoff.submittedAt };
      const event = eventFor(updated, nextSequence(current.events, attemptId), 'handoff_submitted', handoff.submittedAt, { handoffId: handoff.id });
      const next = {
        version: 1 as const,
        attempts: current.attempts.map((attempt) => attempt.id === attemptId ? updated : attempt),
        events: [...current.events, event],
      };
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(updated);
    });
  }

  submitReview(attemptId: string, review: TaskReview) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = current.attempts.find((attempt) => attempt.id === attemptId);
      if (!existing) throw new Error('TASK_ATTEMPT_NOT_FOUND');
      if (existing.status !== 'running' || existing.purpose !== 'review') throw new Error('TASK_ATTEMPT_STATE_CONFLICT');
      if (!existing.contract) throw new Error('TASK_CONTRACT_NOT_FROZEN');
      if (existing.review && existing.review.decision !== 'needs_user_decision') throw new Error('TASK_REVIEW_ALREADY_SUBMITTED');
      if (review.attemptId !== existing.id || review.projectId !== existing.projectId
        || review.taskId !== existing.taskId || review.taskRevision !== existing.taskRevision) throw new Error('TASK_REVIEW_SCOPE_MISMATCH');
      const updated: TaskAttempt = { ...existing, review: clone(review), updatedAt: review.submittedAt };
      const event = eventFor(updated, nextSequence(current.events, attemptId), 'review_submitted', review.submittedAt, { reviewId: review.id });
      const next = { version: 1 as const, attempts: current.attempts.map((attempt) => attempt.id === attemptId ? updated : attempt), events: [...current.events, event] };
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(updated);
    });
  }

  appendEvent(attemptId: string, type: 'rework_requested' | 'user_confirmed' | 'workflow_completed', reason?: string) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = current.attempts.find((attempt) => attempt.id === attemptId);
      if (!existing) throw new Error('TASK_ATTEMPT_NOT_FOUND');
      const now = new Date().toISOString();
      const event = eventFor(existing, nextSequence(current.events, attemptId), type, now, { reason });
      const next = { ...current, events: [...current.events, event] };
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(existing);
    });
  }

  setDependencyState(attemptId: string, blockedByTaskIds: string[]) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = current.attempts.find((attempt) => attempt.id === attemptId);
      if (!existing) throw new Error('TASK_ATTEMPT_NOT_FOUND');
      const nextStatus = blockedByTaskIds.length ? 'waiting_dependencies' : 'queued';
      if (!['waiting_dependencies', 'queued'].includes(existing.status)) return clone(existing);
      if (existing.status === nextStatus && sameValues(existing.blockedByTaskIds, blockedByTaskIds)) return clone(existing);
      const now = new Date().toISOString();
      const updated = { ...existing, status: nextStatus as TaskAttemptStatus, blockedByTaskIds: [...blockedByTaskIds], updatedAt: now };
      const event = eventFor(updated, nextSequence(current.events, attemptId), blockedByTaskIds.length ? 'dependencies_blocked' : 'dependencies_satisfied', now, {
        blockedByTaskIds,
      });
      const next = {
        version: 1 as const,
        attempts: current.attempts.map((attempt) => attempt.id === attemptId ? updated : attempt),
        events: [...current.events, event],
      };
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(updated);
    });
  }

  recoverInterrupted() {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      let attempts = [...current.attempts];
      const events = [...current.events];
      let changed = false;
      for (const attempt of current.attempts) {
        const recovery = recoveryTransition(attempt.status);
        if (!recovery) continue;
        changed = true;
        const now = new Date().toISOString();
        const updated: TaskAttempt = {
          ...attempt,
          status: recovery.status,
          updatedAt: now,
          ...(recovery.finished ? { finishedAt: now } : {}),
        };
        delete updated.runtimeRunId;
        attempts = attempts.map((item) => item.id === attempt.id ? updated : item);
        events.push(eventFor(updated, nextSequence(events, attempt.id), recovery.eventType, now, { reason: recovery.reason }));
      }
      const next = { version: 1 as const, attempts, events };
      if (changed) {
        await this.storage.writeNow(next);
        this.notify(next);
      }
      return clone(next);
    });
  }

  removeProject(projectId: string) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const removed = filterProject(current, projectId);
      if (!removed.attempts.length && !removed.events.length) return { version: 1 as const, projectId, attempts: [], events: [] };
      const next = {
        version: 1 as const,
        attempts: current.attempts.filter((attempt) => attempt.projectId !== projectId),
        events: current.events.filter((event) => event.projectId !== projectId),
      };
      await this.storage.writeNow(next);
      this.notify(next);
      return { version: 1 as const, projectId, attempts: clone(removed.attempts), events: clone(removed.events) };
    });
  }

  restoreProject(snapshot: ProjectTaskExecutionProjectSnapshot) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const restored = decodeSnapshot({ version: 1, attempts: snapshot.attempts, events: snapshot.events });
      if (restored.attempts.some((attempt) => attempt.projectId !== snapshot.projectId)
        || restored.events.some((event) => event.projectId !== snapshot.projectId)) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
      const next = decodeSnapshot({
        version: 1 as const,
        attempts: [...current.attempts.filter((attempt) => attempt.projectId !== snapshot.projectId), ...restored.attempts],
        events: [...current.events.filter((event) => event.projectId !== snapshot.projectId), ...restored.events],
      });
      await this.storage.writeNow(next);
      this.notify(next);
    });
  }

  private notify(snapshot: ProjectTaskExecutionSnapshot) {
    const value = clone(snapshot);
    for (const listener of this.listeners) listener(value);
  }
}

function recoveryTransition(status: TaskAttemptStatus) {
  if (status === 'cancel_requested') return { status: 'cancelled' as const, eventType: 'recovered_cancelled' as const, reason: '应用重启时取消尚未确认。', finished: true };
  if (status === 'starting' || status === 'running' || status === 'pause_requested') {
    return { status: 'paused' as const, eventType: 'recovered_paused' as const, reason: '应用重启后无法确认原运行仍然存活。', finished: false };
  }
  return undefined;
}

function eventFor(
  attempt: TaskAttempt,
  sequence: number,
  type: TaskEventType,
  occurredAt: string,
  detail: { blockedByTaskIds?: string[]; reason?: string; failure?: TaskAttemptFailure; contractRevision?: number; handoffId?: string; reviewId?: string } = {},
): TaskEvent {
  return {
    version: 1,
    id: randomUUID(),
    projectId: attempt.projectId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    sequence,
    type,
    occurredAt,
    ...(detail.blockedByTaskIds?.length ? { blockedByTaskIds: [...detail.blockedByTaskIds] } : {}),
    ...(detail.reason ? { reason: detail.reason } : {}),
    ...(detail.failure ? { failure: detail.failure } : {}),
    ...(detail.contractRevision ? { contractRevision: detail.contractRevision } : {}),
    ...(detail.handoffId ? { handoffId: detail.handoffId } : {}),
    ...(detail.reviewId ? { reviewId: detail.reviewId } : {}),
  };
}

function createAttemptRecord(current: ProjectTaskExecutionSnapshot, input: ProjectTaskAttemptCreateInput, now: string) {
  const attempt: TaskAttempt = {
    version: 1,
    id: randomUUID(),
    projectId: input.projectId,
    taskId: input.taskId,
    attemptNumber: current.attempts.filter((item) => item.projectId === input.projectId && item.taskId === input.taskId).length + 1,
    taskRevision: input.taskRevision,
    ...(input.contractSourceFingerprint ? { contractSourceFingerprint: input.contractSourceFingerprint } : {}),
    completionFlowVersion: 2,
    purpose: input.purpose ?? 'execution',
    assigneeId: input.assigneeId,
    actorPartnerId: input.actorPartnerId ?? input.assigneeId,
    rootAttemptId: input.rootAttemptId ?? '',
    ...(input.sourceAttemptId ? { sourceAttemptId: input.sourceAttemptId } : {}),
    reworkRound: input.reworkRound ?? 0,
    ...(input.reworkRequest ? { reworkRequest: clone(input.reworkRequest) } : {}),
    permissionMode: input.permissionMode,
    status: input.blockedByTaskIds.length ? 'waiting_dependencies' : 'queued',
    blockedByTaskIds: [...input.blockedByTaskIds],
    ...(input.retryOfAttemptId ? { retryOfAttemptId: input.retryOfAttemptId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  if (!attempt.rootAttemptId) attempt.rootAttemptId = attempt.id;
  return {
    attempt,
    events: [
      eventFor(attempt, 1, 'attempt_created', now),
      ...(input.blockedByTaskIds.length ? [eventFor(attempt, 2, 'dependencies_blocked', now, { blockedByTaskIds: input.blockedByTaskIds })] : []),
    ],
  };
}

function nextSequence(events: TaskEvent[], attemptId: string) {
  return events.filter((event) => event.attemptId === attemptId).reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
}

function filterProject(snapshot: ProjectTaskExecutionSnapshot, projectId: string): ProjectTaskExecutionSnapshot {
  return {
    version: 1,
    attempts: snapshot.attempts.filter((attempt) => attempt.projectId === projectId),
    events: snapshot.events.filter((event) => event.projectId === projectId),
  };
}

function decodeSnapshot(value: unknown): ProjectTaskExecutionSnapshot {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.attempts) || !Array.isArray(value.events)) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  const attempts = value.attempts.map(decodeAttempt);
  const events = value.events.map(decodeEvent);
  if (new Set(attempts.map((attempt) => attempt.id)).size !== attempts.length || new Set(events.map((event) => event.id)).size !== events.length) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  const attemptIds = new Set(attempts.map((attempt) => attempt.id));
  if (events.some((event) => !attemptIds.has(event.attemptId))) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  for (const attempt of attempts) {
    const attemptEvents = events.filter((event) => event.attemptId === attempt.id);
    if (attemptEvents.some((event) => event.projectId !== attempt.projectId || event.taskId !== attempt.taskId)) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
    const sequences = attemptEvents.map((event) => event.sequence).sort((a, b) => a - b);
    if (!sequences.length || sequences.some((sequence, index) => sequence !== index + 1)) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  }
  const activeTaskKeys = attempts.filter((attempt) => isActive(attempt.status)).map((attempt) => `${attempt.projectId}\0${attempt.taskId}`);
  if (new Set(activeTaskKeys).size !== activeTaskKeys.length) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  return { version: 1, attempts, events };
}

function decodeAttempt(value: unknown): TaskAttempt {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.projectId !== 'string'
    || typeof value.taskId !== 'string' || !positiveInteger(value.attemptNumber) || !positiveInteger(value.taskRevision)
    || (value.contractSourceFingerprint !== undefined && typeof value.contractSourceFingerprint !== 'string')
    || (value.completionFlowVersion !== undefined && value.completionFlowVersion !== 1 && value.completionFlowVersion !== 2)
    || (value.purpose !== undefined && !isTaskAttemptPurpose(value.purpose))
    || (value.actorPartnerId !== undefined && typeof value.actorPartnerId !== 'string')
    || (value.rootAttemptId !== undefined && typeof value.rootAttemptId !== 'string')
    || typeof value.assigneeId !== 'string' || !isProjectPermissionMode(value.permissionMode) || !isTaskAttemptStatus(value.status)
    || !Array.isArray(value.blockedByTaskIds) || !value.blockedByTaskIds.every((item) => typeof item === 'string')
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  return {
    version: 1,
    id: value.id,
    projectId: value.projectId,
    taskId: value.taskId,
    attemptNumber: value.attemptNumber,
    taskRevision: value.taskRevision,
    ...(typeof value.contractSourceFingerprint === 'string' ? { contractSourceFingerprint: value.contractSourceFingerprint } : {}),
    completionFlowVersion: value.completionFlowVersion === 2 ? 2 : 1,
    purpose: isTaskAttemptPurpose(value.purpose) ? value.purpose : 'execution',
    assigneeId: value.assigneeId,
    actorPartnerId: typeof value.actorPartnerId === 'string' ? value.actorPartnerId : value.assigneeId,
    rootAttemptId: typeof value.rootAttemptId === 'string' ? value.rootAttemptId : value.id,
    ...(typeof value.sourceAttemptId === 'string' ? { sourceAttemptId: value.sourceAttemptId } : {}),
    reworkRound: nonNegativeInteger(value.reworkRound) ? value.reworkRound : 0,
    ...(value.reworkRequest !== undefined ? { reworkRequest: decodeReworkRequest(value.reworkRequest) } : {}),
    permissionMode: value.permissionMode,
    status: value.status,
    blockedByTaskIds: [...value.blockedByTaskIds],
    ...(typeof value.retryOfAttemptId === 'string' ? { retryOfAttemptId: value.retryOfAttemptId } : {}),
    ...(typeof value.runtimeRunId === 'string' ? { runtimeRunId: value.runtimeRunId } : {}),
    ...(value.failure !== undefined ? { failure: decodeFailure(value.failure) } : {}),
    ...(value.contract !== undefined ? { contract: decodeContract(value.contract) } : {}),
    ...(value.handoff !== undefined ? { handoff: decodeHandoff(value.handoff) } : {}),
    ...(value.review !== undefined ? { review: decodeReview(value.review) } : {}),
    createdAt: validDate(value.createdAt),
    updatedAt: validDate(value.updatedAt),
    ...(typeof value.startedAt === 'string' ? { startedAt: validDate(value.startedAt) } : {}),
    ...(typeof value.finishedAt === 'string' ? { finishedAt: validDate(value.finishedAt) } : {}),
  };
}

function decodeEvent(value: unknown): TaskEvent {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.projectId !== 'string'
    || typeof value.taskId !== 'string' || typeof value.attemptId !== 'string' || !positiveInteger(value.sequence)
    || !isTaskEventType(value.type) || typeof value.occurredAt !== 'string') throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  return {
    version: 1,
    id: value.id,
    projectId: value.projectId,
    taskId: value.taskId,
    attemptId: value.attemptId,
    sequence: value.sequence,
    type: value.type,
    occurredAt: validDate(value.occurredAt),
    ...(Array.isArray(value.blockedByTaskIds) && value.blockedByTaskIds.every((item) => typeof item === 'string') ? { blockedByTaskIds: [...value.blockedByTaskIds] } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(value.failure !== undefined ? { failure: decodeFailure(value.failure) } : {}),
    ...(positiveInteger(value.contractRevision) ? { contractRevision: value.contractRevision } : {}),
    ...(typeof value.handoffId === 'string' ? { handoffId: value.handoffId } : {}),
    ...(typeof value.reviewId === 'string' ? { reviewId: value.reviewId } : {}),
  };
}

function decodeContract(value: unknown): FrozenTaskContract {
  if (!isRecord(value) || value.version !== 1 || typeof value.projectId !== 'string' || typeof value.projectName !== 'string'
    || typeof value.projectDescription !== 'string' || typeof value.taskId !== 'string' || typeof value.taskCode !== 'string'
    || (value.purpose !== undefined && !isTaskAttemptPurpose(value.purpose))
    || (value.actorPartnerId !== undefined && typeof value.actorPartnerId !== 'string')
    || !positiveInteger(value.taskRevision) || typeof value.title !== 'string' || typeof value.description !== 'string'
    || typeof value.assigneeId !== 'string' || !isRecord(value.workRole) || typeof value.workRole.name !== 'string'
    || !Array.isArray(value.workRole.responsibilities) || !value.workRole.responsibilities.every((item) => typeof item === 'string')
    || !['builtin', 'global', 'project', 'inline'].includes(String(value.workRole.scope))
    || !Array.isArray(value.acceptanceCriteria) || !Array.isArray(value.dependencyHandoffs)
    || !isRecord(value.completionRule) || !isRecord(value.workspace) || typeof value.workspace.projectRoot !== 'string'
    || value.workspace.executionMode !== 'shared_serial' || typeof value.frozenAt !== 'string') throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  const acceptanceCriteria = value.acceptanceCriteria.map((item) => {
    if (!isRecord(item) || typeof item.criterionId !== 'string' || typeof item.text !== 'string') throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
    return { criterionId: item.criterionId, text: item.text };
  });
  const dependencyHandoffs = value.dependencyHandoffs.map((item) => {
    if (!isRecord(item) || typeof item.taskId !== 'string' || typeof item.summary !== 'string'
      || !stringArray(item.deliveryRefs) || !stringArray(item.unresolvedIssues)) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
    return { taskId: item.taskId, ...(typeof item.handoffId === 'string' ? { handoffId: item.handoffId } : {}), summary: item.summary, deliveryRefs: [...item.deliveryRefs], fileRefs: decodeFileRefs(item.fileRefs), unresolvedIssues: [...item.unresolvedIssues] };
  });
  const workRole = decodeWorkRole(value.workRole);
  return {
    version: 1,
    purpose: isTaskAttemptPurpose(value.purpose) ? value.purpose : 'execution',
    actorPartnerId: typeof value.actorPartnerId === 'string' ? value.actorPartnerId : value.assigneeId,
    projectId: value.projectId,
    projectName: value.projectName,
    projectDescription: value.projectDescription,
    taskId: value.taskId,
    taskCode: value.taskCode,
    taskRevision: value.taskRevision,
    title: value.title,
    description: value.description,
    assigneeId: value.assigneeId,
    workRole,
    ...(value.reviewWorkRole !== undefined ? { reviewWorkRole: decodeWorkRole(value.reviewWorkRole) } : {}),
    acceptanceCriteria,
    completionRule: decodeCompletionRule(value.completionRule),
    dependencyHandoffs,
    ...(value.methodTemplate !== undefined ? { methodTemplate: decodeMethodTemplate(value.methodTemplate) } : {}),
    ...(value.stageContext !== undefined ? { stageContext: decodeStageContext(value.stageContext) } : {}),
    workspace: { projectRoot: value.workspace.projectRoot, executionMode: 'shared_serial' },
    frozenAt: validDate(value.frozenAt),
  };
}

function decodeWorkRole(value: unknown): FrozenTaskContract['workRole'] {
  if (!isRecord(value) || typeof value.name !== 'string' || !Array.isArray(value.responsibilities)
    || !value.responsibilities.every((item) => typeof item === 'string')
    || !['builtin', 'global', 'project', 'inline'].includes(String(value.scope))) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  const roleId = typeof value.roleId === 'string' ? value.roleId : undefined;
  const roleRevision = positiveInteger(value.roleRevision) ? value.roleRevision : undefined;
  if (!roleId && roleRevision) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  return {
    ...(roleId ? { roleId, ...(roleRevision ? { roleRevision } : {}) } : {}),
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    responsibilities: [...value.responsibilities] as string[],
    ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
    scope: value.scope as FrozenTaskContract['workRole']['scope'],
  };
}

function decodeStageContext(value: unknown): NonNullable<FrozenTaskContract['stageContext']> {
  if (!isRecord(value)) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  if (value.type === 'review' && nonNegativeInteger(value.reviewRound) && Array.isArray(value.candidateHandoffs)) {
    return { type: 'review', reviewRound: value.reviewRound, candidateHandoffs: value.candidateHandoffs.map(decodeHandoff) };
  }
  if (value.type === 'rework' && positiveInteger(value.reworkRound) && (value.requestedBy === 'review' || value.requestedBy === 'user')
    && typeof value.feedback === 'string' && stringArray(value.failedCriterionIds) && Array.isArray(value.lockedCriteria) && Array.isArray(value.previousHandoffs)) {
    return {
      type: 'rework', reworkRound: value.reworkRound, requestedBy: value.requestedBy, feedback: value.feedback,
      failedCriterionIds: [...value.failedCriterionIds],
      lockedCriteria: value.lockedCriteria.map(decodeCriterionEvidence),
      previousHandoffs: value.previousHandoffs.map(decodeHandoff),
    };
  }
  throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
}

function decodeCompletionRule(value: Record<string, unknown>): FrozenTaskContract['completionRule'] {
  if (value.type === 'executor_submit' || value.type === 'user_confirm') return { type: value.type };
  if (value.type === 'partner_review' && typeof value.reviewerPartnerId === 'string'
    && typeof value.autoReworkLimit === 'number' && Number.isSafeInteger(value.autoReworkLimit) && value.autoReworkLimit >= 0) {
    return { type: 'partner_review', reviewerPartnerId: value.reviewerPartnerId, autoReworkLimit: value.autoReworkLimit };
  }
  throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
}

function decodeMethodTemplate(value: unknown): NonNullable<FrozenTaskContract['methodTemplate']> {
  if (!isRecord(value) || typeof value.templateId !== 'string' || typeof value.name !== 'string'
    || typeof value.version !== 'string' || typeof value.instructions !== 'string') throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  return { templateId: value.templateId, name: value.name, version: value.version, instructions: value.instructions, ...(typeof value.sourceAttribution === 'string' ? { sourceAttribution: value.sourceAttribution } : {}) };
}

function decodeHandoff(value: unknown): TaskHandoff {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.attemptId !== 'string'
    || typeof value.projectId !== 'string' || typeof value.taskId !== 'string' || !positiveInteger(value.taskRevision)
    || !['submitted', 'needs_user_decision', 'blocked'].includes(String(value.disposition)) || typeof value.summary !== 'string'
    || !Array.isArray(value.criterionEvidence) || !stringArray(value.changedPaths) || !Array.isArray(value.verification)
    || !stringArray(value.deliveryRefs) || !stringArray(value.unresolvedIssues) || typeof value.submittedAt !== 'string') throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  const criterionEvidence = value.criterionEvidence.map((item) => {
    if (!isRecord(item) || typeof item.criterionId !== 'string' || !['satisfied', 'not_satisfied', 'unverified'].includes(String(item.result)) || !stringArray(item.evidence)) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
    return { criterionId: item.criterionId, result: item.result as TaskHandoff['criterionEvidence'][number]['result'], evidence: [...item.evidence] };
  });
  const verification = value.verification.map((item) => {
    if (!isRecord(item) || typeof item.commandOrCheck !== 'string' || !['passed', 'failed', 'not_run'].includes(String(item.result))) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
    return { commandOrCheck: item.commandOrCheck, result: item.result as TaskHandoff['verification'][number]['result'], ...(typeof item.evidence === 'string' ? { evidence: item.evidence } : {}) };
  });
  let userDecisionRequest: TaskHandoff['userDecisionRequest'];
  if (value.userDecisionRequest !== undefined) {
    if (!isRecord(value.userDecisionRequest) || typeof value.userDecisionRequest.question !== 'string'
      || typeof value.userDecisionRequest.reason !== 'string' || !stringArray(value.userDecisionRequest.affectedCriteria)) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
    userDecisionRequest = { question: value.userDecisionRequest.question, reason: value.userDecisionRequest.reason, affectedCriteria: [...value.userDecisionRequest.affectedCriteria] };
  }
  return {
    version: 1,
    id: value.id,
    attemptId: value.attemptId,
    projectId: value.projectId,
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    disposition: value.disposition as TaskHandoff['disposition'],
    summary: value.summary,
    criterionEvidence,
    changedPaths: [...value.changedPaths],
    verification,
    deliveryRefs: [...value.deliveryRefs],
    fileRefs: decodeFileRefs(value.fileRefs),
    unresolvedIssues: [...value.unresolvedIssues],
    ...(userDecisionRequest ? { userDecisionRequest } : {}),
    submittedAt: validDate(value.submittedAt),
  };
}

function decodeFileRefs(value: unknown): NonNullable<TaskHandoff['fileRefs']> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  return value.map((item) => {
    if (!isRecord(item) || typeof item.fileId !== 'string' || typeof item.relativePath !== 'string'
      || !positiveInteger(item.revision) || typeof item.contentHash !== 'string'
      || typeof item.sizeBytes !== 'number' || item.sizeBytes < 0) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
    return { fileId: item.fileId, relativePath: item.relativePath, revision: item.revision, contentHash: item.contentHash, sizeBytes: item.sizeBytes };
  });
}

function decodeReview(value: unknown): TaskReview {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.attemptId !== 'string'
    || typeof value.projectId !== 'string' || typeof value.taskId !== 'string' || !positiveInteger(value.taskRevision)
    || !['pass', 'changes_required', 'needs_user_decision'].includes(String(value.decision)) || typeof value.summary !== 'string'
    || !Array.isArray(value.criteria) || typeof value.submittedAt !== 'string') throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  const criteria = value.criteria.map((item) => {
    if (!isRecord(item) || typeof item.criterionId !== 'string' || !['pass', 'fail', 'unverified'].includes(String(item.verdict)) || !stringArray(item.evidence)) {
      throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
    }
    return { criterionId: item.criterionId, verdict: item.verdict as TaskReview['criteria'][number]['verdict'], evidence: [...item.evidence], ...(typeof item.feedback === 'string' ? { feedback: item.feedback } : {}) };
  });
  let userDecisionRequest: TaskReview['userDecisionRequest'];
  if (value.userDecisionRequest !== undefined) {
    if (!isRecord(value.userDecisionRequest) || typeof value.userDecisionRequest.question !== 'string'
      || typeof value.userDecisionRequest.reason !== 'string' || !stringArray(value.userDecisionRequest.affectedCriteria)) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
    userDecisionRequest = { question: value.userDecisionRequest.question, reason: value.userDecisionRequest.reason, affectedCriteria: [...value.userDecisionRequest.affectedCriteria] };
  }
  return {
    version: 1, id: value.id, attemptId: value.attemptId, projectId: value.projectId, taskId: value.taskId,
    taskRevision: value.taskRevision, decision: value.decision as TaskReview['decision'], summary: value.summary,
    criteria, ...(userDecisionRequest ? { userDecisionRequest } : {}), submittedAt: validDate(value.submittedAt),
  };
}

function decodeCriterionEvidence(value: unknown): TaskHandoff['criterionEvidence'][number] {
  if (!isRecord(value) || typeof value.criterionId !== 'string' || !['satisfied', 'not_satisfied', 'unverified'].includes(String(value.result)) || !stringArray(value.evidence)) {
    throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  }
  return { criterionId: value.criterionId, result: value.result as TaskHandoff['criterionEvidence'][number]['result'], evidence: [...value.evidence] };
}

function decodeReworkRequest(value: unknown): NonNullable<TaskAttempt['reworkRequest']> {
  if (!isRecord(value) || (value.requestedBy !== 'review' && value.requestedBy !== 'user') || typeof value.feedback !== 'string' || !stringArray(value.criterionIds)) {
    throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  }
  return { requestedBy: value.requestedBy, feedback: value.feedback, criterionIds: [...value.criterionIds] };
}

function decodeFailure(value: unknown): TaskAttemptFailure {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string' || typeof value.retryable !== 'boolean') throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  return { code: value.code, message: value.message, retryable: value.retryable };
}

function isActive(status: TaskAttemptStatus) {
  return ACTIVE_TASK_ATTEMPT_STATUSES.includes(status);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validDate(value: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error('PROJECT_TASK_EXECUTION_STORE_INVALID');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function sameValues(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
