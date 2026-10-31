import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrototypeProvider, usePrototype } from '../../src/renderer/app/PrototypeProvider';
import { STATE_KEY } from '../../src/renderer/app/persistence';
import type { ApiPartner, Conversation, GroupChat, Partner, PrototypeState } from '../../src/renderer/types/domain';
import {
  AGENT_PROTOCOL_VERSION,
  type MessageAttachment,
  type PartnerProfileSeed,
  type RendererAgentEvent,
  type SendMessageCommand,
} from '../../src/shared/agentProtocol';
import type {
  StudioRoomMetadata,
  StudioRoomSettings,
  StudioRoomSnapshot,
} from '../../src/shared/studioRuntime';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';
import type { ProjectRecord } from '../../src/shared/projectDomain';

function projectRecord(project: PrototypeState['projects'][number]): ProjectRecord {
  return {
    version: project.version,
    id: project.id,
    name: project.name,
    ...(project.avatarDataUrl ? { avatarDataUrl: project.avatarDataUrl } : {}),
    description: project.description,
    status: project.status,
    progress: project.progress,
    tags: project.tags,
    memberIds: project.memberIds,
    revision: project.revision,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

let controls: ReturnType<typeof usePrototype> | undefined;

function Probe() {
  const value = usePrototype();
  useEffect(() => {
    controls = value;
    return () => { controls = undefined; };
  }, [value]);
  return null;
}

function current() {
  if (!controls) throw new Error('PROTOTYPE_CONTEXT_NOT_READY');
  return controls;
}

const createdAt = '2026-10-13T00:00:00.000Z';
const attachment: MessageAttachment = {
  id: 'attachment-one',
  name: 'brief.png',
  mediaType: 'image/png',
  sizeBytes: 512,
};

function identity(name: string) {
  return {
    displayName: name,
    introduction: `${name} introduction`,
    expertise: `${name} expertise`,
    mentionName: name,
  };
}

function apiPartner(id: string, name = id): ApiPartner {
  return {
    id,
    publicIdentity: identity(name),
    status: 'online',
    isPrototype: false,
    createdAt,
    accent: '#58d1c2',
    sourceMode: 'api_partner',
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    model: `${id}-model-v1`,
    personality: `${id} personality v1`,
    systemPrompt: `${id} system v1`,
    apiSessionHistoryEnabled: true,
    thinkingMode: 'auto',
    reasoningEffort: 'high',
    credentialRef: `${id}-credential`,
    configured: true,
    primaryWorkspaceGrantId: `${id}-root-v1`,
    workspaceGrantIds: [`${id}-extra-v1`],
    attachmentCapabilities: {
      supportsImageInput: true,
      acceptedMimeTypes: ['image/png'],
      maxImageBytes: 1024,
      attachmentTransport: 'native_multimodal',
    },
  };
}

function conversation(id: string, partnerId: string, sessionId: string): Conversation {
  return {
    id,
    partnerId,
    title: `${partnerId} chat`,
    messages: [],
    updatedAt: createdAt,
    sessionId,
    permissionMode: 'manual',
    planMode: 'default',
  };
}

function stateWith(partners: Partner[], conversations: Conversation[], groupChats: GroupChat[] = []): PrototypeState {
  return {
    version: 7,
    userProfile: { id: ASTERIUM_USER_ID, displayName: '用户', introduction: 'user profile', audience: 'all', updatedAt: createdAt },
    partners,
    conversations,
    projects: [],
    groupChats,
    activePartnerId: partners[0]?.id ?? '',
    activeConversationId: conversations[0]?.id ?? '',
    activeProjectId: groupChats[0]?.projectId ?? '',
    activeGroupChatId: groupChats[0]?.id ?? '',
  };
}

function persist(state: PrototypeState) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function mount() {
  render(
    <MemoryRouter initialEntries={['/chat']}>
      <PrototypeProvider><Probe /></PrototypeProvider>
    </MemoryRouter>,
  );
}

function baseRoom(metadata: StudioRoomMetadata, settings: StudioRoomSettings, rotationOffset = 0): StudioRoomSnapshot {
  return {
    metadata,
    messages: [],
    cursors: [],
    mutedPartnerIds: [],
    settings,
    rotationOffset,
    models: {},
  };
}

function agentEvent(
  command: SendMessageCommand,
  receipt: { runId: string; sessionId: string },
  connectionSource: SendMessageCommand['connectionSource'],
): RendererAgentEvent {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'authorization.requested',
    eventId: `authorization-${command.conversationId}`,
    partnerId: command.partnerId,
    conversationId: command.conversationId,
    connectionSource,
    clientMessageId: command.clientMessageId,
    sessionId: receipt.sessionId,
    runId: receipt.runId,
    sequence: 1,
    occurredAt: createdAt,
    authorizationId: `auth-${command.conversationId}`,
    action: 'write_file',
    risk: 'medium',
    summary: 'characterization authorization',
    targets: ['K:\\workspace\\result.md'],
  };
}

afterEach(() => {
  controls = undefined;
  window.asteriumAgents = undefined;
  window.asteriumStudio = undefined;
  window.asteriumProjects = undefined;
  window.asteriumNativeBindings = undefined;
});

describe('project file projection boundary characterization', () => {
  it('applies the Main-owned project snapshot immediately while retaining the pull scan', async () => {
    const partner = apiPartner('partner-project', '项目伙伴');
    const state = stateWith([partner], []);
    state.projects = [{
      id: 'project-one', name: '项目一', description: '', status: 'active', progress: 0, tags: [], memberIds: [partner.id], files: [], tasks: [],
      version: 1, revision: 1, createdAt, updatedAt: createdAt,
      workspace: { status: 'ready', rootPath: 'K:\\project-one', deliverablesPath: 'K:\\project-one\\deliverables', initializedAt: createdAt },
    }];
    state.activeProjectId = 'project-one';
    persist(state);
    let filesListener: Parameters<NonNullable<typeof window.asteriumProjects>['onFilesChanged']>[0] | undefined;
    const listFiles = vi.fn(async () => []);
    window.asteriumProjects = {
      initializeDomain: vi.fn(async () => ({
        version: 1 as const,
        projects: state.projects.map(projectRecord),
        tasks: [],
      })),
      chooseLocation: vi.fn(async () => null),
      create: vi.fn(), update: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), removeTask: vi.fn(),
      listRoles: vi.fn(async (projectId: string) => ({ version: 1 as const, projectId, roles: [] })), createRole: vi.fn(), updateRole: vi.fn(), archiveRole: vi.fn(), removeRole: vi.fn(), onRolesChanged: vi.fn(() => () => undefined),
      workflowCatalog: vi.fn(async () => ({ version: 1 as const, templates: [], methods: [] })), listWorkflows: vi.fn(async () => []), createWorkflow: vi.fn(), updateWorkflow: vi.fn(), removeWorkflow: vi.fn(), activateWorkflow: vi.fn(), onWorkflowsChanged: vi.fn(() => () => undefined),
      createWorkspace: vi.fn(), get: vi.fn(async () => ({
        version: 1 as const, projectId: 'project-one', name: '项目一', rootPath: 'K:\\project-one',
        deliverablesPath: 'K:\\project-one\\deliverables', templateFiles: [], createdAt, updatedAt: createdAt,
      })), open: vi.fn(async () => undefined), openFile: vi.fn(async () => undefined),
      listFiles,
      onFilesChanged: vi.fn((listener) => { filesListener = listener; return () => { filesListener = undefined; }; }), onDomainChanged: vi.fn(() => () => undefined),
      getTaskExecution: vi.fn(async () => ({ version: 1 as const, attempts: [], events: [] })),
      enqueueTaskAttempt: vi.fn(), pauseTaskAttempt: vi.fn(), resumeTaskAttempt: vi.fn(), cancelTaskAttempt: vi.fn(), retryTaskAttempt: vi.fn(), resolveTaskGate: vi.fn(),
      onTaskExecutionChanged: vi.fn(() => () => undefined),
      getExecutionPolicy: vi.fn(async () => ({ version: 1 as const, projectId: 'project-one', permissionMode: 'manual' as const, updatedAt: createdAt })),
      setExecutionPolicy: vi.fn(), onExecutionPolicyChanged: vi.fn(() => () => undefined),
      syncMembers: vi.fn(async () => []), changeMembers: vi.fn(), remove: vi.fn(async () => undefined),
    };

    mount();
    await waitFor(() => expect(listFiles).toHaveBeenCalledWith('project-one'));
    act(() => filesListener?.({ projectId: 'project-one', files: [{
      fileId: 'file-result', revision: 1, category: 'delivery', availability: 'available', name: 'result.md', relativePath: 'result.md', sizeBytes: 12, modifiedAt: createdAt,
      artifactId: 'artifact-one', sourcePartnerName: '外部伙伴',
    }] }));

    await waitFor(() => expect(current().state.projects[0].files).toEqual([expect.objectContaining({
      name: 'result.md', relativePath: 'result.md', artifactId: 'artifact-one', sourcePartnerName: '外部伙伴', availability: 'available',
    })]));
  });

  it('migrates a Renderer project into Main and keeps it when its workspace is unavailable', async () => {
    const partner = apiPartner('partner-stale', '测试伙伴');
    const group: GroupChat = {
      id: 'room-stale', projectId: 'project-stale', name: '已删除测试群聊', memberIds: [partner.id], messages: [], createdAt, updatedAt: createdAt,
    };
    const state = stateWith([partner], [], [group]);
    state.projects = [{
      id: 'project-stale', name: '已删除测试项目', description: '', status: 'active', progress: 0, tags: [], memberIds: [partner.id], files: [], tasks: [],
      version: 1, revision: 1, createdAt, updatedAt: createdAt,
      workspace: { status: 'ready', rootPath: 'K:\\missing-project', deliverablesPath: 'K:\\missing-project\\deliverables', initializedAt: createdAt },
    }];
    persist(state);
    const remove = vi.fn(async () => undefined);
    const listFiles = vi.fn(async () => []);
    const syncMembers = vi.fn((projects: Array<{ projectId: string; partnerIds: string[] }>) => {
      void projects;
      return Promise.resolve([]);
    });
    const syncRoom = vi.fn(async () => baseRoom({ roomId: group.id, projectId: group.projectId, name: group.name, memberIds: group.memberIds }, {
      speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false,
    }));
    window.asteriumProjects = {
      initializeDomain: vi.fn(async () => ({
        version: 1 as const,
        projects: state.projects.map(projectRecord),
        tasks: [],
      })),
      chooseLocation: vi.fn(async () => null), create: vi.fn(), update: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), removeTask: vi.fn(),
      listRoles: vi.fn(async (projectId: string) => ({ version: 1 as const, projectId, roles: [] })), createRole: vi.fn(), updateRole: vi.fn(), archiveRole: vi.fn(), removeRole: vi.fn(), onRolesChanged: vi.fn(() => () => undefined),
      workflowCatalog: vi.fn(async () => ({ version: 1 as const, templates: [], methods: [] })), listWorkflows: vi.fn(async () => []), createWorkflow: vi.fn(), updateWorkflow: vi.fn(), removeWorkflow: vi.fn(), activateWorkflow: vi.fn(), onWorkflowsChanged: vi.fn(() => () => undefined),
      get: vi.fn(async () => null), createWorkspace: vi.fn(),
      open: vi.fn(async () => undefined), openFile: vi.fn(async () => undefined), listFiles,
      onFilesChanged: vi.fn(() => () => undefined), onDomainChanged: vi.fn(() => () => undefined),
      getTaskExecution: vi.fn(async () => ({ version: 1 as const, attempts: [], events: [] })),
      enqueueTaskAttempt: vi.fn(), pauseTaskAttempt: vi.fn(), resumeTaskAttempt: vi.fn(), cancelTaskAttempt: vi.fn(), retryTaskAttempt: vi.fn(), resolveTaskGate: vi.fn(),
      onTaskExecutionChanged: vi.fn(() => () => undefined),
      getExecutionPolicy: vi.fn(async () => ({ version: 1 as const, projectId: 'project-stale', permissionMode: 'manual' as const, updatedAt: createdAt })),
      setExecutionPolicy: vi.fn(), onExecutionPolicyChanged: vi.fn(() => () => undefined),
      syncMembers, changeMembers: vi.fn(), remove,
    };
    window.asteriumStudio = {
      syncRoom, getRoom: vi.fn(async () => undefined), removeRoom: vi.fn(async () => undefined),
      setMuted: vi.fn(), setSettings: vi.fn(), resolveDiscussion: vi.fn(), cancelRound: vi.fn(), startRound: vi.fn(),
      prepareTurn: vi.fn(), failTurn: vi.fn(), announce: vi.fn(), onRoomChanged: vi.fn(() => () => undefined),
    };

    mount();

    await waitFor(() => expect(current().state.projects[0]?.workspace?.status).toBe('unavailable'));
    expect(remove).not.toHaveBeenCalled();
    expect(current().state.projects).toHaveLength(1);
    expect(current().state.groupChats).toHaveLength(1);
    expect(syncRoom).toHaveBeenCalled();
    expect(listFiles).not.toHaveBeenCalled();
    expect(syncMembers.mock.calls.every(([projects]) => projects.every((project) => project.projectId !== 'project-stale'))).toBe(true);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STATE_KEY)!).projects).toEqual([]));
  });
});

