import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdapterHost } from '../../src/main/AdapterHost';
import type { PartnerAdapter } from '../../src/main/adapters/PartnerAdapter';
import { ProjectDomainStore } from '../../src/main/project/ProjectDomainStore';
import { ProjectExecutionPolicyStore } from '../../src/main/project/ProjectExecutionPolicyStore';
import { ProjectTaskExecutionStore } from '../../src/main/project/ProjectTaskExecutionStore';
import { ProjectTaskHandoffValidator } from '../../src/main/project/ProjectTaskHandoffValidator';
import { ProjectTaskOrchestrator } from '../../src/main/project/ProjectTaskOrchestrator';
import { ProjectTaskReviewValidator } from '../../src/main/project/ProjectTaskReviewValidator';
import { RunCoordinator } from '../../src/main/runtime/RunCoordinator';
import { conversationWriterScope, projectPartnerWriterScope, projectWorkspaceWriterScope, WriterLeaseCoordinator } from '../../src/main/runtime/WriterLeaseCoordinator';
import type {
  ProjectTaskRuntimeCommand,
  ProjectTaskRuntimeHandle,
  ProjectTaskRuntimeLifecyclePort,
  ProjectTaskRuntimeOutcome,
} from '../../src/main/runtime/PartnerRuntimePort';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';

class TestRuntime implements ProjectTaskRuntimeLifecyclePort {
  readonly commands: ProjectTaskRuntimeCommand[] = [];
  private readonly runs = new Map<string, { resolve: (outcome: ProjectTaskRuntimeOutcome) => void }>();

  constructor(readonly workspaceWriterScope?: 'project_workspace') {}

  async startProjectTask(command: ProjectTaskRuntimeCommand): Promise<ProjectTaskRuntimeHandle> {
    this.commands.push(structuredClone(command));
    let resolve!: (outcome: ProjectTaskRuntimeOutcome) => void;
    const result = new Promise<ProjectTaskRuntimeOutcome>((done) => { resolve = done; });
    this.runs.set(command.attemptId, { resolve });
    return {
      runId: `run-${this.commands.length}`,
      result,
      pause: async (reason) => { resolve({ type: 'paused', reason }); },
      cancel: async (reason) => { resolve({ type: 'cancelled', reason }); },
    };
  }

  finish(attemptId: string, outcome: ProjectTaskRuntimeOutcome) {
    const run = this.runs.get(attemptId);
    if (!run) throw new Error(`Missing test run ${attemptId}`);
    run.resolve(outcome);
  }
}

async function fixture(workspaceWriterScope?: 'project_workspace', validateFileRefs: (refs: import('../../src/shared/projectWorkspace').ProjectFileVersionRef[]) => Promise<void> = async () => undefined) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-task-orchestrator-'));
  const executionPath = path.join(root, 'task-executions.json');
  const domain = new ProjectDomainStore(path.join(root, 'domain.json'));
  const policies = new ProjectExecutionPolicyStore(path.join(root, 'policies.json'));
  await domain.createProject({ id: 'project-a', name: '项目 A', memberIds: ['partner-a', 'partner-b'] });
  const dependency = await domain.createTask({ projectId: 'project-a', title: '前置任务', assigneeId: 'partner-a' });
  const dependent = await domain.createTask({ projectId: 'project-a', title: '下游任务', assigneeId: 'partner-a', dependencyIds: [dependency.id] });
  const parallel = await domain.createTask({ projectId: 'project-a', title: '同伙伴任务', assigneeId: 'partner-a' });
  const otherPartner = await domain.createTask({ projectId: 'project-a', title: '另一伙伴任务', assigneeId: 'partner-b' });
  await policies.update('project-a', 'full');
  const executions = new ProjectTaskExecutionStore(executionPath);
  const runtime = new TestRuntime(workspaceWriterScope);
  const leases = new WriterLeaseCoordinator();
  const options = {
    workspaces: { get: async (projectId: string) => ({ version: 1 as const, projectId, name: projectId, rootPath: root, deliverablesPath: path.join(root, 'deliverables'), templateFiles: [], createdAt: '', updatedAt: '' }) },
    handoffs: new ProjectTaskHandoffValidator({ validateFileRefs: async (_projectId, refs) => validateFileRefs(refs) }),
    reviews: new ProjectTaskReviewValidator(),
  };
  const orchestrator = new ProjectTaskOrchestrator(executions, domain, policies, leases, runtime, options);
  return { root, executionPath, domain, policies, executions, runtime, leases, orchestrator, options, dependency, dependent, parallel, otherPartner };
}

