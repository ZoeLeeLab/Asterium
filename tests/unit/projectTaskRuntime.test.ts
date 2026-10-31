import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectTaskRuntime } from '../../src/main/project/ProjectTaskRuntime';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';
import { StudioRuntimeCatalog } from '../../src/main/studio/StudioRuntimeCatalog';
import type { ProjectTaskRuntimeCommand } from '../../src/main/runtime/PartnerRuntimePort';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type PartnerProfileSeed, type SendMessageCommand } from '../../src/shared/agentProtocol';
import type { TaskAttempt, TaskHandoffSubmission, TaskReviewSubmission } from '../../src/shared/projectTaskExecution';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function seed(kind: 'codex' | 'claude' | 'api'): PartnerProfileSeed {
  const sourceMode = kind === 'api' ? 'api_partner' : 'local_cli';
  return {
    partnerId: `partner-${kind}`,
    sourceMode,
    publicIdentity: { displayName: kind, introduction: '', expertise: '测试', mentionName: kind },
    management: { userProfile: true, personality: true, memoryMode: 'self_managed' },
    personality: '保持简洁。',
    connectionSettings: {
      __studioRuntime: kind === 'api' ? {
        available: true,
        runtime: { kind: 'api', connection: { provider: 'deepseek', endpoint: 'https://api.example.test', model: 'model-a', credentialRef: 'credential-a', workspaceGrantIds: [] } },
      } : {
        available: true,
        runtime: { kind: 'local', adapterType: kind === 'codex' ? 'codex_cli' : 'claude_code', workspaceGrantIds: [] },
      },
    },
  };
}

function taskCommand(partnerId: string, root: string, attemptId = 'attempt-a', taskRevision = 3): ProjectTaskRuntimeCommand {
  return {
    attemptId,
    projectId: 'project-a',
    taskId: 'task-a',
    taskRevision,
    partnerId,
    permissionMode: 'full',
    invocation: { type: 'initial' },
    contract: {
      version: 1, projectId: 'project-a', projectName: '项目 A', projectDescription: '', taskId: 'task-a', taskCode: `TSK-${String(taskRevision).padStart(3, '0')}`, taskRevision,
      purpose: 'execution', actorPartnerId: partnerId,
      title: '真实执行', description: '完成最小闭环', assigneeId: partnerId,
      workRole: { name: '实现工程师', responsibilities: ['实现并验证'], scope: 'inline' },
      acceptanceCriteria: [{ criterionId: `r${taskRevision}:c1`, text: '真实运行完成' }], completionRule: { type: 'executor_submit' }, dependencyHandoffs: [],
      workspace: { projectRoot: root, executionMode: 'shared_serial' }, frozenAt: '2026-10-15T00:00:00.000Z',
    },
  };
}

function event(command: SendMessageCommand, type: 'session.bound' | 'run.completed' | 'run.failed'): PartnerEvent {
  const base = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    eventId: `${type}-a`, partnerId: command.partnerId, conversationId: command.conversationId, connectionSource: command.connectionSource,
    clientMessageId: command.clientMessageId, sessionId: 'workspace-thread-a', runId: 'runtime-run-a', sequence: type === 'session.bound' ? 1 : 2,
    occurredAt: '2026-10-15T00:00:00.000Z', route: command.route,
  } as const;
  if (type === 'session.bound') return { ...base, type, isNew: !command.sessionId };
  if (type === 'run.completed') return { ...base, type, finishReason: 'completed' };
  return { ...base, type, error: { code: 'TEST_FAILED', message: '失败', stage: 'adapter', retryable: true } };
}