describe('studio interaction projection', () => {
  it('keeps the partner approval bubble mounted after approval resolves', async () => {
    const partner = apiPartner('partner-studio-approval', '审批伙伴');
    persist(stateWith([partner], []));
    let listener: ((event: RendererAgentEvent) => void) | undefined;
    window.asteriumAgents = {
      detectClaude: vi.fn(async () => ({ installed: false, loggedIn: false })),
      selectWorkspace: vi.fn(async () => null),
      sendClaudeMessage: vi.fn(),
      cancelRun: vi.fn(),
      resumeSession: vi.fn(),
      onEvent: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    };
    mount();
    const route = { scope: 'group' as const, roomId: 'room-approval', roundId: 'round-approval', bindingGeneration: 1, inputThroughSeq: 1 };
    const base = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      partnerId: partner.id,
      conversationId: 'group:v3:room-approval:partner-studio-approval',
      connectionSource: 'api_partner' as const,
      clientMessageId: 'client-approval',
      sessionId: 'session-approval',
      runId: 'run-approval',
      occurredAt: createdAt,
      route,
    };

    act(() => listener?.({ ...base, eventId: 'authorization-requested', type: 'authorization.requested', sequence: 1, authorizationId: 'authorization-one', action: 'write_file', risk: 'medium', summary: '允许写入项目文件？', targets: ['K:\\project\\result.md'] }));
    await waitFor(() => expect(current().studioInteractions[route.roomId]?.timeline).toHaveLength(1));

    act(() => listener?.({ ...base, eventId: 'authorization-resolved', type: 'authorization.resolved', sequence: 2, authorizationId: 'authorization-one', decision: 'allow_once' }));
    await waitFor(() => expect(current().studioInteractions[route.roomId]?.timeline).toEqual([
      expect.objectContaining({ kind: 'authorization', authorizationId: 'authorization-one', state: 'success', decision: 'allow_once' }),
    ]));
    expect(current().studioInteractions[route.roomId]?.pendingAuthorization).toBeUndefined();
  });
});

