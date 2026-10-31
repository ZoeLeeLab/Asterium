import { randomUUID } from 'node:crypto';
import type { ProjectDomainSnapshot, ProjectTask } from '../../shared/projectDomain';
import type {
  FrozenTaskContract,
  TaskAttempt,
  TaskAttemptFailure,
  TaskAttemptStatus,
  TaskGateResolutionRequest,
  TaskHandoff,
  TaskHandoffSubmission,
  ProjectTaskExecutionSnapshot,
  TaskReviewSubmission,
} from '../../shared/projectTaskExecution';
import type { ProjectExecutionPolicyStore } from './ProjectExecutionPolicyStore';
import type { ProjectDomainStore } from './ProjectDomainStore';
import type { ProjectTaskExecutionStore } from './ProjectTaskExecutionStore';
import { projectPartnerWriterScope, projectWorkspaceWriterScope, type WriterLease, type WriterLeaseCoordinator } from '../runtime/WriterLeaseCoordinator';
import type { ProjectTaskRuntimeHandle, ProjectTaskRuntimeLifecyclePort, ProjectTaskRuntimeOutcome } from '../runtime/PartnerRuntimePort';
import type { ProjectWorkspaceStore } from './ProjectWorkspaceStore';
import type { ProjectTaskHandoffValidator } from './ProjectTaskHandoffValidator';
import type { ProjectTaskReviewValidator } from './ProjectTaskReviewValidator';

interface ProjectTaskOrchestratorOptions {
  workspaces: Pick<ProjectWorkspaceStore, 'get'>;
  handoffs: ProjectTaskHandoffValidator;
  reviews?: ProjectTaskReviewValidator;
}

interface ActiveTaskRun {
  handle: ProjectTaskRuntimeHandle;
  lease: WriterLease;
}

export class ProjectTaskOrchestrator {
  private mutation = Promise.resolve();
  private runtime?: ProjectTaskRuntimeLifecyclePort;
  private active = false;
  private dispatchSuspensions = 0;
  private recovered?: Promise<void>;
  private readonly activeRuns = new Map<string, ActiveTaskRun>();

  constructor(
    private readonly executions: ProjectTaskExecutionStore,
    private readonly domain: Pick<ProjectDomainStore, 'projectSnapshot' | 'setTaskStatusForExecution'>,
    private readonly policies: Pick<ProjectExecutionPolicyStore, 'getOrCreate'>,
    private readonly writerLeases: WriterLeaseCoordinator,
    runtime?: ProjectTaskRuntimeLifecyclePort,
    private readonly options?: ProjectTaskOrchestratorOptions,
  ) {
    this.runtime = runtime;
    this.writerLeases.subscribeAvailable(() => {
      if (this.active) void this.run(() => this.dispatchReady());
    });
  }

  recover() {
    this.recovered ??= this.executions.recoverInterrupted().then(async (snapshot) => {
      await this.syncRecoveredTaskProjection(snapshot);
      await this.repairSucceededAdvancement();
    });
    return this.recovered;
  }

  async activate(runtime: ProjectTaskRuntimeLifecyclePort = requireRuntime(this.runtime)) {
    await this.recover();
    this.runtime = runtime;
    this.active = true;
    await this.run(() => this.dispatchReady());
  }

  snapshot(projectId?: string) {
    return this.recover().then(() => this.executions.snapshot(projectId));
  }

  async withDispatchPaused<T>(operation: () => Promise<T>) {
    this.dispatchSuspensions += 1;
    try {
      return await operation();
    } finally {
      this.dispatchSuspensions -= 1;
      if (this.active && this.dispatchSuspensions === 0) await this.run(() => this.dispatchReady());
    }
  }

  enqueue(projectId: string, taskId: string) {
    return this.run(async () => {
      const attempt = await this.createInitialAttempt(projectId, taskId);
      await this.dispatchReady();
      return attempt;
    });
  }

  retry(attemptId: string) {
    return this.run(async () => {
      const previous = await this.requireAttempt(attemptId);
      if (previous.status !== 'failed' && previous.status !== 'cancelled') throw new Error('TASK_ATTEMPT_NOT_RETRYABLE');
      const policy = await this.policies.getOrCreate(previous.projectId);
      const attempt = await this.executions.createAttempt({
        projectId: previous.projectId,
        taskId: previous.taskId,
        taskRevision: previous.taskRevision,
        contractSourceFingerprint: previous.contractSourceFingerprint,
        assigneeId: previous.assigneeId,
        actorPartnerId: previous.actorPartnerId,
        purpose: previous.purpose,
        rootAttemptId: previous.rootAttemptId,
        sourceAttemptId: previous.sourceAttemptId,
        reworkRound: previous.reworkRound,
        reworkRequest: previous.reworkRequest,
        permissionMode: policy.permissionMode,
        blockedByTaskIds: previous.purpose === 'execution' ? await this.blockersFor(previous.projectId, previous.taskId) : [],
        retryOfAttemptId: previous.id,
      });
      await this.domain.setTaskStatusForExecution(previous.projectId, previous.taskId, statusBeforeStart(attempt));
      await this.dispatchReady();
      return attempt;
    });
  }

