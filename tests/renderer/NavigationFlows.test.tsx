import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { PrototypeProvider, usePrototype } from '../../src/renderer/app/PrototypeProvider';
import { STATE_KEY } from '../../src/renderer/app/persistence';
import { createTestState } from '../fixtures/applicationState';
import { ChatPage } from '../../src/renderer/pages/ChatPage';
import { StudioPage } from '../../src/renderer/pages/StudioPage';
import { AGENT_PROTOCOL_VERSION, type RendererAgentEvent } from '../../src/shared/agentProtocol';
import type { ProjectRecord } from '../../src/shared/projectDomain';
import type { ProjectWorkflowGenerationStartRequest } from '../../src/shared/projectWorkflowGeneration';
import type { StudioRoomSnapshot } from '../../src/shared/studioRuntime';

function projectRecord(project: ReturnType<typeof createTestState>['projects'][number]): ProjectRecord {
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

function withProvider(children: React.ReactNode, initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PrototypeProvider>{children}</PrototypeProvider>
    </MemoryRouter>,
  );
}

function ExistingThreadHarness() {
  const { state, createConversation, ensureConversation } = usePrototype();
  const conversations = state.conversations.filter((conversation) => conversation.partnerId === 'existing-one');
  return <div>
    <span>窗口数 {conversations.length}</span>
    <span>窗口状态 {conversations[0]?.isArchived ? '已归档' : '已恢复'}</span>
    <button type="button" onClick={() => ensureConversation('existing-one')}>接回现有窗口</button>
    <button type="button" onClick={() => createConversation('existing-one', '不应创建')}>尝试新建窗口</button>
  </div>;
}

function NativeLifecycleHarness({ conversationId }: { conversationId: string }) {
  const { state } = usePrototype();
  return <span>{state.conversations.some((conversation) => conversation.id === conversationId) ? '仍有记录' : '记录已清理'}</span>;
}

function NativeStateHarness({ conversationId }: { conversationId: string }) {
  const { state } = usePrototype();
  const conversation = state.conversations.find((item) => item.id === conversationId);
  return <span>{conversation?.nativeThreadState ?? '未知'} · {conversation?.nativeThreadNotice?.message ?? '无提示'}</span>;
}

function LocalDeleteHarness({ conversationId }: { conversationId: string }) {
  const { state, deleteConversationPermanently } = usePrototype();
  const exists = state.conversations.some((conversation) => conversation.id === conversationId);
  return <div>
    <span>{exists ? '残留仍在' : '残留已删除'}</span>
    {exists && <button type="button" onClick={() => void deleteConversationPermanently(conversationId)}>删除本地残留</button>}
  </div>;
}

function AttachmentProbeHarness({ conversationId, attachmentId }: { conversationId: string; attachmentId: string }) {
  const { state } = usePrototype();
  const exists = state.conversations.some((conversation) => conversation.id === conversationId);
  useEffect(() => {
    if (exists) void window.asteriumAttachments?.inspect(attachmentId, conversationId);
  }, [attachmentId, conversationId, exists]);
  return <span>{exists ? '残留已挂载' : '残留未挂载'}</span>;
}

