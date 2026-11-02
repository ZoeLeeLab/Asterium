import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectWorkflowGenerationRuntime } from '../../src/main/project/ProjectWorkflowGenerationRuntime';
import { ProjectWorkflowGenerationStore } from '../../src/main/project/ProjectWorkflowGenerationStore';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';
import { StudioRuntimeCatalog } from '../../src/main/studio/StudioRuntimeCatalog';
import type { SendMessageCommand } from '../../src/shared/agentProtocol';
import type { StudioRoomSnapshot } from '../../src/shared/studioRuntime';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-workflow-generation-runtime-'));
  temporary.push(root);
  const generations = new ProjectWorkflowGenerationStore(path.join(root, 'generations.json'));
  const bindings = new NativeThreadBindingStore(path.join(root, 'bindings.json'));
  const catalog = new StudioRuntimeCatalog();
  catalog.sync({ displayName: '用户', introduction: '', updatedAt: '' }, [{
    partnerId: 'planner-a', sourceMode: 'api_partner', publicIdentity: { displayName: '规划伙伴', introduction: '负责整理', expertise: '规划', mentionName: '规划伙伴' },
    management: { userProfile: true, personality: true, memoryMode: 'asterium' }, personality: '保持简洁。',
    connectionSettings: { __studioRuntime: { available: true, runtime: { kind: 'api', connection: { provider: 'deepseek', endpoint: 'https://api.example.test', model: 'model-a', credentialRef: 'credential-a', workspaceGrantIds: [] } } } },
  }]);
  const room: StudioRoomSnapshot = {
    metadata: { roomId: 'room-a', projectId: 'project-a', name: '公开讨论', memberIds: ['planner-a'] },
    messages: [
      { roomId: 'room-a', messageId: 'message-1', seq: 1, roundId: 'round-a', authorType: 'user', authorId: 'user-a', content: '核心目标', createdAt: '2026-10-16T00:00:00.000Z', status: 'completed' },
      { roomId: 'room-a', messageId: 'message-2', seq: 2, roundId: 'round-a', authorType: 'partner', authorId: 'planner-a', content: '不要被选择的内容', createdAt: '2026-10-16T00:01:00.000Z', status: 'completed' },
      { roomId: 'room-a', messageId: 'message-3', seq: 3, roundId: 'round-a', authorType: 'partner', authorId: 'planner-a', content: '讨论总结', createdAt: '2026-10-16T00:02:00.000Z', status: 'completed' },
    ], cursors: [], mutedPartnerIds: [], settings: { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: true }, rotationOffset: 0, models: {},
  };
  const commands: SendMessageCommand[] = [];
  const createWorkflow = vi.fn(async () => ({ id: 'workflow-a', revision: 1 }));
  const cancelRun = vi.fn(async () => undefined);
  const workflowForGeneration = vi.fn(async (generationId: string) => {
    void generationId;
    return undefined as { id: string } | undefined;
  });
  const startApi = vi.fn(async ({ command }: { command: SendMessageCommand }) => {
    commands.push(command);
    return { runId: 'run-a', sessionId: 'planning-thread-a' };
  });
  const runtime = new ProjectWorkflowGenerationRuntime({
    generations, bindings, catalog, rooms: { getRoom: vi.fn(async () => room) },
    project: vi.fn(async () => ({ id: 'project-a', name: '项目 A', description: '项目说明', memberIds: ['planner-a'] })),
    roles: vi.fn(async () => ({ version: 1 as const, projectId: 'project-a', roles: [] })),
    workflowCatalog: vi.fn(async () => ({ version: 1 as const, templates: [], methods: [] })),
    createWorkflow, workflowForGeneration, startApi,
    startLocal: vi.fn(async () => ({ runId: 'unused', sessionId: 'unused' })), cancelRun, planningRoot: vi.fn(async () => root),
  });
  return { runtime, generations, bindings, commands, createWorkflow, workflowForGeneration, startApi, cancelRun };
}