  resume(attemptId: string, reason = '用户恢复了任务。') {
    return this.run(async () => {
      const attempt = await this.executions.transition(attemptId, ['paused'], {
        status: 'queued', eventType: 'resume_requested', reason, clearRuntime: true, clearFailure: true,
      });
      await this.domain.setTaskStatusForExecution(attempt.projectId, attempt.taskId, statusBeforeStart(attempt));
      await this.reconcileAttempt(attempt);
      await this.dispatchReady();
      return this.requireAttempt(attemptId);
    });
  }

  pause(attemptId: string, reason = '用户暂停了任务。') {
    return this.run(async () => {
      const attempt = await this.requireAttempt(attemptId);
      if (attempt.status === 'waiting_dependencies' || attempt.status === 'queued') {
        const paused = await this.executions.transition(attemptId, [attempt.status], { status: 'paused', eventType: 'paused', reason });
        await this.domain.setTaskStatusForExecution(paused.projectId, paused.taskId, 'blocked');
        return paused;
      }
      if (attempt.status !== 'starting' && attempt.status !== 'running') throw new Error('TASK_ATTEMPT_NOT_PAUSABLE');
      const requested = await this.executions.transition(attemptId, [attempt.status], { status: 'pause_requested', eventType: 'pause_requested', reason });
      const active = this.activeRuns.get(attemptId);
      if (active) await active.handle.pause(reason).catch((error) => this.failRuntimeControl(attemptId, error));
      return requested;
    });
  }

  cancel(attemptId: string, reason = '用户取消了任务。') {
    return this.run(async () => {
      const attempt = await this.requireAttempt(attemptId);
      if (attempt.status === 'waiting_dependencies' || attempt.status === 'queued' || attempt.status === 'paused') {
        const cancelled = await this.executions.transition(attemptId, [attempt.status], { status: 'cancelled', eventType: 'cancelled', reason, finished: true, clearRuntime: true });
        await this.domain.setTaskStatusForExecution(cancelled.projectId, cancelled.taskId, 'cancelled');
        await this.dispatchReady();
        return cancelled;
      }
      if (attempt.status !== 'starting' && attempt.status !== 'running' && attempt.status !== 'pause_requested') throw new Error('TASK_ATTEMPT_NOT_CANCELLABLE');
      const requested = await this.executions.transition(attemptId, [attempt.status], { status: 'cancel_requested', eventType: 'cancel_requested', reason });
      const active = this.activeRuns.get(attemptId);
      if (active) await active.handle.cancel(reason).catch((error) => this.failRuntimeControl(attemptId, error));
      return requested;
    });
  }

  resolveGate(request: TaskGateResolutionRequest) {
    return this.run(async () => {
      const snapshot = await this.domain.projectSnapshot(request.projectId);
      const task = snapshot?.tasks.find((item) => item.id === request.taskId);
      if (!snapshot || !task) throw new Error('PROJECT_TASK_NOT_FOUND');
      const execution = await this.executions.snapshot(request.projectId);
      const latest = execution.attempts.filter((item) => item.taskId === request.taskId).sort(byNewestAttempt)[0];
      if (!latest || latest.status !== 'succeeded' || task.status !== 'review') throw new Error('TASK_GATE_NOT_WAITING');
      if (execution.events.some((event) => event.type === 'workflow_completed' && execution.attempts.some((item) => item.id === event.attemptId && item.rootAttemptId === latest.rootAttemptId))) {
        throw new Error('TASK_GATE_ALREADY_RESOLVED');
      }
      if (request.action === 'accept') {
        await this.executions.appendEvent(latest.id, 'user_confirmed', request.feedback?.trim() || '用户确认任务完成。');
        await this.completeWorkflow(latest);
        return this.requireAttempt(latest.id);
      }
      const root = await this.requireAttempt(latest.rootAttemptId);
      const contract = root.contract;
      if (!contract) throw new Error('TASK_CONTRACT_NOT_FROZEN');
      const feedback = request.feedback?.trim();
      if (!feedback) throw new Error('TASK_REWORK_FEEDBACK_REQUIRED');
      const allowed = contract.acceptanceCriteria.map((item) => item.criterionId);
      const inferred = latest.review?.decision === 'changes_required'
        ? latest.review.criteria.filter((item) => item.verdict !== 'pass').map((item) => item.criterionId)
        : [];
      const criterionIds = [...new Set(request.affectedCriteria?.length ? request.affectedCriteria : inferred)];
      if (allowed.length && !criterionIds.length) throw new Error('TASK_REWORK_CRITERIA_REQUIRED');
      if (criterionIds.some((item) => !allowed.includes(item))) throw new Error('TASK_REWORK_CRITERIA_INVALID');
      const rework = await this.scheduleRework(latest, latest.reworkRound + 1, { requestedBy: 'user', feedback, criterionIds });
      await this.dispatchReady();
      return rework;
    });
  }

