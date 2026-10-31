import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/app/App';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { AGENT_PROTOCOL_VERSION, type RendererAgentEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';

describe('local Claude renderer flow', () => {
  afterEach(() => { window.asteriumAgents = undefined; });

  it('detects, grants, streams, shows an error, and cancels through the narrow preload API', async () => {
    let listener: ((event: RendererAgentEvent) => void) | undefined;
    const sendClaudeMessage = vi.fn(async (partnerId: string, partnerRootGrantId: string | undefined, grantIds: string[], command: SendMessageCommand) => {
      void partnerId;
      void partnerRootGrantId;
      void grantIds;
      void command;
      return { runId: 'run-1', sessionId: 'session-1' };
    });
    const cancelRun = vi.fn(async (command: Parameters<NonNullable<typeof window.asteriumAgents>['cancelRun']>[0]) => { void command; });
    const sendGuidance = vi.fn(async () => ({ disposition: 'deferred' as const }));
    window.asteriumAgents = {
      detectClaude: vi.fn(async () => ({ installed: true, loggedIn: true, version: '2.1.198', authMethod: 'oauth_token', executableLabel: 'claude.exe' })),
      selectWorkspace: vi.fn()
        .mockResolvedValueOnce({ grantId: 'grant-1', displayPath: 'K:\\qa\\claude-smoke-renderer' })
        .mockResolvedValueOnce({ grantId: 'grant-2', displayPath: 'K:\\qa\\shared-assets' }),
      sendClaudeMessage,
      cancelRun,
      sendGuidance,
      resumeSession: vi.fn(async () => undefined),
      onEvent: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    };
    const mounted = render(<MemoryRouter initialEntries={['/settings/partners']}><PrototypeProvider><App /></PrototypeProvider></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '邀请本地伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '检测 CLI 与登录状态' }));
    expect(await screen.findByText(/Claude Code 2\.1\.198/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导入配置来源' }));
    expect(await screen.findByText('K:\\qa\\claude-smoke-renderer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加工作区' }));
    expect(await screen.findByText('K:\\qa\\shared-assets')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/显示名称/), { target: { value: '本地伙伴' } });
    fireEvent.change(screen.getByLabelText('称呼或 @ 名称'), { target: { value: '本地伙伴' } });
    fireEvent.click(screen.getByRole('button', { name: '确认邀请本地伙伴' }));
    expect(await screen.findByText('本地伙伴 已加入星丛')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '去和 TA 聊聊' }));

    const input = await screen.findByRole('textbox', { name: /给 本地伙伴 发送消息/ });
    fireEvent.change(input, { target: { value: '请回复一句话' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendClaudeMessage).toHaveBeenCalledTimes(1));
    expect(sendClaudeMessage.mock.calls[0][2]).toEqual(['grant-2']);
    expect(sendClaudeMessage.mock.calls[0][1]).toBe('grant-1');
    expect(sendClaudeMessage.mock.calls[0][3]).toMatchObject({ connectionSource: 'local_cli', content: { text: '请回复一句话' } });
    expect(sendClaudeMessage.mock.calls[0][3].runtimeContext).not.toHaveProperty('user');

    const base = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      eventId: 'event-1', partnerId: sendClaudeMessage.mock.calls[0][3].partnerId,
      conversationId: sendClaudeMessage.mock.calls[0][3].conversationId,
      connectionSource: 'local_cli' as const, clientMessageId: sendClaudeMessage.mock.calls[0][3].clientMessageId,
      sessionId: 'session-1', runId: 'run-1', occurredAt: new Date(0).toISOString(),
    };
    act(() => listener?.({ ...base, type: 'message.accepted', sequence: 1 }));
    act(() => listener?.({ ...base, eventId: 'event-2', type: 'text.delta', text: '真实流式回复', sequence: 2 }));
    expect(await screen.findByText('真实流式回复')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '下一轮请补充日志' } });
    fireEvent.click(screen.getByRole('button', { name: '暂存中途消息' }));
    const pendingGuidance = screen.getByLabelText('待发送的中途消息');
    expect(sendGuidance).not.toHaveBeenCalled();
    fireEvent.click(within(pendingGuidance).getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendGuidance).toHaveBeenCalledWith(expect.objectContaining({ type: 'guidance.send', runId: 'run-1', content: { type: 'text', text: '下一轮请补充日志' } })));
    expect(within(pendingGuidance).getByText('等待当前回复结束后自动发送')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '停止当前任务' }));
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', connectionSource: 'local_cli' })));
    act(() => listener?.({ ...base, eventId: 'event-3', type: 'run.failed', sequence: 3, error: { code: 'TEST_ERROR', message: '可读错误', stage: 'adapter', retryable: true } }));
    await waitFor(() => expect(sendClaudeMessage).toHaveBeenCalledTimes(2));
    expect(sendClaudeMessage.mock.calls[1][3]).toMatchObject({ sessionId: 'session-1', content: { text: '下一轮请补充日志' } });
    expect(await screen.findByText('这次任务没有完成')).toBeInTheDocument();
    expect(screen.queryByText('可读错误')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(localStorage.getItem('asterium.prototype.v7')).toContain('grant-1');
      expect(localStorage.getItem('asterium.prototype.v7')).toContain('session-1');
    });
    mounted.unmount();
    render(<MemoryRouter initialEntries={['/chat']}><PrototypeProvider><App /></PrototypeProvider></MemoryRouter>);
    const resumedInput = await screen.findByRole('textbox', { name: /给 本地伙伴 发送消息/ });
    fireEvent.change(resumedInput, { target: { value: '重启后继续' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendClaudeMessage).toHaveBeenCalledTimes(3));
    expect(sendClaudeMessage.mock.calls[2][2]).toEqual(['grant-2']);
    expect(sendClaudeMessage.mock.calls[2][3]).toMatchObject({ sessionId: 'session-1', content: { text: '重启后继续' } });
  });

  it('imports a selected Claude JSONL session and binds it to a new Asterium conversation', async () => {
    let sent: SendMessageCommand | undefined;
    window.asteriumAgents = {
      detectClaude: vi.fn(async () => ({ installed: true, loggedIn: true, version: '2.1.198', executableLabel: 'claude.exe' })),
      importClaudeSession: vi.fn(async () => ({
        sessionId: '417878a2-0066-4471-b81f-67a37418b7c0',
        sessionFilePath: 'C:\\Users\\fixture-user\\.claude\\projects\\K--qa\\417878a2-0066-4471-b81f-67a37418b7c0.jsonl',
        workspaceGrant: { grantId: 'grant-imported', displayPath: 'K:\\qa' },
      })),
      selectWorkspace: vi.fn(),
      sendClaudeMessage: vi.fn(async (_partnerId, _partnerRootGrantId, _grants, command) => { sent = command; return { runId: 'run-imported', sessionId: '417878a2-0066-4471-b81f-67a37418b7c0' }; }),
      cancelRun: vi.fn(), resumeSession: vi.fn(), onEvent: vi.fn(() => () => undefined),
    };
    render(<MemoryRouter initialEntries={['/settings/partners']}><PrototypeProvider><App /></PrototypeProvider></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '邀请本地伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '检测 CLI 与登录状态' }));
    await screen.findByText(/Claude Code 2\.1\.198/);
    fireEvent.click(screen.getByRole('button', { name: '导入已有会话' }));
    fireEvent.click(screen.getByRole('button', { name: '选择 Claude session JSONL' }));
    expect(await screen.findByText(/已选择会话 417878a2/)).toBeInTheDocument();
    expect(screen.getByText('K:\\qa')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/显示名称/), { target: { value: '导入的本地伙伴' } });
    fireEvent.change(screen.getByLabelText('称呼或 @ 名称'), { target: { value: '导入本地伙伴' } });
    fireEvent.click(screen.getByRole('button', { name: '确认邀请本地伙伴' }));
    fireEvent.click(await screen.findByRole('button', { name: '去和 TA 聊聊' }));
    const input = await screen.findByRole('textbox', { name: /给 导入的本地伙伴 发送消息/ });
    fireEvent.change(input, { target: { value: '继续这个会话' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sent).toMatchObject({ sessionId: '417878a2-0066-4471-b81f-67a37418b7c0' }));
  });

  it('regenerates the latest Claude reply in a fresh session from the preceding visible context', async () => {
    let listener: ((event: RendererAgentEvent) => void) | undefined;
    const sendClaudeMessage = vi.fn(async (_partnerId: string, _partnerRootGrantId: string | undefined, _grants: string[], command: SendMessageCommand) => ({
      runId: sendClaudeMessage.mock.calls.length === 1 ? 'run-original' : 'run-regenerated',
      sessionId: sendClaudeMessage.mock.calls.length === 1 ? 'session-original' : 'session-regenerated',
      command,
    }));
    window.asteriumAgents = {
      detectClaude: vi.fn(async () => ({ installed: true, loggedIn: true, version: '2.1.198', authMethod: 'oauth_token', executableLabel: 'claude.exe' })),
      selectWorkspace: vi.fn(async () => ({ grantId: 'grant-claude', displayPath: 'K:\\qa\\claude-regenerate' })),
      sendClaudeMessage,
      cancelRun: vi.fn(),
      resumeSession: vi.fn(),
      onEvent: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    };
    render(<MemoryRouter initialEntries={['/settings/partners']}><PrototypeProvider><App /></PrototypeProvider></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '邀请本地伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '检测 CLI 与登录状态' }));
    await screen.findByText(/Claude Code 2\.1\.198/);
    fireEvent.click(screen.getByRole('button', { name: '导入配置来源' }));
    await screen.findByText('K:\\qa\\claude-regenerate');
    fireEvent.change(screen.getByLabelText(/显示名称/), { target: { value: '可重生的本地伙伴' } });
    fireEvent.change(screen.getByLabelText('称呼或 @ 名称'), { target: { value: '可重生本地伙伴' } });
    fireEvent.click(screen.getByRole('button', { name: '确认邀请本地伙伴' }));
    fireEvent.click(await screen.findByRole('button', { name: '去和 TA 聊聊' }));

    const input = await screen.findByRole('textbox', { name: /给 可重生的本地伙伴 发送消息/ });
    fireEvent.change(input, { target: { value: '请换一种说法' } });
    fireEvent.click(screen.getByRole('button', { name: /^发送$/ }));
    await waitFor(() => expect(sendClaudeMessage).toHaveBeenCalledTimes(1));
    const original = sendClaudeMessage.mock.calls[0][3];
    const originalBase = {
      protocolVersion: AGENT_PROTOCOL_VERSION, partnerId: original.partnerId, conversationId: original.conversationId,
      connectionSource: 'local_cli' as const, clientMessageId: original.clientMessageId,
      sessionId: 'session-original', runId: 'run-original', occurredAt: new Date(0).toISOString(),
    };
    act(() => listener?.({ ...originalBase, eventId: 'original-bound', type: 'session.bound', isNew: true, sequence: 1 }));
    act(() => listener?.({ ...originalBase, eventId: 'original-accepted', type: 'message.accepted', sequence: 2 }));
    act(() => listener?.({ ...originalBase, eventId: 'original-text', type: 'text.delta', text: '第一次回复', sequence: 3 }));
    act(() => listener?.({ ...originalBase, eventId: 'original-complete', type: 'run.completed', finishReason: 'end_turn', sequence: 4 }));
    expect(await screen.findByText('第一次回复')).toBeInTheDocument();
    let originalMessageId = '';
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('asterium.prototype.v7') ?? '{}') as { activeConversationId?: string; conversations?: Array<{ id: string; messages: Array<{ id: string; authorId: string }> }> };
      originalMessageId = stored.conversations?.find((item) => item.id === stored.activeConversationId)?.messages.find((item) => item.authorId === ASTERIUM_USER_ID)?.id ?? '';
      expect(originalMessageId).toMatch(/^message-/);
    });

    fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
    await waitFor(() => expect(sendClaudeMessage).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('第一次回复')).not.toBeInTheDocument();
    const regenerated = sendClaudeMessage.mock.calls[1][3];
    expect(regenerated).toMatchObject({
      connectionSource: 'local_cli',
      content: { text: '请换一种说法' },
    });
    expect(regenerated.sessionId).toBeUndefined();
    expect(regenerated.forkFromTurnId).toBeUndefined();

    const regeneratedBase = {
      protocolVersion: AGENT_PROTOCOL_VERSION, partnerId: regenerated.partnerId, conversationId: regenerated.conversationId,
      connectionSource: 'local_cli' as const, clientMessageId: regenerated.clientMessageId,
      sessionId: 'session-regenerated', runId: 'run-regenerated', occurredAt: new Date(1).toISOString(),
    };
    act(() => listener?.({ ...regeneratedBase, eventId: 'regenerated-bound', type: 'session.bound', isNew: true, sequence: 1 }));
    act(() => listener?.({ ...regeneratedBase, eventId: 'regenerated-accepted', type: 'message.accepted', sequence: 2 }));
    act(() => listener?.({ ...regeneratedBase, eventId: 'regenerated-text', type: 'text.delta', text: '第二次回复', sequence: 3 }));
    act(() => listener?.({ ...regeneratedBase, eventId: 'regenerated-complete', type: 'run.completed', finishReason: 'end_turn', sequence: 4 }));
    expect(await screen.findByText('第二次回复')).toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('asterium.prototype.v7') ?? '{}') as { activeConversationId?: string; conversations?: Array<{ id: string; sessionId?: string; messages: Array<{ id: string; authorId: string }> }> };
      const conversation = stored.conversations?.find((item) => item.id === stored.activeConversationId);
      expect(conversation?.sessionId).toBe('session-regenerated');
      expect(conversation?.messages.find((item) => item.authorId === ASTERIUM_USER_ID)?.id).toBe(originalMessageId);
    });
  });
});