describe('ProjectWorkflowGenerationRuntime', () => {
  it('freezes arbitrary selected public messages in ledger order and saves only through the structured tool', async () => {
    const { runtime, commands, createWorkflow } = await fixture();
    const generation = await runtime.start({ requestId: 'request-a', projectId: 'project-a', roomId: 'room-a', plannerPartnerId: 'planner-a', messageIds: ['message-3', 'message-1'] });
    const command = commands[0];

    expect(generation.sourceMessages.map((message) => message.messageId)).toEqual(['message-1', 'message-3']);
    expect(command.route).toMatchObject({ scope: 'workflow_planning', projectId: 'project-a', roomId: 'room-a', generationId: generation.id });
    expect(command.execution).toEqual({ permissionMode: 'read_only', planMode: 'default' });
    expect(command.apiContext).toEqual({ history: [], apiSessionHistoryEnabled: false });
    expect(command.content.text).toContain('核心目标');
    expect(command.content.text).toContain('讨论总结');
    expect(command.content.text).not.toContain('不要被选择的内容');
    expect(command.content.text).toContain('trust="untrusted"');

    const tool = runtime.toolOptions(command)?.workflowDraft;
    expect(tool).toBeTypeOf('function');
    const result = await tool!({
      name: '讨论草稿', description: '可编辑草稿', generationSummary: '根据两条公开消息整理。',
      nodes: [{ clientKey: 'step-a', title: '实现目标', description: '只完成目标', assigneePartnerId: 'planner-a', dependencyKeys: [], acceptanceCriteria: ['目标完成'], completionRule: { type: 'executor_submit' }, sourceMessageIds: ['message-1', 'message-3'] }],
    });
    expect(JSON.parse(result)).toMatchObject({ saved: true, workflowId: 'workflow-a', status: 'draft' });
    expect(createWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      generationId: generation.id,
      sourceMessages: [expect.objectContaining({ messageId: 'message-1', seq: 1 }), expect.objectContaining({ messageId: 'message-3', seq: 3 })],
    }));
    expect((await runtime.listProject('project-a'))[0]).toMatchObject({ status: 'submitted', workflowId: 'workflow-a' });
  });

  it('starts at most one runtime for repeated concurrent request ids', async () => {
    const { runtime, startApi } = await fixture();
    const request = { requestId: 'request-race', projectId: 'project-a', roomId: 'room-a', plannerPartnerId: 'planner-a', messageIds: ['message-1'] };
    const [left, right] = await Promise.all([runtime.start(request), runtime.start(request)]);
    expect(left.id).toBe(right.id);
    expect(startApi).toHaveBeenCalledTimes(1);
  });

  it('rejects missing or cross-ledger message ids before a runtime starts', async () => {
    const { runtime, startApi } = await fixture();
    await expect(runtime.start({ requestId: 'request-invalid', projectId: 'project-a', roomId: 'room-a', plannerPartnerId: 'planner-a', messageIds: ['private-message'] })).rejects.toThrow('PROJECT_WORKFLOW_GENERATION_SOURCE_INVALID');
    expect(startApi).not.toHaveBeenCalled();
  });

  it('keeps a cancelled generation immutable while retry gets a fresh planning route', async () => {
    const { runtime, commands, cancelRun } = await fixture();
    const old = await runtime.start({ requestId: 'request-old', projectId: 'project-a', roomId: 'room-a', plannerPartnerId: 'planner-a', messageIds: ['message-1'] });
    const oldCommand = commands[0];
    await runtime.cancel({ projectId: 'project-a', generationId: old.id });
    expect(cancelRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-a', route: expect.objectContaining({ generationId: old.id }) }));

    await runtime.onEvent({ type: 'run.completed' } as never, oldCommand);
    expect((await runtime.listProject('project-a')).find((item) => item.id === old.id)?.status).toBe('cancelled');
    await expect(runtime.toolOptions(oldCommand)?.workflowDraft({ name: '迟到', description: '', generationSummary: '迟到', nodes: [] })).rejects.toThrow('PROJECT_WORKFLOW_GENERATION_ROUTE_MISMATCH');

    const retried = await runtime.retry({ projectId: 'project-a', generationId: old.id, requestId: 'request-retry' });
    expect(retried.id).not.toBe(old.id);
    expect(commands[1].route).toMatchObject({ scope: 'workflow_planning', generationId: retried.id });
    expect(commands[1].route).not.toEqual(oldCommand.route);
  });

  it('reconciles a saved draft before interrupting still-running generations on restart', async () => {
    const { runtime, workflowForGeneration } = await fixture();
    const generation = await runtime.start({ requestId: 'request-recover', projectId: 'project-a', roomId: 'room-a', plannerPartnerId: 'planner-a', messageIds: ['message-1'] });
    workflowForGeneration.mockImplementation(async (generationId: string) => generationId === generation.id ? { id: 'workflow-recovered' } : undefined);

    await runtime.recover();

    expect((await runtime.listProject('project-a')).find((item) => item.id === generation.id)).toMatchObject({ status: 'submitted', workflowId: 'workflow-recovered' });
  });
});
