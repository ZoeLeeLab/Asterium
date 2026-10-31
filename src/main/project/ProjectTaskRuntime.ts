import { randomUUID } from 'node:crypto';
import type { AsteriumRuntimeContextInput, CancelRunCommand, PartnerEvent, SendMessageCommand, SendMessageReceipt } from '../../shared/agentProtocol';
import { AGENT_PROTOCOL_VERSION } from '../../shared/agentProtocol';
import type { TaskAttempt, TaskHandoff, TaskHandoffSubmission, TaskReview, TaskReviewSubmission } from '../../shared/projectTaskExecution';
import type { ProjectFileVersionRef } from '../../shared/projectWorkspace';
import type { AsteriumTaskToolInput } from '../runtime/AsteriumRuntimeTools';
import type { ProjectTaskRuntimeCommand, ProjectTaskRuntimeHandle, ProjectTaskRuntimeLifecyclePort, ProjectTaskRuntimeOutcome } from '../runtime/PartnerRuntimePort';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import type { StudioPartnerRecord, StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
import { compileProjectTaskPrompt } from './ProjectTaskPrompt';

interface ProjectTaskRuntimeDependencies {
  catalog: Pick<StudioRuntimeCatalog, 'partner' | 'user'>;
  bindings: Pick<NativeThreadBindingStore, 'reserve' | 'getForScope' | 'activate' | 'invalidate' | 'markCompleted'>;
  startApi: (request: { partner: StudioPartnerRecord; command: SendMessageCommand; projectRoot: string }) => Promise<SendMessageReceipt>;
  startLocal: (request: { partner: StudioPartnerRecord; command: SendMessageCommand; projectRoot: string }) => Promise<SendMessageReceipt>;
  cancelRun: (command: CancelRunCommand) => Promise<void>;
  submitHandoff: (attemptId: string, submission: TaskHandoffSubmission) => Promise<TaskAttempt>;
  submitReview?: (attemptId: string, submission: TaskReviewSubmission) => Promise<TaskAttempt>;
  captureChangedFiles?: (projectId: string, changedPaths: string[]) => Promise<ProjectFileVersionRef[]>;
}

interface ActiveWorkspaceRun {
  command: ProjectTaskRuntimeCommand;
  message: SendMessageCommand;
  bindingId: string;
  resolve: (outcome: ProjectTaskRuntimeOutcome) => void;
  result: Promise<ProjectTaskRuntimeOutcome>;
  runId?: string;
  sessionId?: string;
  control?: { type: 'paused' | 'cancelled'; reason: string };
  handoff?: TaskHandoff;
  review?: TaskReview;
  taskToolFailure?: { code: string; message: string; retryable: boolean };
  fileRefs: Map<string, ProjectFileVersionRef>;
  settled: boolean;
}

export class ProjectTaskRuntime implements ProjectTaskRuntimeLifecyclePort {
  readonly workspaceWriterScope = 'project_workspace' as const;
  private readonly runsByAttempt = new Map<string, ActiveWorkspaceRun>();
  private readonly runsByClientMessage = new Map<string, ActiveWorkspaceRun>();

  constructor(private readonly dependencies: ProjectTaskRuntimeDependencies) {}

  async startProjectTask(command: ProjectTaskRuntimeCommand): Promise<ProjectTaskRuntimeHandle> {
    if (this.runsByAttempt.has(command.attemptId)) throw new Error('PROJECT_TASK_RUNTIME_ALREADY_ACTIVE');
    const partner = this.dependencies.catalog.partner(command.partnerId);
    if (!partner?.available || partner.runtime.kind === 'unsupported' || partner.sourceMode === 'existing_thread') throw new Error('PROJECT_TASK_PARTNER_RUNTIME_UNAVAILABLE');
    if (command.contract.workspace.projectRoot.length === 0) throw new Error('PROJECT_WORKSPACE_NOT_READY');
    const conversationId = workspaceConversationId(command.projectId, command.partnerId);
    let binding = await this.dependencies.bindings.reserve({
      partnerId: command.partnerId,
      source: partner.sourceMode,
      scope: 'workspace',
      conversationId,
      projectId: command.projectId,
    });
    if (binding.conversationId !== conversationId || binding.source !== partner.sourceMode) {
      await this.dependencies.bindings.invalidate(binding.bindingId);
      binding = await this.dependencies.bindings.reserve({ partnerId: command.partnerId, source: partner.sourceMode, scope: 'workspace', conversationId, projectId: command.projectId });
    }

    let resolve!: (outcome: ProjectTaskRuntimeOutcome) => void;
    const result = new Promise<ProjectTaskRuntimeOutcome>((done) => { resolve = done; });
    const clientMessageId = `workspace-task:${command.attemptId}:${randomUUID()}`;
    const message: SendMessageCommand = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'message.send',
      commandId: `workspace-command:${command.attemptId}:${randomUUID()}`,
      partnerId: command.partnerId,
      conversationId,
      connectionSource: partner.sourceMode,
      clientMessageId,
      ...(binding.nativeThreadId ? { sessionId: binding.nativeThreadId } : {}),
      route: { scope: 'workspace', projectId: command.projectId },
      content: { type: 'text', text: compileProjectTaskPrompt(command.contract, command.invocation) },
      execution: { permissionMode: command.permissionMode, planMode: 'default' },
      runtimeContext: taskRuntimeContext(partner, this.dependencies.catalog.user(), command),
      ...(partner.runtime.kind === 'api' ? { apiContext: { history: [], apiSessionHistoryEnabled: true } } : {}),
    };
    const active: ActiveWorkspaceRun = { command, message, bindingId: binding.bindingId, resolve, result, fileRefs: new Map(), settled: false };
    this.runsByAttempt.set(command.attemptId, active);
    this.runsByClientMessage.set(clientMessageId, active);
    try {
      const receipt = partner.runtime.kind === 'api'
        ? await this.dependencies.startApi({ partner, command: message, projectRoot: command.contract.workspace.projectRoot })
        : await this.dependencies.startLocal({ partner, command: message, projectRoot: command.contract.workspace.projectRoot });
      active.runId = receipt.runId;
      active.sessionId = receipt.sessionId;
      return {
        runId: receipt.runId,
        result,
        pause: (reason) => this.control(active, 'paused', reason),
        cancel: (reason) => this.control(active, 'cancelled', reason),
      };
    } catch (error) {
      this.cleanup(active);
      throw error;
    }
  }

  reportChanges(attemptId: string, paths: string[], recorder: { report(command: SendMessageCommand, paths: string[], verification?: TaskHandoffSubmission['verification']): void }, verification?: TaskHandoffSubmission['verification']) {
    const active = this.runsByAttempt.get(attemptId);
    if (active) recorder.report(active.message, paths, verification);
  }

  changeContext(command: SendMessageCommand) {
    const active = this.runsByClientMessage.get(command.clientMessageId);
    return active ? { attemptId: active.command.attemptId, taskId: active.command.taskId, title: active.command.contract.title, purpose: active.command.contract.purpose, control: active.control?.type } : undefined;
  }

  toolOptions(command: SendMessageCommand) {
    if (command.route?.scope !== 'workspace') return undefined;
    const active = this.runsByClientMessage.get(command.clientMessageId);
    if (!active) return undefined;
    const task = async (input: AsteriumTaskToolInput) => {
      if (input.action === 'context') return JSON.stringify({ contract: active.command.contract, invocation: active.command.invocation }, null, 2);
      if (input.action === 'submit_review') {
        if (active.command.contract.purpose !== 'review') throw new Error('TASK_REVIEW_STAGE_INVALID');
        try {
          if (!this.dependencies.submitReview) throw new Error('TASK_REVIEW_VALIDATION_NOT_CONNECTED');
          const submission: TaskReviewSubmission = {
            decision: input.decision,
            summary: input.summary,
            criteria: input.criteria,
            ...(input.userDecisionRequest ? { userDecisionRequest: input.userDecisionRequest } : {}),
          };
          const attempt = await this.dependencies.submitReview(active.command.attemptId, submission);
          active.review = attempt.review;
          active.taskToolFailure = undefined;
          return JSON.stringify({ accepted: true, reviewId: attempt.review?.id, decision: attempt.review?.decision }, null, 2);
        } catch (error) {
          active.taskToolFailure = taskToolFailure(error);
          throw error;
        }
      }
      if (active.command.contract.purpose === 'review') throw new Error('TASK_HANDOFF_STAGE_INVALID');
      // Formal deliveries are authoritative Main-owned records captured from
      // deliver_file events. Model-supplied names and paths are not references.
      const changedRefs = await this.dependencies.captureChangedFiles?.(active.command.projectId, input.changedPaths) ?? [];
      for (const ref of changedRefs) active.fileRefs.set(ref.fileId, ref);
      const submission: TaskHandoffSubmission = { ...input, deliveryRefs: [], fileRefs: [...active.fileRefs.values()] };
      delete (submission as TaskHandoffSubmission & { action?: string }).action;
      try {
        const attempt = await this.dependencies.submitHandoff(active.command.attemptId, submission);
        active.handoff = attempt.handoff;
        active.taskToolFailure = undefined;
        return JSON.stringify({ accepted: true, handoffId: attempt.handoff?.id, disposition: attempt.handoff?.disposition }, null, 2);
      } catch (error) {
        active.taskToolFailure = taskToolFailure(error);
        throw error;
      }
    };
    return {
      task,
      workspaceBoundary: { projectId: active.command.projectId, projectRoot: active.command.contract.workspace.projectRoot },
    };
  }

  async validateFirstEvent(event: Extract<PartnerEvent, { type: 'session.bound' }>, command: SendMessageCommand) {
    if (command.route?.scope !== 'workspace') return;
    const active = this.requireActive(command);
    const binding = await this.dependencies.bindings.getForScope(command.partnerId, 'workspace', command.route.projectId);
    if (!binding || binding.bindingId !== active.bindingId || binding.conversationId !== command.conversationId) throw new Error('NATIVE_BINDING_ROUTE_MISMATCH');
    if (binding.state === 'pending') await this.dependencies.bindings.activate(binding.bindingId, event.sessionId);
    else if (binding.nativeThreadId !== event.sessionId) throw new Error('NATIVE_THREAD_ROUTE_MISMATCH');
  }

  async onEvent(event: PartnerEvent, command: SendMessageCommand) {
    if (command.route?.scope !== 'workspace') return;
    const active = this.runsByClientMessage.get(command.clientMessageId);
    if (!active || active.settled) return;
    if (event.type === 'run.completed') {
      const binding = await this.dependencies.bindings.getForScope(command.partnerId, 'workspace', command.route.projectId);
      if (binding?.bindingId === active.bindingId) await this.dependencies.bindings.markCompleted(binding.bindingId, event.runId).catch(() => undefined);
      if (active.control) this.settle(active, { type: active.control.type, reason: active.control.reason });
      else if (active.handoff?.disposition === 'submitted') this.settle(active, { type: 'succeeded' });
      else if (active.handoff?.disposition === 'needs_user_decision') this.settle(active, { type: 'paused', reason: active.handoff.userDecisionRequest?.question || '任务需要用户决定。' });
      else if (active.handoff?.disposition === 'blocked') this.settle(active, { type: 'failed', error: { code: 'TASK_REPORTED_BLOCKED', message: active.handoff.summary, retryable: true } });
      else if (active.review?.decision === 'needs_user_decision') this.settle(active, { type: 'paused', reason: active.review.userDecisionRequest?.question || '复核需要用户决定。' });
      else if (active.review) this.settle(active, { type: 'succeeded' });
      else this.settle(active, { type: 'failed', error: active.taskToolFailure ?? (active.command.contract.purpose === 'review'
        ? { code: 'TASK_REVIEW_REQUIRED', message: '复核运行结束前没有提交结构化结论。', retryable: true }
        : { code: 'TASK_HANDOFF_REQUIRED', message: '伙伴运行结束前没有提交结构化 handoff。', retryable: true }) });
    } else if (event.type === 'run.failed') {
      this.settle(active, { type: 'failed', error: { code: event.error.code, message: event.error.message, retryable: event.error.retryable } });
    } else if (event.type === 'run.cancelled') {
      this.settle(active, { type: active.control?.type ?? 'cancelled', reason: active.control?.reason ?? event.reason });
    }
  }

  recordProjectFile(event: Pick<PartnerEvent, 'clientMessageId' | 'route'>, ref: ProjectFileVersionRef) {
    if (event.route?.scope !== 'workspace') return;
    this.runsByClientMessage.get(event.clientMessageId)?.fileRefs.set(ref.fileId, ref);
  }

  fail(command: SendMessageCommand, error: unknown) {
    if (command.route?.scope !== 'workspace') return;
    const active = this.runsByClientMessage.get(command.clientMessageId);
    if (!active || active.settled) return;
    this.settle(active, { type: 'failed', error: { code: 'ADAPTER_STREAM_FAILED', message: error instanceof Error ? error.message : '伙伴事件流中断。', retryable: true } });
  }

  async invalidatePending(command: SendMessageCommand) {
    if (command.route?.scope !== 'workspace') return;
    const active = this.runsByClientMessage.get(command.clientMessageId);
    if (active) await this.dependencies.bindings.invalidate(active.bindingId).catch(() => undefined);
  }

  released(command: SendMessageCommand) {
    if (command.route?.scope !== 'workspace') return;
    const active = this.runsByClientMessage.get(command.clientMessageId);
    if (active && !active.settled) this.settle(active, { type: 'failed', error: { code: 'TASK_RUNTIME_RELEASED', message: '伙伴运行结束但没有终止事件。', retryable: true } });
  }

  private async control(active: ActiveWorkspaceRun, type: 'paused' | 'cancelled', reason: string) {
    if (active.settled || !active.runId || !active.sessionId) return;
    active.control = { type, reason };
    await this.dependencies.cancelRun({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'run.cancel',
      commandId: `workspace-${type}:${active.command.attemptId}:${randomUUID()}`,
      partnerId: active.message.partnerId,
      conversationId: active.message.conversationId,
      connectionSource: active.message.connectionSource,
      clientMessageId: active.message.clientMessageId,
      runId: active.runId,
      sessionId: active.sessionId,
      route: active.message.route,
      reason,
    });
  }

  private requireActive(command: SendMessageCommand) {
    const active = this.runsByClientMessage.get(command.clientMessageId);
    if (!active) throw new Error('PROJECT_TASK_RUNTIME_NOT_ACTIVE');
    return active;
  }

  private settle(active: ActiveWorkspaceRun, outcome: ProjectTaskRuntimeOutcome) {
    if (active.settled) return;
    active.settled = true;
    active.resolve(outcome);
    this.cleanup(active);
  }

  private cleanup(active: ActiveWorkspaceRun) {
    this.runsByAttempt.delete(active.command.attemptId);
    this.runsByClientMessage.delete(active.message.clientMessageId);
  }
}