describe('ProjectTaskRuntime', () => {
  it.each(['codex', 'claude', 'api'] as const)('uses the same frozen workspace contract and handoff semantics for %s', async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `asterium-task-runtime-${kind}-`));
    temporary.push(root);
    const bindings = new NativeThreadBindingStore(path.join(root, 'bindings.json'));
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: '' }, [seed(kind)]);
    let sent: SendMessageCommand | undefined;
    const startApi = vi.fn(async ({ command }: { command: SendMessageCommand }) => {
      sent = command;
      return { runId: 'runtime-run-a', sessionId: 'workspace-thread-a' };
    });
    const startLocal = vi.fn(async ({ command }: { command: SendMessageCommand }) => {
      sent = command;
      return { runId: 'runtime-run-a', sessionId: 'workspace-thread-a' };
    });
    const submitHandoff = vi.fn(async (attemptId: string, submission: TaskHandoffSubmission): Promise<TaskAttempt> => ({
      version: 1, id: attemptId, projectId: 'project-a', taskId: 'task-a', attemptNumber: 1, taskRevision: 3, completionFlowVersion: 2, assigneeId: `partner-${kind}`,
      purpose: 'execution', actorPartnerId: `partner-${kind}`, rootAttemptId: attemptId, reworkRound: 0,
      permissionMode: 'full', status: 'running', blockedByTaskIds: [], createdAt: '', updatedAt: '',
      handoff: { version: 1, id: 'handoff-a', attemptId, projectId: 'project-a', taskId: 'task-a', taskRevision: 3, submittedAt: '', ...submission },
    }));
    const runtime = new ProjectTaskRuntime({ catalog, bindings, startApi, startLocal, cancelRun: vi.fn(async () => undefined), submitHandoff });
    const handle = await runtime.startProjectTask(taskCommand(`partner-${kind}`, root));
    const command = sent!;

    expect(command).toMatchObject({
      conversationId: `workspace:v1:project-a:partner-${kind}`,
      route: { scope: 'workspace', projectId: 'project-a' },
      execution: { permissionMode: 'full', planMode: 'default' },
    });
    expect(command.content.text).toContain('[冻结任务契约]');
    expect(command.content.text).toContain(root);
    expect(command.content.text).not.toContain('MouseCrew');
    if (kind === 'api') expect(command.apiContext).toEqual({ history: [], apiSessionHistoryEnabled: true });
    expect(kind === 'api' ? startApi : startLocal).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: root }));
    expect(kind === 'api' ? startLocal : startApi).not.toHaveBeenCalled();

    await runtime.validateFirstEvent(event(command, 'session.bound') as Extract<PartnerEvent, { type: 'session.bound' }>, command);
    runtime.recordProjectFile({ clientMessageId: command.clientMessageId, route: command.route }, { fileId: 'file-delivered', relativePath: 'result.md', revision: 1, contentHash: 'a'.repeat(64), sizeBytes: 12 });
    const tools = runtime.toolOptions(command)!;
    expect(await tools.task!({ action: 'context' })).toContain('TSK-003');
    await tools.task!({
      action: 'submit_handoff', disposition: 'submitted', summary: '真实运行完成。',
      criterionEvidence: [{ criterionId: 'r3:c1', result: 'satisfied', evidence: ['测试通过'] }], changedPaths: [], verification: [], deliveryRefs: ['错误的文件路径'], unresolvedIssues: [],
    });
    expect(submitHandoff).toHaveBeenCalledWith('attempt-a', expect.objectContaining({ deliveryRefs: [], fileRefs: [expect.objectContaining({ fileId: 'file-delivered' })] }));

    await runtime.onEvent(event(command, 'run.completed'), command);
    await expect(handle.result).resolves.toEqual({ type: 'succeeded' });
    expect(await bindings.getForScope(`partner-${kind}`, 'workspace', 'project-a')).toMatchObject({
      conversationId: `workspace:v1:project-a:partner-${kind}`, nativeThreadId: 'workspace-thread-a', lastCompletedRunId: 'runtime-run-a', state: 'active',
    });
  });

  it('reuses only the project workspace thread and never a single or group binding', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-task-runtime-reuse-'));
    temporary.push(root);
    const bindings = new NativeThreadBindingStore(path.join(root, 'bindings.json'));
    await bindings.registerSingle({ partnerId: 'partner-codex', source: 'local_cli', conversationId: 'single-a', nativeThreadId: 'single-thread' });
    const group = await bindings.reserve({ partnerId: 'partner-codex', source: 'local_cli', scope: 'group', conversationId: 'group-a', roomId: 'room-a' });
    await bindings.activate(group.bindingId, 'group-thread');
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: '' }, [seed('codex')]);
    const sent: SendMessageCommand[] = [];
    const runtime = new ProjectTaskRuntime({
      catalog, bindings,
      startApi: vi.fn(async () => ({ runId: 'unused', sessionId: 'unused' })),
      startLocal: vi.fn(async ({ command }) => { sent.push(command); return { runId: `run-${sent.length}`, sessionId: 'workspace-thread' }; }),
      cancelRun: vi.fn(async () => undefined),
      submitHandoff: vi.fn(),
    });

    const first = await runtime.startProjectTask(taskCommand('partner-codex', root));
    await runtime.validateFirstEvent(event(sent[0], 'session.bound') as Extract<PartnerEvent, { type: 'session.bound' }>, sent[0]);
    await runtime.onEvent(event(sent[0], 'run.failed'), sent[0]);
    await first.result;
    await runtime.startProjectTask(taskCommand('partner-codex', root, 'attempt-b'));

    expect(sent[0].sessionId).toBeUndefined();
    expect(sent[1].sessionId).toBe('workspace-thread-a');
    expect(sent[1].sessionId).not.toBe('single-thread');
    expect(sent[1].sessionId).not.toBe('group-thread');
  });

  it('keeps a cancelled attempt isolated when its workspace thread is retried and late events arrive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-task-runtime-cancel-retry-'));
    temporary.push(root);
    const bindings = new NativeThreadBindingStore(path.join(root, 'bindings.json'));
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: '' }, [seed('codex')]);
    const sent: SendMessageCommand[] = [];
    const submitHandoff = vi.fn(async (attemptId: string, submission: TaskHandoffSubmission): Promise<TaskAttempt> => {
      if (attemptId === 'attempt-old') throw new Error('TASK_ATTEMPT_NOT_ACCEPTING_HANDOFF');
      return {
        version: 1, id: attemptId, projectId: 'project-a', taskId: 'task-a', attemptNumber: 2, taskRevision: 4, completionFlowVersion: 2, assigneeId: 'partner-codex',
        purpose: 'execution', actorPartnerId: 'partner-codex', rootAttemptId: attemptId, reworkRound: 0,
        permissionMode: 'full', status: 'running', blockedByTaskIds: [], createdAt: '', updatedAt: '',
        handoff: { version: 1, id: 'handoff-new', attemptId, projectId: 'project-a', taskId: 'task-a', taskRevision: 4, submittedAt: '', ...submission },
      };
    });
    const runtime = new ProjectTaskRuntime({
      catalog, bindings,
      startApi: vi.fn(async () => ({ runId: 'unused', sessionId: 'unused' })),
      startLocal: vi.fn(async ({ command }) => { sent.push(command); return { runId: `run-${sent.length}`, sessionId: 'workspace-thread' }; }),
      cancelRun: vi.fn(async () => undefined), submitHandoff,
    });

    const oldHandle = await runtime.startProjectTask(taskCommand('partner-codex', root, 'attempt-old', 3));
    const oldCommand = sent[0];
    await runtime.validateFirstEvent(event(oldCommand, 'session.bound') as Extract<PartnerEvent, { type: 'session.bound' }>, oldCommand);
    const oldTools = runtime.toolOptions(oldCommand)!;
    await oldHandle.cancel('用户主动取消');
    await runtime.onEvent({ ...event(oldCommand, 'run.completed'), type: 'run.cancelled', reason: '用户主动取消' }, oldCommand);
    await expect(oldHandle.result).resolves.toEqual({ type: 'cancelled', reason: '用户主动取消' });

    const newHandle = await runtime.startProjectTask(taskCommand('partner-codex', root, 'attempt-new', 4));
    const newCommand = sent[1];
    const newTools = runtime.toolOptions(newCommand)!;
    expect(await oldTools.task!({ action: 'context' })).toContain('"taskRevision": 3');
    expect(await newTools.task!({ action: 'context' })).toContain('"taskRevision": 4');

    await runtime.onEvent(event(oldCommand, 'run.completed'), oldCommand);
    let newSettled = false;
    void newHandle.result.then(() => { newSettled = true; });
    await Promise.resolve();
    expect(newSettled).toBe(false);

    await expect(oldTools.task!({
      action: 'submit_handoff', disposition: 'submitted', summary: '迟到提交。',
      criterionEvidence: [{ criterionId: 'r3:c1', result: 'satisfied', evidence: [] }], changedPaths: [], verification: [], deliveryRefs: [], unresolvedIssues: [],
    })).rejects.toThrow('TASK_ATTEMPT_NOT_ACCEPTING_HANDOFF');
    runtime.recordProjectFile({ clientMessageId: newCommand.clientMessageId, route: newCommand.route }, { fileId: 'file-new', relativePath: 'workspace-file.md', revision: 2, contentHash: 'b'.repeat(64), sizeBytes: 8 });
    await newTools.task!({
      action: 'submit_handoff', disposition: 'submitted', summary: '新 Attempt 提交。',
      criterionEvidence: [{ criterionId: 'r4:c1', result: 'satisfied', evidence: [] }], changedPaths: [], verification: [], deliveryRefs: ['workspace-file.md'], unresolvedIssues: [],
    });
    expect(submitHandoff).toHaveBeenLastCalledWith('attempt-new', expect.objectContaining({ deliveryRefs: [], fileRefs: [expect.objectContaining({ fileId: 'file-new', revision: 2 })] }));
    await runtime.onEvent(event(newCommand, 'run.completed'), newCommand);
    await expect(newHandle.result).resolves.toEqual({ type: 'succeeded' });
  });

  it('preserves the last structured handoff rejection as the runtime failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-task-runtime-handoff-failure-'));
    temporary.push(root);
    const bindings = new NativeThreadBindingStore(path.join(root, 'bindings.json'));
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: '' }, [seed('api')]);
    let sent!: SendMessageCommand;
    const runtime = new ProjectTaskRuntime({
      catalog, bindings,
      startApi: vi.fn(async ({ command }) => { sent = command; return { runId: 'run-a', sessionId: 'workspace-thread-a' }; }),
      startLocal: vi.fn(), cancelRun: vi.fn(async () => undefined),
      submitHandoff: vi.fn(async () => { throw new Error('TASK_HANDOFF_CRITERIA_INCOMPLETE'); }),
    });
    const handle = await runtime.startProjectTask(taskCommand('partner-api', root));
    const tools = runtime.toolOptions(sent)!;
    await expect(tools.task!({
      action: 'submit_handoff', disposition: 'submitted', summary: '缺少验收项。',
      criterionEvidence: [], changedPaths: [], verification: [], deliveryRefs: [], unresolvedIssues: [],
    })).rejects.toThrow('TASK_HANDOFF_CRITERIA_INCOMPLETE');
    await runtime.onEvent(event(sent, 'run.completed'), sent);
    await expect(handle.result).resolves.toEqual({
      type: 'failed', error: { code: 'TASK_HANDOFF_CRITERIA_INCOMPLETE', message: '结构化 handoff 提交失败：TASK_HANDOFF_CRITERIA_INCOMPLETE', retryable: true },
    });
  });

  it.each([
    { decision: 'pass' as const, outcome: { type: 'succeeded' as const } },
    { decision: 'needs_user_decision' as const, outcome: { type: 'paused' as const, reason: '是否接受当前证据？' } },
  ])('uses submit_review for review stages and maps $decision to the expected runtime outcome', async ({ decision, outcome }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `asterium-task-review-${decision}-`));
    temporary.push(root);
    const bindings = new NativeThreadBindingStore(path.join(root, 'bindings.json'));
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: '' }, [seed('claude')]);
    let sent!: SendMessageCommand;
    const submitReview = vi.fn(async (attemptId: string, submission: TaskReviewSubmission): Promise<TaskAttempt> => ({
      version: 1, id: attemptId, projectId: 'project-a', taskId: 'task-a', attemptNumber: 2, taskRevision: 3, completionFlowVersion: 2,
      purpose: 'review', assigneeId: 'partner-codex', actorPartnerId: 'partner-claude', rootAttemptId: 'attempt-root', sourceAttemptId: 'attempt-root', reworkRound: 0,
      permissionMode: 'full', status: 'running', blockedByTaskIds: [], createdAt: '', updatedAt: '',
      review: {
        version: 1, id: 'review-a', attemptId, projectId: 'project-a', taskId: 'task-a', taskRevision: 3, submittedAt: '', ...submission,
      },
    }));
    const runtime = new ProjectTaskRuntime({
      catalog, bindings,
      startApi: vi.fn(async () => ({ runId: 'unused', sessionId: 'unused' })),
      startLocal: vi.fn(async ({ command }) => { sent = command; return { runId: 'review-run', sessionId: 'review-thread' }; }),
      cancelRun: vi.fn(async () => undefined), submitHandoff: vi.fn(), submitReview,
    });
    const base = taskCommand('partner-claude', root, `attempt-${decision}`);
    const command: ProjectTaskRuntimeCommand = {
      ...base,
      partnerId: 'partner-claude',
      contract: {
        ...base.contract, purpose: 'review', actorPartnerId: 'partner-claude', assigneeId: 'partner-codex',
        workRole: { name: '独立复核', responsibilities: ['只按冻结标准检查'], scope: 'inline' },
        completionRule: { type: 'partner_review', reviewerPartnerId: 'partner-claude', autoReworkLimit: 2 },
        stageContext: { type: 'review', reviewRound: 0, candidateHandoffs: [] },
      },
    };
    const handle = await runtime.startProjectTask(command);
    expect(sent.content.text).toContain('asterium_task(action=submit_review)');
    expect(sent.content.text).toContain('不修改文件、代码、任务契约或交付物');
    const tools = runtime.toolOptions(sent)!;
    await expect(tools.task!({
      action: 'submit_handoff', disposition: 'submitted', summary: '错误动作', criterionEvidence: [], changedPaths: [], verification: [], deliveryRefs: [], unresolvedIssues: [],
    })).rejects.toThrow('TASK_HANDOFF_STAGE_INVALID');
    await tools.task!({
      action: 'submit_review', decision, summary: decision === 'pass' ? '复核通过。' : '需要用户决定。',
      criteria: [{ criterionId: 'r3:c1', verdict: decision === 'pass' ? 'pass' : 'unverified', evidence: ['复核证据'] }],
      ...(decision === 'needs_user_decision' ? { userDecisionRequest: { question: '是否接受当前证据？', reason: '范围存在歧义。', affectedCriteria: ['r3:c1'] } } : {}),
    });
    expect(submitReview).toHaveBeenCalledWith(command.attemptId, expect.objectContaining({ decision }));
    expect(submitReview.mock.calls[0][1]).not.toHaveProperty('action');
    await runtime.onEvent(event(sent, 'run.completed'), sent);
    await expect(handle.result).resolves.toEqual(outcome);
  });
});