  reconcileProject(snapshot?: ProjectDomainSnapshot) {
    return this.run(() => this.reconcileAll(snapshot));
  }

  submitHandoff(attemptId: string, submission: TaskHandoffSubmission) {
    return this.run(async () => {
      const attempt = await this.requireAttempt(attemptId);
      if (attempt.status !== 'running') throw new Error('TASK_ATTEMPT_NOT_ACCEPTING_HANDOFF');
      if (attempt.purpose === 'review') throw new Error('TASK_HANDOFF_STAGE_INVALID');
      if (!attempt.contract) throw new Error('TASK_CONTRACT_NOT_FROZEN');
      if (!this.options) throw new Error('TASK_HANDOFF_VALIDATION_NOT_CONNECTED');
      const normalized = await this.options.handoffs.validate(attempt.contract, submission);
      return this.executions.submitHandoff(attemptId, {
        version: 1, id: randomUUID(), attemptId: attempt.id, projectId: attempt.projectId, taskId: attempt.taskId,
        taskRevision: attempt.taskRevision, ...normalized, submittedAt: new Date().toISOString(),
      });
    });
  }

  submitReview(attemptId: string, submission: TaskReviewSubmission) {
    return this.run(async () => {
      const attempt = await this.requireAttempt(attemptId);
      if (attempt.status !== 'running') throw new Error('TASK_ATTEMPT_NOT_ACCEPTING_REVIEW');
      if (attempt.purpose !== 'review' || !attempt.contract) throw new Error('TASK_REVIEW_STAGE_INVALID');
      if (!this.options) throw new Error('TASK_REVIEW_VALIDATION_NOT_CONNECTED');
      if (!this.options.reviews) throw new Error('TASK_REVIEW_VALIDATION_NOT_CONNECTED');
      const normalized = this.options.reviews.validate(attempt.contract, submission);
      return this.executions.submitReview(attemptId, {
        version: 1, id: randomUUID(), attemptId: attempt.id, projectId: attempt.projectId, taskId: attempt.taskId,
        taskRevision: attempt.taskRevision, ...normalized, submittedAt: new Date().toISOString(),
      });
    });
  }

  private async createInitialAttempt(projectId: string, taskId: string) {
    const snapshot = await this.domain.projectSnapshot(projectId);
    if (!snapshot) throw new Error('PROJECT_NOT_FOUND');
    if (snapshot.project.status === 'complete') throw new Error('PROJECT_NOT_ACTIVE');
    const task = snapshot.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error('PROJECT_TASK_NOT_FOUND');
    if (!task.assigneeId) throw new Error('PROJECT_TASK_ASSIGNEE_REQUIRED');
    if (task.status === 'completed' || task.status === 'cancelled') throw new Error('PROJECT_TASK_NOT_RUNNABLE');
    if (task.status === 'review' || await this.executions.pendingCompletionForTask(projectId, taskId)) throw new Error('PROJECT_TASK_PENDING_COMPLETION');
    const completion = task.execution?.completionRule;
    if (completion?.type === 'partner_review') {
      if (completion.reviewerPartnerId === task.assigneeId) throw new Error('PROJECT_TASK_REVIEWER_MUST_BE_INDEPENDENT');
      if (!task.acceptanceCriteria.length) throw new Error('PROJECT_TASK_REVIEW_CRITERIA_REQUIRED');
    }
    const policy = await this.policies.getOrCreate(projectId);
    const blockedByTaskIds = dependencyBlockers(task, snapshot.tasks);
    const attempt = await this.executions.createAttempt({
      projectId, taskId, taskRevision: task.revision, contractSourceFingerprint: taskContractFingerprint(task), assigneeId: task.assigneeId, actorPartnerId: task.assigneeId,
      purpose: 'execution', permissionMode: policy.permissionMode, blockedByTaskIds,
    });
    await this.domain.setTaskStatusForExecution(projectId, taskId, attempt.status === 'waiting_dependencies' ? 'blocked' : 'todo');
    return attempt;
  }

  private async createStageAttempt(source: TaskAttempt, input: {
    purpose: 'review' | 'rework'; actorPartnerId: string; reworkRound: number; reworkRequest?: TaskAttempt['reworkRequest'];
  }) {
    const policy = await this.policies.getOrCreate(source.projectId);
    return this.executions.createAttempt({
      projectId: source.projectId, taskId: source.taskId, taskRevision: source.taskRevision,
      contractSourceFingerprint: source.contractSourceFingerprint,
      assigneeId: (await this.requireAttempt(source.rootAttemptId)).assigneeId,
      actorPartnerId: input.actorPartnerId, purpose: input.purpose, rootAttemptId: source.rootAttemptId,
      sourceAttemptId: source.id, reworkRound: input.reworkRound, reworkRequest: input.reworkRequest,
      permissionMode: policy.permissionMode, blockedByTaskIds: [],
    });
  }