function taskToolFailure(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return { code, message: taskToolFailureMessage(code), retryable: true };
}

function taskToolFailureMessage(code: string) {
  if (code === 'TASK_ATTEMPT_NOT_ACCEPTING_HANDOFF') return '结构化 handoff 提交时，当前 Attempt 已不再接受交付。';
  if (code === 'TASK_HANDOFF_DELIVERY_REF_INVALID') return '结构化 handoff 引用了无效或未正式登记的交付物。';
  if (code === 'TASK_HANDOFF_FILE_REF_INVALID') return '结构化 handoff 引用了不属于当前项目的正式文件。';
  if (code === 'TASK_HANDOFF_FILE_REF_STALE') return '结构化 handoff 引用的文件版本已变化，请重新核对后提交。';
  if (code.startsWith('TASK_REVIEW_')) return `结构化复核提交失败：${code}`;
  return `结构化 handoff 提交失败：${code}`;
}

function workspaceConversationId(projectId: string, partnerId: string) {
  return `workspace:v1:${projectId}:${partnerId}`;
}

function taskRuntimeContext(partner: StudioPartnerRecord, user: ReturnType<StudioRuntimeCatalog['user']>, command: ProjectTaskRuntimeCommand): AsteriumRuntimeContextInput {
  return {
    partner: {
      displayName: partner.publicIdentity.displayName,
      introduction: partner.publicIdentity.introduction,
      expertise: partner.publicIdentity.expertise,
      mentionName: partner.publicIdentity.mentionName,
      avatarAvailable: Boolean(partner.publicIdentity.avatarDataUrl),
      ...(partner.personality ? { personality: partner.personality } : {}),
      ...(partner.systemPrompt ? { systemPrompt: partner.systemPrompt } : {}),
    },
    user: { displayName: user.displayName, introduction: user.introduction },
    runtime: partner.runtimeContext,
    conversation: { title: `${command.contract.projectName} · ${command.contract.title}` },
  };
}