describe('single-chat runtime boundary characterization', () => {
  it('keeps send attachments, cancellation, and authorization routed to each of the three source types', async () => {
    const local: Partner = {
      id: 'partner-local', publicIdentity: identity('Local'), status: 'online', isPrototype: false, createdAt, accent: '#69a7ff',
      sourceMode: 'local_cli', adapterType: 'codex_cli', location: 'local', sessionMode: 'resume',
      connectionLabel: 'Codex', connectionKind: 'local_codex', codexRuntimeId: 'runtime-one',
      partnerRoot: 'K:\\local-root', partnerRootGrantId: 'local-root-grant', workspaceGrantIds: ['local-extra-grant'],
    };
    const api = apiPartner('partner-api', 'API');
    const existing: Partner = {
      id: 'partner-existing', publicIdentity: identity('Existing'), status: 'online', isPrototype: false, createdAt, accent: '#a68cff',
      sourceMode: 'existing_thread', serviceType: 'cyberboss_server', serviceUrl: 'https://example.test', threadId: 'upstream-thread',
      workspaceRoot: '/srv/workspace', connectionLabel: 'CyberBoss', connectionStatus: 'connected', credentialRef: 'bridge-ref', configured: true,
      capabilities: { streamingText: true, cancellation: true, toolEvents: true, fileEvents: true, reconnect: true },
    };
    const conversations = [
      conversation('conversation-local', local.id, 'session-local'),
      conversation('conversation-api', api.id, 'session-api'),
      { ...conversation('conversation-existing', existing.id, 'upstream-thread'), isPrimaryThread: true },
    ];
    persist(stateWith([local, api, existing], conversations));

    let listener: ((event: RendererAgentEvent) => void) | undefined;
    const sentLocal: SendMessageCommand[] = [];
    const sentApi: SendMessageCommand[] = [];
    const sentExisting: SendMessageCommand[] = [];
    const receipts = new Map<string, { runId: string; sessionId: string }>();
    const receiptFor = (command: SendMessageCommand) => {
      const receipt = { runId: `run-${command.conversationId}`, sessionId: command.sessionId ?? `session-${command.conversationId}` };
      receipts.set(command.conversationId, receipt);
      return receipt;
    };
    type AgentsApi = NonNullable<typeof window.asteriumAgents>;
    const cancelRun = vi.fn(async (command: Parameters<AgentsApi['cancelRun']>[0]) => { void command; });
    const resolveAuthorization = vi.fn(async (command: Parameters<NonNullable<AgentsApi['resolveAuthorization']>>[0]) => { void command; });
    window.asteriumAgents = {
      detectClaude: vi.fn(async () => ({ installed: false, loggedIn: false })),
      selectWorkspace: vi.fn(async () => null),
      sendClaudeMessage: vi.fn(async (_partnerId, _root, _grants, command) => receiptFor(command)),
      sendLocalCliMessage: vi.fn(async (_adapter, _partnerId, _root, _grants, command) => { sentLocal.push(command); return receiptFor(command); }),
      sendApiMessage: vi.fn(async (_connection, command) => { sentApi.push(command); return receiptFor(command); }),
      sendExistingThreadMessage: vi.fn(async (_connection, command) => { sentExisting.push(command); return receiptFor(command); }),
      cancelRun,
      resumeSession: vi.fn(async () => undefined),
      resolveAuthorization,
      onEvent: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    };
    mount();

    for (const item of conversations) {
      await act(async () => {
        expect(await current().sendChatMessage(item.id, `send ${item.id}`, [attachment])).toBe(true);
      });
    }
    await waitFor(() => {
      expect(sentLocal).toHaveLength(1);
      expect(sentApi).toHaveLength(1);
      expect(sentExisting).toHaveLength(1);
    });
    for (const command of [sentLocal[0], sentApi[0], sentExisting[0]]) {
      expect(command.attachments).toEqual([attachment]);
      expect(command.partnerId).toBe(conversations.find((item) => item.id === command.conversationId)?.partnerId);
    }

    await waitFor(() => expect(current().state.conversations.every((item) => Boolean(item.activeRun))).toBe(true));
    const messageCountsBeforeGroupEvent = current().state.conversations.map((item) => [item.id, item.messages.length] as const);
    act(() => listener?.({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'text.delta',
      eventId: 'group-event-isolation',
      partnerId: local.id,
      conversationId: 'group:v3:room-isolation:partner-local',
      connectionSource: 'local_cli',
      clientMessageId: 'group-client-isolation',
      sessionId: 'group-session-isolation',
      runId: 'group-run-isolation',
      sequence: 1,
      occurredAt: createdAt,
      route: { scope: 'group', roomId: 'room-isolation', roundId: 'round-isolation', bindingGeneration: 1, inputThroughSeq: 1 },
      text: 'must not enter any single chat',
    }));
    await waitFor(() => expect(current().studioInteractions['room-isolation']?.runId).toBe('group-run-isolation'));
    expect(current().state.conversations.map((item) => [item.id, item.messages.length] as const)).toEqual(messageCountsBeforeGroupEvent);

    act(() => {
      for (const item of conversations) current().cancelChatRun(item.id);
    });
    await waitFor(() => expect(cancelRun).toHaveBeenCalledTimes(3));
    expect(cancelRun.mock.calls.map(([command]) => [command.partnerId, command.conversationId, command.route])).toEqual([
      ['partner-local', 'conversation-local', undefined],
      ['partner-api', 'conversation-api', undefined],
      ['partner-existing', 'conversation-existing', undefined],
    ]);

    const commands = [sentLocal[0], sentApi[0], sentExisting[0]];
    for (const command of commands) {
      act(() => listener?.(agentEvent(command, receipts.get(command.conversationId)!, command.connectionSource)));
      await waitFor(() => expect(current().state.conversations.find((item) => item.id === command.conversationId)?.pendingAuthorization?.authorizationId).toBe(`auth-${command.conversationId}`));
      act(() => current().resolveChatAuthorization(command.conversationId, 'allow_once'));
    }
    await waitFor(() => expect(resolveAuthorization).toHaveBeenCalledTimes(3));
    expect(resolveAuthorization.mock.calls.map(([command]) => [command.partnerId, command.conversationId, command.authorizationId, command.route])).toEqual([
      ['partner-local', 'conversation-local', 'auth-conversation-local', undefined],
      ['partner-api', 'conversation-api', 'auth-conversation-api', undefined],
      ['partner-existing', 'conversation-existing', 'auth-conversation-existing', undefined],
    ]);
  });

  it('regenerates local CLI and API turns with the original attachment and source-specific continuation metadata', async () => {
    const local: Partner = {
      id: 'partner-local', publicIdentity: identity('Local'), status: 'online', isPrototype: false, createdAt, accent: '#69a7ff',
      sourceMode: 'local_cli', adapterType: 'codex_cli', location: 'local', sessionMode: 'resume',
      connectionLabel: 'Codex', connectionKind: 'local_codex', codexRuntimeId: 'runtime-one',
      partnerRoot: 'K:\\local-root', partnerRootGrantId: 'local-root-grant', workspaceGrantIds: ['local-extra-grant'],
    };
    const api = apiPartner('partner-api', 'API');
    const localConversation: Conversation = {
      ...conversation('conversation-local', local.id, 'session-local'),
      messages: [
        { id: 'local-history', authorId: local.id, content: 'old context', createdAt, runId: 'turn-before-regeneration' },
        { id: 'local-user', authorId: ASTERIUM_USER_ID, content: 'original local prompt', createdAt, clientMessageId: 'old-local-client', attachments: [attachment] },
        { id: 'local-answer', authorId: local.id, content: 'replace me', createdAt, runId: 'old-local-answer' },
      ],
    };
    const apiConversation: Conversation = {
      ...conversation('conversation-api', api.id, 'session-api'),
      messages: [
        { id: 'api-history', authorId: api.id, content: 'api context', createdAt, runId: 'api-history-run' },
        { id: 'api-user', authorId: ASTERIUM_USER_ID, content: 'original api prompt', createdAt, clientMessageId: 'old-api-client', attachments: [attachment] },
        { id: 'api-answer', authorId: api.id, content: 'replace me too', createdAt, runId: 'old-api-answer' },
      ],
    };
    persist(stateWith([local, api], [localConversation, apiConversation]));
    const sendLocalCliMessage = vi.fn(async (_adapter, _partnerId, _root, _grants, command: SendMessageCommand) => ({ runId: 'run-local-new', sessionId: command.sessionId ?? 'session-local-new' }));
    const sendApiMessage = vi.fn(async (_connection, command: SendMessageCommand) => ({ runId: 'run-api-new', sessionId: command.sessionId ?? 'session-api-new' }));
    window.asteriumAgents = {
      detectClaude: vi.fn(async () => ({ installed: false, loggedIn: false })),
      selectWorkspace: vi.fn(async () => null),
      sendClaudeMessage: vi.fn(async () => ({ runId: 'unused', sessionId: 'unused' })),
      sendLocalCliMessage,
      sendApiMessage,
      cancelRun: vi.fn(async () => undefined),
      resumeSession: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
    };
    mount();

    act(() => current().regenerateChatTurn(localConversation.id, 'edited local prompt'));
    await waitFor(() => expect(sendLocalCliMessage).toHaveBeenCalledTimes(1));
    const localCommand = sendLocalCliMessage.mock.calls[0][4];
    expect(localCommand).toMatchObject({
      partnerId: local.id,
      conversationId: localConversation.id,
      sessionId: 'session-local',
      forkFromTurnId: 'turn-before-regeneration',
      attachments: [attachment],
      content: { type: 'text', text: 'edited local prompt' },
    });

    act(() => current().regenerateChatTurn(apiConversation.id, 'edited api prompt'));
    await waitFor(() => expect(sendApiMessage).toHaveBeenCalledTimes(1));
    const apiCommand = sendApiMessage.mock.calls[0][1];
    expect(apiCommand).toMatchObject({
      partnerId: api.id,
      conversationId: apiConversation.id,
      sessionId: 'session-api',
      attachments: [attachment],
      content: { type: 'text', text: 'edited api prompt' },
      apiContext: { apiSessionHistoryEnabled: true, replaceTurnClientMessageId: 'old-api-client' },
    });
  });

  it.todo('product gap: existing-thread conversations need an explicit regeneration contract before a passing expectation can be added');
});

