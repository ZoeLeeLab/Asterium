import { describe, expect, it, vi } from 'vitest';
import type { PartnerProfileSeed } from '../../src/shared/agentProtocol';
import type { StudioPreparedTurn, StudioRoomSnapshot } from '../../src/shared/studioRuntime';
import type { StudioRuntimeLifecyclePort } from '../../src/main/runtime/PartnerRuntimePort';
import { StudioOrchestrator } from '../../src/main/studio/StudioOrchestrator';
import { StudioRuntimeCatalog } from '../../src/main/studio/StudioRuntimeCatalog';
import { ProjectMutationCoordinator } from '../../src/main/project/ProjectMutationCoordinator';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';

const createdAt = '2026-10-13T00:00:00.000Z';

function localSeed(partnerId = 'partner-local', displayName = '外部伙伴'): PartnerProfileSeed {
  return {
    partnerId,
    sourceMode: 'local_cli',
    publicIdentity: { displayName, introduction: '伙伴介绍', expertise: '编码', mentionName: displayName },
    management: { userProfile: true, personality: true, memoryMode: 'self_managed' },
    personality: '温和而严谨',
    systemPrompt: '长期稳定指令',
    connectionSettings: {
      adapterType: 'codex_cli',
      __studioRuntime: {
        available: true,
        defaultPermissionMode: 'manual',
        runtime: { kind: 'local', adapterType: 'codex_cli', partnerRootGrantId: 'root-one', workspaceGrantIds: ['extra-one'], codexRuntimeId: 'runtime-one', codexRuntimeEnvironment: 'global_cli' },
      },
    },
  };
}

function queuedSnapshot(): StudioRoomSnapshot {
  return {
    metadata: { roomId: 'room-one', projectId: 'project-one', name: '主讨论组', memberIds: ['partner-local'] },
    messages: [{ roomId: 'room-one', messageId: 'message-one', seq: 1, roundId: 'round-one', authorType: 'user', authorId: ASTERIUM_USER_ID, content: '请讨论', createdAt, status: 'completed' }],
    cursors: [],
    activeRound: {
      roundId: 'round-one', roomId: 'room-one', triggerMessageId: 'message-one', speakerQueue: ['partner-local'],
      members: [{ turnId: 'turn-one', partnerId: 'partner-local', state: 'queued' }], state: 'queued', participantIds: ['partner-local'], permissionMode: 'manual', createdAt, updatedAt: createdAt,
    },
    mutedPartnerIds: [],
    settings: { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false },
    rotationOffset: 0,
    models: {},
  };
}