  private async reconcileAttempt(attempt: TaskAttempt, tasks?: ProjectTask[]) {
    if (attempt.purpose !== 'execution') return;
    const project = tasks ? undefined : await this.domain.projectSnapshot(attempt.projectId);
    const projectTasks = tasks ?? project?.tasks;
    const task = projectTasks?.find((item) => item.id === attempt.taskId);
    if (!task || (attempt.status !== 'waiting_dependencies' && attempt.status !== 'queued')) return;
    const reconciled = await this.executions.setDependencyState(attempt.id, dependencyBlockers(task, projectTasks ?? []));
    await this.domain.setTaskStatusForExecution(reconciled.projectId, reconciled.taskId, reconciled.status === 'waiting_dependencies' ? 'blocked' : 'todo');
  }

  private async dispatchReady() {
    if (!this.active || !this.runtime || this.dispatchSuspensions > 0) return;
    const snapshot = await this.executions.snapshot();
    const queued = snapshot.attempts.filter((attempt) => attempt.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const attempt of queued) {
      if (this.activeRuns.has(attempt.id)) continue;
      const project = await this.domain.projectSnapshot(attempt.projectId);
      if (!project || project.project.status !== 'active') continue;
      const current = project.tasks.find((task) => task.id === attempt.taskId);
      if (!current) continue;
      if (attempt.purpose === 'execution' && dependencyBlockers(current, project.tasks).length) {
        await this.executions.setDependencyState(attempt.id, dependencyBlockers(current, project.tasks));
        continue;
      }
      const scope = this.runtime.workspaceWriterScope === 'project_workspace'
        ? projectWorkspaceWriterScope(attempt.projectId)
        : projectPartnerWriterScope(attempt.projectId, attempt.actorPartnerId);
      const lease = this.writerLeases.tryAcquire(scope, `task:${attempt.id}`);
      if (!lease) continue;
      await this.start(attempt, lease);
    }
  }

  private async start(attempt: TaskAttempt, lease: WriterLease) {
    const runtime = requireRuntime(this.runtime);
    try {
      const prepared = attempt.contract ? attempt : await this.executions.freezeContract(attempt.id, await this.buildContract(attempt));
      await this.executions.transition(prepared.id, ['queued'], { status: 'starting', eventType: 'runtime_starting', started: true });
      await this.domain.setTaskStatusForExecution(attempt.projectId, attempt.taskId, attempt.purpose === 'review' ? 'review' : 'in_progress');
      const invocation = await this.invocationFor(prepared);
      const handle = await runtime.startProjectTask({
        attemptId: prepared.id, projectId: prepared.projectId, taskId: prepared.taskId, taskRevision: prepared.taskRevision,
        partnerId: prepared.actorPartnerId, permissionMode: prepared.permissionMode, contract: prepared.contract!, invocation,
      });
      this.activeRuns.set(prepared.id, { handle, lease });
      await this.executions.transition(prepared.id, ['starting'], { status: 'running', eventType: 'runtime_started', runtimeRunId: handle.runId });
      void handle.result.then(
        (outcome) => this.run(() => this.finish(prepared.id, outcome)),
        (error) => this.run(() => this.finish(prepared.id, { type: 'failed', error: normalizeFailure(error) })),
      );
    } catch (error) {
      lease.release();
      await this.failStart(attempt, error);
    }
  }

  private async finish(attemptId: string, outcome: ProjectTaskRuntimeOutcome) {
    const active = this.activeRuns.get(attemptId);
    this.activeRuns.delete(attemptId);
    active?.lease.release();
    const attempt = await this.requireAttempt(attemptId);
    if (attempt.status === 'cancel_requested') await this.finishCancelled(attempt, outcome.type === 'cancelled' ? outcome.reason : '取消请求在运行结束时生效。');
    else if (attempt.status === 'pause_requested') await this.finishPaused(attempt, outcome.type === 'paused' ? outcome.reason : '暂停请求在运行结束时生效。');
    else if (attempt.status !== 'running') await this.dispatchReady();
    else if (outcome.type === 'succeeded') {
      const submissionReady = attempt.purpose === 'review'
        ? Boolean(attempt.review && attempt.review.decision !== 'needs_user_decision')
        : Boolean(attempt.handoff?.disposition === 'submitted');
      if (!submissionReady) {
        const failure = attempt.purpose === 'review'
          ? { code: 'TASK_REVIEW_REQUIRED', message: '复核运行结束前没有提交可处理的结构化复核结论。', retryable: true }
          : { code: 'TASK_HANDOFF_REQUIRED', message: '伙伴运行结束前没有提交可进入待处理状态的结构化 handoff。', retryable: true };
        const failed = await this.executions.transition(attemptId, ['running'], { status: 'failed', eventType: 'failed', finished: true, failure });
        await this.domain.setTaskStatusForExecution(failed.projectId, failed.taskId, 'blocked');
      } else {
        const succeeded = await this.executions.transition(attemptId, ['running'], { status: 'succeeded', eventType: 'succeeded', finished: true });
        await this.advanceSucceeded(succeeded);
      }
    } else if (outcome.type === 'paused') await this.finishPaused(attempt, outcome.reason);
    else if (outcome.type === 'cancelled') await this.finishCancelled(attempt, outcome.reason);
    else {
      const failed = await this.executions.transition(attemptId, ['running'], { status: 'failed', eventType: 'failed', failure: outcome.error, finished: true });
      await this.domain.setTaskStatusForExecution(failed.projectId, failed.taskId, 'blocked');
    }
    await this.reconcileAll();
  }