describe('ProjectTaskOrchestrator', () => {
  it('refuses to freeze a new dependent task when an externally deleted delivery reference is unavailable', async () => {
    let fileAvailable = true;
    const value = await fixture(undefined, async (refs) => {
      if (!fileAvailable && refs.length) throw new Error('TASK_HANDOFF_FILE_REF_INVALID');
    });
    await value.orchestrator.activate();
    const first = await value.orchestrator.enqueue('project-a', value.dependency.id);
    const waiting = await value.orchestrator.enqueue('project-a', value.dependent.id);
    await value.orchestrator.submitHandoff(first.id, {
      disposition: 'submitted', summary: '前置任务已交付。', criterionEvidence: [], changedPaths: [], verification: [], deliveryRefs: [], unresolvedIssues: [],
      fileRefs: [{ fileId: 'file-a', relativePath: 'result.md', revision: 1, contentHash: 'hash', sizeBytes: 6 }],
    });
    fileAvailable = false;
    value.runtime.finish(first.id, { type: 'succeeded' });

    await waitFor(async () => (await value.executions.findAttempt(waiting.id))?.status === 'failed');
    expect((await value.executions.findAttempt(waiting.id))?.failure).toMatchObject({ code: 'TASK_DEPENDENCY_FILE_UNAVAILABLE' });
    expect(value.runtime.commands.map((command) => command.attemptId)).toEqual([first.id]);
  });

  it('does not dispatch newly created attempts until an atomic workflow mutation finishes', async () => {
    const value = await fixture();
    await value.orchestrator.activate();
    let attemptId = '';
    await value.orchestrator.withDispatchPaused(async () => {
      const attempt = await value.executions.createAttempt({
        projectId: 'project-a', taskId: value.parallel.id, taskRevision: value.parallel.revision,
        assigneeId: 'partner-a', permissionMode: 'full', blockedByTaskIds: [],
      });
      attemptId = attempt.id;
      await value.orchestrator.activate();
      expect(value.runtime.commands).toEqual([]);
    });
    expect(value.runtime.commands.map((command) => command.attemptId)).toEqual([attemptId]);
  });

  it('auto-completes executor submissions, releases dependencies, serializes one project-partner scope, and runs different partners concurrently', async () => {
    const value = await fixture();
    await value.orchestrator.activate();
    const first = await value.orchestrator.enqueue('project-a', value.dependency.id);
    const waiting = await value.orchestrator.enqueue('project-a', value.dependent.id);
    const samePartner = await value.orchestrator.enqueue('project-a', value.parallel.id);
    const otherPartner = await value.orchestrator.enqueue('project-a', value.otherPartner.id);
    await value.policies.update('project-a', 'manual');

    expect(value.runtime.commands.map((command) => command.attemptId)).toEqual([first.id, otherPartner.id]);
    expect(value.leases.ownerFor(projectPartnerWriterScope('project-a', 'partner-a'))).toBe(`task:${first.id}`);
    expect(value.leases.ownerFor(projectPartnerWriterScope('project-a', 'partner-b'))).toBe(`task:${otherPartner.id}`);
    expect(value.runtime.commands[0]).toMatchObject({ permissionMode: 'full', partnerId: 'partner-a', taskRevision: 1 });
    expect((await value.executions.findAttempt(waiting.id))?.status).toBe('waiting_dependencies');
    expect((await value.executions.findAttempt(samePartner.id))?.status).toBe('queued');

    await submitSuccess(value.orchestrator, first.id);
    value.runtime.finish(first.id, { type: 'succeeded' });
    await waitFor(async () => (await value.domain.projectSnapshot('project-a'))?.tasks.find((task) => task.id === value.dependency.id)?.status === 'completed');
    await waitFor(async () => (await value.executions.findAttempt(waiting.id))?.status === 'running');
    expect(value.runtime.commands.at(-1)?.attemptId).toBe(waiting.id);
    expect(value.runtime.commands.at(-1)?.permissionMode).toBe('full');
    expect((await value.executions.findAttempt(samePartner.id))?.status).toBe('queued');

    await submitSuccess(value.orchestrator, waiting.id);
    value.runtime.finish(waiting.id, { type: 'succeeded' });
    await waitFor(async () => (await value.executions.findAttempt(samePartner.id))?.status === 'running');
    expect(value.runtime.commands.map((command) => command.attemptId)).toEqual([first.id, otherPartner.id, waiting.id, samePartner.id]);
  });

  it('runs a same-partner workspace task and independent single chat concurrently', async () => {
    const value = await fixture('project_workspace');
    await value.orchestrator.activate();
    const attempt = await value.orchestrator.enqueue('project-a', value.parallel.id);
    const current: SendMessageCommand = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'message.send',
      commandId: 'command-single-chat',
      partnerId: 'partner-a',
      conversationId: 'single-chat',
      connectionSource: 'local_cli',
      clientMessageId: 'client-single-chat',
      content: { type: 'text', text: '并发测试' },
    };
    let releaseChat!: () => void;
    const chatBarrier = new Promise<void>((resolve) => { releaseChat = resolve; });
    const chatStarted = vi.fn();
    const adapter: PartnerAdapter = {
      connectionSource: 'local_cli',
      capabilities: { streamingText: true, cancellation: true, sessionResume: true, toolEvents: true, fileEvents: true, authorizationBridge: true, extensions: [] },
      async *sendMessage() {
        chatStarted();
        yield taskChatEvent(current, 'session.bound', 1);
        await chatBarrier;
        yield taskChatEvent(current, 'run.completed', 2);
      },
      async *resumeSession() { yield* []; },
      resolveAuthorization: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };
    const coordinator = new RunCoordinator(new AdapterHost(), {
      deliver: vi.fn(), emit: vi.fn(), observe: vi.fn(async () => undefined),
    }, value.leases);

    await coordinator.start(adapter, current);
    expect(chatStarted).toHaveBeenCalledTimes(1);
    expect((await value.executions.findAttempt(attempt.id))?.status).toBe('running');
    expect(value.leases.ownerFor(projectWorkspaceWriterScope('project-a'))).toBe(`task:${attempt.id}`);
    expect(value.leases.ownerFor(conversationWriterScope(current))).toBe(`runtime:${current.commandId}`);

    releaseChat();
    await submitSuccess(value.orchestrator, attempt.id);
    value.runtime.finish(attempt.id, { type: 'succeeded' });
    await waitFor(async () => (await value.domain.projectSnapshot('project-a'))?.tasks.find((task) => task.id === value.parallel.id)?.status === 'completed');
    await vi.waitFor(() => expect(value.leases.ownerFor(conversationWriterScope(current))).toBeUndefined());
  });

  it('runs same-partner tasks from different projects concurrently', async () => {
    const value = await fixture('project_workspace');
    await value.domain.createProject({ id: 'project-b', name: '项目 B', memberIds: ['partner-a'] });
    const projectBTask = await value.domain.createTask({ projectId: 'project-b', title: '项目 B 任务', assigneeId: 'partner-a' });
    await value.orchestrator.activate();

    const projectAAttempt = await value.orchestrator.enqueue('project-a', value.parallel.id);
    const projectBAttempt = await value.orchestrator.enqueue('project-b', projectBTask.id);

    expect(value.runtime.commands.map((command) => command.attemptId)).toEqual([projectAAttempt.id, projectBAttempt.id]);
    expect(value.leases.ownerFor(projectWorkspaceWriterScope('project-a'))).toBe(`task:${projectAAttempt.id}`);
    expect(value.leases.ownerFor(projectWorkspaceWriterScope('project-b'))).toBe(`task:${projectBAttempt.id}`);

    await submitSuccess(value.orchestrator, projectAAttempt.id);
    await submitSuccess(value.orchestrator, projectBAttempt.id);
    value.runtime.finish(projectAAttempt.id, { type: 'succeeded' });
    value.runtime.finish(projectBAttempt.id, { type: 'succeeded' });
    await waitFor(async () => (await value.executions.findAttempt(projectAAttempt.id))?.status === 'succeeded'
      && (await value.executions.findAttempt(projectBAttempt.id))?.status === 'succeeded');
  });

  it('serializes different partners that share one real project working tree', async () => {
    const value = await fixture('project_workspace');
    await value.orchestrator.activate();
    const first = await value.orchestrator.enqueue('project-a', value.parallel.id);
    const second = await value.orchestrator.enqueue('project-a', value.otherPartner.id);

    expect(value.runtime.commands.map((command) => command.attemptId)).toEqual([first.id]);
    expect((await value.executions.findAttempt(second.id))?.status).toBe('queued');
    expect(value.leases.ownerFor(projectWorkspaceWriterScope('project-a'))).toBe(`task:${first.id}`);

    await submitSuccess(value.orchestrator, first.id);
    value.runtime.finish(first.id, { type: 'succeeded' });
    await waitFor(async () => (await value.executions.findAttempt(second.id))?.status === 'running');
    expect(value.runtime.commands.map((command) => command.attemptId)).toEqual([first.id, second.id]);
  });

  it('pauses, resumes, cancels, retries and records a runtime failure', async () => {
    const value = await fixture();
    await value.orchestrator.activate();
    const first = await value.orchestrator.enqueue('project-a', value.parallel.id);

    await value.orchestrator.pause(first.id, '稍后继续');
    await waitFor(async () => (await value.executions.findAttempt(first.id))?.status === 'paused');
    expect((await value.domain.projectSnapshot('project-a'))?.tasks.find((task) => task.id === value.parallel.id)?.status).toBe('blocked');

    await value.orchestrator.resume(first.id);
    await waitFor(async () => value.runtime.commands.filter((command) => command.attemptId === first.id).length === 2);
    await value.orchestrator.cancel(first.id, '不再执行');
    await waitFor(async () => (await value.executions.findAttempt(first.id))?.status === 'cancelled');

    const retry = await value.orchestrator.retry(first.id);
    await waitFor(async () => (await value.executions.findAttempt(retry.id))?.status === 'running');
    value.runtime.finish(retry.id, { type: 'failed', error: { code: 'TEST_FAILURE', message: '测试失败', retryable: true } });
    await waitFor(async () => (await value.executions.findAttempt(retry.id))?.status === 'failed');
    expect((await value.executions.findAttempt(retry.id))?.failure).toEqual({ code: 'TEST_FAILURE', message: '测试失败', retryable: true });
    expect(retry).toMatchObject({ attemptNumber: 2, retryOfAttemptId: first.id });

    const eventTypes = (await value.executions.snapshot()).events.filter((event) => event.attemptId === first.id).map((event) => event.type);
    expect(eventTypes).toEqual([
      'attempt_created', 'contract_frozen', 'runtime_starting', 'runtime_started', 'pause_requested', 'paused',
      'resume_requested', 'runtime_starting', 'runtime_started', 'cancel_requested', 'cancelled',
    ]);
  });

  it('keeps an actively cancelled attempt terminal while its retry runs', async () => {
    const value = await fixture();
    await value.orchestrator.activate();
    const cancelled = await value.orchestrator.enqueue('project-a', value.parallel.id);
    await value.orchestrator.cancel(cancelled.id, '用户主动取消');
    await waitFor(async () => (await value.executions.findAttempt(cancelled.id))?.status === 'cancelled');

    const retry = await value.orchestrator.retry(cancelled.id);
    await waitFor(async () => (await value.executions.findAttempt(retry.id))?.status === 'running');
    value.runtime.finish(cancelled.id, { type: 'succeeded' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect((await value.executions.findAttempt(cancelled.id))?.status).toBe('cancelled');
    expect((await value.executions.findAttempt(retry.id))?.status).toBe('running');
    expect(retry).toMatchObject({ attemptNumber: 2, retryOfAttemptId: cancelled.id });
    expect(value.runtime.commands.at(-1)).toMatchObject({ attemptId: retry.id, invocation: { type: 'retry' } });
  });

  it('recovers an interrupted run as paused without automatically restarting it', async () => {
    const value = await fixture();
    await value.orchestrator.activate();
    const attempt = await value.orchestrator.enqueue('project-a', value.parallel.id);
    const cancelling = await value.executions.createAttempt({
      projectId: 'project-a', taskId: value.otherPartner.id, taskRevision: value.otherPartner.revision,
      assigneeId: 'partner-b', permissionMode: 'full', blockedByTaskIds: [],
    });
    await value.executions.transition(cancelling.id, ['queued'], { status: 'cancel_requested', eventType: 'cancel_requested' });
    expect((await value.executions.findAttempt(attempt.id))?.status).toBe('running');

    const restartedStore = new ProjectTaskExecutionStore(value.executionPath);
    const restartedRuntime = new TestRuntime();
    const restarted = new ProjectTaskOrchestrator(restartedStore, value.domain, value.policies, new WriterLeaseCoordinator(), restartedRuntime, value.options);
    await restarted.recover();

    expect((await restartedStore.findAttempt(attempt.id))?.status).toBe('paused');
    expect((await restartedStore.findAttempt(cancelling.id))?.status).toBe('cancelled');
    expect((await restartedStore.snapshot()).events).toContainEqual(expect.objectContaining({ attemptId: attempt.id, type: 'recovered_paused' }));
    expect(restartedRuntime.commands).toEqual([]);

    await restarted.activate();
    expect(restartedRuntime.commands).toEqual([]);
    await restarted.resume(attempt.id);
    expect(restartedRuntime.commands).toHaveLength(1);
    expect(restartedRuntime.commands[0].contract).toEqual(value.runtime.commands[0].contract);
  });

  it('restores the frozen contract and structured handoff from the durable ledger', async () => {
    const value = await fixture('project_workspace');
    await value.orchestrator.activate();
    const attempt = await value.orchestrator.enqueue('project-a', value.parallel.id);
    await submitSuccess(value.orchestrator, attempt.id);
    value.runtime.finish(attempt.id, { type: 'succeeded' });
    await waitFor(async () => (await value.domain.projectSnapshot('project-a'))?.tasks.find((task) => task.id === value.parallel.id)?.status === 'completed');

    const restored = await new ProjectTaskExecutionStore(value.executionPath).findAttempt(attempt.id);
    expect(restored?.contract).toMatchObject({ projectId: 'project-a', taskId: value.parallel.id, completionRule: { type: 'executor_submit' } });
    expect(restored?.handoff).toMatchObject({ disposition: 'submitted', summary: '任务已完成并通过验收。' });
    expect((await value.domain.projectSnapshot('project-a'))?.tasks.find((task) => task.id === value.parallel.id)?.status).toBe('completed');
  });

  it('runs an independent partner review and completes only after every frozen criterion passes', async () => {
    const value = await fixture('project_workspace');
    const task = await value.domain.createTask({
      projectId: 'project-a', title: '独立复核任务', assigneeId: 'partner-a', acceptanceCriteria: ['功能完成', '测试通过'],
      execution: {
        reviewWorkRole: { roleId: 'architecture-audit', roleRevision: 3, name: '架构审计', responsibilities: ['检查边界'], prompt: '只报告可证实风险。', scope: 'project' },
        completionRule: { type: 'partner_review', reviewerPartnerId: 'partner-b', autoReworkLimit: 2 },
      },
    });
    await value.orchestrator.activate();
    const execution = await value.orchestrator.enqueue('project-a', task.id);
    await submitSuccess(value.orchestrator, execution.id, ['r1:c1', 'r1:c2']);
    value.runtime.finish(execution.id, { type: 'succeeded' });

    await waitFor(async () => value.runtime.commands.length === 2);
    const review = value.runtime.commands[1];
    expect(review).toMatchObject({ partnerId: 'partner-b', contract: { purpose: 'review', actorPartnerId: 'partner-b', workRole: { roleId: 'architecture-audit', roleRevision: 3, name: '架构审计' } } });
    expect(review.contract.stageContext).toMatchObject({ type: 'review', reviewRound: 0 });
    expect((await value.domain.projectSnapshot('project-a'))?.tasks.find((item) => item.id === task.id)?.status).toBe('review');

    await value.orchestrator.submitReview(review.attemptId, {
      decision: 'pass', summary: '两项验收标准均有充分证据。',
      criteria: [
        { criterionId: 'r1:c1', verdict: 'pass', evidence: ['功能证据'] },
        { criterionId: 'r1:c2', verdict: 'pass', evidence: ['测试证据'] },
      ],
    });
    value.runtime.finish(review.attemptId, { type: 'succeeded' });
    await waitFor(async () => (value.domain.projectSnapshot('project-a')).then((snapshot) => snapshot?.tasks.find((item) => item.id === task.id)?.status === 'completed'));
    const events = (await value.executions.snapshot('project-a')).events.filter((event) => event.taskId === task.id);
    expect(events.map((event) => event.type)).toContain('workflow_completed');
  });

  it('limits automatic rework to failed criteria, locks passed criteria, and returns to independent review', async () => {
    const value = await fixture('project_workspace');
    const task = await value.domain.createTask({
      projectId: 'project-a', title: '有限返工任务', assigneeId: 'partner-a', acceptanceCriteria: ['接口完成', '测试通过'],
      execution: { completionRule: { type: 'partner_review', reviewerPartnerId: 'partner-b', autoReworkLimit: 2 } },
    });
    await value.orchestrator.activate();
    const execution = await value.orchestrator.enqueue('project-a', task.id);
    await submitSuccess(value.orchestrator, execution.id, ['r1:c1', 'r1:c2']);
    value.runtime.finish(execution.id, { type: 'succeeded' });
    await waitFor(async () => value.runtime.commands.length === 2);

    const firstReview = value.runtime.commands[1];
    await value.orchestrator.submitReview(firstReview.attemptId, {
      decision: 'changes_required', summary: '测试证据不足，需要只补测试项。',
      criteria: [
        { criterionId: 'r1:c1', verdict: 'pass', evidence: ['接口实现证据'] },
        { criterionId: 'r1:c2', verdict: 'fail', evidence: ['失败日志'], feedback: '补齐失败路径测试。' },
      ],
    });
    value.runtime.finish(firstReview.attemptId, { type: 'succeeded' });
    await waitFor(async () => value.runtime.commands.length === 3);

    const rework = value.runtime.commands[2];
    expect(rework).toMatchObject({ partnerId: 'partner-a', contract: { purpose: 'rework', acceptanceCriteria: [{ criterionId: 'r1:c2' }] } });
    expect(rework.contract.stageContext).toMatchObject({
      type: 'rework', reworkRound: 1, failedCriterionIds: ['r1:c2'],
      lockedCriteria: [{ criterionId: 'r1:c1', result: 'satisfied' }],
    });
    await submitSuccess(value.orchestrator, rework.attemptId, ['r1:c2']);
    value.runtime.finish(rework.attemptId, { type: 'succeeded' });
    await waitFor(async () => value.runtime.commands.length === 4);

    const secondReview = value.runtime.commands[3];
    expect(secondReview).toMatchObject({ partnerId: 'partner-b', contract: { purpose: 'review' } });
    expect(secondReview.contract.stageContext).toMatchObject({ type: 'review', reviewRound: 1 });
    await value.orchestrator.submitReview(secondReview.attemptId, {
      decision: 'pass', summary: '返工后全部标准通过。',
      criteria: [
        { criterionId: 'r1:c1', verdict: 'pass', evidence: ['锁定的接口证据'] },
        { criterionId: 'r1:c2', verdict: 'pass', evidence: ['新增测试证据'] },
      ],
    });
    value.runtime.finish(secondReview.attemptId, { type: 'succeeded' });
    await waitFor(async () => (value.domain.projectSnapshot('project-a')).then((snapshot) => snapshot?.tasks.find((item) => item.id === task.id)?.status === 'completed'));
  });

  it('stops after the configured rework limit and lets the user explicitly resolve the gate', async () => {
    const value = await fixture('project_workspace');
    const task = await value.domain.createTask({
      projectId: 'project-a', title: '返工上限任务', assigneeId: 'partner-a', acceptanceCriteria: ['结果正确'],
      execution: { completionRule: { type: 'partner_review', reviewerPartnerId: 'partner-b', autoReworkLimit: 0 } },
    });
    await value.orchestrator.activate();
    const execution = await value.orchestrator.enqueue('project-a', task.id);
    await submitSuccess(value.orchestrator, execution.id, ['r1:c1']);
    value.runtime.finish(execution.id, { type: 'succeeded' });
    await waitFor(async () => value.runtime.commands.length === 2);
    const review = value.runtime.commands[1];
    await value.orchestrator.submitReview(review.attemptId, {
      decision: 'changes_required', summary: '结果仍不正确。',
      criteria: [{ criterionId: 'r1:c1', verdict: 'fail', evidence: ['复核失败'], feedback: '修正结果。' }],
    });
    value.runtime.finish(review.attemptId, { type: 'succeeded' });
    await waitFor(async () => (value.executions.findAttempt(review.attemptId)).then((attempt) => attempt?.status === 'succeeded'));

    expect(value.runtime.commands).toHaveLength(2);
    expect((await value.domain.projectSnapshot('project-a'))?.tasks.find((item) => item.id === task.id)?.status).toBe('review');
    await value.orchestrator.resolveGate({ projectId: 'project-a', taskId: task.id, action: 'accept', feedback: '用户接受当前结果。' });
    expect((await value.domain.projectSnapshot('project-a'))?.tasks.find((item) => item.id === task.id)?.status).toBe('completed');
  });

  it('keeps user-confirm tasks submitted until acceptance and preserves a review stage across restart', async () => {
    const value = await fixture('project_workspace');
    const confirmTask = await value.domain.createTask({
      projectId: 'project-a', title: '用户确认任务', assigneeId: 'partner-a', acceptanceCriteria: ['用户可验收'],
      execution: { completionRule: { type: 'user_confirm' } },
    });
    await value.orchestrator.activate();
    const confirmAttempt = await value.orchestrator.enqueue('project-a', confirmTask.id);
    await submitSuccess(value.orchestrator, confirmAttempt.id, ['r1:c1']);
    value.runtime.finish(confirmAttempt.id, { type: 'succeeded' });
    await waitFor(async () => (value.domain.projectSnapshot('project-a')).then((snapshot) => snapshot?.tasks.find((item) => item.id === confirmTask.id)?.status === 'review'));
    await expect(value.orchestrator.resolveGate({
      projectId: 'project-a', taskId: confirmTask.id, action: 'request_changes', feedback: '只修正验收项。',
    })).rejects.toThrow('TASK_REWORK_CRITERIA_REQUIRED');
    const rework = await value.orchestrator.resolveGate({
      projectId: 'project-a', taskId: confirmTask.id, action: 'request_changes', feedback: '只修正验收项。', affectedCriteria: ['r1:c1'],
    });
    await waitFor(async () => (value.executions.findAttempt(rework.id)).then((attempt) => attempt?.status === 'running'));
    expect(value.runtime.commands.at(-1)).toMatchObject({ attemptId: rework.id, contract: { purpose: 'rework', acceptanceCriteria: [{ criterionId: 'r1:c1' }] } });
    await submitSuccess(value.orchestrator, rework.id, ['r1:c1']);
    value.runtime.finish(rework.id, { type: 'succeeded' });
    await waitFor(async () => (value.executions.findAttempt(rework.id)).then((attempt) => attempt?.status === 'succeeded'));
    await value.orchestrator.resolveGate({ projectId: 'project-a', taskId: confirmTask.id, action: 'accept' });
    expect((await value.domain.projectSnapshot('project-a'))?.tasks.find((item) => item.id === confirmTask.id)?.status).toBe('completed');

    const reviewTask = await value.domain.createTask({
      projectId: 'project-a', title: '重启复核任务', assigneeId: 'partner-a', acceptanceCriteria: ['重启后继续复核'],
      execution: { completionRule: { type: 'partner_review', reviewerPartnerId: 'partner-b', autoReworkLimit: 1 } },
    });
    const execution = await value.orchestrator.enqueue('project-a', reviewTask.id);
    await submitSuccess(value.orchestrator, execution.id, ['r1:c1']);
    value.runtime.finish(execution.id, { type: 'succeeded' });
    await waitFor(async () => value.runtime.commands.some((command) => command.taskId === reviewTask.id && command.contract.purpose === 'review'));
    const runningReview = value.runtime.commands.find((command) => command.taskId === reviewTask.id && command.contract.purpose === 'review')!;
    await value.orchestrator.reconcileProject();

    const restartedStore = new ProjectTaskExecutionStore(value.executionPath);
    const restartedRuntime = new TestRuntime('project_workspace');
    const restarted = new ProjectTaskOrchestrator(restartedStore, value.domain, value.policies, new WriterLeaseCoordinator(), restartedRuntime, value.options);
    await restarted.recover();
    expect((await restartedStore.findAttempt(runningReview.attemptId))?.status).toBe('paused');
    await restarted.activate();
    expect(restartedRuntime.commands).toEqual([]);
    await restarted.resume(runningReview.attemptId, '重启后继续独立复核。');
    expect(restartedRuntime.commands).toHaveLength(1);
    expect(restartedRuntime.commands[0]).toMatchObject({
      attemptId: runningReview.attemptId, partnerId: 'partner-b', invocation: { type: 'resume', reason: '重启后继续独立复核。' },
      contract: { purpose: 'review', stageContext: { type: 'review' } },
    });
  });

  it('repairs a succeeded execution whose review stage was not scheduled before process exit', async () => {
    const value = await fixture('project_workspace');
    const task = await value.domain.createTask({
      projectId: 'project-a', title: '终态修复任务', assigneeId: 'partner-a', acceptanceCriteria: ['复核可恢复'],
      execution: { completionRule: { type: 'partner_review', reviewerPartnerId: 'partner-b', autoReworkLimit: 1 } },
    });
    await value.orchestrator.activate();
    const execution = await value.orchestrator.enqueue('project-a', task.id);
    await submitSuccess(value.orchestrator, execution.id, ['r1:c1']);
    await value.executions.transition(execution.id, ['running'], { status: 'succeeded', eventType: 'succeeded', finished: true });

    const restartedStore = new ProjectTaskExecutionStore(value.executionPath);
    const restartedRuntime = new TestRuntime('project_workspace');
    const restarted = new ProjectTaskOrchestrator(restartedStore, value.domain, value.policies, new WriterLeaseCoordinator(), restartedRuntime, value.options);
    await restarted.recover();

    const recovered = await restartedStore.snapshot('project-a');
    const review = recovered.attempts.find((attempt) => attempt.sourceAttemptId === execution.id);
    expect(review).toMatchObject({ purpose: 'review', actorPartnerId: 'partner-b', status: 'queued', rootAttemptId: execution.id });
    expect((await value.domain.projectSnapshot('project-a'))?.tasks.find((item) => item.id === task.id)?.status).toBe('review');
    await restarted.activate();
    expect(restartedRuntime.commands).toHaveLength(1);
    expect(restartedRuntime.commands[0]).toMatchObject({ attemptId: review?.id, contract: { purpose: 'review' } });
  });

  it('does not retroactively auto-complete historical submitted tasks from before completion-rule orchestration', async () => {
    const value = await fixture('project_workspace');
    const attempt = await value.orchestrator.enqueue('project-a', value.parallel.id);
    const historical = await value.executions.snapshot();
    const stored = historical.attempts.find((item) => item.id === attempt.id)! as unknown as Record<string, unknown>;
    stored.status = 'succeeded';
    delete stored.completionFlowVersion;
    await writeFile(value.executionPath, `${JSON.stringify(historical, null, 2)}\n`, 'utf8');
    await value.domain.setTaskStatusForExecution('project-a', value.parallel.id, 'review');

    const restartedStore = new ProjectTaskExecutionStore(value.executionPath);
    const restartedRuntime = new TestRuntime('project_workspace');
    const restarted = new ProjectTaskOrchestrator(restartedStore, value.domain, value.policies, new WriterLeaseCoordinator(), restartedRuntime, value.options);
    await restarted.recover();
    await restarted.activate();

    expect((await restartedStore.findAttempt(attempt.id))?.completionFlowVersion).toBe(1);
    expect((await restartedStore.snapshot('project-a')).attempts).toHaveLength(1);
    expect((await value.domain.projectSnapshot('project-a'))?.tasks.find((item) => item.id === value.parallel.id)?.status).toBe('review');
    expect(restartedRuntime.commands).toEqual([]);
  });

  it('removes and restores a project execution ledger as one snapshot', async () => {
    const value = await fixture();
    const attempt = await value.orchestrator.enqueue('project-a', value.parallel.id);
    const removed = await value.executions.removeProject('project-a');
    expect(removed.attempts.map((item) => item.id)).toEqual([attempt.id]);
    expect((await value.executions.snapshot()).attempts).toEqual([]);

    await value.executions.restoreProject(removed);
    expect((await value.executions.findAttempt(attempt.id))?.status).toBe('queued');
    expect((await value.executions.snapshot()).events).toHaveLength(1);
  });
});

function taskChatEvent(command: SendMessageCommand, type: 'session.bound' | 'run.completed', sequence: number): PartnerEvent {
  const base = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    eventId: `${type}-${sequence}`,
    partnerId: command.partnerId,
    conversationId: command.conversationId,
    connectionSource: command.connectionSource,
    clientMessageId: command.clientMessageId,
    sessionId: 'session-single-chat',
    runId: 'run-single-chat',
    sequence,
    occurredAt: '2026-10-15T00:00:00.000Z',
  } as const;
  return type === 'session.bound' ? { ...base, type, isNew: true } : { ...base, type, finishReason: 'completed' };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000) {
  const started = Date.now();
  while (!await check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for orchestration state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function submitSuccess(orchestrator: ProjectTaskOrchestrator, attemptId: string, criterionIds: string[] = []) {
  await orchestrator.submitHandoff(attemptId, {
    disposition: 'submitted',
    summary: '任务已完成并通过验收。',
    criterionEvidence: criterionIds.map((criterionId) => ({ criterionId, result: 'satisfied' as const, evidence: [`${criterionId} 已验证`] })),
    changedPaths: [],
    verification: [],
    deliveryRefs: [],
    unresolvedIssues: [],
  });
}
