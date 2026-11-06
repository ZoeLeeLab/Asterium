import { describe, expect, it } from 'vitest';
import { buildNativeLifecycleSyncGroups, prototypeReducer } from '../../src/renderer/app/PrototypeProvider';
import { apiHistory, userProfileContext } from '../../src/renderer/app/apiContext';
import { loadPrototypeState, savePrototypeState, STATE_KEY } from '../../src/renderer/app/persistence';
import { createTestState } from '../fixtures/applicationState';
import type { ApiPartner, Conversation, LocalCliPartner, Message, PrototypeState } from '../../src/renderer/types/domain';
import { AGENT_PROTOCOL_VERSION, CODEX_NATIVE_TOOL_PROTOCOL_VERSION } from '../../src/shared/agentProtocol';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';

describe('prototypeReducer', () => {
  it('keeps an API tool running until its real completion, then splits at the ordered guidance boundary', () => {
    let state = createTestState(); const chat = state.conversations[0];
    const apiPartner = state.partners.find((partner) => partner.sourceMode === 'api_partner')!;
    state.partners = state.partners.map((partner) => partner.id === chat.partnerId ? { ...apiPartner, id: partner.id } : partner);
    state.conversations[0] = { ...chat, sessionId: 's', activeRun: { runId: 'r', clientMessageId: 'original' }, messages: [
      { id: 'u', authorId: ASTERIUM_USER_ID, content: 'task', createdAt: '12:00', clientMessageId: 'original', runId: 'r' },
      { id: 'a', authorId: chat.partnerId, content: 'before', createdAt: '12:00', runId: 'r', runState: 'running', isStreaming: true, toolEvents: [{ id: 'tool', label: 'running', state: 'running' }], timeline: [{ id: 'started', sequence: 1, kind: 'tool', toolCallId: 'tool', category: 'mcp', summary: 'running', state: 'running' }] },
    ] };
    const user: Message = { id: 'g', authorId: ASTERIUM_USER_ID, content: 'correction', createdAt: '12:01', clientMessageId: 'guidance', runId: 'r', isGuidance: true, guidanceState: 'queued', status: 'awaiting_confirmation' };
    state = prototypeReducer(state, { type: 'sendChatGuidance', conversationId: chat.id, runId: 'r', message: user, waitForApplication: true });
    expect(state.conversations[0].messages[1].toolEvents?.[0].state).toBe('running');
    expect(state.conversations[0].messages[1].runState).toBe('running');
    const base = { protocolVersion: AGENT_PROTOCOL_VERSION, partnerId: chat.partnerId, conversationId: chat.id, connectionSource: 'api_partner' as const, clientMessageId: 'original', sessionId: 's', runId: 'r', occurredAt: new Date().toISOString() };
    state = prototypeReducer(state, { type: 'agentEvent', event: { ...base, type: 'tool.completed', eventId: 'complete', sequence: 1, toolCallId: 'tool', outcome: 'success', summary: 'real result' } });
    state = prototypeReducer(state, { type: 'agentEvent', event: { ...base, type: 'guidance.applied', eventId: 'applied', sequence: 2, guidanceClientMessageId: 'guidance' } });
    state = prototypeReducer(state, { type: 'agentEvent', event: { ...base, type: 'text.delta', eventId: 'after', sequence: 3, text: 'after' } });
    const messages = state.conversations[0].messages;
    expect(messages.map((m) => m.content)).toEqual(['task', 'before', 'correction', 'after']);
    expect(messages[1].toolEvents?.[0]).toMatchObject({ state: 'success', label: 'real result' });
    expect(messages[2]).toMatchObject({ guidanceState: 'applied', status: 'delivered' });
    state = prototypeReducer(state, { type: 'agentEvent', event: { ...base, type: 'guidance.applied', eventId: 'duplicate', sequence: 4, guidanceClientMessageId: 'guidance' } });
    expect(state.conversations[0].messages).toEqual(messages);
  });

  it('marks managed data deleted only after a partner has been removed', () => {
    const state = createTestState();
    state.partners = state.partners.map((partner) => partner.id === 'fixture-api' ? { ...partner, isRemoved: true } : partner);

    const removed = prototypeReducer(state, { type: 'markPartnerDataDeleted', partnerId: 'fixture-api', deletedAt: '2026-10-18T12:00:00.000Z' });
    const active = prototypeReducer(state, { type: 'markPartnerDataDeleted', partnerId: 'fixture-local-a', deletedAt: '2026-10-18T12:00:00.000Z' });

    expect(removed.partners.find((partner) => partner.id === 'fixture-api')?.managedDataDeletedAt).toBe('2026-10-18T12:00:00.000Z');
    expect(active.partners.find((partner) => partner.id === 'fixture-local-a')?.managedDataDeletedAt).toBeUndefined();
  });

  it('removes a deleted artifact from the current conversation without touching message history', () => {
    const state = createTestState();
    const conversation = state.conversations[0];
    conversation.artifacts = [{ id: 'artifact-card', artifactRef: 'artifact-main', name: 'result.md', createdAt: '2026-10-17T00:00:00.000Z' }];
    const messages = conversation.messages;

    const next = prototypeReducer(state, { type: 'removeConversationArtifact', conversationId: conversation.id, artifactId: 'artifact-main' });

    expect(next.conversations.find((item) => item.id === conversation.id)?.artifacts).toEqual([]);
    expect(next.conversations.find((item) => item.id === conversation.id)?.messages).toEqual(messages);
  });

  it('groups native Codex lifecycle checks by partner and bound root', () => {
    const partner: LocalCliPartner = {
      id: 'partner-codex', publicIdentity: { displayName: '测试助手', introduction: '', expertise: '', mentionName: '测试助手' },
      status: 'online', isPrototype: false, createdAt: '2026-10-16T00:00:00.000Z', accent: '#fff',
      sourceMode: 'local_cli', adapterType: 'codex_cli', location: 'local', sessionMode: 'new',
      connectionLabel: 'Codex 桌面应用', connectionKind: 'local_codex', partnerRootGrantId: 'grant-a', codexRuntimeId: 'runtime-a',
    };
    const conversation = (id: string, sessionId: string, partnerRootGrantId?: string): Conversation => ({
      id, partnerId: partner.id, title: id, messages: [], updatedAt: '2026-10-16T00:00:00.000Z', sessionId,
      ...(partnerRootGrantId ? { partnerRootGrantId } : {}),
    });

    const groups = buildNativeLifecycleSyncGroups([partner], [
      conversation('conversation-a', 'thread-a'),
      conversation('conversation-b', 'thread-b'),
      conversation('conversation-b-copy', 'thread-b'),
      conversation('conversation-c', 'thread-c', 'grant-b'),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.request.partnerRootGrantId === 'grant-a')?.request.threadIds).toEqual(['thread-a', 'thread-b']);
    expect(groups.find((group) => group.request.partnerRootGrantId === 'grant-a')?.conversations).toHaveLength(3);
    expect(groups.find((group) => group.request.partnerRootGrantId === 'grant-b')?.request.threadIds).toEqual(['thread-c']);
  });

  it('keeps Main-owned projects and tasks out of Renderer Local Storage', () => {
    const state = createTestState();
    savePrototypeState(state);

    const stored = JSON.parse(localStorage.getItem(STATE_KEY)!);
    expect(stored.projects).toEqual([]);
    expect(stored.groupChats).toHaveLength(state.groupChats.length);
    expect(loadPrototypeState().projects).toEqual([]);
  });

  it('shares the common user profile only when the partner opts in', () => {
    const profile = { id: ASTERIUM_USER_ID, displayName: '用户', introduction: '喜欢清晰、温柔的交流。', audience: 'local_cli' as const, updatedAt: '2026-09-21T00:00:00.000Z' };
    const expected = '用户姓名：用户\n用户个人介绍：\n喜欢清晰、温柔的交流。';

    expect(userProfileContext(profile, { sourceMode: 'local_cli', profileManagement: { userProfile: false, personality: false, memoryMode: 'self_managed' } })).toBe('');
    expect(userProfileContext(profile, { sourceMode: 'existing_thread', profileManagement: { userProfile: true, personality: false, memoryMode: 'none' } })).toBe(expected);
    expect(userProfileContext(profile, { sourceMode: 'api_partner' })).toBe(expected);
  });

  it('limits API memory to the newest 30 messages and 60,000 characters', () => {
    const messages = Array.from({ length: 35 }, (_, index): Message => ({
      id: `history-${index}`,
      authorId: index % 2 ? ASTERIUM_USER_ID : 'partner-api',
      content: `${String(index).padStart(2, '0')}:${'x'.repeat(2_500)}`,
      createdAt: '12:00',
    }));
    const history = apiHistory(messages);
    expect(history).toHaveLength(24);
    expect(history.reduce((total, item) => total + item.content.length, 0)).toBe(60_000);
    expect(history[0].content).toHaveLength(2_431);
    expect(history[1].content.startsWith('12:')).toBe(true);
    expect(history.at(-1)?.content.startsWith('34:')).toBe(true);
  });

  it('adds a partner to the shared partner collection', () => {
    const state = createTestState();
    const partner: ApiPartner = {
      id: 'partner-new',
      publicIdentity: {
        displayName: '新伙伴',
        introduction: '本地测试伙伴',
        expertise: '测试',
        mentionName: '新伙伴',
      },
      status: 'online',
      isPrototype: true,
      createdAt: '2026-09-07T12:00:00.000Z',
      accent: '#6aa5ff',
      sourceMode: 'api_partner',
      provider: 'custom',
      model: 'demo-model',
      personality: '清晰直接',
      apiSessionHistoryEnabled: false,
      thinkingMode: 'auto',
      reasoningEffort: 'high',
      configured: false,
    };

    const next = prototypeReducer(state, { type: 'addPartner', partner });
    expect(next.partners).toContainEqual(partner);
    expect(next.activePartnerId).toBe(partner.id);
    expect(next.projects.every((project) => !project.memberIds.includes(partner.id))).toBe(true);
  });

  it('only appends the local user message', () => {
    const state = createTestState();
    const conversation = state.conversations[0];
    const before = conversation.messages.length;
    const message: Message = {
      id: 'message-local',
      authorId: ASTERIUM_USER_ID,
      content: '只发送这条本地消息',
      createdAt: '12:30',
      status: 'delivered',
    };

    const next = prototypeReducer(state, {
      type: 'sendChatMessage',
      conversationId: conversation.id,
      message,
    });
    const updated = next.conversations.find((item) => item.id === conversation.id)!;
    expect(updated.messages).toHaveLength(before + 1);
    expect(updated.messages.at(-1)).toEqual(message);
  });

  it('adds a partner to the selected project once', () => {
    const state = createTestState();
    const projectId = state.projects[0].id;
    const partnerId = state.partners.at(-1)!.id;
    const once = prototypeReducer(state, { type: 'addProjectMember', projectId, partnerId });
    const twice = prototypeReducer(once, { type: 'addProjectMember', projectId, partnerId });
    expect(twice.projects[0].memberIds.filter((id) => id === partnerId)).toHaveLength(1);
  });

  it('updates a partner in place so shared references resolve the new identity', () => {
    const state = createTestState();
    const original = state.partners[0];
    const updated = { ...original, publicIdentity: { ...original.publicIdentity, displayName: '同步后的名字', expertise: '生命周期测试' } };
    const next = prototypeReducer(state, { type: 'updatePartner', partner: updated });

    expect(next.partners).toHaveLength(state.partners.length);
    expect(next.partners.find((partner) => partner.id === original.id)?.publicIdentity.displayName).toBe('同步后的名字');
    expect(next.conversations.some((conversation) => conversation.partnerId === original.id)).toBe(true);
    expect(next.groupChats.some((group) => group.memberIds.includes(original.id))).toBe(true);
  });

  it('replaces renderer workspace metadata with the authoritative main-process snapshot', () => {
    const state = createTestState();
    const local = state.partners.find((partner) => partner.sourceMode === 'local_cli')!;
    const api = state.partners.find((partner) => partner.sourceMode === 'api_partner')!;
    const localNext = prototypeReducer(state, { type: 'syncPartnerWorkspaceState', workspace: {
      partnerId: local.id,
      cwd: { grantId: 'cwd-real', displayPath: 'D:\\fixture-workspace' },
      workspaces: [{ grantId: 'extra-real', displayPath: 'K:\\实际目录' }],
      version: 5,
      unavailableGrantIds: [],
    } });
    const apiNext = prototypeReducer(localNext, { type: 'syncPartnerWorkspaceState', workspace: {
      partnerId: api.id,
      cwd: { grantId: 'api-cwd', displayPath: 'K:\\API主目录' },
      workspaces: [{ grantId: 'api-extra', displayPath: 'K:\\API额外目录' }],
      version: 3,
      unavailableGrantIds: [],
    } });

    expect(apiNext.partners.find((partner) => partner.id === local.id)).toMatchObject({
      partnerRootGrantId: 'cwd-real', partnerRoot: 'D:\\fixture-workspace', workspaceGrantIds: ['extra-real'], workingDirectories: ['K:\\实际目录'], workspaceVersion: 5,
    });
    expect(apiNext.partners.find((partner) => partner.id === api.id)).toMatchObject({
      primaryWorkspaceGrantId: 'api-cwd', workspaceGrantIds: ['api-cwd', 'api-extra'], workingDirectories: ['K:\\API主目录', 'K:\\API额外目录'], workspaceVersion: 3,
    });
  });

  it('optimistically adds API workspace grants without changing the primary grant', () => {
    const state = createTestState();
    const api = state.partners.find((partner) => partner.sourceMode === 'api_partner')!;
    const next = prototypeReducer(state, {
      type: 'updatePartnerWorkspaceGrants',
      partnerId: api.id,
      grants: [
        { grantId: 'api-cwd', displayPath: 'K:\\API主目录' },
        { grantId: 'api-extra', displayPath: 'K:\\API额外目录' },
      ],
      preferredGrantId: 'api-cwd',
    });

    expect(next.partners.find((partner) => partner.id === api.id)).toMatchObject({
      primaryWorkspaceGrantId: 'api-cwd',
      workspaceGrantIds: ['api-cwd', 'api-extra'],
      workingDirectories: ['K:\\API主目录', 'K:\\API额外目录'],
    });
  });

  it('keeps old native sessions resumable when a new partner cwd creates a fresh conversation', () => {
    const state = createTestState();
    const partner = state.partners.find((item) => item.sourceMode === 'local_cli')!;
    const originalIndex = state.conversations.findIndex((item) => item.partnerId === partner.id);
    const original = {
      ...state.conversations[originalIndex],
      sessionId: 'native-session-old',
      partnerRoot: 'K:\\old-cwd',
      partnerRootGrantId: 'grant-old',
    };
    state.conversations[originalIndex] = original;
    const fresh = {
      ...original,
      id: 'conversation-new-cwd',
      title: '新工作区对话',
      messages: [],
      sessionId: undefined,
      partnerRoot: 'D:\\new-cwd',
      partnerRootGrantId: 'grant-new',
    };

    const next = prototypeReducer(state, { type: 'rebindPartnerRoot', partnerId: partner.id, conversation: fresh });
    expect(next.conversations[0]).toEqual(fresh);
    expect(next.conversations.find((item) => item.id === original.id)).toMatchObject({
      sessionId: 'native-session-old',
      partnerRoot: 'K:\\old-cwd',
    });
    expect(next.conversations.find((item) => item.id === original.id)?.isDisabled).not.toBe(true);
  });

  it('switches a visible conversation between cwd-specific native sessions without losing either binding', () => {
    const state = createTestState();
    const partner = state.partners.find((item) => item.sourceMode === 'local_cli')!;
    const conversation = state.conversations.find((item) => item.partnerId === partner.id)!;
    const switched = {
      ...conversation,
      partnerRoot: 'D:\\new-cwd',
      partnerRootGrantId: 'grant-new',
      sessionId: 'native-session-new',
      nativeSessionBindings: {
        'k:/old-cwd': { sessionId: 'native-session-old', partnerRoot: 'K:\\old-cwd', partnerRootGrantId: 'grant-old' },
      },
    };

    const next = prototypeReducer(state, { type: 'switchConversationWorkspace', conversationId: conversation.id, conversation: switched });
    expect(next.conversations.find((item) => item.id === conversation.id)).toMatchObject({
      partnerRoot: 'D:\\new-cwd',
      sessionId: 'native-session-new',
      nativeSessionBindings: { 'k:/old-cwd': { sessionId: 'native-session-old' } },
    });
  });

  it('soft-removes a partner while retaining history, projects, files, and member references', () => {
    const state = createTestState();
    const removedId = state.activePartnerId;
    const conversations = state.conversations.length;
    const projects = state.projects.length;
    const files = state.projects.flatMap((project) => project.files).length;
    const next = prototypeReducer(state, { type: 'removePartner', partnerId: removedId, removedAt: '2026-09-09T00:00:00.000Z' });

    expect(next.partners.find((partner) => partner.id === removedId)).toMatchObject({ isRemoved: true, status: 'offline' });
    expect(next.conversations).toHaveLength(conversations);
    expect(next.projects).toHaveLength(projects);
    expect(next.projects.flatMap((project) => project.files)).toHaveLength(files);
    expect(next.groupChats.some((group) => group.memberIds.includes(removedId))).toBe(true);
    expect(next.activePartnerId).not.toBe(removedId);
  });

  it('edits and deletes an independent group without deleting its project or files', () => {
    const state = createTestState();
    const group = state.groupChats.find((item) => item.memberIds.length < state.partners.length)!;
    const project = state.projects.find((item) => item.id === group.projectId)!;
    const candidate = state.partners.find((partner) => !group.memberIds.includes(partner.id))!;
    const added = prototypeReducer(state, { type: 'toggleGroupMember', groupChatId: group.id, partnerId: candidate.id });
    const removedAgain = prototypeReducer(added, { type: 'toggleGroupMember', groupChatId: group.id, partnerId: candidate.id });
    const renamed = prototypeReducer(removedAgain, { type: 'updateGroupChat', groupChat: { ...group, name: '改名后的群聊' } });
    const deleted = prototypeReducer(renamed, { type: 'removeGroupChat', groupChatId: group.id });

    expect(added.groupChats.find((item) => item.id === group.id)?.memberIds).toContain(candidate.id);
    expect(added.projects.find((item) => item.id === project.id)?.memberIds).toContain(candidate.id);
    expect(removedAgain.groupChats.find((item) => item.id === group.id)?.memberIds).not.toContain(candidate.id);
    expect(removedAgain.projects.find((item) => item.id === project.id)?.memberIds).toContain(candidate.id);
    expect(renamed.groupChats.find((item) => item.id === group.id)?.name).toBe('改名后的群聊');
    expect(deleted.groupChats.find((item) => item.id === group.id)).toBeUndefined();
    expect(deleted.projects.find((item) => item.id === project.id)?.files).toEqual(project.files);
  });

  it('archives and restores a group only in Asterium state', () => {
    const state = createTestState();
    const group = state.groupChats.find((item) => item.id === state.activeGroupChatId) ?? state.groupChats[0];
    const project = state.projects.find((item) => item.id === group.projectId)!;
    const archivedAt = '2026-10-11T20:30:00.000Z';
    const archived = prototypeReducer(state, { type: 'archiveGroupChat', groupChatId: group.id, archivedAt });
    const restored = prototypeReducer(archived, { type: 'restoreGroupChat', groupChatId: group.id });

    expect(archived.groupChats.find((item) => item.id === group.id)?.archivedAt).toBe(archivedAt);
    expect(archived.activeGroupChatId).not.toBe(group.id);
    expect(restored.groupChats.find((item) => item.id === group.id)?.archivedAt).toBeUndefined();
    expect(restored.projects.find((item) => item.id === project.id)).toEqual(project);
  });

  it('updates project card details without replacing project contents', () => {
    const state = createTestState();
    const project = state.projects[0];
    const nextProject = { ...project, name: '新的项目名称', description: '新的简介', avatarDataUrl: 'data:image/png;base64,avatar' };
    const next = prototypeReducer(state, { type: 'updateProject', project: nextProject });

    expect(next.projects.find((item) => item.id === project.id)).toMatchObject({
      name: '新的项目名称',
      description: '新的简介',
      avatarDataUrl: 'data:image/png;base64,avatar',
      files: project.files,
      tasks: project.tasks,
    });
  });

  it('removes project leavers from every project group while keeping other project members', () => {
    const state = createTestState();
    const group = state.groupChats[0];
    const project = state.projects.find((item) => item.id === group.projectId)!;
    const leaving = group.memberIds[0];
    const nextMembers = project.memberIds.filter((id) => id !== leaving);
    const next = prototypeReducer(state, { type: 'setProjectMembers', projectId: project.id, memberIds: nextMembers });

    expect(next.projects.find((item) => item.id === project.id)?.memberIds).toEqual(nextMembers);
    expect(next.groupChats.filter((item) => item.projectId === project.id).every((item) => !item.memberIds.includes(leaving))).toBe(true);
  });

  it('pins and unpins a conversation', () => {
    const state = createTestState();
    const conversationId = state.conversations[0].id;
    const pinned = prototypeReducer(state, { type: 'toggleConversationPin', conversationId });
    const unpinned = prototypeReducer(pinned, { type: 'toggleConversationPin', conversationId });
    expect(pinned.conversations[0].isPinned).toBe(true);
    expect(unpinned.conversations[0].isPinned).toBe(false);
  });

  it('renames and archives conversations without touching the upstream session', () => {
    const state = createTestState();
    const target = state.conversations[0];
    const renamed = prototypeReducer(state, { type: 'renameConversation', conversationId: target.id, title: '  新标题  ' });
    const renamedTarget = renamed.conversations.find((item) => item.id === target.id);
    expect(renamedTarget?.title).toBe('新标题');
    expect(renamedTarget?.sessionId).toBe(target.sessionId);
    const archived = prototypeReducer(renamed, { type: 'archiveConversation', conversationId: target.id, archivedAt: '2026-09-12T00:00:00.000Z' });
    const archivedTarget = archived.conversations.find((item) => item.id === target.id);
    expect(archivedTarget).toMatchObject({ isArchived: true, archivedAt: '2026-09-12T00:00:00.000Z' });
    expect(archivedTarget?.sessionId).toBe(target.sessionId);
    expect(archived.activeConversationId).not.toBe(target.id);
  });

  it('refuses to archive a conversation while its run is active', () => {
    const state = createTestState();
    state.conversations[0] = { ...state.conversations[0], activeRun: { runId: 'run-active', clientMessageId: 'client-active' } };
    expect(prototypeReducer(state, { type: 'archiveConversation', conversationId: state.conversations[0].id, archivedAt: new Date().toISOString() })).toBe(state);
  });

  it('restores archived conversations and only permanently deletes archived records', () => {
    const state = createTestState();
    const target = state.conversations[0];
    const unchanged = prototypeReducer(state, { type: 'deleteConversationPermanently', conversationId: target.id });
    expect(unchanged).toBe(state);
    const archived = prototypeReducer(state, { type: 'archiveConversation', conversationId: target.id, archivedAt: '2026-09-12T00:00:00.000Z' });
    const restored = prototypeReducer(archived, { type: 'restoreConversation', conversationId: target.id });
    expect(restored.conversations.find((item) => item.id === target.id)?.isArchived).toBeUndefined();
    const deleted = prototypeReducer(archived, { type: 'deleteConversationPermanently', conversationId: target.id });
    expect(deleted.conversations.some((item) => item.id === target.id)).toBe(false);
  });

  it('removes Main-confirmed deleted conversations even when a stale Renderer copy was not archived', () => {
    const state = createTestState();
    const target = state.conversations[0];
    const reconciled = prototypeReducer(state, { type: 'reconcileDeletedConversations', conversationIds: [target.id] });
    expect(reconciled.conversations.some((conversation) => conversation.id === target.id)).toBe(false);
    expect(reconciled.activeConversationId).not.toBe(target.id);
  });

  it('mirrors confirmed native archive, restore, and deletion states', () => {
    const state = createTestState();
    const target = state.conversations[0];
    const archived = prototypeReducer(state, { type: 'syncNativeThreadLifecycle', conversationId: target.id, state: 'archived', checkedAt: '2026-10-04T01:00:00.000Z' });
    expect(archived.conversations.find((item) => item.id === target.id)).toMatchObject({ isArchived: true, nativeThreadState: 'archived' });

    const restored = prototypeReducer(archived, { type: 'syncNativeThreadLifecycle', conversationId: target.id, state: 'active', checkedAt: '2026-10-04T01:01:00.000Z' });
    expect(restored.conversations.find((item) => item.id === target.id)).toMatchObject({ nativeThreadState: 'active' });
    expect(restored.conversations.find((item) => item.id === target.id)?.isArchived).toBeUndefined();

    const deleted = prototypeReducer(restored, { type: 'syncNativeThreadLifecycle', conversationId: target.id, state: 'deleted', checkedAt: '2026-10-04T01:02:00.000Z' });
    expect(deleted.conversations.some((item) => item.id === target.id)).toBe(false);
  });

  it('does not reopen a locally archived conversation just because its native thread is still active', () => {
    const state = createTestState();
    const target = state.conversations[0];
    state.conversations[0] = { ...target, nativeThreadState: 'active', nativeThreadStateCheckedAt: '2026-10-04T01:00:00.000Z' };
    const archived = prototypeReducer(state, { type: 'archiveConversation', conversationId: target.id, archivedAt: '2026-10-04T01:01:00.000Z' });
    const synchronized = prototypeReducer(archived, { type: 'syncNativeThreadLifecycle', conversationId: target.id, state: 'active', checkedAt: '2026-10-04T01:02:00.000Z' });

    expect(synchronized.conversations.find((item) => item.id === target.id)).toMatchObject({ isArchived: true, nativeThreadState: 'active' });
  });

  it('archives all conversations left by a removed partner in one action', () => {
    const state = createTestState();
    const partnerId = state.partners[0].id;
    const removed = prototypeReducer(state, { type: 'removePartner', partnerId, removedAt: '2026-09-12T00:00:00.000Z' });
    const archived = prototypeReducer(removed, { type: 'archivePartnerConversations', partnerId, archivedAt: '2026-09-12T00:01:00.000Z' });
    expect(archived.conversations.filter((conversation) => conversation.partnerId === partnerId).every((conversation) => conversation.isArchived)).toBe(true);
    expect(archived.conversations.filter((conversation) => conversation.partnerId !== partnerId).some((conversation) => !conversation.isArchived)).toBe(true);
  });

  it('creates and activates a local project shell', () => {
    const state = createTestState();
    const project = { ...state.projects[0], id: 'project-new', name: '新项目' };
    const next = prototypeReducer(state, { type: 'createProject', project });
    expect(next.projects[0]).toEqual(project);
    expect(next.activeProjectId).toBe(project.id);
  });

  it('removes a project, archives its groups, and selects the next active project', () => {
    const state = createTestState();
    const target = state.projects.find((project) => project.id === state.activeProjectId) ?? state.projects[0];
    const archivedAt = '2026-10-18T10:00:00.000Z';
    const next = prototypeReducer(state, { type: 'removeProject', projectId: target.id, archivedAt });

    expect(next.projects.some((project) => project.id === target.id)).toBe(false);
    expect(next.groupChats.filter((group) => group.projectId === target.id)).not.toHaveLength(0);
    expect(next.groupChats.filter((group) => group.projectId === target.id).every((group) => group.archivedAt === archivedAt)).toBe(true);
    expect(next.groupChats.filter((group) => group.projectId === target.id).every((group) => group.projectDeletedAt === archivedAt)).toBe(true);
    expect(next.activeProjectId).toBe(next.projects[0]?.id ?? '');
    expect(next.activeGroupChatId).toBe(next.groupChats.find((group) => group.projectId === next.activeProjectId && !group.archivedAt)?.id ?? '');
  });

  it('keeps single messages and group ledger projections independent for the same partner', () => {
    const state = createTestState();
    const messageTime = '2026-10-13T00:00:00.000Z';
    const partner = state.partners[0];
    const conversation = state.conversations.find((item) => item.partnerId === partner.id)!;
    const group = state.groupChats.find((item) => item.memberIds.includes(partner.id))!;
    const originalSingleMessages = structuredClone(conversation.messages);
    const originalGroupMessages = structuredClone(group.messages);

    const withGroupProjection = prototypeReducer(state, {
      type: 'hydrateStudioMessages',
      groupChatId: group.id,
      messages: [{ id: 'studio-only', authorId: partner.id, content: '只属于群聊', createdAt: messageTime }],
    });
    expect(withGroupProjection.conversations.find((item) => item.id === conversation.id)?.messages).toEqual(originalSingleMessages);
    expect(withGroupProjection.groupChats.find((item) => item.id === group.id)?.messages.map((item) => item.content)).toEqual(['只属于群聊']);

    const withSingleMessage = prototypeReducer(withGroupProjection, {
      type: 'sendChatMessage',
      conversationId: conversation.id,
      message: { id: 'single-only', authorId: ASTERIUM_USER_ID, content: '只属于单聊', createdAt: messageTime },
    });
    expect(withSingleMessage.groupChats.find((item) => item.id === group.id)?.messages.map((item) => item.content)).toEqual(['只属于群聊']);
    expect(withSingleMessage.conversations.find((item) => item.id === conversation.id)?.messages).toEqual([
      ...originalSingleMessages,
      expect.objectContaining({ id: 'single-only', content: '只属于单聊' }),
    ]);
    expect(originalGroupMessages).not.toEqual(withSingleMessage.groupChats.find((item) => item.id === group.id)?.messages);
  });

  it('applies all four delivery states independently from run state', () => {
    const state = createTestState();
    const conversation = state.conversations[0];
    const withPending = prototypeReducer(state, {
      type: 'sendChatMessage', conversationId: conversation.id,
      message: { id: 'delivery-message', authorId: ASTERIUM_USER_ID, content: '测试四态', createdAt: '12:00', clientMessageId: 'client-delivery', status: 'sending' },
    });
    const states = ['awaiting_confirmation', 'delivered', 'failed'] as const;
    const final = states.reduce((current, deliveryState, index) => prototypeReducer(current, {
      type: 'agentEvent',
      event: {
        protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.delivery', eventId: `delivery-${index}`,
        partnerId: conversation.partnerId, conversationId: conversation.id, connectionSource: 'local_cli',
        clientMessageId: 'client-delivery', state: deliveryState, occurredAt: new Date(index).toISOString(),
      },
    }), withPending);
    expect(final.conversations[0].messages.at(-1)?.status).toBe('failed');
  });

  it('accepts sequence numbers that restart for a new run in the same conversation', () => {
    const state = createTestState();
    const conversation = state.conversations[0];
    const base = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      partnerId: conversation.partnerId,
      conversationId: conversation.id,
      connectionSource: 'local_cli' as const,
      clientMessageId: 'client-second',
      sessionId: 'session-shared',
      occurredAt: new Date().toISOString(),
    };
    const afterOldRun = {
      ...state,
      conversations: state.conversations.map((item) => item.id === conversation.id
        ? { ...item, lastRunId: 'run-first', lastSequence: 8, messages: [...item.messages, { id: 'user-second', authorId: ASTERIUM_USER_ID, content: '第二轮', createdAt: '12:00', clientMessageId: 'client-second' }] }
        : item),
    };
    const bound = prototypeReducer(afterOldRun, {
      type: 'agentEvent',
      event: { ...base, type: 'session.bound', eventId: 'second-1', runId: 'run-second', sequence: 1, isNew: false },
    });
    const withText = prototypeReducer(bound, {
      type: 'agentEvent',
      event: { ...base, type: 'text.delta', eventId: 'second-2', runId: 'run-second', sequence: 2, text: '第二轮回复' },
    });
    expect(withText.conversations[0]).toMatchObject({ lastRunId: 'run-second', lastSequence: 2 });
    expect(withText.conversations[0].messages.at(-1)?.content).toBe('第二轮回复');
  });

  it('records protocol v2 only when a newly started Codex thread reports it', () => {
    const state = createTestState();
    const conversation = state.conversations[0];
    const base = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      partnerId: conversation.partnerId,
      conversationId: conversation.id,
      connectionSource: 'local_cli' as const,
      clientMessageId: 'client-protocol',
      sessionId: 'thread-protocol',
      runId: 'run-protocol',
      occurredAt: '2026-10-18T00:00:00.000Z',
    };
    const protocolState = {
      ...state,
      conversations: state.conversations.map((item) => item.id === conversation.id ? {
        ...item,
        activeRun: { runId: base.runId, clientMessageId: base.clientMessageId },
      } : item),
    };
    const legacyState = {
      ...protocolState,
      conversations: protocolState.conversations.map((item) => item.id === conversation.id ? { ...item, nativeToolProtocolVersion: 1 } : item),
    };
    const resumedLegacy = prototypeReducer(legacyState, {
      type: 'agentEvent',
      event: { ...base, type: 'session.bound', eventId: 'legacy-bound', sequence: 1, isNew: false },
    });
    expect(resumedLegacy.conversations[0].nativeToolProtocolVersion).toBe(1);

    const startedV2 = prototypeReducer(protocolState, {
      type: 'agentEvent',
      event: { ...base, type: 'session.bound', eventId: 'v2-bound', sequence: 1, isNew: true, toolProtocolVersion: CODEX_NATIVE_TOOL_PROTOCOL_VERSION },
    });
    expect(startedV2.conversations[0].nativeToolProtocolVersion).toBe(CODEX_NATIVE_TOOL_PROTOCOL_VERSION);
  });

  it('marks a completed background reply unread and clears it only when the conversation is selected', () => {
    const state = createTestState();
    const conversation = state.conversations[0];
    const base = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      partnerId: conversation.partnerId,
      conversationId: conversation.id,
      connectionSource: 'local_cli' as const,
      clientMessageId: 'client-unread',
      sessionId: 'session-unread',
      runId: 'run-unread',
      occurredAt: '2026-09-30T12:00:00.000Z',
    };
    state.conversations[0] = { ...conversation, sessionId: base.sessionId, activeRun: { runId: base.runId, clientMessageId: base.clientMessageId }, messages: [...conversation.messages, { id: 'user-unread', authorId: ASTERIUM_USER_ID, content: '后台测试', createdAt: '12:00', clientMessageId: base.clientMessageId }] };
    const withText = prototypeReducer(state, { type: 'agentEvent', event: { ...base, type: 'text.delta', eventId: 'unread-text', sequence: 1, text: '后台回复完成。' } });
    const completed = prototypeReducer(withText, { type: 'agentEvent', unreadOnCompletion: true, event: { ...base, type: 'run.completed', eventId: 'unread-complete', sequence: 2, finishReason: 'end_turn' } });
    expect(completed.conversations[0].unreadCompletedAt).toBe(base.occurredAt);

    const selected = prototypeReducer(completed, { type: 'selectConversation', conversationId: conversation.id });
    expect(selected.conversations[0].unreadCompletedAt).toBeUndefined();

    const visibleCompletion = prototypeReducer(withText, { type: 'agentEvent', unreadOnCompletion: false, event: { ...base, type: 'run.completed', eventId: 'visible-complete', sequence: 2, finishReason: 'end_turn' } });
    expect(visibleCompletion.conversations[0].unreadCompletedAt).toBeUndefined();
  });

  it('does not mark failed runs or empty successful runs unread', () => {
    const state = createTestState();
    const conversation = state.conversations[0];
    const base = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      partnerId: conversation.partnerId,
      conversationId: conversation.id,
      connectionSource: 'local_cli' as const,
      clientMessageId: 'client-no-unread',
      sessionId: 'session-no-unread',
      runId: 'run-no-unread',
      occurredAt: '2026-09-30T12:05:00.000Z',
    };
    state.conversations[0] = { ...conversation, sessionId: base.sessionId, activeRun: { runId: base.runId, clientMessageId: base.clientMessageId }, messages: [...conversation.messages, { id: 'user-no-unread', authorId: ASTERIUM_USER_ID, content: '测试', createdAt: '12:00', clientMessageId: base.clientMessageId }] };
    const failed = prototypeReducer(state, { type: 'agentEvent', unreadOnCompletion: true, event: { ...base, type: 'run.failed', eventId: 'failed-run', sequence: 1, error: { code: 'FAILED', message: '失败', stage: 'adapter', retryable: false } } });
    expect(failed.conversations[0].unreadCompletedAt).toBeUndefined();
    const completed = prototypeReducer(state, { type: 'agentEvent', unreadOnCompletion: true, event: { ...base, type: 'run.completed', eventId: 'empty-complete', sequence: 1, finishReason: 'end_turn' } });
    expect(completed.conversations[0].unreadCompletedAt).toBeUndefined();
  });

  it('leaves Plan mode when a native partner starts executing the confirmed plan', () => {
    const state = createTestState();
    const conversation = { ...state.conversations[0], planMode: 'plan' as const, planStatus: 'ready' as const, sessionId: 'session-plan', activeRun: { runId: 'run-plan', clientMessageId: 'client-plan' }, messages: [...state.conversations[0].messages, { id: 'user-plan', authorId: ASTERIUM_USER_ID, content: '制定计划', createdAt: '12:00', clientMessageId: 'client-plan' }] };
    state.conversations[0] = conversation;
    const next = prototypeReducer(state, { type: 'agentEvent', event: {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'plan.updated',
      eventId: 'plan-executing',
      partnerId: conversation.partnerId,
      conversationId: conversation.id,
      connectionSource: 'local_cli',
      clientMessageId: 'client-plan',
      sessionId: 'session-plan',
      runId: 'run-plan',
      sequence: 1,
      occurredAt: '2026-10-01T01:00:00.000Z',
      status: 'executing',
      planMode: 'default',
      explanation: '开始执行',
    } });

    expect(next.conversations[0]).toMatchObject({ planMode: 'default', planStatus: 'executing' });
  });

  it('keeps Plan events in conversation A while B is active, including after restart and replay', () => {
    const initial = createTestState();
    const partner = initial.partners.find((item) => item.sourceMode === 'local_cli')!;
    const original = initial.conversations.find((item) => item.partnerId === partner.id)!;
    const conversationA = {
      ...original,
      id: 'conversation-plan-a',
      title: '对话 A',
      sessionId: 'native-thread-a',
      planMode: 'plan' as const,
      activeRun: { runId: 'run-plan-a', clientMessageId: 'client-plan-a' },
      messages: [{ id: 'user-plan-a', authorId: ASTERIUM_USER_ID, content: '请先制定计划', createdAt: '12:00', clientMessageId: 'client-plan-a' }],
    };
    const conversationB = {
      ...original,
      id: 'conversation-plan-b',
      title: '对话 B',
      sessionId: 'native-thread-b',
      messages: [{ id: 'user-plan-b', authorId: ASTERIUM_USER_ID, content: 'B 的内容', createdAt: '12:01', clientMessageId: 'client-plan-b' }],
      activeRun: undefined,
    };
    let state: PrototypeState = {
      ...initial,
      conversations: [conversationA, conversationB, ...initial.conversations.filter((item) => item.id !== original.id)],
      activePartnerId: partner.id,
      activeConversationId: conversationA.id,
    };
    state = prototypeReducer(state, { type: 'selectConversation', conversationId: conversationB.id });
    const base = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      partnerId: partner.id,
      conversationId: conversationA.id,
      connectionSource: 'local_cli' as const,
      clientMessageId: 'client-plan-a',
      sessionId: 'native-thread-a',
      runId: 'run-plan-a',
      occurredAt: '2026-10-09T02:00:00.000Z',
    };
    const events = [
      { ...base, type: 'plan.updated' as const, eventId: 'plan-a-1', sequence: 1, status: 'planning' as const, explanation: '开始规划' },
      { ...base, type: 'text.delta' as const, eventId: 'plan-a-2', sequence: 2, text: '只属于 A 的计划正文' },
      { ...base, type: 'plan.updated' as const, eventId: 'plan-a-3', sequence: 3, status: 'ready' as const, explanation: '计划已就绪' },
    ];
    for (const event of events) state = prototypeReducer(state, { type: 'agentEvent', event });

    const aBeforeRestart = state.conversations.find((item) => item.id === conversationA.id)!;
    const bBeforeRestart = state.conversations.find((item) => item.id === conversationB.id)!;
    expect(aBeforeRestart.messages.at(-1)?.content).toBe('只属于 A 的计划正文');
    expect(aBeforeRestart.messages.at(-1)?.timeline?.filter((item) => item.kind === 'plan')).toHaveLength(1);
    expect(bBeforeRestart.messages).toEqual(conversationB.messages);
    expect(state.activeConversationId).toBe(conversationB.id);

    savePrototypeState(state);
    const restored = loadPrototypeState();
    const replayed = events.reduce((current, event) => prototypeReducer(current, { type: 'agentEvent', event }), restored);
    const aAfterRestart = replayed.conversations.find((item) => item.id === conversationA.id)!;
    const bAfterRestart = replayed.conversations.find((item) => item.id === conversationB.id)!;
    expect(aAfterRestart.messages.at(-1)?.content).toBe('只属于 A 的计划正文');
    expect(aAfterRestart.messages.at(-1)?.timeline?.filter((item) => item.kind === 'plan')).toHaveLength(1);
    expect(bAfterRestart.messages).toEqual(conversationB.messages);
  });

  it('gives the assistant segments on either side of accepted guidance distinct message ids', () => {
    const initial = createTestState();
    const conversation = initial.conversations[0];
    initial.conversations[0] = {
      ...conversation,
      sessionId: 'thread-guidance',
      activeRun: { runId: 'run-guidance', clientMessageId: 'client-original' },
      messages: [
        { id: 'user-original', authorId: ASTERIUM_USER_ID, content: '先开始规划', createdAt: '12:00', clientMessageId: 'client-original', runId: 'run-guidance' },
        { id: 'assistant-run-guidance', authorId: conversation.partnerId, content: '插话前回复', createdAt: '12:01', runId: 'run-guidance', runState: 'running', isStreaming: true },
      ],
    };

    let state = prototypeReducer(initial, {
      type: 'sendChatGuidance',
      conversationId: conversation.id,
      runId: 'run-guidance',
      message: { id: 'user-guidance', authorId: ASTERIUM_USER_ID, content: '中途补充', createdAt: '12:02', clientMessageId: 'client-guidance', runId: 'run-guidance', isGuidance: true },
    });
    state = prototypeReducer(state, { type: 'agentEvent', event: {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'text.delta',
      eventId: 'guidance-text-after',
      partnerId: conversation.partnerId,
      conversationId: conversation.id,
      connectionSource: 'local_cli',
      clientMessageId: 'client-original',
      sessionId: 'thread-guidance',
      runId: 'run-guidance',
      sequence: 1,
      occurredAt: '2026-10-09T12:03:00.000Z',
      text: '插话后回复',
    } });

    const assistantMessages = state.conversations[0].messages.filter((message) => message.authorId !== ASTERIUM_USER_ID);
    expect(assistantMessages.map((message) => message.content)).toEqual(['插话前回复', '插话后回复']);
    expect(new Set(assistantMessages.map((message) => message.id)).size).toBe(2);
    expect(assistantMessages[0].id).toContain(':before-guidance:user-guidance');
  });

  it('rejects events whose partner, native thread, or active run do not match the target conversation', () => {
    const state = createTestState();
    const conversation = state.conversations[0];
    state.conversations[0] = {
      ...conversation,
      sessionId: 'thread-correct',
      activeRun: { runId: 'run-correct', clientMessageId: 'client-correct' },
      messages: [...conversation.messages, { id: 'user-correct', authorId: ASTERIUM_USER_ID, content: '正确消息', createdAt: '12:00', clientMessageId: 'client-correct' }],
    };
    const foreign = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'plan.updated' as const,
      eventId: 'foreign-plan',
      partnerId: conversation.partnerId,
      conversationId: conversation.id,
      connectionSource: 'local_cli' as const,
      clientMessageId: 'client-foreign',
      sessionId: 'thread-foreign',
      runId: 'run-foreign',
      sequence: 1,
      occurredAt: '2026-10-09T02:10:00.000Z',
      status: 'planning' as const,
    };
    expect(prototypeReducer(state, { type: 'agentEvent', event: foreign })).toBe(state);
  });

  it('updates the same existing-thread partner and conversation when CyberBoss changes threads', () => {
    const state = createTestState();
    state.partners.push({
      id: 'existing-dynamic', publicIdentity: { displayName: '外部伙伴', introduction: '', expertise: '', mentionName: '外部伙伴' },
      status: 'online', isPrototype: false, createdAt: '2026-09-12T00:00:00.000Z', accent: '#67b5a4',
      sourceMode: 'existing_thread', serviceType: 'cyberboss_server', serviceUrl: 'https://cyberboss.example.invalid',
      threadId: 'thread-before-123', workspaceRoot: '/workspace/example-project', connectionLabel: 'CyberBoss', connectionStatus: 'connected', configured: true,
    });
    state.conversations.push({ id: 'existing-window', partnerId: 'existing-dynamic', title: '外部伙伴', messages: [], updatedAt: '2026-09-12T00:00:00.000Z', sessionId: 'thread-before-123' });
    const next = prototypeReducer(state, { type: 'agentEvent', event: {
      protocolVersion: AGENT_PROTOCOL_VERSION, type: 'existing_thread.changed', eventId: 'thread-event-1', partnerId: 'existing-dynamic',
      connectionSource: 'existing_thread', threadId: 'thread-after-456', previousThreadId: 'thread-before-123', workspaceRoot: '/workspace/example-project', reason: 'new', occurredAt: '2026-09-12T02:00:00.000Z',
    } });
    expect(next.partners.find((partner) => partner.id === 'existing-dynamic')).toMatchObject({ threadId: 'thread-after-456', workspaceRoot: '/workspace/example-project' });
    expect(next.conversations.find((conversation) => conversation.id === 'existing-window')).toMatchObject({ sessionId: 'thread-after-456', title: '外部伙伴' });
    expect(next.conversations.filter((conversation) => conversation.partnerId === 'existing-dynamic')).toHaveLength(1);
  });
});