  private async advanceSucceeded(attempt: TaskAttempt) {
    const root = await this.requireAttempt(attempt.rootAttemptId);
    const rule = root.contract?.completionRule;
    if (!rule) throw new Error('TASK_CONTRACT_NOT_FROZEN');
    if (attempt.purpose === 'execution') {
      if (rule.type === 'executor_submit') return this.completeWorkflow(attempt);
      await this.domain.setTaskStatusForExecution(attempt.projectId, attempt.taskId, 'review');
      if (rule.type === 'partner_review') await this.scheduleReview(attempt, rule.reviewerPartnerId);
      return;
    }
    if (attempt.purpose === 'rework') {
      if (rule.type === 'executor_submit') return this.completeWorkflow(attempt);
      if (rule.type === 'user_confirm') {
        await this.domain.setTaskStatusForExecution(attempt.projectId, attempt.taskId, 'review');
        return;
      }
      await this.domain.setTaskStatusForExecution(attempt.projectId, attempt.taskId, 'review');
      await this.scheduleReview(attempt, rule.reviewerPartnerId);
      return;
    }
    const review = attempt.review!;
    if (review.decision === 'pass') return this.completeWorkflow(attempt);
    await this.domain.setTaskStatusForExecution(attempt.projectId, attempt.taskId, 'review');
    if (review.decision === 'changes_required' && rule.type === 'partner_review' && attempt.reworkRound < rule.autoReworkLimit) {
      const failed = review.criteria.filter((item) => item.verdict !== 'pass');
      await this.scheduleRework(attempt, attempt.reworkRound + 1, {
        requestedBy: 'review',
        feedback: failed.map((item) => `[${item.criterionId}] ${item.feedback || review.summary}`).join('\n'),
        criterionIds: failed.map((item) => item.criterionId),
      });
    }
  }

  private async scheduleReview(source: TaskAttempt, reviewerPartnerId: string) {
    const root = await this.requireAttempt(source.rootAttemptId);
    if (reviewerPartnerId === root.assigneeId) throw new Error('PROJECT_TASK_REVIEWER_MUST_BE_INDEPENDENT');
    return this.createStageAttempt(source, { purpose: 'review', actorPartnerId: reviewerPartnerId, reworkRound: source.reworkRound });
  }

  private async scheduleRework(source: TaskAttempt, reworkRound: number, request: NonNullable<TaskAttempt['reworkRequest']>) {
    await this.executions.appendEvent(source.id, 'rework_requested', request.feedback);
    const root = await this.requireAttempt(source.rootAttemptId);
    const attempt = await this.createStageAttempt(source, { purpose: 'rework', actorPartnerId: root.assigneeId, reworkRound, reworkRequest: request });
    await this.domain.setTaskStatusForExecution(source.projectId, source.taskId, 'todo');
    return attempt;
  }

  private async completeWorkflow(attempt: TaskAttempt) {
    await this.executions.appendEvent(attempt.id, 'workflow_completed', '当前任务的完成规则已经满足。');
    await this.domain.setTaskStatusForExecution(attempt.projectId, attempt.taskId, 'completed');
    await this.reconcileAll();
    await this.enqueueEligibleDependents(attempt.projectId, attempt.taskId);
  }

  private async enqueueEligibleDependents(projectId: string, completedTaskId: string) {
    const project = await this.domain.projectSnapshot(projectId);
    if (!project) return;
    const execution = await this.executions.snapshot(projectId);
    for (const task of project.tasks.filter((item) => item.dependencyIds.includes(completedTaskId))) {
      if (task.status === 'completed' || task.status === 'cancelled') continue;
      if (task.dependencyIds.some((id) => project.tasks.find((item) => item.id === id)?.status !== 'completed')) continue;
      if (execution.attempts.some((attempt) => attempt.taskId === task.id)) continue;
      if (!task.assigneeId) {
        await this.domain.setTaskStatusForExecution(projectId, task.id, 'blocked');
        continue;
      }
      await this.createInitialAttempt(projectId, task.id);
    }
    await this.dispatchReady();
  }

  private async finishPaused(attempt: TaskAttempt, reason?: string) {
    const paused = await this.executions.transition(attempt.id, ['running', 'pause_requested'], { status: 'paused', eventType: 'paused', reason, clearRuntime: true });
    await this.domain.setTaskStatusForExecution(paused.projectId, paused.taskId, 'blocked');
  }