describe('navigation shell interactions', () => {
  it('searches visible bodies in the current chat, highlights matches and clears the query when switching chats', async () => {
    const state = createTestState();
    state.conversations[0].messages[0].content = '第一条含 **Al**pha 和 alpha。';
    state.conversations[0].messages[0].toolNote = '仅工具标记';
    state.conversations[0].messages[1].content = '第二条也有 ALPHA。';
    state.conversations[1].messages[0].content = '另一条单聊含 alpha。';
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const registry = new Map<string, Set<Range>>();
    vi.stubGlobal('CSS', { highlights: registry });
    vi.stubGlobal('Highlight', class extends Set<Range> {});
    try {
      withProvider(<ChatPage />, '/chat');
      const trigger = screen.getByRole('button', { name: '搜索当前对话' });
      fireEvent.click(trigger);
      const bar = screen.getByRole('search', { name: '当前对话搜索' });
      const input = within(bar).getByRole('searchbox');
      const count = within(bar).getByRole('status');
      expect(input).toHaveFocus();
      fireEvent.change(input, { target: { value: 'alpha' } });
      await waitFor(() => expect(count).toHaveTextContent('1 / 2'));
      const current = () => [...(registry.get('asterium-conversation-search-current') ?? [])].map(range => range.toString());
      expect(current()).toEqual(['Alpha', 'alpha']);
      fireEvent.click(within(bar).getByRole('button', { name: '下一条匹配' }));
      expect(count).toHaveTextContent('2 / 2');
      expect(current()).toEqual(['ALPHA']);
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
      expect(count).toHaveTextContent('1 / 2');

      fireEvent.change(input, { target: { value: '仅工具标记' } });
      await waitFor(() => expect(count).toHaveTextContent('无匹配'));
      expect(registry.size).toBe(0);
      fireEvent.change(input, { target: { value: 'alpha' } });
      await waitFor(() => expect(count).toHaveTextContent('1 / 2'));
      fireEvent.click(screen.getByRole('button', { name: '视觉细节' }));
      const nextInput = screen.getByRole('searchbox', { name: '搜索当前对话正文' });
      expect(nextInput).toHaveValue('');
      fireEvent.change(nextInput, { target: { value: 'alpha' } });
      await waitFor(() => expect(within(screen.getByRole('search')).getByRole('status')).toHaveTextContent('1 / 1'));
      fireEvent.keyDown(nextInput, { key: 'Escape' });
      expect(screen.queryByRole('searchbox', { name: '搜索当前对话正文' })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(registry.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('requires a partner and groups a newly created chat under that partner', () => {
    withProvider(<ChatPage />, '/chat');
    fireEvent.click(screen.getByRole('button', { name: '创建对话' }));
    const dialog = screen.getByRole('dialog', { name: '创建对话' });
    fireEvent.click(screen.getByRole('radio', { name: /测试伙伴 B/ }));
    fireEvent.change(screen.getByLabelText(/对话名称/), { target: { value: '指定伙伴的新对话' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建对话' }));
    expect(screen.getByText('指定伙伴的新对话')).toBeInTheDocument();
  });

  it('uses the whole partner row to expand and collapse conversations', () => {
    const view = withProvider(<ChatPage />, '/chat');
    const activePartnerRow = screen.getByRole('button', { name: '收起 测试伙伴 A 的对话' });
    expect(activePartnerRow).toHaveAttribute('aria-expanded', 'true');
    expect(view.container.querySelector('.partner-disclosure')).not.toBeInTheDocument();

    fireEvent.click(activePartnerRow);
    expect(screen.getByRole('button', { name: '展开 测试伙伴 A 的对话' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: '展开 测试伙伴 B 的对话' }));
    expect(screen.getByRole('button', { name: '收起 测试伙伴 B 的对话' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('marks partner avatars with their connection source', () => {
    const state = createTestState();
    state.partners.push({
      id: 'existing-avatar',
      publicIdentity: { displayName: '现有头像伙伴', introduction: '', expertise: '', mentionName: '现有头像伙伴' },
      status: 'online',
      isPrototype: false,
      createdAt: '2026-09-15T00:00:00.000Z',
      accent: '#7890ac',
      sourceMode: 'existing_thread',
      serviceType: 'cyberboss_server',
      serviceUrl: 'https://bridge.example.test',
      threadId: 'thread-avatar',
      connectionLabel: 'CyberBoss 服务器',
      connectionStatus: 'connected',
      configured: true,
    });
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    withProvider(<ChatPage />, '/chat');

    const orbit = screen.getByLabelText('伙伴快速切换');
    expect(orbit.querySelectorAll('.avatar--source-local-cli')).toHaveLength(2);
    expect(orbit.querySelector('.avatar--source-api-partner')).toBeInTheDocument();
    expect(orbit.querySelector('.avatar--source-existing-thread')).toBeInTheDocument();
    expect(within(orbit).getByTitle('测试伙伴 A').querySelector('.avatar')).toHaveClass('avatar--selected');
  });

  it('pins a conversation and filters local chat records', () => {
    withProvider(<ChatPage />, '/chat');
    fireEvent.click(screen.getByRole('button', { name: '置顶 测试对话' }));
    const pinned = screen.getByRole('region', { name: '置顶对话' });
    expect(within(pinned).getByText('测试对话')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索聊天记录'), { target: { value: '复核' } });
    expect(screen.getByText('交互复核')).toBeInTheDocument();
    expect(screen.queryByText('视觉细节')).not.toBeInTheDocument();
  });

  it('jumps directly to the latest message when switching conversations', () => {
    const view = withProvider(<ChatPage />, '/chat');
    const messageList = view.container.querySelector<HTMLElement>('.message-list')!;
    Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1_400 });
    Object.defineProperty(messageList, 'clientHeight', { configurable: true, value: 400 });
    messageList.scrollTop = 120;
    fireEvent.scroll(messageList);

    fireEvent.click(screen.getByRole('button', { name: '交互复核' }));

    expect(messageList.scrollTop).toBe(1_400);
  });

  it('does not leave a duplicate-key Plan bubble behind after switching to another partner', () => {
    const state = createTestState();
    const conversation = state.conversations[0];
    state.conversations[0] = {
      ...conversation,
      messages: [
        { id: 'assistant-legacy-plan', authorId: conversation.partnerId, content: '只属于 Plan 对话的前半段', createdAt: '12:00', runId: 'run-plan:before-guidance:user-guidance' },
        { id: 'assistant-legacy-plan', authorId: conversation.partnerId, content: '只属于 Plan 对话的后半段', createdAt: '12:01', runId: 'run-plan' },
      ],
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    withProvider(<ChatPage />, '/chat');
    expect(screen.getByText('只属于 Plan 对话的前半段')).toBeInTheDocument();
    expect(screen.getByText('只属于 Plan 对话的后半段')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开 测试伙伴 B 的对话' }));
    fireEvent.click(screen.getByRole('button', { name: '交互复核' }));

    expect(screen.queryByText('只属于 Plan 对话的前半段')).not.toBeInTheDocument();
    expect(screen.queryByText('只属于 Plan 对话的后半段')).not.toBeInTheDocument();
    expect(screen.getByText('我会重点检查按钮是否真的有反馈。')).toBeInTheDocument();
  });

  it('renames and archives a local conversation without touching the partner', () => {
    withProvider(<ChatPage />, '/chat');
    fireEvent.click(screen.getByRole('button', { name: '修改对话标题 测试对话' }));
    const renameDialog = screen.getByRole('dialog', { name: '修改对话标题' });
    fireEvent.change(within(renameDialog).getByLabelText('对话标题'), { target: { value: '星丛新标题' } });
    fireEvent.click(within(renameDialog).getByRole('button', { name: '保存标题' }));
    expect(screen.getByText('星丛新标题')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '归档对话 星丛新标题' }));
    const archiveDialog = screen.getByRole('dialog', { name: '归档这段对话？' });
    expect(within(archiveDialog).getByText(/不会改变 Codex、Claude Code 或其他上游线程/)).toBeInTheDocument();
    fireEvent.click(within(archiveDialog).getByRole('button', { name: '确认归档' }));
    expect(screen.queryByText('星丛新标题')).not.toBeInTheDocument();
    expect(screen.getAllByText('测试伙伴 A').length).toBeGreaterThan(0);
  });

  it('archives a real Codex conversation locally without changing its native thread', async () => {
    const state = createTestState();
    const local = state.partners[0];
    if (local.sourceMode !== 'local_cli') throw new Error('expected local partner');
    state.partners[0] = {
      ...local,
      isPrototype: false,
      connectionKind: 'local_codex',
      adapterType: 'codex_cli',
      partnerRootGrantId: 'grant-root',
      codexRuntimeId: 'runtime-desktop',
      codexRuntime: { executableLabel: 'codex.exe', environment: 'desktop_app', environmentLabel: 'Codex 桌面应用', codexHome: 'C:\\Users\\fixture-user\\.codex', loggedIn: true, version: '0.160.0' },
    };
    state.conversations[0] = { ...state.conversations[0], sessionId: 'thread-native', nativeThreadState: 'active' };
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const originalAgents = window.asteriumAgents;
    const getLocalThreadLifecycles = vi.fn(async () => [{ threadId: 'thread-native', state: 'active' as const, checkedAt: '2026-10-04T02:00:00.000Z' }]);
    const changeLocalThreadLifecycle = vi.fn(async () => ({ threadId: 'thread-native', state: 'archived' as const, checkedAt: '2026-10-04T02:01:00.000Z' }));
    window.asteriumAgents = {
      ...originalAgents,
      onEvent: originalAgents?.onEvent ?? (() => () => undefined),
      getLocalThreadLifecycles,
      changeLocalThreadLifecycle,
    } as typeof window.asteriumAgents;
    const view = withProvider(<ChatPage />, '/chat');
    try {
      await waitFor(() => expect(getLocalThreadLifecycles).toHaveBeenCalled());
      fireEvent.click(screen.getByRole('button', { name: '归档对话 测试对话' }));
      const dialog = screen.getByRole('dialog', { name: '归档这段对话？' });
      expect(within(dialog).getByText(/不会改变 Codex、Claude Code 或其他上游线程/)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: '确认归档' }));
      await waitFor(() => expect(screen.queryByText('测试对话')).not.toBeInTheDocument());
      expect(changeLocalThreadLifecycle).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      window.asteriumAgents = originalAgents;
    }
  });

  it('cleans a stale Asterium archive after a confirmed native Codex archive disappears', async () => {
    const state = createTestState();
    const local = state.partners[0];
    const conversationId = state.conversations[0].id;
    if (local.sourceMode !== 'local_cli') throw new Error('expected local partner');
    state.partners[0] = {
      ...local,
      isPrototype: false,
      connectionKind: 'local_codex',
      adapterType: 'codex_cli',
      partnerRootGrantId: 'grant-root',
      codexRuntimeId: 'runtime-desktop',
      codexRuntime: { executableLabel: 'codex.exe', environment: 'desktop_app', environmentLabel: 'Codex 桌面应用', codexHome: 'C:\\Users\\fixture-user\\.codex', loggedIn: true, version: '0.160.0' },
    };
    state.conversations[0] = {
      ...state.conversations[0],
      sessionId: 'thread-deleted-after-archive',
      isArchived: true,
      archivedAt: '2026-10-04T02:00:00.000Z',
      nativeThreadState: 'archived',
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const originalAgents = window.asteriumAgents;
    window.asteriumAgents = {
      ...originalAgents,
      onEvent: originalAgents?.onEvent ?? (() => () => undefined),
      getLocalThreadLifecycles: vi.fn(async () => [{
        threadId: 'thread-deleted-after-archive',
        state: 'unavailable' as const,
        checkedAt: '2026-10-04T02:01:00.000Z',
        message: '原生线程仍可读取，但已不在活动或归档列表。',
      }]),
    } as typeof window.asteriumAgents;
    const view = withProvider(<NativeLifecycleHarness conversationId={conversationId} />, '/chat');
    try {
      await waitFor(() => expect(screen.getByText('记录已清理')).toBeInTheDocument());
    } finally {
      view.unmount();
      window.asteriumAgents = originalAgents;
    }
  });

  it('keeps an archived Asterium record when Codex lifecycle synchronization is temporarily unavailable', async () => {
    const state = createTestState();
    const local = state.partners[0];
    const conversationId = state.conversations[0].id;
    if (local.sourceMode !== 'local_cli') throw new Error('expected local partner');
    state.partners[0] = {
      ...local,
      isPrototype: false,
      connectionKind: 'local_codex',
      adapterType: 'codex_cli',
      partnerRootGrantId: 'grant-root',
      codexRuntimeId: 'runtime-desktop',
      codexRuntime: { executableLabel: 'codex.exe', environment: 'desktop_app', environmentLabel: 'Codex 桌面应用', codexHome: 'C:\\Users\\fixture-user\\.codex', loggedIn: true, version: '0.160.0' },
    };
    state.conversations[0] = {
      ...state.conversations[0],
      sessionId: 'thread-sync-unavailable',
      isArchived: true,
      archivedAt: '2026-10-04T02:00:00.000Z',
      nativeThreadState: 'archived',
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const originalAgents = window.asteriumAgents;
    const getLocalThreadLifecycles = vi.fn(async () => [{
      threadId: 'thread-sync-unavailable',
      state: 'unavailable' as const,
      reason: 'runtime_unavailable' as const,
      checkedAt: '2026-10-04T02:01:00.000Z',
      message: 'Codex 状态运行时暂时无法初始化；星丛没有改动本地记录。',
    }]);
    window.asteriumAgents = {
      ...originalAgents,
      onEvent: originalAgents?.onEvent ?? (() => () => undefined),
      getLocalThreadLifecycles,
    } as typeof window.asteriumAgents;
    const view = withProvider(<NativeStateHarness conversationId={conversationId} />, '/chat');
    try {
      await waitFor(() => expect(getLocalThreadLifecycles).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText(/unavailable · Codex 状态运行时暂时无法初始化/)).toBeInTheDocument());
      expect(JSON.parse(localStorage.getItem(STATE_KEY)!).conversations.some((conversation: { id: string }) => conversation.id === conversationId)).toBe(true);
    } finally {
      view.unmount();
      window.asteriumAgents = originalAgents;
    }
  });

  it('keeps a newly bound active Codex thread usable while its list index catches up', async () => {
    const state = createTestState();
    const local = state.partners[0];
    const conversationId = state.conversations[0].id;
    if (local.sourceMode !== 'local_cli') throw new Error('expected local partner');
    state.partners[0] = {
      ...local,
      isPrototype: false,
      connectionKind: 'local_codex',
      adapterType: 'codex_cli',
      partnerRootGrantId: 'grant-root',
      codexRuntimeId: 'runtime-desktop',
      codexRuntime: { executableLabel: 'codex.exe', environment: 'desktop_app', environmentLabel: 'Codex 桌面应用', codexHome: 'C:\\Users\\fixture-user\\.codex', loggedIn: true, version: '0.160.0' },
    };
    state.conversations[0] = {
      ...state.conversations[0],
      sessionId: 'thread-awaiting-index',
      nativeThreadState: 'active',
      nativeThreadStateCheckedAt: '2026-10-04T02:00:00.000Z',
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const originalAgents = window.asteriumAgents;
    const getLocalThreadLifecycles = vi.fn(async () => [{
      threadId: 'thread-awaiting-index',
      state: 'unavailable' as const,
      checkedAt: '2026-10-04T02:00:01.000Z',
      message: '暂时无法确认这个原生线程的状态；星丛没有改动本地记录。',
    }]);
    window.asteriumAgents = {
      ...originalAgents,
      onEvent: originalAgents?.onEvent ?? (() => () => undefined),
      getLocalThreadLifecycles,
    } as typeof window.asteriumAgents;
    const view = withProvider(<NativeStateHarness conversationId={conversationId} />, '/chat');
    try {
      await waitFor(() => expect(getLocalThreadLifecycles).toHaveBeenCalled());
      expect(screen.getByText('active · 无提示')).toBeInTheDocument();
    } finally {
      view.unmount();
      window.asteriumAgents = originalAgents;
    }
  });

  it('deletes an existing stale archive locally without calling the native Codex lifecycle', async () => {
    const state = createTestState();
    const local = state.partners[0];
    const conversationId = state.conversations[0].id;
    if (local.sourceMode !== 'local_cli') throw new Error('expected local partner');
    state.partners[0] = {
      ...local,
      isPrototype: false,
      connectionKind: 'local_codex',
      adapterType: 'codex_cli',
      partnerRootGrantId: 'grant-root',
      codexRuntimeId: 'runtime-desktop',
    };
    state.conversations[0] = {
      ...state.conversations[0],
      sessionId: 'thread-already-deleted',
      isArchived: true,
      archivedAt: '2026-10-04T02:00:00.000Z',
      nativeThreadState: 'unavailable',
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const originalAgents = window.asteriumAgents;
    const originalConversations = window.asteriumConversations;
    const changeLocalThreadLifecycle = vi.fn();
    const deleteConversation = vi.fn(async () => ({ conversationId, cleanupPending: false }));
    window.asteriumAgents = {
      ...originalAgents,
      onEvent: originalAgents?.onEvent ?? (() => () => undefined),
      changeLocalThreadLifecycle,
    } as typeof window.asteriumAgents;
    window.asteriumConversations = { delete: deleteConversation, listDeleted: vi.fn(async () => []) };
    const view = withProvider(<LocalDeleteHarness conversationId={conversationId} />, '/chat');
    try {
      await waitFor(() => expect(screen.getByText('残留仍在')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: '删除本地残留' }));
      await waitFor(() => expect(screen.getByText('残留已删除')).toBeInTheDocument());
      expect(changeLocalThreadLifecycle).not.toHaveBeenCalled();
      expect(deleteConversation).toHaveBeenCalledWith({ conversationId, partnerId: local.id, source: 'local_cli' });
    } finally {
      view.unmount();
      window.asteriumAgents = originalAgents;
      window.asteriumConversations = originalConversations;
    }
  });

  it('reconciles a durable Main deletion before mounting attachment readers or syncing stale bindings', async () => {
    const state = createTestState();
    const target = state.conversations[0];
    state.conversations[0] = { ...target, sessionId: 'thread-stale-after-delete' };
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const originalConversations = window.asteriumConversations;
    const originalAttachments = window.asteriumAttachments;
    const originalBindings = window.asteriumNativeBindings;
    const inspect = vi.fn(async () => { throw new Error('ATTACHMENT_REFERENCE_INVALID'); });
    const syncSingle = vi.fn(async (bindings: Array<{ partnerId: string; source: 'local_cli' | 'api_partner'; conversationId: string; nativeThreadId: string }>) => { void bindings; });
    window.asteriumConversations = {
      delete: vi.fn(async (request) => ({ conversationId: request.conversationId, cleanupPending: false })),
      listDeleted: vi.fn(async () => [target.id]),
    };
    window.asteriumAttachments = { ...originalAttachments, inspect } as typeof window.asteriumAttachments;
    window.asteriumNativeBindings = { syncSingle };

    const view = withProvider(<AttachmentProbeHarness conversationId={target.id} attachmentId="attachment-stale" />, '/chat');
    try {
      await waitFor(() => expect(screen.getByText('残留未挂载')).toBeInTheDocument());
      expect(inspect).not.toHaveBeenCalled();
      expect(syncSingle.mock.calls.flatMap(([bindings]) => bindings).some((binding) => binding.conversationId === target.id)).toBe(false);
      await waitFor(() => {
        const persisted = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as { conversations?: Array<{ id: string }> };
        expect(persisted.conversations?.some((conversation) => conversation.id === target.id)).toBe(false);
      });
    } finally {
      view.unmount();
      window.asteriumConversations = originalConversations;
      window.asteriumAttachments = originalAttachments;
      window.asteriumNativeBindings = originalBindings;
    }
  });

  it('restores the single existing-thread window and refuses to create a second one', () => {
    const state = createTestState();
    state.partners.push({
      id: 'existing-one',
      publicIdentity: { displayName: '现有伙伴', introduction: '', expertise: '', mentionName: '现有伙伴' },
      status: 'online',
      isPrototype: false,
      createdAt: '2026-09-12T00:00:00.000Z',
      accent: '#69a7ff',
      sourceMode: 'existing_thread',
      serviceType: 'cyberboss_server',
      serviceUrl: 'https://bridge.example.test',
      threadId: 'thread-one',
      connectionLabel: 'CyberBoss 服务器',
      connectionStatus: 'connected',
      configured: true,
    });
    state.conversations.push({
      id: 'existing-conversation', partnerId: 'existing-one', title: '唯一窗口', messages: [],
      updatedAt: '2026-09-12T00:00:00.000Z', isArchived: true, archivedAt: '2026-09-12T01:00:00.000Z',
    });
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const harness = withProvider(<ExistingThreadHarness />, '/chat');

    expect(screen.getByText('窗口状态 已归档')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接回现有窗口' }));
    expect(screen.getByText('窗口状态 已恢复')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '尝试新建窗口' }));
    expect(screen.getByText('窗口数 1')).toBeInTheDocument();
    harness.unmount();

    withProvider(<ChatPage />, '/chat');
    expect(screen.queryByRole('button', { name: '和 现有伙伴 创建对话' })).not.toBeInTheDocument();
    expect(screen.getByTitle('现有伙伴')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^创建对话$/ }));
    expect(screen.queryByRole('radio', { name: /现有伙伴/ })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /测试伙伴 A/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /测试伙伴 C/ })).toBeInTheDocument();
  });

  it.each(['chat', 'studio'] as const)('collapses and restores %s rails independently and remembers them', (page) => {
    const content = page === 'chat' ? <ChatPage /> : <Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>;
    const route = page === 'chat' ? '/chat' : '/studio/discussion';
    const view = withProvider(content, route);
    const main = document.querySelector('.app-grid') as HTMLElement;
    const left = main.querySelector('.left-rail') as HTMLElement;
    const right = main.querySelector('.right-rail') as HTMLElement;
    const originalWidth = main.style.getPropertyValue(`--${page}-left-width`);
    fireEvent.click(screen.getByRole('button', { name: '收起左侧栏' }));
    expect(left.hidden).toBe(true);
    expect(right.hidden).toBe(false);
    expect(main.style.getPropertyValue(`--${page}-left-gap`)).toBe('0px');
    fireEvent.click(screen.getByRole('button', { name: '收起右侧栏' }));
    expect(right.hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '展开左侧栏' }));
    expect(main.style.getPropertyValue(`--${page}-left-width`)).toBe(originalWidth);
    expect(JSON.parse(localStorage.getItem(`asterium.${page}.collapsedRails.v1`)!)).toEqual({ left: false, right: true });
    view.unmount();
    withProvider(content, route);
    expect(screen.getByRole('button', { name: '展开右侧栏' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: '收起左侧栏' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not let a queued group auto-scroll pull a history reader back down', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const view = withProvider(<Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>, '/studio/discussion');
    try {
      const list = document.querySelector('.studio-messages') as HTMLDivElement;
      Object.defineProperties(list, { scrollHeight: { value: 1500, configurable: true }, clientHeight: { value: 300, configurable: true } });
      list.scrollTop = 0;
      fireEvent.scroll(list);
      act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); });
      expect(list.scrollTop).toBe(0);
      expect(screen.getByRole('button', { name: '回到底部' })).toBeInTheDocument();
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('creates a group chat inside a new project shell', async () => {
    withProvider(
      <Routes>
        <Route path="/studio/:mode" element={<StudioPage />} />
      </Routes>,
      '/studio/discussion',
    );
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
    expect(screen.getByRole('dialog', { name: '新建工作室群聊' })).toBeInTheDocument();
    const tabs = within(screen.getByRole('navigation', { name: '项目来源' })).getAllByRole('button');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['创建新项目', '选择已有项目']);
    expect(tabs[0]).toHaveClass('active');
    const dialog = screen.getByRole('dialog', { name: '新建工作室群聊' });
    fireEvent.change(within(dialog).getByLabelText(/项目名称/), { target: { value: '本地新项目' } });
    fireEvent.change(within(dialog).getByLabelText(/群聊名称/), { target: { value: '本地讨论组' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并进入' }));
    expect((await screen.findAllByText('本地新项目')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('本地讨论组')).length).toBeGreaterThan(0);
  });

  it('creates a project group directly from the project row add button', async () => {
    withProvider(
      <Routes>
        <Route path="/studio/:mode" element={<StudioPage />} />
      </Routes>,
      '/studio/discussion',
    );

    const addButton = screen.getByRole('button', { name: '在 示例项目 A 中新建群聊' });
    fireEvent.click(addButton);
    expect(screen.queryByRole('dialog', { name: '新建工作室群聊' })).not.toBeInTheDocument();
    expect((await screen.findAllByText('新群聊')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '在 示例项目 A 中新建群聊' }));
    expect((await screen.findAllByText('新群聊 2')).length).toBeGreaterThan(0);
  });

  it('closes the group speaking-mode menu as soon as a mode is selected', async () => {
    const state = createTestState();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const group = state.groupChats.find(item => item.id === state.activeGroupChatId)!;
    const snapshot: StudioRoomSnapshot = {
      metadata: { roomId: group.id, projectId: group.projectId, name: group.name, memberIds: group.memberIds },
      messages: [], cursors: [], mutedPartnerIds: [], models: {}, rotationOffset: 0,
      settings: { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: false },
    };
    const originalStudio = window.asteriumStudio;
    const setSettings = vi.fn(async () => snapshot);
    window.asteriumStudio = {
      syncRoom: vi.fn(async () => snapshot), getRoom: vi.fn(async () => snapshot), removeRoom: vi.fn(),
      setMuted: vi.fn(), setSettings, resolveDiscussion: vi.fn(), cancelRound: vi.fn(), startRound: vi.fn(),
      prepareTurn: vi.fn(), failTurn: vi.fn(), announce: vi.fn(), onRoomChanged: vi.fn(() => () => undefined),
    } as never;
    const view = withProvider(<Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>, '/studio/discussion');
    try {
      fireEvent.click(await screen.findByRole('button', { name: '自由讨论' }));
      fireEvent.click(screen.getByRole('menuitemradio', { name: /逐一回应/ }));
      expect(screen.queryByRole('menuitemradio', { name: /逐一回应/ })).not.toBeInTheDocument();
      await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ roomId: group.id, settings: expect.objectContaining({ speakingMode: 'round_robin' }) }));
    } finally { view.unmount(); window.asteriumStudio = originalStudio; }
  });

  it('shows one three-level project permission control and persists changes through the project API', async () => {
    const state = createTestState();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const projectId = state.activeProjectId!;
    const originalProjects = window.asteriumProjects;
    const setExecutionPolicy = vi.fn(async ({ permissionMode }: { projectId: string; permissionMode: 'read_only' | 'manual' | 'full' }) => ({
      version: 1 as const, projectId, permissionMode, updatedAt: '2026-10-15T00:00:00.000Z',
    }));
    window.asteriumProjects = {
      initializeDomain: vi.fn(async () => ({
        version: 1 as const,
        projects: state.projects.map(projectRecord),
        tasks: state.projects.flatMap((project) => project.tasks),
      })),
      chooseLocation: vi.fn(async () => null), create: vi.fn(), update: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), removeTask: vi.fn(),
      listRoles: vi.fn(async (projectId: string) => ({ version: 1 as const, projectId, roles: [] })), createRole: vi.fn(), updateRole: vi.fn(), archiveRole: vi.fn(), removeRole: vi.fn(), onRolesChanged: vi.fn(() => () => undefined),
      workflowCatalog: vi.fn(async () => ({ version: 1 as const, templates: [], methods: [] })), listWorkflows: vi.fn(async () => []), createWorkflow: vi.fn(), updateWorkflow: vi.fn(), removeWorkflow: vi.fn(), activateWorkflow: vi.fn(), onWorkflowsChanged: vi.fn(() => () => undefined),
      get: vi.fn(async () => null), createWorkspace: vi.fn(),
      open: vi.fn(async () => undefined), openFile: vi.fn(async () => undefined), listFiles: vi.fn(async () => []),
      onFilesChanged: vi.fn(() => () => undefined), onDomainChanged: vi.fn(() => () => undefined),
      getTaskExecution: vi.fn(async () => ({ version: 1 as const, attempts: [], events: [] })),
      enqueueTaskAttempt: vi.fn(), pauseTaskAttempt: vi.fn(), resumeTaskAttempt: vi.fn(), cancelTaskAttempt: vi.fn(), retryTaskAttempt: vi.fn(), resolveTaskGate: vi.fn(),
      onTaskExecutionChanged: vi.fn(() => () => undefined),
      getExecutionPolicy: vi.fn(async () => ({ version: 1 as const, projectId, permissionMode: 'manual' as const, updatedAt: '2026-10-15T00:00:00.000Z' })),
      setExecutionPolicy, onExecutionPolicyChanged: vi.fn(() => () => undefined),
      syncMembers: vi.fn(async () => []), changeMembers: vi.fn(), remove: vi.fn(async () => undefined),
    };

    const view = withProvider(
      <Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>,
      '/studio/discussion',
    );
    try {
      const trigger = await screen.findByRole('button', { name: '手动审批' });
      fireEvent.click(trigger);
      const menu = screen.getByRole('menu', { name: '选择项目权限模式' });
      expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
      expect(within(menu).getByRole('menuitemradio', { name: /只读/ })).toBeInTheDocument();
      expect(within(menu).getByRole('menuitemradio', { name: /手动审批/ })).toBeInTheDocument();
      expect(within(menu).getByRole('menuitemradio', { name: /完整权限/ })).toBeInTheDocument();
      expect(within(menu).queryByText(/自动模式/)).not.toBeInTheDocument();

      fireEvent.click(within(menu).getByRole('menuitemradio', { name: /完整权限/ }));
      expect(screen.queryByRole('menu', { name: '选择项目权限模式' })).not.toBeInTheDocument();
      await waitFor(() => expect(setExecutionPolicy).toHaveBeenCalledWith({ projectId, permissionMode: 'full' }));
      expect(await screen.findByRole('button', { name: '完整权限' })).toBeInTheDocument();
    } finally {
      view.unmount();
      window.asteriumProjects = originalProjects;
    }
  });

  it('submits an arbitrary multi-selection of public discussion message ids to one planner', async () => {
    const state = createTestState();
    const project = state.projects.find((item) => item.id === state.activeProjectId)!;
    const group = state.groupChats.find((item) => item.id === state.activeGroupChatId)!;
    const planner = state.partners.find((item) => item.id === 'fixture-local-a')!;
    if (planner.sourceMode !== 'local_cli') throw new Error('TEST_PLANNER_INVALID');
    planner.isPrototype = false;
    planner.connectionKind = 'local_codex';
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const originalProjects = window.asteriumProjects;
    const originalStudio = window.asteriumStudio;
    const snapshot: StudioRoomSnapshot = {
      metadata: { roomId: group.id, projectId: project.id, name: group.name, memberIds: group.memberIds },
      messages: [
        { roomId: group.id, messageId: 'public-1', seq: 1, roundId: 'round-a', authorType: 'user', authorId: state.userProfile.id, content: '核心目标', createdAt: '2026-10-16T10:00:00.000Z', status: 'completed' },
        { roomId: group.id, messageId: 'public-2', seq: 2, roundId: 'round-a', authorType: 'partner', authorId: 'fixture-local-a', content: '中间讨论', createdAt: '2026-10-16T10:01:00.000Z', status: 'completed' },
        { roomId: group.id, messageId: 'public-3', seq: 3, roundId: 'round-a', authorType: 'partner', authorId: 'fixture-local-a', content: '伙伴总结', createdAt: '2026-10-16T10:02:00.000Z', status: 'completed' },
      ], cursors: [], mutedPartnerIds: [], settings: { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: true }, rotationOffset: 0, models: {},
    };
    window.asteriumStudio = {
      syncRoom: vi.fn(async () => snapshot), getRoom: vi.fn(async () => snapshot), removeRoom: vi.fn(async () => undefined),
      setMuted: vi.fn(async () => snapshot), setSettings: vi.fn(async () => snapshot), resolveDiscussion: vi.fn(async () => snapshot), cancelRound: vi.fn(async () => snapshot),
      startRound: vi.fn(async () => snapshot), prepareTurn: vi.fn(), failTurn: vi.fn(async () => snapshot), announce: vi.fn(async () => snapshot), onRoomChanged: vi.fn(() => () => undefined),
    };
    const startWorkflowGeneration = vi.fn(async (request: ProjectWorkflowGenerationStartRequest) => ({
      version: 1 as const, id: 'generation-ui', requestId: request.requestId, requestFingerprint: 'fingerprint', projectId: request.projectId, roomId: request.roomId,
      plannerPartnerId: request.plannerPartnerId, sourceDigest: 'digest', status: 'running' as const, validationFailures: 0,
      sourceMessages: request.messageIds.map((messageId, index) => ({ messageId, seq: index + 1, authorType: 'user' as const, authorId: state.userProfile.id, content: messageId, contentHash: 'a'.repeat(64), createdAt: '2026-10-16T00:00:00.000Z', status: 'completed' as const })),
      createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
    }));
    window.asteriumProjects = {
      initializeDomain: vi.fn(async () => ({ version: 1 as const, projects: state.projects.map(projectRecord), tasks: state.projects.flatMap((item) => item.tasks) })),
      create: vi.fn(), update: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), removeTask: vi.fn(), onDomainChanged: vi.fn(() => () => undefined),
      listRoles: vi.fn(async (projectId: string) => ({ version: 1 as const, projectId, roles: [] })), createRole: vi.fn(), updateRole: vi.fn(), archiveRole: vi.fn(), removeRole: vi.fn(), onRolesChanged: vi.fn(() => () => undefined),
      workflowCatalog: vi.fn(async () => ({ version: 1 as const, templates: [], methods: [] })), listWorkflows: vi.fn(async () => []), createWorkflow: vi.fn(), updateWorkflow: vi.fn(), removeWorkflow: vi.fn(), activateWorkflow: vi.fn(), onWorkflowsChanged: vi.fn(() => () => undefined),
      listWorkflowGenerations: vi.fn(async () => []), startWorkflowGeneration, cancelWorkflowGeneration: vi.fn(), retryWorkflowGeneration: vi.fn(), onWorkflowGenerationChanged: vi.fn(() => () => undefined),
      chooseLocation: vi.fn(async () => null), createWorkspace: vi.fn(), get: vi.fn(async () => null), open: vi.fn(async () => undefined), openFile: vi.fn(async () => undefined), listFiles: vi.fn(async () => []), onFilesChanged: vi.fn(() => () => undefined),
      getTaskExecution: vi.fn(async () => ({ version: 1 as const, attempts: [], events: [] })), enqueueTaskAttempt: vi.fn(), pauseTaskAttempt: vi.fn(), resumeTaskAttempt: vi.fn(), cancelTaskAttempt: vi.fn(), retryTaskAttempt: vi.fn(), resolveTaskGate: vi.fn(), onTaskExecutionChanged: vi.fn(() => () => undefined),
      getExecutionPolicy: vi.fn(async () => ({ version: 1 as const, projectId: project.id, permissionMode: 'manual' as const, updatedAt: '2026-10-16T00:00:00.000Z' })), setExecutionPolicy: vi.fn(), onExecutionPolicyChanged: vi.fn(() => () => undefined),
      syncMembers: vi.fn(async () => []), changeMembers: vi.fn(), remove: vi.fn(async () => undefined),
    };

    const view = withProvider(<Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>, '/studio/discussion');
    try {
      await screen.findByText('核心目标');
      fireEvent.click(await screen.findByRole('button', { name: '生成工作流' }));
      const dialog = screen.getByRole('dialog', { name: '从讨论生成工作流' });
      expect(within(dialog).getByLabelText(/规划伙伴/)).toHaveValue('fixture-local-a');
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /#2 · 测试伙伴 A.*中间讨论/ }));
      fireEvent.click(within(dialog).getByRole('button', { name: '生成可编辑草稿' }));
      await waitFor(() => expect(startWorkflowGeneration).toHaveBeenCalledWith(expect.objectContaining({
        projectId: project.id, roomId: group.id, plannerPartnerId: 'fixture-local-a', messageIds: ['public-1', 'public-3'], requestId: expect.any(String),
      })));
      expect(await screen.findByText('正在生成工作流草稿')).toBeInTheDocument();
    } finally {
      view.unmount();
      window.asteriumProjects = originalProjects;
      window.asteriumStudio = originalStudio;
    }
  });

  it('creates and edits a Main-owned project task with assignment, dependencies, and acceptance criteria', async () => {
    const state = createTestState();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const project = state.projects.find((item) => item.id === state.activeProjectId)!;
    const originalProjects = window.asteriumProjects;
    const executionRole = { version: 1 as const, id: 'role-global-implementation', scope: 'global' as const, group: '项目中期', name: '实现工程师', description: '实现并验证', responsibilities: ['实现冻结范围'], prompt: '保持最小改动。', revision: 2, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' };
    const reviewRole = { version: 1 as const, id: 'role-project-audit', scope: 'project' as const, projectId: project.id, group: '项目收尾', name: '架构审计', description: '检查边界', responsibilities: ['检查权威真源'], prompt: '只报告证据。', revision: 4, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' };
    const createTask = vi.fn(async (input) => ({
      version: 1 as const,
      id: 'task-ui-created',
      projectId: input.projectId,
      code: input.code ?? 'TSK-004',
      title: input.title,
      description: input.description ?? '',
      ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
      status: input.status ?? 'todo',
      dependencyIds: input.dependencyIds ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      note: input.note ?? '',
      ...(input.execution ? { execution: input.execution } : {}),
      revision: 1,
      createdAt: '2026-10-15T01:00:00.000Z',
      updatedAt: '2026-10-15T01:00:00.000Z',
    }));
    const updateTask = vi.fn(async (input) => ({
      version: 1 as const,
      id: input.taskId,
      projectId: input.projectId,
      code: input.code ?? 'TSK-004',
      title: input.title,
      description: input.description ?? '',
      ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
      status: input.status,
      dependencyIds: input.dependencyIds ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      note: input.note ?? '',
      ...(input.execution ? { execution: input.execution } : {}),
      revision: 2,
      createdAt: '2026-10-15T01:00:00.000Z',
      updatedAt: '2026-10-15T01:05:00.000Z',
    }));
    window.asteriumProjects = {
      initializeDomain: vi.fn(async () => ({
        version: 1 as const,
        projects: state.projects.map(projectRecord),
        tasks: state.projects.flatMap((item) => item.tasks),
      })),
      create: vi.fn(), update: vi.fn(), createTask, updateTask, removeTask: vi.fn(), onDomainChanged: vi.fn(() => () => undefined),
      listRoles: vi.fn(async (projectId: string) => ({ version: 1 as const, projectId, roles: [executionRole, reviewRole] })), createRole: vi.fn(), updateRole: vi.fn(), archiveRole: vi.fn(), removeRole: vi.fn(), onRolesChanged: vi.fn(() => () => undefined),
      workflowCatalog: vi.fn(async () => ({ version: 1 as const, templates: [], methods: [] })), listWorkflows: vi.fn(async () => []), createWorkflow: vi.fn(), updateWorkflow: vi.fn(), removeWorkflow: vi.fn(), activateWorkflow: vi.fn(), onWorkflowsChanged: vi.fn(() => () => undefined),
      chooseLocation: vi.fn(async () => null), createWorkspace: vi.fn(), get: vi.fn(async () => null),
      open: vi.fn(async () => undefined), openFile: vi.fn(async () => undefined), listFiles: vi.fn(async () => []), onFilesChanged: vi.fn(() => () => undefined),
      getTaskExecution: vi.fn(async () => ({ version: 1 as const, attempts: [], events: [] })),
      enqueueTaskAttempt: vi.fn(), pauseTaskAttempt: vi.fn(), resumeTaskAttempt: vi.fn(), cancelTaskAttempt: vi.fn(), retryTaskAttempt: vi.fn(), resolveTaskGate: vi.fn(),
      onTaskExecutionChanged: vi.fn(() => () => undefined),
      getExecutionPolicy: vi.fn(async () => ({ version: 1 as const, projectId: project.id, permissionMode: 'manual' as const, updatedAt: '2026-10-15T00:00:00.000Z' })),
      setExecutionPolicy: vi.fn(), onExecutionPolicyChanged: vi.fn(() => () => undefined), syncMembers: vi.fn(async () => []), changeMembers: vi.fn(), remove: vi.fn(async () => undefined),
    };

    const view = withProvider(<Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>, '/studio/workspace');
    const previousScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      fireEvent.click(await screen.findByRole('button', { name: '新建任务' }));
      const createDialog = screen.getByRole('dialog', { name: '新建任务' });
      fireEvent.change(within(createDialog).getByLabelText('任务名称'), { target: { value: '真实任务编辑链路' } });
      fireEvent.change(within(createDialog).getByLabelText('任务说明'), { target: { value: '验证 Main 任务接口' } });
      fireEvent.change(within(createDialog).getByLabelText('负责人'), { target: { value: 'fixture-local-a' } });
      fireEvent.change(within(createDialog).getByLabelText('执行角色'), { target: { value: 'role-global-implementation@2' } });
      fireEvent.click(within(createDialog).getByRole('checkbox', { name: /AST-041.*设备接入模块/ }));
      fireEvent.change(within(createDialog).getByLabelText(/验收标准/), { target: { value: '创建可持久化\n重启后仍存在' } });
      fireEvent.change(within(createDialog).getByLabelText('完成规则'), { target: { value: 'partner_review' } });
      fireEvent.change(within(createDialog).getByLabelText('复核伙伴'), { target: { value: 'fixture-local-b' } });
      fireEvent.change(within(createDialog).getByLabelText(/复核角色/), { target: { value: 'role-project-audit@4' } });
      fireEvent.click(within(createDialog).getByRole('button', { name: '保存任务' }));

      await waitFor(() => expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
        projectId: project.id,
        title: '真实任务编辑链路',
        assigneeId: 'fixture-local-a',
        dependencyIds: ['t1'],
        acceptanceCriteria: ['创建可持久化', '重启后仍存在'],
        execution: {
          workRole: { roleId: executionRole.id, roleRevision: 2, name: '实现工程师', description: '实现并验证', responsibilities: ['实现冻结范围'], prompt: '保持最小改动。', scope: 'global' },
          reviewWorkRole: { roleId: reviewRole.id, roleRevision: 4, name: '架构审计', description: '检查边界', responsibilities: ['检查权威真源'], prompt: '只报告证据。', scope: 'project' },
          completionRule: { type: 'partner_review', reviewerPartnerId: 'fixture-local-b', autoReworkLimit: 2 },
        },
      })));
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' }));
      fireEvent.click(await screen.findByRole('button', { name: '编辑任务 真实任务编辑链路' }));
      const editDialog = screen.getByRole('dialog', { name: '编辑任务 · TSK-004' });
      fireEvent.change(within(editDialog).getByLabelText('状态'), { target: { value: 'blocked' } });
      fireEvent.change(within(editDialog).getByLabelText('当前备注'), { target: { value: '等待外部输入' } });
      fireEvent.click(within(editDialog).getByRole('button', { name: '保存任务' }));

      await waitFor(() => expect(updateTask).toHaveBeenCalledWith(expect.objectContaining({
        projectId: project.id, taskId: 'task-ui-created', expectedRevision: 1,
        status: 'blocked', note: '等待外部输入', dependencyIds: ['t1'],
      })));
      expect((await screen.findAllByText('受阻')).length).toBeGreaterThan(1);

      fireEvent.click(screen.getByRole('button', { name: '角色管理' }));
      const manager = screen.getByRole('dialog', { name: '工作角色' });
      fireEvent.click(within(manager).getByRole('button', { name: /新建自定义角色/ }));
      const roleDialog = screen.getByRole('dialog', { name: '新建工作角色' });
      fireEvent.change(within(roleDialog).getByLabelText('保存范围'), { target: { value: 'global' } });
      const roleGroupSelect = within(roleDialog).getByLabelText(/角色分组/);
      for (const group of ['项目准备', '项目前期', '项目中期', '项目收尾', '新建自定义分组…']) {
        expect(within(roleGroupSelect).getByRole('option', { name: group })).toBeInTheDocument();
      }
      fireEvent.change(roleGroupSelect, { target: { value: '__custom__' } });
      fireEvent.change(within(roleDialog).getByLabelText('自定义分组名称'), { target: { value: '发布准备' } });
      fireEvent.change(within(roleDialog).getByLabelText('角色名称'), { target: { value: '发布审计' } });
      fireEvent.change(within(roleDialog).getByLabelText(/职责/), { target: { value: '检查发布边界\n核对回滚方案' } });
      fireEvent.change(within(roleDialog).getByLabelText('角色 Prompt'), { target: { value: '只报告已证实风险。' } });
      fireEvent.click(within(roleDialog).getByRole('button', { name: '保存角色' }));
      await waitFor(() => expect(window.asteriumProjects?.createRole).toHaveBeenCalledWith({
        scope: 'global', group: '发布准备', name: '发布审计', description: '', responsibilities: ['检查发布边界', '核对回滚方案'], prompt: '只报告已证实风险。',
      }));
    } finally {
      if (previousScrollIntoView) HTMLElement.prototype.scrollIntoView = previousScrollIntoView;
      else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      view.unmount();
      window.asteriumProjects = originalProjects;
    }
  });

  it('creates an editable workflow draft from a template and activates the saved DAG', async () => {
    const state = createTestState();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const project = state.projects.find((item) => item.id === state.activeProjectId)!;
    const originalProjects = window.asteriumProjects;
    const role = { version: 1 as const, id: 'builtin-implementation-engineer', scope: 'builtin' as const, group: '项目中期', name: '实现工程师', description: '实现并验证', responsibilities: ['实现冻结范围'], prompt: '', revision: 1, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' };
    const method = { templateId: 'method-implementation-self-check', name: '实现与自检', version: '1', description: '完成冻结范围并自检', instructions: '只实现冻结范围。' };
    const created = {
      version: 1 as const, id: 'workflow-ui', projectId: project.id, name: '快速实现', description: '单步骤流程', status: 'draft' as const,
      sourceTemplate: { templateId: 'quick-implementation', templateVersion: '1' }, revision: 1,
      createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
      nodes: [{
        id: 'workflow-node', position: 0, title: '实现并自检', description: '完成实现', dependencyNodeIds: [], acceptanceCriteria: ['实现完成'], note: '',
        execution: {
          workRole: { roleId: role.id, roleRevision: 1, name: role.name, description: role.description, responsibilities: role.responsibilities, scope: role.scope },
          methodTemplate: { templateId: method.templateId, name: method.name, version: method.version, instructions: method.instructions },
          completionRule: { type: 'user_confirm' as const },
        },
      }],
    };
    const createWorkflow = vi.fn(async () => created);
    const updateWorkflow = vi.fn(async (input) => ({ ...created, name: input.name, description: input.description, nodes: input.nodes, revision: 2, updatedAt: '2026-10-16T00:01:00.000Z' }));
    const saveWorkflowTemplate = vi.fn(async () => ({ version: 1 as const, id: 'project-template-ui', projectId: project.id, name: '我的快速实现', description: '项目内模板', nodes: created.nodes, revision: 1, createdAt: '2026-10-16T00:02:00.000Z', updatedAt: '2026-10-16T00:02:00.000Z' }));
    const activateWorkflow = vi.fn(async () => ({ workflow: { ...created, status: 'active' as const, revision: 3 }, taskIds: ['task-from-workflow'], attemptIds: ['attempt-from-workflow'] }));
    window.asteriumProjects = {
      initializeDomain: vi.fn(async () => ({ version: 1 as const, projects: state.projects.map(projectRecord), tasks: state.projects.flatMap((item) => item.tasks) })),
      create: vi.fn(), update: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), removeTask: vi.fn(), onDomainChanged: vi.fn(() => () => undefined),
      listRoles: vi.fn(async (projectId: string) => ({ version: 1 as const, projectId, roles: [role] })), createRole: vi.fn(), updateRole: vi.fn(), archiveRole: vi.fn(), removeRole: vi.fn(), onRolesChanged: vi.fn(() => () => undefined),
      workflowCatalog: vi.fn(async () => ({ version: 1 as const, templates: [
        { id: 'quick-implementation', version: '1', name: '快速实现', description: '单步骤流程', nodeCount: 1, kind: 'builtin' as const },
        { id: 'project-template-existing', version: '1', revision: 1, name: '已有项目模板', description: '检查操作顺序', nodeCount: 1, kind: 'project' as const, projectId: project.id },
      ], methods: [method] })),
      listWorkflows: vi.fn(async () => [created]), createWorkflow, updateWorkflow, removeWorkflow: vi.fn(), activateWorkflow,
      saveWorkflowTemplate, updateWorkflowTemplate: vi.fn(), removeWorkflowTemplate: vi.fn(), onWorkflowsChanged: vi.fn(() => () => undefined),
      chooseLocation: vi.fn(async () => null), createWorkspace: vi.fn(), get: vi.fn(async () => null), open: vi.fn(async () => undefined), openFile: vi.fn(async () => undefined), listFiles: vi.fn(async () => []), onFilesChanged: vi.fn(() => () => undefined),
      getTaskExecution: vi.fn(async () => ({ version: 1 as const, attempts: [], events: [] })), enqueueTaskAttempt: vi.fn(), pauseTaskAttempt: vi.fn(), resumeTaskAttempt: vi.fn(), cancelTaskAttempt: vi.fn(), retryTaskAttempt: vi.fn(), resolveTaskGate: vi.fn(), onTaskExecutionChanged: vi.fn(() => () => undefined),
      getExecutionPolicy: vi.fn(async () => ({ version: 1 as const, projectId: project.id, permissionMode: 'manual' as const, updatedAt: '2026-10-16T00:00:00.000Z' })), setExecutionPolicy: vi.fn(), onExecutionPolicyChanged: vi.fn(() => () => undefined),
      syncMembers: vi.fn(async () => []), changeMembers: vi.fn(), remove: vi.fn(async () => undefined),
    };

    const view = withProvider(<Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>, '/studio/workspace');
    try {
      fireEvent.click(await screen.findByRole('button', { name: '流程草稿' }));
      let manager = await screen.findByRole('dialog', { name: '工作流程' });
      fireEvent.click(within(manager).getByRole('button', { name: '编辑' }));
      let editor = await screen.findByRole('dialog', { name: '编辑流程 · 快速实现' });
      fireEvent.click(within(editor).getByRole('button', { name: '取消' }));
      manager = await screen.findByRole('dialog', { name: '工作流程' });
      fireEvent.click(within(manager).getByRole('button', { name: /从模板创建/ }));
      let templates = await screen.findByRole('dialog', { name: '从模板创建流程' });
      const projectTemplate = within(templates).getByText('已有项目模板').closest('article')!;
      expect(projectTemplate.children[1]).toContainElement(within(projectTemplate).getByRole('button', { name: '删除' }));
      expect(within(projectTemplate).queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
      expect(projectTemplate.children[0]).toContainElement(projectTemplate.querySelector('.workflow-template-list__arrow'));
      fireEvent.click(within(templates).getByRole('button', { name: '关闭' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: '流程草稿' }));
      manager = await screen.findByRole('dialog', { name: '工作流程' });
      fireEvent.click(within(manager).getByRole('button', { name: /从模板创建/ }));
      templates = await screen.findByRole('dialog', { name: '从模板创建流程' });
      const quickTemplate = within(templates).getByText('快速实现').closest('article')!;
      fireEvent.click(quickTemplate.querySelector('.workflow-template-list__arrow')!);
      await waitFor(() => expect(createWorkflow).toHaveBeenCalledWith({ projectId: project.id, templateId: 'quick-implementation' }));

      editor = await screen.findByRole('dialog', { name: '编辑流程 · 快速实现' });
      fireEvent.click(within(editor).getByRole('button', { name: '关闭' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: '流程草稿' }));
      manager = await screen.findByRole('dialog', { name: '工作流程' });
      fireEvent.click(within(manager).getByRole('button', { name: /从模板创建/ }));
      templates = await screen.findByRole('dialog', { name: '从模板创建流程' });
      fireEvent.click(within(templates).getByText('快速实现').closest('article')!.querySelector('.workflow-template-list__arrow')!);
      editor = await screen.findByRole('dialog', { name: '编辑流程 · 快速实现' });
      fireEvent.click(within(editor).getByRole('button', { name: '取消' }));
      const returnedTemplates = await screen.findByRole('dialog', { name: '从模板创建流程' });
      fireEvent.click(within(returnedTemplates).getByRole('button', { name: '取消' }));
      manager = await screen.findByRole('dialog', { name: '工作流程' });
      fireEvent.click(within(manager).getByRole('button', { name: /从模板创建/ }));
      templates = await screen.findByRole('dialog', { name: '从模板创建流程' });
      const returnedQuickTemplate = within(templates).getByText('快速实现').closest('article')!;
      fireEvent.click(returnedQuickTemplate.querySelector('.workflow-template-list__arrow')!);
      editor = await screen.findByRole('dialog', { name: '编辑流程 · 快速实现' });
      const inlineAdd = within(editor).getByRole('button', { name: '在步骤 1 后增加步骤' });
      expect(editor.querySelector('.workflow-node-list')?.lastElementChild).toBe(inlineAdd);
      expect(within(editor).queryByRole('button', { name: '增加步骤' })).not.toBeInTheDocument();
      expect(within(editor).getByLabelText(/方法模板/)).toHaveValue('method-implementation-self-check@1');
      fireEvent.change(within(editor).getByLabelText('负责人'), { target: { value: 'fixture-local-a' } });
      fireEvent.change(within(editor).getByLabelText('步骤名称'), { target: { value: '实现真实链路' } });
      fireEvent.click(within(editor).getByRole('button', { name: '另存为模板' }));
      let templateDialog = await screen.findByRole('dialog', { name: '另存为项目模板' });
      fireEvent.click(within(templateDialog).getByRole('button', { name: '取消' }));
      editor = await screen.findByRole('dialog', { name: '编辑流程 · 快速实现' });
      fireEvent.click(within(editor).getByRole('button', { name: '另存为模板' }));
      templateDialog = await screen.findByRole('dialog', { name: '另存为项目模板' });
      fireEvent.change(within(templateDialog).getByLabelText('模板名称'), { target: { value: '我的快速实现' } });
      fireEvent.change(within(templateDialog).getByLabelText('模板说明'), { target: { value: '项目内模板' } });
      fireEvent.click(within(templateDialog).getByRole('button', { name: '保存模板' }));
      await waitFor(() => expect(saveWorkflowTemplate).toHaveBeenCalledWith(expect.objectContaining({
        projectId: project.id, workflowId: created.id, expectedWorkflowRevision: 2, name: '我的快速实现', description: '项目内模板',
      })));

      const reopenedEditor = await screen.findByRole('dialog', { name: '编辑流程 · 快速实现' });
      fireEvent.click(within(reopenedEditor).getByRole('button', { name: '确认执行' }));

      await waitFor(() => expect(updateWorkflow).toHaveBeenCalledWith(expect.objectContaining({
        projectId: project.id, workflowId: created.id, expectedRevision: 1,
        nodes: [expect.objectContaining({ title: '实现真实链路', assigneeId: 'fixture-local-a' })],
      })));
      await waitFor(() => expect(activateWorkflow).toHaveBeenCalledWith(expect.objectContaining({
        projectId: project.id, workflowId: created.id, expectedRevision: 2, activationId: expect.any(String),
      })));
    } finally {
      view.unmount();
      window.asteriumProjects = originalProjects;
    }
  });

  it('forwards the selected acceptance criteria when requesting task rework', async () => {
    const state = createTestState();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const project = state.projects.find((item) => item.id === state.activeProjectId)!;
    const task = project.tasks.find((item) => item.id === 't2')!;
    task.execution = { completionRule: { type: 'user_confirm' } };
    const timestamp = '2026-10-15T01:00:00.000Z';
    const attempt = {
      version: 1 as const,
      id: 'attempt-user-confirm',
      projectId: project.id,
      taskId: task.id,
      attemptNumber: 1,
      taskRevision: task.revision,
      completionFlowVersion: 2 as const,
      purpose: 'execution' as const,
      assigneeId: task.assigneeId!,
      actorPartnerId: task.assigneeId!,
      rootAttemptId: 'attempt-user-confirm',
      reworkRound: 0,
      permissionMode: 'manual' as const,
      status: 'succeeded' as const,
      blockedByTaskIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: timestamp,
    };
    const originalProjects = window.asteriumProjects;
    const resolveTaskGate = vi.fn(async () => attempt);
    window.asteriumProjects = {
      initializeDomain: vi.fn(async () => ({
        version: 1 as const,
        projects: state.projects.map(projectRecord),
        tasks: state.projects.flatMap((item) => item.tasks),
      })),
      create: vi.fn(), update: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), removeTask: vi.fn(), onDomainChanged: vi.fn(() => () => undefined),
      listRoles: vi.fn(async (projectId: string) => ({ version: 1 as const, projectId, roles: [] })), createRole: vi.fn(), updateRole: vi.fn(), archiveRole: vi.fn(), removeRole: vi.fn(), onRolesChanged: vi.fn(() => () => undefined),
      workflowCatalog: vi.fn(async () => ({ version: 1 as const, templates: [], methods: [] })), listWorkflows: vi.fn(async () => []), createWorkflow: vi.fn(), updateWorkflow: vi.fn(), removeWorkflow: vi.fn(), activateWorkflow: vi.fn(), onWorkflowsChanged: vi.fn(() => () => undefined),
      chooseLocation: vi.fn(async () => null), createWorkspace: vi.fn(),
      get: vi.fn(async () => ({
        version: 1 as const, projectId: project.id, name: project.name, rootPath: 'K:\\workspace', deliverablesPath: 'K:\\workspace\\deliverables',
        templateFiles: [], createdAt: timestamp, updatedAt: timestamp,
      })),
      open: vi.fn(async () => undefined), openFile: vi.fn(async () => undefined), listFiles: vi.fn(async () => []), onFilesChanged: vi.fn(() => () => undefined),
      getTaskExecution: vi.fn(async () => ({ version: 1 as const, attempts: [attempt], events: [] })),
      enqueueTaskAttempt: vi.fn(), pauseTaskAttempt: vi.fn(), resumeTaskAttempt: vi.fn(), cancelTaskAttempt: vi.fn(), retryTaskAttempt: vi.fn(), resolveTaskGate,
      onTaskExecutionChanged: vi.fn(() => () => undefined),
      getExecutionPolicy: vi.fn(async () => ({ version: 1 as const, projectId: project.id, permissionMode: 'manual' as const, updatedAt: timestamp })),
      setExecutionPolicy: vi.fn(), onExecutionPolicyChanged: vi.fn(() => () => undefined), syncMembers: vi.fn(async () => []), changeMembers: vi.fn(), remove: vi.fn(async () => undefined),
    };

    const view = withProvider(<Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>, '/studio/workspace');
    try {
      fireEvent.click(await screen.findByRole('button', { name: '要求调整' }));
      const submit = screen.getByRole('button', { name: '提交调整要求' });
      fireEvent.change(screen.getByPlaceholderText('只填写既有验收项需要调整的内容'), { target: { value: '请修正失败状态。' } });
      expect(submit).toBeDisabled();
      fireEvent.click(screen.getByRole('checkbox', { name: task.acceptanceCriteria[0] }));
      expect(submit).toBeEnabled();
      fireEvent.click(submit);

      await waitFor(() => expect(resolveTaskGate).toHaveBeenCalledWith({
        projectId: project.id,
        taskId: task.id,
        action: 'request_changes',
        feedback: '请修正失败状态。',
        affectedCriteria: [`r${task.revision}:c1`],
      }));
    } finally {
      view.unmount();
      window.asteriumProjects = originalProjects;
    }
  });

  it('edits members and sends archived groups directly to settings management', async () => {
    withProvider(
      <Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>,
      '/studio/discussion',
    );
    fireEvent.click(screen.getByRole('button', { name: /编辑群聊名称/ }));
    const editor = screen.getByRole('dialog', { name: '编辑群聊名称' });
    fireEvent.change(within(editor).getByLabelText('群聊名称'), { target: { value: '生命周期讨论组' } });
    fireEvent.click(within(editor).getByRole('button', { name: '保存名称' }));
    expect(screen.getAllByText('生命周期讨论组').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '成员管理' }));
    const members = screen.getByRole('dialog', { name: '管理群聊成员' });
    fireEvent.click(within(members).getByRole('button', { name: '取消选择 测试伙伴 C' }));
    fireEvent.click(within(members).getByRole('button', { name: '添加成员 测试伙伴 C' }));
    fireEvent.click(within(members).getByRole('button', { name: '保存成员' }));
    expect(screen.getAllByText('测试伙伴 C').length).toBeGreaterThan(0);
    fireEvent.contextMenu(screen.getByRole('button', { name: '测试伙伴 C，右键管理' }));
    expect(screen.getByRole('menuitem', { name: '禁言' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: '移出群聊' }));
    expect(screen.getByRole('dialog', { name: '移出群聊？' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog', { name: '移出群聊？' })).getByRole('button', { name: '取消' }));

    fireEvent.click(screen.getByRole('button', { name: /归档群聊 生命周期讨论组/ }));
    expect(screen.queryByRole('dialog', { name: '归档群聊？' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '尚未创建群聊' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /已归档/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('示例项目 A').length).toBeGreaterThan(0);
  });

  it('keeps a group chat pinned to the newest interaction after the next layout frame', async () => {
    const state = createTestState();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const group = state.groupChats.find((item) => item.id === state.activeGroupChatId)!;
    const partner = state.partners.find((item) => group.memberIds.includes(item.id))!;
    let listener: ((event: RendererAgentEvent) => void) | undefined;
    const originalAgents = window.asteriumAgents;
    window.asteriumAgents = {
      detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(),
      onEvent: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    };
    const view = withProvider(
      <Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>,
      '/studio/discussion',
    );
    try {
      const list = view.container.querySelector<HTMLElement>('.studio-messages')!;
      let scrollHeight = 900;
      Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => scrollHeight });
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
      list.scrollTop = 500;
      fireEvent.scroll(list);
      scrollHeight = 1_400;

      act(() => listener?.({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        type: 'authorization.requested',
        eventId: 'studio-approval-scroll',
        partnerId: partner.id,
        conversationId: `group:v3:${group.id}:${partner.id}`,
        connectionSource: partner.sourceMode,
        clientMessageId: 'studio-client-scroll',
        sessionId: 'studio-session-scroll',
        runId: 'studio-run-scroll',
        sequence: 1,
        occurredAt: new Date().toISOString(),
        route: { scope: 'group', roomId: group.id, roundId: 'studio-round-scroll', bindingGeneration: 1, inputThroughSeq: 1 },
        authorizationId: 'studio-auth-scroll',
        action: 'write_file',
        risk: 'medium',
        summary: '允许写入项目文件？',
        targets: ['K:\\project\\result.md'],
      }));

      await waitFor(() => expect(list.scrollTop).toBe(1_400));
      expect(list.querySelector('.studio-interaction-row')).toBeInTheDocument();
    } finally {
      view.unmount();
      window.asteriumAgents = originalAgents;
    }
  });

  it('keeps a group authorization inside the matching streaming partner bubble', async () => {
    const state = createTestState();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const group = state.groupChats.find((item) => item.id === state.activeGroupChatId)!;
    const partner = state.partners.find((item) => group.memberIds.includes(item.id))!;
    const now = new Date().toISOString();
    const snapshot: StudioRoomSnapshot = {
      metadata: { roomId: group.id, projectId: group.projectId, name: group.name, memberIds: [...group.memberIds] },
      messages: [],
      cursors: [],
      mutedPartnerIds: [],
      settings: { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false },
      rotationOffset: 0,
      models: {},
      activeRound: {
        roundId: 'studio-round-inline-approval',
        roomId: group.id,
        triggerMessageId: 'studio-trigger-inline-approval',
        speakerQueue: [partner.id],
        members: [{ turnId: 'studio-turn-inline-approval', partnerId: partner.id, state: 'running', runId: 'studio-run-inline-approval' }],
        currentPartnerId: partner.id,
        state: 'running',
        participantIds: [partner.id],
        permissionMode: 'manual',
        createdAt: now,
        updatedAt: now,
      },
      streaming: { partnerId: partner.id, runId: 'studio-run-inline-approval', content: '我先说明这次要写入的内容。' },
    };
    let listener: ((event: RendererAgentEvent) => void) | undefined;
    const originalAgents = window.asteriumAgents;
    const originalStudio = window.asteriumStudio;
    window.asteriumAgents = {
      detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(),
      onEvent: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    };
    window.asteriumStudio = {
      syncRoom: vi.fn(async () => snapshot), getRoom: vi.fn(async () => snapshot), removeRoom: vi.fn(async () => undefined),
      setMuted: vi.fn(async () => snapshot), setSettings: vi.fn(async () => snapshot), resolveDiscussion: vi.fn(async () => snapshot),
      cancelRound: vi.fn(async () => snapshot), startRound: vi.fn(async () => snapshot), prepareTurn: vi.fn(), failTurn: vi.fn(async () => snapshot),
      announce: vi.fn(async () => snapshot), onRoomChanged: vi.fn(() => () => undefined),
    };

    const view = withProvider(
      <Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>,
      '/studio/discussion',
    );
    try {
      const streamingText = await screen.findByText('我先说明这次要写入的内容。');
      act(() => listener?.({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        type: 'authorization.requested',
        eventId: 'studio-approval-inline',
        partnerId: partner.id,
        conversationId: `group:v3:${group.id}:${partner.id}`,
        connectionSource: partner.sourceMode,
        clientMessageId: 'studio-client-inline-approval',
        sessionId: 'studio-session-inline-approval',
        runId: 'studio-run-inline-approval',
        sequence: 1,
        occurredAt: now,
        route: { scope: 'group', roomId: group.id, roundId: 'studio-round-inline-approval', bindingGeneration: 1, inputThroughSeq: 1 },
        authorizationId: 'studio-auth-inline',
        action: 'write_file',
        risk: 'medium',
        summary: '允许写入项目文件？',
        targets: ['K:\\project\\result.md'],
      }));

      await waitFor(() => {
        const bubble = streamingText.closest('.message-bubble');
        expect(bubble).not.toBeNull();
        expect(within(bubble as HTMLElement).getByText('需要你的确认')).toBeInTheDocument();
        expect(view.container.querySelector('.studio-interaction-row')).not.toBeInTheDocument();
      });
    } finally {
      view.unmount();
      window.asteriumAgents = originalAgents;
      window.asteriumStudio = originalStudio;
    }
  });

  it('adds and removes project members with the two-column manager and preserves the saved list', async () => {
    withProvider(
      <Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>,
      '/studio/discussion',
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑项目资料' }));
    let editor = screen.getByRole('dialog', { name: '编辑项目资料' });
    const remove = within(editor).getAllByRole('button', { name: /移出项目成员/ })[0];
    const partnerName = remove.getAttribute('aria-label')!.replace('移出项目成员 ', '');
    fireEvent.click(remove);
    expect(within(editor).getByRole('button', { name: `添加项目成员 ${partnerName}` })).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: '保存项目资料' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑项目资料' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '编辑项目资料' }));
    editor = screen.getByRole('dialog', { name: '编辑项目资料' });
    expect(within(editor).getByRole('button', { name: `添加项目成员 ${partnerName}` })).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: `添加项目成员 ${partnerName}` }));
    fireEvent.click(within(editor).getByRole('button', { name: '保存项目资料' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑项目资料' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '编辑项目资料' }));
    editor = screen.getByRole('dialog', { name: '编辑项目资料' });
    expect(within(editor).getByRole('button', { name: `移出项目成员 ${partnerName}` })).toBeInTheDocument();
  });

  it('shows a project file removed from Windows and prevents opening it', () => {
    const state = createTestState();
    const project = state.projects.find((item) => item.id === state.activeProjectId)!;
    project.workspace = { status: 'ready', rootPath: 'C:\\Projects\\demo', deliverablesPath: 'C:\\Projects\\demo\\deliverables' };
    project.files = [{
      id: 'missing-project-file', name: '已删除交付.md', meta: '伙伴交付', kind: 'document',
      fileId: 'missing-project-file', relativePath: 'deliverables\\partner\\已删除交付.md', availability: 'missing',
    }];
    localStorage.setItem(STATE_KEY, JSON.stringify(state));

    withProvider(
      <Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>,
      '/studio/discussion',
    );

    const removed = screen.getByRole('button', { name: /已删除交付\.md.*原文件已删除，引用已失效/ });
    expect(removed).toHaveAttribute('aria-disabled', 'true');
    fireEvent.contextMenu(removed);
    expect(screen.getByRole('menuitem', { name: '删除文件' })).toBeInTheDocument();
  });

  it('keeps project files inside a stable scroll region and removes the duplicate folder action', () => {
    const state = createTestState();
    const project = state.projects.find((item) => item.id === state.activeProjectId)!;
    project.workspace = { status: 'ready', rootPath: 'C:\\Projects\\demo', deliverablesPath: 'C:\\Projects\\demo\\deliverables' };
    project.files = Array.from({ length: 12 }, (_, index) => ({
      id: `project-file-${index}`,
      fileId: `project-file-${index}`,
      name: `交付-${index}.md`,
      meta: '伙伴交付',
      kind: 'document' as const,
      relativePath: `deliverables\\交付-${index}.md`,
      availability: 'available' as const,
    }));
    localStorage.setItem(STATE_KEY, JSON.stringify(state));

    const view = withProvider(
      <Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>,
      '/studio/discussion',
    );

    const list = screen.getByLabelText('项目文件列表');
    Object.defineProperty(list, 'getBoundingClientRect', { configurable: true, value: () => ({ right: 300 }) });
    fireEvent.pointerMove(list, { clientX: 286 });
    expect(list).toHaveClass('project-files-list--scrollbar');
    fireEvent.pointerLeave(list);
    expect(list).not.toHaveClass('project-files-list--scrollbar');
    expect(screen.queryByRole('button', { name: '打开全部文件' })).not.toBeInTheDocument();
    expect(view.container.querySelector('.project-files-list')).toBe(list);
    fireEvent.contextMenu(screen.getByRole('button', { name: /交付-0\.md/ }));
    expect(screen.getByRole('menuitem', { name: '删除文件' })).toBeInTheDocument();
  });

  it('deletes a project from Asterium while keeping a confirmation boundary', async () => {
    withProvider(
      <Routes><Route path="/studio/:mode" element={<StudioPage />} /></Routes>,
      '/studio/discussion',
    );
    const activeProjectName = screen.getAllByText('示例项目 A')[0].textContent;
    fireEvent.click(screen.getByRole('button', { name: '编辑项目资料' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '编辑项目资料' })).getByRole('button', { name: '删除项目' }));
    const confirmation = screen.getByRole('dialog', { name: '删除项目？' });
    expect(within(confirmation).getByText(/现有 Studio 群聊与伙伴项目工作笔记本会移入归档/)).toBeInTheDocument();
    expect(within(confirmation).getByText(/不会删除磁盘上的现有文件、聊天记录、单聊或伙伴原生线程/)).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole('button', { name: '删除项目' }));
    await waitFor(() => expect(screen.queryByText(activeProjectName ?? '')).not.toBeInTheDocument());
  });
});
