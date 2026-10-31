import { describe, expect, it, vi } from 'vitest';
import type { PartnerProfileSeed } from '../../src/shared/agentProtocol';
import type { StudioPreparedTurn } from '../../src/shared/studioRuntime';
import { PartnerRuntimePort, type PartnerRuntimePortDependencies } from '../../src/main/runtime/PartnerRuntimePort';
import { StudioRuntimeCatalog } from '../../src/main/studio/StudioRuntimeCatalog';

const prepared: StudioPreparedTurn = {
  room: { roomId: 'room-one', projectId: 'project-one', name: '讨论组', memberIds: ['partner-one'] },
  round: {
    roundId: 'round-one', roomId: 'room-one', triggerMessageId: 'message-one', speakerQueue: ['partner-one'],
    members: [{ turnId: 'turn-one', partnerId: 'partner-one', state: 'running' }], state: 'running', currentPartnerId: 'partner-one', participantIds: ['partner-one'],
    permissionMode: 'full', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z',
  },
  settings: { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false },
  mutedPartnerIds: [],
  conversationId: 'group:v3:room-one:partner-one',
  bindingGeneration: 1,
  inputThroughSeq: 1,
  processedAfterSeq: 0,
  messages: [],
  models: {},
};

function seed(kind: 'api' | 'local'): PartnerProfileSeed {
  return {
    partnerId: 'partner-one',
    sourceMode: kind === 'api' ? 'api_partner' : 'local_cli',
    publicIdentity: { displayName: '伙伴', introduction: '', expertise: '', mentionName: '伙伴' },
    management: { userProfile: true, personality: true, memoryMode: 'self_managed' },
    personality: '人设',
    connectionSettings: {
      __studioRuntime: kind === 'api' ? {
        available: true,
        defaultPermissionMode: 'manual',
        runtime: { kind: 'api', connection: { provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', credentialRef: 'credential-one', workspaceGrantIds: [] } },
      } : {
        available: true,
        defaultPermissionMode: 'manual',
        runtime: { kind: 'local', adapterType: 'codex_cli', partnerRootGrantId: 'root-one', workspaceGrantIds: ['extra-one'], codexRuntimeId: 'runtime-one', codexRuntimeEnvironment: 'global_cli' },
      },
    },
  };
}

describe('PartnerRuntimePort', () => {
  it('keeps workspace task execution on the same port without adding a prompt payload', async () => {
    const startProjectTask = vi.fn<NonNullable<PartnerRuntimePortDependencies['startProjectTask']>>(async () => ({
      runId: 'task-run-one',
      result: Promise.resolve({ type: 'succeeded' }),
      pause: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    }));
    const port = new PartnerRuntimePort({
      prepareTurn: vi.fn(async () => prepared),
      startApi: vi.fn(async () => ({ runId: 'run-api', sessionId: 'session-api' })),
      startLocal: vi.fn(async () => ({ runId: 'run-local', sessionId: 'session-local' })),
      cancelRun: vi.fn(async () => undefined),
      startProjectTask,
    });
    const command = {
      attemptId: 'attempt-one', projectId: 'project-one', taskId: 'task-one', taskRevision: 3,
      partnerId: 'partner-one', permissionMode: 'full' as const,
      contract: {
        version: 1 as const, projectId: 'project-one', projectName: '项目', projectDescription: '', taskId: 'task-one', taskCode: 'TSK-001', taskRevision: 3,
        purpose: 'execution' as const, actorPartnerId: 'partner-one',
        title: '任务', description: '', assigneeId: 'partner-one', workRole: { name: '执行者', responsibilities: ['完成任务'], scope: 'inline' as const },
        acceptanceCriteria: [], completionRule: { type: 'executor_submit' as const }, dependencyHandoffs: [],
        workspace: { projectRoot: 'K:\\project', executionMode: 'shared_serial' as const }, frozenAt: '2026-10-15T00:00:00.000Z',
      },
      invocation: { type: 'initial' as const },
    };

    await expect(port.startProjectTask(command)).resolves.toMatchObject({ runId: 'task-run-one' });
    expect(startProjectTask).toHaveBeenCalledWith(command);
    expect(startProjectTask.mock.calls[0][0]).not.toHaveProperty('content');
    expect(startProjectTask.mock.calls[0][0]).not.toHaveProperty('prompt');
  });

  it.each(['api', 'local'] as const)('keeps Studio source selection inside the unified runtime port for %s partners', async (kind) => {
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: '' }, [seed(kind)]);
    const partner = catalog.partner('partner-one')!;
    const startApi = vi.fn<PartnerRuntimePortDependencies['startApi']>(async () => ({ runId: 'run-api', sessionId: 'session-api' }));
    const startLocal = vi.fn<PartnerRuntimePortDependencies['startLocal']>(async () => ({ runId: 'run-local', sessionId: 'session-local' }));
    const prepareTurn = vi.fn(async () => prepared);
    const cancelRun = vi.fn(async () => undefined);
    const port = new PartnerRuntimePort({ prepareTurn, startApi, startLocal, cancelRun });

    await expect(port.prepareStudioTurn(partner, 'room-one', 'round-one')).resolves.toBe(prepared);
    const receipt = await port.startStudioTurn({ partner, prepared, content: '公开群聊内容', context: { partner: { displayName: '伙伴', introduction: '', expertise: '', mentionName: '伙伴', avatarAvailable: false }, runtime: partner.runtimeContext } });

    expect(receipt.runId).toBe(kind === 'api' ? 'run-api' : 'run-local');
    expect(startApi).toHaveBeenCalledTimes(kind === 'api' ? 1 : 0);
    expect(startLocal).toHaveBeenCalledTimes(kind === 'local' ? 1 : 0);
    const call = kind === 'api' ? startApi.mock.calls[0]![0] : startLocal.mock.calls[0]![0];
    expect(call.command).toMatchObject({
      partnerId: 'partner-one',
      conversationId: prepared.conversationId,
      route: { scope: 'group', roomId: 'room-one', roundId: 'round-one', bindingGeneration: 1, inputThroughSeq: 1 },
      content: { type: 'text', text: '公开群聊内容' },
      execution: { permissionMode: 'full', planMode: 'default' },
    });
    if (kind === 'api') {
      expect(call.command.apiContext).toMatchObject({ apiSessionHistoryEnabled: true });
      expect(call.command.apiContext).not.toHaveProperty('systemPrompt');
      await port.startStudioTurn({ partner, prepared: { ...prepared, nativeThreadId: 'session-api' }, content: '后续公开群聊内容', context: { partner: { displayName: '伙伴', introduction: '', expertise: '', mentionName: '伙伴', avatarAvailable: false }, runtime: partner.runtimeContext } });
      expect(startApi.mock.calls[1][0].command.apiContext).toMatchObject({ apiSessionHistoryEnabled: true });
      expect(startApi.mock.calls[1][0].command.apiContext).not.toHaveProperty('systemPrompt');
    }

    await port.cancelRun({
      partner,
      conversationId: prepared.conversationId,
      runId: receipt.runId,
      sessionId: receipt.sessionId,
      route: { scope: 'group', roomId: 'room-one', roundId: 'round-one', bindingGeneration: 1, inputThroughSeq: 1 },
    }, '用户取消');
    expect(cancelRun).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: 'partner-one',
      connectionSource: kind === 'api' ? 'api_partner' : 'local_cli',
      conversationId: prepared.conversationId,
      runId: receipt.runId,
      sessionId: receipt.sessionId,
    }));
  });
});