  private async finishCancelled(attempt: TaskAttempt, reason?: string) {
    const cancelled = await this.executions.transition(attempt.id, ['running', 'pause_requested', 'cancel_requested'], {
      status: 'cancelled', eventType: 'cancelled', reason, finished: true, clearRuntime: true,
    });
    await this.domain.setTaskStatusForExecution(cancelled.projectId, cancelled.taskId, 'cancelled');
  }

  private async failStart(attempt: TaskAttempt, error: unknown) {
    const current = await this.requireAttempt(attempt.id);
    if (current.status !== 'queued' && current.status !== 'starting') return;
    const failed = await this.executions.transition(attempt.id, [current.status], { status: 'failed', eventType: 'failed', failure: normalizeFailure(error), finished: true });
    await this.domain.setTaskStatusForExecution(failed.projectId, failed.taskId, 'blocked');
  }

  private async failRuntimeControl(attemptId: string, error: unknown) {
    const active = this.activeRuns.get(attemptId);
    this.activeRuns.delete(attemptId);
    active?.lease.release();
    const failed = await this.executions.transition(attemptId, ['pause_requested', 'cancel_requested'], {
      status: 'failed', eventType: 'failed', failure: normalizeFailure(error), finished: true,
    });
    await this.domain.setTaskStatusForExecution(failed.projectId, failed.taskId, 'blocked');
    await this.reconcileAll();
  }

  private async requireAttempt(attemptId: string) {
    const attempt = await this.executions.findAttempt(attemptId);
    if (!attempt) throw new Error('TASK_ATTEMPT_NOT_FOUND');
    return attempt;
  }

  private async buildContract(attempt: TaskAttempt): Promise<FrozenTaskContract> {
    if (!this.options) throw new Error('PROJECT_TASK_CONTRACT_NOT_CONNECTED');
    if (attempt.retryOfAttemptId) {
      const previous = await this.requireAttempt(attempt.retryOfAttemptId);
      if (previous.contract) return structuredClone(previous.contract);
    }
    const [snapshot, workspace, execution] = await Promise.all([
      this.domain.projectSnapshot(attempt.projectId), this.options.workspaces.get(attempt.projectId), this.executions.snapshot(attempt.projectId),
    ]);
    if (!snapshot) throw new Error('PROJECT_NOT_FOUND');
    if (!workspace) throw new Error('PROJECT_WORKSPACE_NOT_READY');
    const task = snapshot.tasks.find((item) => item.id === attempt.taskId);
    if (!task) throw new Error('TASK_CONTRACT_SOURCE_CHANGED');
    if (attempt.purpose === 'execution') {
      if (task.assigneeId !== attempt.assigneeId
        || (attempt.contractSourceFingerprint
          ? taskContractFingerprint(task) !== attempt.contractSourceFingerprint
          : task.revision !== attempt.taskRevision)) throw new Error('TASK_CONTRACT_SOURCE_CHANGED');
      const dependencyHandoffs = task.dependencyIds.map((taskId) => aggregateDependencyHandoff(taskId, execution.attempts));
      try {
        for (const dependency of dependencyHandoffs) await this.options.handoffs.validateDependencyFileRefs(attempt.projectId, dependency.fileRefs ?? []);
      } catch (error) {
        throw Object.assign(new Error('依赖任务的原文件已删除或内容版本已经变化，当前引用已失效。恢复原文件后可以重试。', { cause: error }), {
          code: 'TASK_DEPENDENCY_FILE_UNAVAILABLE',
          retryable: true,
        });
      }
      return {
        version: 1, purpose: 'execution', actorPartnerId: attempt.actorPartnerId,
        projectId: snapshot.project.id, projectName: snapshot.project.name, projectDescription: snapshot.project.description,
        taskId: task.id, taskCode: task.code, taskRevision: attempt.taskRevision, title: task.title, description: task.description,
        assigneeId: attempt.assigneeId,
        workRole: task.execution?.workRole ?? { name: '任务执行者', responsibilities: ['完成冻结任务契约', '按验收标准提供可核验证据', '通过结构化 handoff 交付结果'], scope: 'inline' },
        ...(task.execution?.reviewWorkRole ? { reviewWorkRole: task.execution.reviewWorkRole } : {}),
        acceptanceCriteria: task.acceptanceCriteria.map((text, index) => ({ criterionId: `r${attempt.taskRevision}:c${index + 1}`, text })),
        completionRule: task.execution?.completionRule ?? { type: 'executor_submit' }, dependencyHandoffs,
        ...(task.execution?.methodTemplate ? { methodTemplate: task.execution.methodTemplate } : {}),
        workspace: { projectRoot: workspace.rootPath, executionMode: 'shared_serial' }, frozenAt: new Date().toISOString(),
      };
    }
    const root = await this.requireAttempt(attempt.rootAttemptId);
    if (!root.contract) throw new Error('TASK_CONTRACT_NOT_FROZEN');
    const base = root.contract;
    const chainHandoffs = execution.attempts.filter((item) => item.rootAttemptId === root.id && item.handoff).sort(byAttemptNumber).map((item) => item.handoff!);
    if (attempt.purpose === 'review') {
      return {
        ...base, purpose: 'review', actorPartnerId: attempt.actorPartnerId,
        workRole: base.reviewWorkRole ?? { name: '独立复核', responsibilities: ['只按冻结验收标准检查', '核对结构化交付与可见证据', '提交逐项复核结论且不修改实现'], scope: 'inline' },
        acceptanceCriteria: [...base.acceptanceCriteria],
        stageContext: { type: 'review', reviewRound: attempt.reworkRound, candidateHandoffs: structuredClone(chainHandoffs) },
        frozenAt: new Date().toISOString(),
      };
    }
    const request = attempt.reworkRequest;
    if (!request) throw new Error('TASK_REWORK_REQUEST_REQUIRED');
    const latestEvidence = aggregateCriterionEvidence(chainHandoffs);
    const failed = new Set(request.criterionIds);
    return {
      ...base, purpose: 'rework', actorPartnerId: attempt.actorPartnerId,
      acceptanceCriteria: base.acceptanceCriteria.filter((item) => failed.has(item.criterionId)),
      stageContext: {
        type: 'rework', reworkRound: attempt.reworkRound, requestedBy: request.requestedBy, feedback: request.feedback,
        failedCriterionIds: [...request.criterionIds], lockedCriteria: latestEvidence.filter((item) => !failed.has(item.criterionId)),
        previousHandoffs: structuredClone(chainHandoffs),
      },
      frozenAt: new Date().toISOString(),
    };
  }