describe('studio queue and shared partner characterization', () => {
  it.each([
    {
      label: 'round robin',
      settings: { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false } as StudioRoomSettings,
      rotationOffset: 1,
      mentions: [],
      expectedQueue: ['partner-b', 'partner-c', 'partner-a'],
    },
    {
      label: 'selected partners',
      settings: { speakingMode: 'selected_partners', selectedPartnerIds: ['partner-c', 'partner-a'], discussionProtectionEnabled: false } as StudioRoomSettings,
      rotationOffset: 0,
      mentions: [],
      expectedQueue: ['partner-c', 'partner-a'],
    },
    {
      label: 'free discussion with a real mention',
      settings: { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: true } as StudioRoomSettings,
      rotationOffset: 0,
      mentions: [{ partnerId: 'partner-b', label: '小B', start: 0, end: 3, source: 'user' as const }],
      expectedQueue: ['partner-b'],
    },
  ])('delegates the current $label speaker selection inputs to Main', async ({ settings, rotationOffset, mentions }) => {
    const partners = [apiPartner('partner-a', '小A'), apiPartner('partner-b', '小B'), apiPartner('partner-c', '小C')];
    const metadata = { roomId: 'room-one', projectId: 'project-one', name: '安全网讨论组', memberIds: partners.map((item) => item.id) };
    const group: GroupChat = { id: metadata.roomId, projectId: metadata.projectId, name: metadata.name, memberIds: [...metadata.memberIds], messages: [], createdAt, updatedAt: createdAt };
    persist(stateWith(partners, [], [group]));
    const snapshot = baseRoom(metadata, settings, rotationOffset);
    const startRound = vi.fn(async () => snapshot);
    window.asteriumAgents = {
      detectClaude: vi.fn(async () => ({ installed: false, loggedIn: false })), selectWorkspace: vi.fn(async () => null),
      sendClaudeMessage: vi.fn(async () => ({ runId: 'unused', sessionId: 'unused' })), cancelRun: vi.fn(async () => undefined),
      resumeSession: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined),
    };
    window.asteriumStudio = {
      syncRoom: vi.fn(async () => snapshot), getRoom: vi.fn(async () => snapshot), removeRoom: vi.fn(async () => undefined),
      setMuted: vi.fn(async () => snapshot), setSettings: vi.fn(async () => snapshot), resolveDiscussion: vi.fn(async () => snapshot),
      cancelRound: vi.fn(async () => snapshot), startRound, prepareTurn: vi.fn(), failTurn: vi.fn(async () => snapshot),
      announce: vi.fn(async () => snapshot), onRoomChanged: vi.fn(() => () => undefined),
    };
    mount();
    await waitFor(() => expect(current().studioRooms[metadata.roomId]).toBeDefined());

    await act(async () => {
      expect(await current().sendStudioMessage(metadata.roomId, '请讨论', mentions)).toBe(true);
    });
    expect(startRound).toHaveBeenCalledWith(expect.objectContaining({
      room: metadata,
      speakerQueue: metadata.memberIds,
      ...(mentions.length ? { mentions } : {}),
    }));
  });

  it('uses the updated partner identity, model, capabilities, and workspace grants in both single and group runs', async () => {
    const initial = apiPartner('partner-shared', '共享伙伴');
    const single = conversation('conversation-shared', initial.id, 'session-shared');
    const metadata = { roomId: 'room-shared', projectId: 'project-shared', name: '共享配置讨论组', memberIds: [initial.id] };
    const group: GroupChat = { id: metadata.roomId, projectId: metadata.projectId, name: metadata.name, memberIds: [initial.id], messages: [], createdAt, updatedAt: createdAt };
    persist(stateWith([initial], [single], [group]));
    const resting = baseRoom(metadata, { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false });
    let roomListener: ((snapshot: StudioRoomSnapshot) => void) | undefined;
    const sendApiMessage = vi.fn(async (_connection, command: SendMessageCommand) => ({ runId: `run-${command.clientMessageId}`, sessionId: command.sessionId ?? `session-${command.clientMessageId}` }));
    const savePartnerProfile = vi.fn(async (profile: PartnerProfileSeed) => ({
      partnerId: profile.partnerId, directoryName: 'shared-partner', revision: 'saved-shared-profile',
      publicIdentity: profile.publicIdentity, management: profile.management,
      personality: profile.personality, systemPrompt: profile.systemPrompt, conversationModels: {},
    }));
    const prepareTurn = vi.fn();
    window.asteriumAgents = {
      detectClaude: vi.fn(async () => ({ installed: false, loggedIn: false })), selectWorkspace: vi.fn(async () => null),
      sendClaudeMessage: vi.fn(async () => ({ runId: 'unused', sessionId: 'unused' })), sendApiMessage,
      savePartnerProfile,
      cancelRun: vi.fn(async () => undefined), resumeSession: vi.fn(async () => undefined), onEvent: vi.fn(() => () => undefined),
    };
    window.asteriumStudio = {
      syncRoom: vi.fn(async () => resting), getRoom: vi.fn(async () => resting), removeRoom: vi.fn(async () => undefined),
      setMuted: vi.fn(async () => resting), setSettings: vi.fn(async () => resting), resolveDiscussion: vi.fn(async () => resting),
      cancelRound: vi.fn(async () => resting), startRound: vi.fn(async () => resting), prepareTurn, failTurn: vi.fn(async () => resting),
      announce: vi.fn(async () => resting), onRoomChanged: vi.fn((next) => { roomListener = next; return () => { roomListener = undefined; }; }),
    };
    mount();
    await waitFor(() => expect(current().studioRooms[metadata.roomId]).toBeDefined());

    const updated: ApiPartner = {
      ...initial,
      publicIdentity: { ...initial.publicIdentity, displayName: '共享伙伴新版', expertise: 'updated expertise' },
      model: 'shared-model-v2',
      personality: 'shared personality v2',
      primaryWorkspaceGrantId: 'shared-root-v2',
      workspaceGrantIds: ['shared-extra-v2'],
      attachmentCapabilities: { ...initial.attachmentCapabilities!, maxImageBytes: 2048 },
    };
    await act(async () => { await current().updatePartner(updated); });
    await waitFor(() => expect(current().state.partners[0]).toMatchObject({ model: 'shared-model-v2' }));
    await waitFor(() => expect(savePartnerProfile).toHaveBeenCalled());

    const savedProfile = savePartnerProfile.mock.calls.at(-1)![0];
    expect(savedProfile).toMatchObject({
      partnerId: updated.id,
      publicIdentity: { displayName: '共享伙伴新版', expertise: 'updated expertise' },
      personality: 'shared personality v2',
      connectionSettings: {
        __studioRuntime: {
          available: true,
          runtime: {
            kind: 'api',
            connection: {
              model: 'shared-model-v2',
              primaryWorkspaceGrantId: 'shared-root-v2',
              workspaceGrantIds: ['shared-extra-v2'],
              attachmentCapabilities: { maxImageBytes: 2048 },
            },
          },
        },
      },
    });

    await act(async () => {
      expect(await current().sendChatMessage(single.id, 'single after update', [attachment])).toBe(true);
    });
    await waitFor(() => expect(sendApiMessage.mock.calls.some(([, command]) => !command.route)).toBe(true));

    const queued: StudioRoomSnapshot = {
      ...resting,
      activeRound: {
        roundId: 'round-shared', roomId: metadata.roomId, triggerMessageId: 'group-user', speakerQueue: [updated.id],
        members: [{ turnId: 'turn-shared', partnerId: updated.id, state: 'queued' }], currentPartnerId: undefined,
        state: 'queued', participantIds: [updated.id], permissionMode: 'manual', createdAt, updatedAt: createdAt,
      },
    };
    act(() => roomListener?.(queued));
    expect(prepareTurn).not.toHaveBeenCalled();
    expect(sendApiMessage.mock.calls.some(([, command]) => command.route?.scope === 'group')).toBe(false);

    const singleCall = sendApiMessage.mock.calls.find(([, command]) => !command.route)!;
    expect(singleCall[0]).toMatchObject({
      model: 'shared-model-v2',
      primaryWorkspaceGrantId: 'shared-root-v2',
      workspaceGrantIds: ['shared-extra-v2'],
      attachmentCapabilities: { maxImageBytes: 2048 },
    });
    expect(singleCall[1]).toMatchObject({
      partnerId: updated.id,
      runtimeContext: {
        partner: { displayName: '共享伙伴新版', expertise: 'updated expertise', personality: 'shared personality v2' },
        runtime: { source: 'api_partner', provider: 'deepseek', model: 'shared-model-v2' },
      },
    });
  });

  it.todo('product gap: define how private partner memory settings are shared with group runs without leaking single-chat history');
});