describe('Main StudioOrchestrator', () => {
  it.each([
    {
      label: 'round robin rotation',
      settings: { speakingMode: 'round_robin' as const, selectedPartnerIds: [], discussionProtectionEnabled: false },
      rotationOffset: 1,
      mentions: [],
      expected: ['partner-b', 'partner-c', 'partner-a'],
    },
    {
      label: 'selected partners',
      settings: { speakingMode: 'selected_partners' as const, selectedPartnerIds: ['partner-c', 'partner-a'], discussionProtectionEnabled: false },
      rotationOffset: 0,
      mentions: [],
      expected: ['partner-c', 'partner-a'],
    },
    {
      label: 'free discussion mention',
      settings: { speakingMode: 'free_discussion' as const, selectedPartnerIds: [], discussionProtectionEnabled: true },
      rotationOffset: 0,
      mentions: [{ partnerId: 'partner-b', label: '小B', source: 'user' as const }],
      expected: ['partner-b'],
    },
  ])('owns $label queue selection', async ({ settings, rotationOffset, mentions, expected }) => {
    const metadata = { roomId: 'room-queue', projectId: 'project-one', name: '队列讨论组', memberIds: ['partner-a', 'partner-b', 'partner-c'] };
    const resting: StudioRoomSnapshot = { metadata, messages: [], cursors: [], mutedPartnerIds: [], settings, rotationOffset, models: {} };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: createdAt }, [localSeed('partner-a', '小A'), localSeed('partner-b', '小B'), localSeed('partner-c', '小C')]);
    const rooms = {
      getRoom: vi.fn(async () => resting),
      publishUserMessage: vi.fn(async () => resting),
      cancelRound: vi.fn(async () => resting),
      failPreparedTurn: vi.fn(async () => resting),
    };
    const runtime: StudioRuntimeLifecyclePort = { prepareStudioTurn: vi.fn(), startStudioTurn: vi.fn(), cancelRun: vi.fn() };
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime);

    await orchestrator.startRound({ room: metadata, messageId: 'message-one', content: '请讨论', authorId: ASTERIUM_USER_ID, speakerQueue: ['renderer-candidate'], ...(mentions.length ? { mentions } : {}) });
    expect(rooms.publishUserMessage).toHaveBeenCalledWith(expect.objectContaining({ speakerQueue: expected, ...(mentions.length ? { mentions } : {}) }), 'manual');
  });

  it('captures the Main-owned project permission once when a round starts', async () => {
    const metadata = { roomId: 'room-policy', projectId: 'project-one', name: '权限群聊', memberIds: ['partner-local'] };
    const resting: StudioRoomSnapshot = {
      metadata, messages: [], cursors: [], mutedPartnerIds: [],
      settings: { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false },
      rotationOffset: 0, models: {},
    };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: createdAt }, [localSeed()]);
    const rooms = {
      getRoom: vi.fn(async () => resting), publishUserMessage: vi.fn(async () => resting),
      cancelRound: vi.fn(async () => resting), failPreparedTurn: vi.fn(async () => resting),
    };
    const runtime: StudioRuntimeLifecyclePort = { prepareStudioTurn: vi.fn(), startStudioTurn: vi.fn(), cancelRun: vi.fn() };
    const executionPolicies = { getOrCreate: vi.fn(async () => ({ version: 1 as const, projectId: 'project-one', permissionMode: 'full' as const, updatedAt: createdAt })) };
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime, undefined, executionPolicies);

    await orchestrator.startRound({ room: metadata, messageId: 'message-policy', content: '执行任务', authorId: ASTERIUM_USER_ID, speakerQueue: [] });

    expect(executionPolicies.getOrCreate).toHaveBeenCalledWith('project-one');
    expect(rooms.publishUserMessage).toHaveBeenCalledWith(expect.any(Object), 'full');
  });

  it('does not recreate a room after its project deletion commits', async () => {
    const metadata = { roomId: 'room-deleted', projectId: 'project-deleted', name: '已删除项目群聊', memberIds: ['partner-local'] };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: createdAt }, [localSeed()]);
    const rooms = {
      getRoom: vi.fn(async () => undefined),
      publishUserMessage: vi.fn(),
      cancelRound: vi.fn(),
      failPreparedTurn: vi.fn(),
    };
    const runtime: StudioRuntimeLifecyclePort = { prepareStudioTurn: vi.fn(), startStudioTurn: vi.fn(), cancelRun: vi.fn() };
    const coordinator = new ProjectMutationCoordinator();
    coordinator.markProjectDeleted(metadata.projectId);
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime, coordinator);

    await expect(orchestrator.startRound({
      room: metadata, messageId: 'message-deleted', content: '不应重新开始', authorId: ASTERIUM_USER_ID, speakerQueue: [],
    })).rejects.toThrow('PROJECT_REMOVED');
    expect(rooms.publishUserMessage).not.toHaveBeenCalled();
  });

  it('keeps the Main room membership authoritative when a stale start request arrives', async () => {
    const canonical = { roomId: 'room-one', projectId: 'project-one', name: '权威群聊名', memberIds: ['partner-local'] };
    const snapshot: StudioRoomSnapshot = {
      metadata: canonical, messages: [], cursors: [], mutedPartnerIds: [],
      settings: { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false },
      rotationOffset: 0, models: {},
    };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: createdAt }, [localSeed(), localSeed('partner-stale', '旧成员')]);
    const rooms = {
      getRoom: vi.fn(async () => snapshot),
      publishUserMessage: vi.fn(async () => snapshot),
      cancelRound: vi.fn(async () => snapshot),
      failPreparedTurn: vi.fn(async () => snapshot),
    };
    const runtime: StudioRuntimeLifecyclePort = { prepareStudioTurn: vi.fn(), startStudioTurn: vi.fn(), cancelRun: vi.fn() };
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime, new ProjectMutationCoordinator());

    await orchestrator.startRound({
      room: { ...canonical, name: '旧群聊名', memberIds: ['partner-local', 'partner-stale'] },
      messageId: 'message-stale', content: '使用当前成员', authorId: ASTERIUM_USER_ID, speakerQueue: [],
    });

    expect(rooms.publishUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      room: canonical, speakerQueue: ['partner-local'],
    }), 'manual');
  });

  it('starts the next canonical queued turn through one runtime lifecycle port', async () => {
    const queued = queuedSnapshot();
    const prepared: StudioPreparedTurn = {
      room: queued.metadata,
      round: { ...queued.activeRound!, state: 'running', currentPartnerId: 'partner-local', members: [{ ...queued.activeRound!.members[0], state: 'running', inputThroughSeq: 1, bindingGeneration: 1, conversationId: 'group:v3:room-one:partner-local' }] },
      settings: queued.settings,
      mutedPartnerIds: [],
      conversationId: 'group:v3:room-one:partner-local',
      bindingGeneration: 1,
      inputThroughSeq: 1,
      processedAfterSeq: 0,
      messages: queued.messages,
      models: {},
    };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '用户介绍', updatedAt: createdAt }, [localSeed()]);
    const rooms = {
      getRoom: vi.fn(async () => queued),
      publishUserMessage: vi.fn(async () => queued),
      cancelRound: vi.fn(async () => ({ ...queued, activeRound: { ...queued.activeRound!, state: 'cancelled' as const } })),
      failPreparedTurn: vi.fn(async () => queued),
    };
    const runtime: StudioRuntimeLifecyclePort = {
      prepareStudioTurn: vi.fn(async () => prepared),
      startStudioTurn: vi.fn(async () => ({ runId: 'run-one', sessionId: 'session-one' })),
      cancelRun: vi.fn(async () => undefined),
    };
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime);

    orchestrator.handleSnapshot(queued);
    await vi.waitFor(() => expect(runtime.startStudioTurn).toHaveBeenCalledTimes(1));

    expect(runtime.prepareStudioTurn).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'partner-local', available: true }), 'room-one', 'round-one');
    expect(runtime.startStudioTurn).toHaveBeenCalledWith(expect.objectContaining({
      partner: expect.objectContaining({ partnerId: 'partner-local' }),
      prepared,
      content: expect.stringContaining('你本次需要处理的公开群聊增量：'),
      context: expect.objectContaining({
        partner: expect.objectContaining({ displayName: '外部伙伴', personality: '温和而严谨' }),
        runtime: { source: 'local_cli', adapter: 'codex_cli' },
        conversation: { title: '主讨论组', studio: expect.objectContaining({ roomId: 'room-one', projectId: 'project-one', explicitDeliveryTarget: 'room_project', passAllowed: false }) },
      }),
    }));
    expect(runtime.startStudioTurn).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.not.stringContaining('<asterium_group_pass'),
    }));
    const firstContent = vi.mocked(runtime.startStudioTurn).mock.calls[0][0].content;
    expect(firstContent).not.toContain('你在星丛中的名字：外部伙伴');
    expect(firstContent).not.toContain('你的星丛代管设定');
    expect(firstContent).not.toContain('你的星丛代管稳定指令');
    expect(firstContent).not.toContain('当前用户：用户｜用户介绍');
    expect(firstContent).not.toContain('当前群聊初始成员（名字｜@名称｜partnerId）');
    expect(firstContent).not.toContain('外部伙伴｜partner-local');
    expect(firstContent).not.toContain('伙伴介绍');
    expect(firstContent).not.toContain('编码');
    expect(firstContent).not.toContain('当前或最近模型');
    expect(firstContent).toContain('你本次需要处理的公开群聊增量：');
    expect(firstContent).not.toContain('mention_partner');
    expect(firstContent).toContain('伙伴名字[消息序号]');
  });

  it('omits the current partner own public reply and bootstrap identity on later group turns', async () => {
    const queued = queuedSnapshot();
    const prepared: StudioPreparedTurn = {
      room: queued.metadata,
      round: { ...queued.activeRound!, state: 'running', currentPartnerId: 'partner-local', members: [{ ...queued.activeRound!.members[0], state: 'running', inputThroughSeq: 1, bindingGeneration: 1, conversationId: 'group:v3:room-one:partner-local' }] },
      settings: queued.settings,
      mutedPartnerIds: [],
      conversationId: 'group:v3:room-one:partner-local',
      bindingGeneration: 1,
      nativeThreadId: 'native-thread-one',
      previousSpeakingMode: 'round_robin',
      inputThroughSeq: 1,
      processedAfterSeq: 0,
      messages: [
        ...queued.messages,
        {
          roomId: queued.metadata.roomId,
          messageId: 'partner-message-one',
          seq: 2,
          roundId: queued.activeRound!.roundId,
          authorType: 'partner',
          authorId: 'partner-local',
          content: '这是我上一轮的回复',
          createdAt,
          status: 'completed',
        },
      ],
      models: {},
    };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: 'Test user', introduction: '用户介绍', updatedAt: createdAt }, [localSeed()]);
    const rooms = {
      getRoom: vi.fn(async () => queued), publishUserMessage: vi.fn(async () => queued), cancelRound: vi.fn(async () => queued), failPreparedTurn: vi.fn(async () => queued),
    };
    const runtime: StudioRuntimeLifecyclePort = {
      prepareStudioTurn: vi.fn(async () => prepared),
      startStudioTurn: vi.fn(async () => ({ runId: 'run-later', sessionId: 'native-thread-one' })),
      cancelRun: vi.fn(async () => undefined),
    };
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime);

    orchestrator.handleSnapshot(queued);
    await vi.waitFor(() => expect(runtime.startStudioTurn).toHaveBeenCalledTimes(1));
    const content = vi.mocked(runtime.startStudioTurn).mock.calls[0][0].content;
    expect(content).toContain('[1] Test user（用户）：请讨论');
    expect(content).not.toContain('你本次需要处理的公开群聊增量：');
    expect(content).not.toContain('（self）');
    expect(content).not.toContain('这是我上一轮的回复');
    expect(content).not.toContain('你此前发出的公开回复');
    expect(content).not.toContain('当前发言模式：逐一回应');
    expect(content).not.toContain('asterium_status(key=conversation)');
    expect(content).not.toContain('mention_partner');
    expect(content).not.toContain('伙伴名字[消息序号]');
    expect(content).not.toContain('请直接给出一条适合公开群聊的可见回复');
    expect(content).not.toContain('只有明确调用 deliver_file');
    expect(content).not.toContain('只根据下面提供的公开群聊内容回应');
    expect(content).not.toContain('你在星丛中的名字');
    expect(content).not.toContain('你的星丛代管设定');
    expect(content).not.toContain('你的星丛代管稳定指令');
    expect(content).not.toContain('当前用户：');
    expect(content).not.toContain('当前群聊初始成员');
  });

  it('does not repeat visible-reply guidance in an unchanged selected-partners thread', async () => {
    const base = queuedSnapshot();
    const selected = { ...base, settings: { speakingMode: 'selected_partners' as const, selectedPartnerIds: ['partner-local'], discussionProtectionEnabled: false } };
    const prepared: StudioPreparedTurn = {
      room: selected.metadata,
      round: { ...selected.activeRound!, state: 'running', currentPartnerId: 'partner-local', members: [{ ...selected.activeRound!.members[0], state: 'running', inputThroughSeq: 1, bindingGeneration: 1, conversationId: 'group:v3:room-one:partner-local' }] },
      settings: selected.settings,
      previousSpeakingMode: 'selected_partners',
      mutedPartnerIds: [],
      conversationId: 'group:v3:room-one:partner-local',
      bindingGeneration: 1,
      nativeThreadId: 'native-thread-one',
      inputThroughSeq: 1,
      processedAfterSeq: 0,
      messages: selected.messages,
      models: {},
    };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: createdAt }, [localSeed()]);
    const rooms = {
      getRoom: vi.fn(async () => selected), publishUserMessage: vi.fn(async () => selected), cancelRound: vi.fn(async () => selected), failPreparedTurn: vi.fn(async () => selected),
    };
    const runtime: StudioRuntimeLifecyclePort = {
      prepareStudioTurn: vi.fn(async () => prepared),
      startStudioTurn: vi.fn(async () => ({ runId: 'run-selected', sessionId: 'native-thread-one' })),
      cancelRun: vi.fn(async () => undefined),
    };
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime);

    orchestrator.handleSnapshot(selected);
    await vi.waitFor(() => expect(runtime.startStudioTurn).toHaveBeenCalledTimes(1));
    const content = vi.mocked(runtime.startStudioTurn).mock.calls[0][0].content;
    expect(content).not.toContain('当前发言模式：指定发言');
    expect(content).not.toContain('请直接给出一条适合公开群聊的可见回复');
  });

  it('offers pass only to unmentioned partners in free discussion', async () => {
    const base = queuedSnapshot();
    const free = { ...base, settings: { speakingMode: 'free_discussion' as const, selectedPartnerIds: [], discussionProtectionEnabled: false } };
    const prepared: StudioPreparedTurn = {
      room: free.metadata,
      round: { ...free.activeRound!, state: 'running', currentPartnerId: 'partner-local', members: [{ ...free.activeRound!.members[0], state: 'running', inputThroughSeq: 1, bindingGeneration: 1, conversationId: 'group:v3:room-one:partner-local' }] },
      settings: free.settings,
      mutedPartnerIds: [],
      conversationId: 'group:v3:room-one:partner-local',
      bindingGeneration: 1,
      inputThroughSeq: 1,
      processedAfterSeq: 0,
      messages: free.messages,
      models: {},
    };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: createdAt }, [localSeed()]);
    const rooms = {
      getRoom: vi.fn(async () => free), publishUserMessage: vi.fn(async () => free), cancelRound: vi.fn(async () => free), failPreparedTurn: vi.fn(async () => free),
    };
    const runtime: StudioRuntimeLifecyclePort = {
      prepareStudioTurn: vi.fn(async () => prepared),
      startStudioTurn: vi.fn(async () => ({ runId: 'run-one', sessionId: 'session-one' })),
      cancelRun: vi.fn(async () => undefined),
    };
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime);

    orchestrator.handleSnapshot(free);
    await vi.waitFor(() => expect(runtime.startStudioTurn).toHaveBeenCalledTimes(1));
    expect(runtime.startStudioTurn).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('<asterium_group_pass />'),
      context: expect.objectContaining({ conversation: { title: '主讨论组', studio: expect.objectContaining({ passAllowed: true }) } }),
    }));
    const content = vi.mocked(runtime.startStudioTurn).mock.calls[0][0].content;
    expect(content).toContain('当前发言模式：自由讨论。可以使用 mention_partner');
    expect(content).toContain('asterium_status(key=conversation)');
    expect(content).toContain('如需真正邀请另一位伙伴继续本轮讨论，必须调用 mention_partner');
  });

  it('announces a changed mode once and only repeats mention guidance when entering free discussion', async () => {
    const base = queuedSnapshot();
    const free = { ...base, settings: { speakingMode: 'free_discussion' as const, selectedPartnerIds: [], discussionProtectionEnabled: false } };
    const prepared: StudioPreparedTurn = {
      room: free.metadata,
      round: { ...free.activeRound!, state: 'running', currentPartnerId: 'partner-local', members: [{ ...free.activeRound!.members[0], state: 'running', inputThroughSeq: 1, bindingGeneration: 1, conversationId: 'group:v3:room-one:partner-local' }] },
      settings: free.settings,
      previousSpeakingMode: 'round_robin',
      mutedPartnerIds: [],
      conversationId: 'group:v3:room-one:partner-local',
      bindingGeneration: 1,
      nativeThreadId: 'native-thread-one',
      inputThroughSeq: 1,
      processedAfterSeq: 0,
      messages: free.messages,
      models: {},
    };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: createdAt }, [localSeed()]);
    const rooms = {
      getRoom: vi.fn(async () => free), publishUserMessage: vi.fn(async () => free), cancelRound: vi.fn(async () => free), failPreparedTurn: vi.fn(async () => free),
    };
    const runtime: StudioRuntimeLifecyclePort = {
      prepareStudioTurn: vi.fn(async () => prepared),
      startStudioTurn: vi.fn(async () => ({ runId: 'run-one', sessionId: 'native-thread-one' })),
      cancelRun: vi.fn(async () => undefined),
    };
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime);

    orchestrator.handleSnapshot(free);
    await vi.waitFor(() => expect(runtime.startStudioTurn).toHaveBeenCalledTimes(1));
    const content = vi.mocked(runtime.startStudioTurn).mock.calls[0][0].content;
    expect(content).toContain('当前发言模式：自由讨论。可以使用 mention_partner');
    expect(content).toContain('如需真正邀请另一位伙伴继续本轮讨论，必须调用 mention_partner');
    expect(content).not.toContain('asterium_status(key=conversation)');
    expect(content).toContain('<asterium_group_pass />');
  });

  it('does not repeat the PASS marker but restores citation guidance after context compression', async () => {
    const base = queuedSnapshot();
    const free = { ...base, settings: { speakingMode: 'free_discussion' as const, selectedPartnerIds: [], discussionProtectionEnabled: false } };
    const prepared: StudioPreparedTurn = {
      room: free.metadata,
      round: { ...free.activeRound!, state: 'running', currentPartnerId: 'partner-local', members: [{ ...free.activeRound!.members[0], state: 'running', inputThroughSeq: 1, bindingGeneration: 1, conversationId: 'group:v3:room-one:partner-local' }] },
      settings: free.settings,
      previousSpeakingMode: 'free_discussion',
      mutedPartnerIds: [],
      conversationId: 'group:v3:room-one:partner-local',
      bindingGeneration: 1,
      nativeThreadId: 'native-thread-one',
      inputThroughSeq: 1,
      processedAfterSeq: 0,
      messages: free.messages,
      models: {},
      omittedRange: { fromSeq: 1, throughSeq: 8 },
    };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: createdAt }, [localSeed()]);
    const rooms = {
      getRoom: vi.fn(async () => free), publishUserMessage: vi.fn(async () => free), cancelRound: vi.fn(async () => free), failPreparedTurn: vi.fn(async () => free),
    };
    const runtime: StudioRuntimeLifecyclePort = {
      prepareStudioTurn: vi.fn(async () => prepared),
      startStudioTurn: vi.fn(async () => ({ runId: 'run-one', sessionId: 'native-thread-one' })),
      cancelRun: vi.fn(async () => undefined),
    };
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime);

    orchestrator.handleSnapshot(free);
    await vi.waitFor(() => expect(runtime.startStudioTurn).toHaveBeenCalledTimes(1));
    const content = vi.mocked(runtime.startStudioTurn).mock.calls[0][0].content;
    expect(content).not.toContain('<asterium_group_pass />');
    expect(content).not.toContain('当前发言模式：自由讨论');
    expect(content).not.toContain('你本次需要处理的公开群聊增量：');
    expect(content).toContain('伙伴名字[消息序号]');
  });

  it('uses a correction-only prompt for the serialized fallback retry', async () => {
    const queued = queuedSnapshot();
    const prepared: StudioPreparedTurn = {
      room: queued.metadata,
      round: { ...queued.activeRound!, state: 'running', currentPartnerId: 'partner-local', members: [{ ...queued.activeRound!.members[0], state: 'running', inputThroughSeq: 1, bindingGeneration: 1, conversationId: 'group:v3:room-one:partner-local' }] },
      settings: queued.settings,
      mutedPartnerIds: [],
      conversationId: 'group:v3:room-one:partner-local',
      bindingGeneration: 1,
      inputThroughSeq: 1,
      processedAfterSeq: 0,
      messages: queued.messages,
      models: {},
    };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: createdAt }, [localSeed()]);
    const rooms = {
      getRoom: vi.fn(async () => queued), publishUserMessage: vi.fn(async () => queued), cancelRound: vi.fn(async () => queued), failPreparedTurn: vi.fn(async () => queued),
    };
    const runtime: StudioRuntimeLifecyclePort = {
      prepareStudioTurn: vi.fn(async () => prepared),
      startStudioTurn: vi.fn(async () => ({ runId: 'run-retry', sessionId: 'session-one' })),
      cancelRun: vi.fn(async () => undefined),
    };
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime);
    orchestrator.markPassCorrection('room-one', 'round-one', 'partner-local');

    orchestrator.handleSnapshot(queued);
    await vi.waitFor(() => expect(runtime.startStudioTurn).toHaveBeenCalledTimes(1));
    const request = vi.mocked(runtime.startStudioTurn).mock.calls[0][0];
    expect(request.content).toBe('[系统纠正] 当前发言模式为逐一回应，不允许跳过发言。请针对刚才的公开群聊增量给出一条可见回复。');
    expect(request.content).not.toContain('当前群聊成员');
  });

  it('owns canonical cancellation and runtime cancellation in Main', async () => {
    const queued = queuedSnapshot();
    const running: StudioRoomSnapshot = {
      ...queued,
      activeRound: {
        ...queued.activeRound!, state: 'running', currentPartnerId: 'partner-local',
        members: [{ ...queued.activeRound!.members[0], state: 'running', runId: 'run-one', sessionId: 'session-one', conversationId: 'group:v3:room-one:partner-local', bindingGeneration: 1, inputThroughSeq: 1 }],
      },
    };
    const cancelled = { ...running, activeRound: { ...running.activeRound!, state: 'cancelled' as const } };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: createdAt }, [localSeed()]);
    const rooms = {
      getRoom: vi.fn(async () => running),
      publishUserMessage: vi.fn(async () => running),
      cancelRound: vi.fn(async () => cancelled),
      failPreparedTurn: vi.fn(async () => running),
    };
    const runtime: StudioRuntimeLifecyclePort = {
      prepareStudioTurn: vi.fn(),
      startStudioTurn: vi.fn(),
      cancelRun: vi.fn(async () => undefined),
    };
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime);

    await expect(orchestrator.cancelRound('room-one')).resolves.toBe(cancelled);
    expect(rooms.cancelRound).toHaveBeenCalledWith('room-one');
    expect(runtime.cancelRun).toHaveBeenCalledWith(expect.objectContaining({
      partner: expect.objectContaining({ partnerId: 'partner-local' }), conversationId: 'group:v3:room-one:partner-local', runId: 'run-one', sessionId: 'session-one',
      route: { scope: 'group', roomId: 'room-one', roundId: 'round-one', bindingGeneration: 1, inputThroughSeq: 1 },
    }), '用户停止了本轮群聊');
  });

  it('cancels a run whose receipt arrives after the canonical round was cancelled', async () => {
    const queued = queuedSnapshot();
    const prepared: StudioPreparedTurn = {
      room: queued.metadata,
      round: {
        ...queued.activeRound!,
        state: 'running',
        currentPartnerId: 'partner-local',
        members: [{
          ...queued.activeRound!.members[0],
          state: 'running',
          conversationId: 'group:v3:room-one:partner-local',
          bindingGeneration: 1,
          inputThroughSeq: 1,
        }],
      },
      settings: queued.settings,
      mutedPartnerIds: [],
      conversationId: 'group:v3:room-one:partner-local',
      bindingGeneration: 1,
      inputThroughSeq: 1,
      processedAfterSeq: 0,
      messages: queued.messages,
      models: {},
    };
    const running = { ...queued, activeRound: prepared.round };
    const cancelled = { ...running, activeRound: { ...prepared.round, state: 'cancelled' as const } };
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: createdAt }, [localSeed()]);
    let resolveReceipt!: (receipt: { runId: string; sessionId: string }) => void;
    const lateReceipt = new Promise<{ runId: string; sessionId: string }>((resolve) => { resolveReceipt = resolve; });
    const rooms = {
      getRoom: vi.fn(async () => running),
      publishUserMessage: vi.fn(async () => queued),
      cancelRound: vi.fn(async () => cancelled),
      failPreparedTurn: vi.fn(async () => running),
    };
    const runtime: StudioRuntimeLifecyclePort = {
      prepareStudioTurn: vi.fn(async () => prepared),
      startStudioTurn: vi.fn(async () => lateReceipt),
      cancelRun: vi.fn(async () => undefined),
    };
    const orchestrator = new StudioOrchestrator(rooms, catalog, runtime);

    orchestrator.handleSnapshot(queued);
    await vi.waitFor(() => expect(runtime.startStudioTurn).toHaveBeenCalledTimes(1));
    await orchestrator.cancelRound('room-one');
    expect(runtime.cancelRun).not.toHaveBeenCalled();

    resolveReceipt({ runId: 'run-late', sessionId: 'session-late' });
    await vi.waitFor(() => expect(runtime.cancelRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-late',
      sessionId: 'session-late',
      conversationId: 'group:v3:room-one:partner-local',
    }), '用户已停止本轮群聊'));
  });
});