  private async invocationFor(attempt: TaskAttempt) {
    if (attempt.retryOfAttemptId) {
      const previous = await this.executions.findAttempt(attempt.retryOfAttemptId);
      return { type: 'retry' as const, ...(previous?.failure ? { previousFailure: previous.failure } : {}) };
    }
    if (attempt.startedAt) {
      const events = (await this.executions.snapshot(attempt.projectId)).events.filter((event) => event.attemptId === attempt.id && event.reason);
      return { type: 'resume' as const, ...(events.at(-1)?.reason ? { reason: events.at(-1)!.reason } : {}) };
    }
    return { type: 'initial' as const };
  }

  private async blockersFor(projectId: string, taskId: string) {
    const snapshot = await this.domain.projectSnapshot(projectId);
    const task = snapshot?.tasks.find((item) => item.id === taskId);
    return task ? dependencyBlockers(task, snapshot?.tasks ?? []) : [];
  }

  private async reconcileAll(snapshot?: ProjectDomainSnapshot) {
    const projectIds = snapshot?.projects.map((project) => project.id) ?? [...new Set((await this.executions.snapshot()).attempts.map((attempt) => attempt.projectId))];
    for (const projectId of projectIds) {
      const project = snapshot
        ? { project: snapshot.projects.find((item) => item.id === projectId), tasks: snapshot.tasks.filter((task) => task.projectId === projectId) }
        : await this.domain.projectSnapshot(projectId);
      if (!project?.project) continue;
      const attempts = (await this.executions.snapshot(projectId)).attempts;
      for (const attempt of attempts.filter((item) => item.status === 'waiting_dependencies' || item.status === 'queued')) await this.reconcileAttempt(attempt, project.tasks);
    }
    await this.dispatchReady();
  }

  private async syncRecoveredTaskProjection(snapshot: ProjectTaskExecutionSnapshot) {
    const latest = new Map<string, TaskAttempt>();
    for (const attempt of snapshot.attempts) {
      const key = `${attempt.projectId}\0${attempt.taskId}`;
      if (!latest.has(key) || latest.get(key)!.attemptNumber < attempt.attemptNumber) latest.set(key, attempt);
    }
    for (const attempt of latest.values()) {
      const project = await this.domain.projectSnapshot(attempt.projectId);
      const task = project?.tasks.find((item) => item.id === attempt.taskId);
      if (!task) continue;
      const completed = snapshot.events.some((event) => event.projectId === attempt.projectId && event.taskId === attempt.taskId
        && event.type === 'workflow_completed'
        && snapshot.attempts.some((item) => item.id === event.attemptId && item.rootAttemptId === attempt.rootAttemptId));
      if (completed) {
        if (task.status !== 'completed') await this.domain.setTaskStatusForExecution(attempt.projectId, attempt.taskId, 'completed');
        continue;
      }
      const projected = projectedTaskStatus(attempt);
      if (!projected || task.status === 'completed') continue;
      await this.domain.setTaskStatusForExecution(attempt.projectId, attempt.taskId, projected);
    }
  }

  private async repairSucceededAdvancement() {
    const snapshot = await this.executions.snapshot();
    const completedRoots = new Set(snapshot.events.filter((event) => event.type === 'workflow_completed').map((event) => {
      return snapshot.attempts.find((attempt) => attempt.id === event.attemptId)?.rootAttemptId;
    }).filter((value): value is string => Boolean(value)));
    const sourcedAttempts = new Set(snapshot.attempts.map((attempt) => attempt.sourceAttemptId).filter((value): value is string => Boolean(value)));
    for (const attempt of snapshot.attempts.filter((item) => item.status === 'succeeded' && item.completionFlowVersion === 2).sort(byAttemptNumber)) {
      if (completedRoots.has(attempt.rootAttemptId) || sourcedAttempts.has(attempt.id)) continue;
      await this.advanceSucceeded(attempt);
      const refreshed = await this.executions.snapshot(attempt.projectId);
      if (refreshed.events.some((event) => event.type === 'workflow_completed'
        && refreshed.attempts.some((item) => item.id === event.attemptId && item.rootAttemptId === attempt.rootAttemptId))) {
        completedRoots.add(attempt.rootAttemptId);
      }
    }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(() => this.recover()).then(operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function dependencyBlockers(task: ProjectTask, tasks: ProjectTask[]) {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  return task.dependencyIds.filter((dependencyId) => byId.get(dependencyId)?.status !== 'completed');
}

function statusBeforeStart(attempt: TaskAttempt): ProjectTask['status'] {
  if (attempt.status === 'waiting_dependencies') return 'blocked';
  return attempt.purpose === 'review' ? 'review' : 'todo';
}

function projectedTaskStatus(attempt: TaskAttempt): ProjectTask['status'] | undefined {
  if (attempt.status === 'waiting_dependencies' || attempt.status === 'paused' || attempt.status === 'failed') return 'blocked';
  if (attempt.status === 'queued') return attempt.purpose === 'review' ? 'review' : 'todo';
  if (attempt.status === 'starting' || attempt.status === 'running' || attempt.status === 'pause_requested' || attempt.status === 'cancel_requested') return attempt.purpose === 'review' ? 'review' : 'in_progress';
  if (attempt.status === 'cancelled') return 'cancelled';
  if (attempt.status === 'succeeded') return 'review';
  return undefined;
}

function aggregateDependencyHandoff(taskId: string, attempts: TaskAttempt[]) {
  const relevant = attempts.filter((item) => item.taskId === taskId && item.handoff).sort(byAttemptNumber);
  const latest = relevant.at(-1)?.handoff;
  const currentFiles = new Map<string, NonNullable<TaskHandoff['fileRefs']>[number]>();
  for (const attempt of relevant) for (const ref of attempt.handoff?.fileRefs ?? []) currentFiles.set(ref.fileId, ref);
  return latest ? {
    taskId, handoffId: latest.id, summary: latest.summary,
    deliveryRefs: [...latest.deliveryRefs],
    fileRefs: [...currentFiles.values()],
    unresolvedIssues: [...latest.unresolvedIssues],
  } : { taskId, summary: '该前置任务已由用户标记完成，但没有结构化伙伴交付。', deliveryRefs: [], fileRefs: [], unresolvedIssues: [] };
}

function aggregateCriterionEvidence(handoffs: TaskHandoff[]) {
  const values = new Map<string, TaskHandoff['criterionEvidence'][number]>();
  for (const handoff of handoffs) for (const evidence of handoff.criterionEvidence) values.set(evidence.criterionId, structuredClone(evidence));
  return [...values.values()];
}

function byAttemptNumber(left: TaskAttempt, right: TaskAttempt) {
  return left.attemptNumber - right.attemptNumber;
}

function byNewestAttempt(left: TaskAttempt, right: TaskAttempt) {
  return right.attemptNumber - left.attemptNumber;
}

export function taskContractFingerprint(task: ProjectTask) {
  return JSON.stringify({
    code: task.code,
    title: task.title,
    description: task.description,
    assigneeId: task.assigneeId,
    dependencyIds: task.dependencyIds,
    acceptanceCriteria: task.acceptanceCriteria,
    execution: task.execution ?? null,
  });
}

function normalizeFailure(error: unknown): TaskAttemptFailure {
  if (isFailure(error)) return { code: error.code, message: error.message, retryable: error.retryable };
  return { code: 'TASK_RUNTIME_FAILED', message: error instanceof Error ? error.message.slice(0, 1_000) : '任务运行失败。', retryable: true };
}

function isFailure(value: unknown): value is TaskAttemptFailure {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    && 'message' in value && typeof value.message === 'string' && 'retryable' in value && typeof value.retryable === 'boolean';
}

function requireRuntime(runtime?: ProjectTaskRuntimeLifecyclePort): ProjectTaskRuntimeLifecyclePort {
  if (!runtime) throw new Error('PROJECT_TASK_RUNTIME_NOT_CONNECTED');
  return runtime;
}

export const NON_TERMINAL_TASK_ATTEMPT_STATUSES: readonly TaskAttemptStatus[] = [
  'waiting_dependencies', 'queued', 'starting', 'running', 'pause_requested', 'paused', 'cancel_requested',
];
