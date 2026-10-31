import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/app/App';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { createTestState } from '../fixtures/applicationState';
import type { SendMessageCommand } from '../../src/shared/agentProtocol';

function installWorkspaceMismatch() {
  const state = createTestState();
  const partner = state.partners.find((item) => item.id === 'fixture-local-a');
  const conversation = state.conversations.find((item) => item.id === 'conversation-a-1');
  if (!partner || partner.sourceMode !== 'local_cli' || !conversation) throw new Error('demo fixture is incomplete');

  Object.assign(partner, {
    isPrototype: false,
    location: 'local',
    connectionKind: 'local_codex',
    connectionLabel: '本机 Codex',
    codexRuntimeId: 'runtime-global',
    codexRuntime: {
      executableLabel: 'codex.exe',
      environment: 'desktop_app',
      environmentLabel: 'Codex 桌面应用',
      codexHome: 'C:\\Users\\fixture-user\\.codex',
      loggedIn: true,
      version: '0.159.2',
      authMethod: 'using ChatGPT',
    },
    partnerRootKind: 'imported',
    partnerRoot: 'D:\\current-cwd',
    partnerRootGrantId: 'grant-current',
    workspaceGrantIds: [],
  });
  Object.assign(conversation, {
    partnerRootKind: 'imported',
    partnerRoot: 'K:\\old-cwd',
    partnerRootGrantId: 'grant-old',
    workspaceGrantIds: [],
    sessionId: 'thread-old',
    nativeToolProtocolVersion: 1,
  });
  localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
}

function installAgentBridge() {
  const sendLocalCliMessage = vi.fn(async (
    _adapterType: 'claude_code' | 'codex_cli',
    _partnerId: string,
    _partnerRootGrantId: string | undefined,
    _grantIds: string[],
    command: SendMessageCommand,
    _codexRuntimeId?: string,
    _codexRuntimeEnvironment?: 'global_cli' | 'desktop_app' | 'vscode_extension' | 'path',
  ) => {
    void _codexRuntimeId;
    void _codexRuntimeEnvironment;
    return { runId: 'run-next', sessionId: command.sessionId ?? 'thread-current' };
  });
  const syncPartnerWorkspace = vi.fn(async (partnerId: string, cwdGrantId: string | undefined, workspaceGrantIds: string[]) => ({
    partnerId,
    ...(cwdGrantId ? { cwd: { grantId: cwdGrantId, displayPath: 'K:\\old-root' } } : {}),
    workspaces: workspaceGrantIds.map((grantId) => ({ grantId, displayPath: grantId })),
    version: 1,
    unavailableGrantIds: [],
  }));
  window.asteriumAgents = {
    detectClaude: vi.fn(async () => ({ installed: false, loggedIn: false })),
    detectCodex: vi.fn(async () => ({ installed: true, loggedIn: true, runtimes: [] })),
    selectWorkspace: vi.fn(async () => null),
    syncPartnerWorkspace,
    sendClaudeMessage: vi.fn(),
    sendLocalCliMessage,
    cancelRun: vi.fn(async () => undefined),
    resumeSession: vi.fn(async () => undefined),
    resolveAuthorization: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
  };
  return { sendLocalCliMessage, syncPartnerWorkspace };
}

function renderChat() {
  render(<MemoryRouter initialEntries={['/chat']}><PrototypeProvider><App /></PrototypeProvider></MemoryRouter>);
}

describe('conversation workspace switching', () => {
  afterEach(() => {
    window.asteriumAgents = undefined;
    window.asteriumAttachments = undefined;
  });

  it('keeps the mismatched conversation editable and restores focus after cancelling the choice', async () => {
    installWorkspaceMismatch();
    const { sendLocalCliMessage } = installAgentBridge();
    renderChat();

    const input = await screen.findByRole('textbox', { name: '发送时将确认切换到当前工作区的新 session' });
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).not.toBeDisabled();

    fireEvent.change(input, { target: { value: '保留这条草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('dialog', { name: '这条对话绑定了另一个工作区' })).toBeInTheDocument();
    expect(screen.getByText('K:\\old-cwd')).toBeInTheDocument();
    expect(screen.getAllByText('D:\\current-cwd').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '这条对话绑定了另一个工作区' })).not.toBeInTheDocument());
    expect(input).toHaveValue('保留这条草稿');
    await waitFor(() => expect(input).toHaveFocus());
    expect(sendLocalCliMessage).not.toHaveBeenCalled();
  });

  it('can switch the partner back to the conversation cwd and resume its old native thread', async () => {
    installWorkspaceMismatch();
    const { sendLocalCliMessage, syncPartnerWorkspace } = installAgentBridge();
    renderChat();

    const input = await screen.findByRole('textbox', { name: '发送时将确认切换到当前工作区的新 session' });
    fireEvent.change(input, { target: { value: '继续旧线程' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(await screen.findByRole('button', { name: '切回旧 cwd' }));

    await waitFor(() => expect(syncPartnerWorkspace).toHaveBeenCalledWith('fixture-local-a', 'grant-old', []));
    await waitFor(() => expect(sendLocalCliMessage).toHaveBeenCalledTimes(1));
    expect(sendLocalCliMessage.mock.calls[0][2]).toBe('grant-old');
    expect(sendLocalCliMessage.mock.calls[0][4]).toEqual(expect.objectContaining({ sessionId: 'thread-old' }));
    expect(sendLocalCliMessage.mock.calls[0][6]).toBe('desktop_app');
  });

  it('can keep the current cwd and start a separate native thread for the visible conversation', async () => {
    installWorkspaceMismatch();
    const { sendLocalCliMessage, syncPartnerWorkspace } = installAgentBridge();
    renderChat();

    const input = await screen.findByRole('textbox', { name: '发送时将确认切换到当前工作区的新 session' });
    fireEvent.change(input, { target: { value: '使用当前工作区' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(await screen.findByRole('button', { name: '在当前 cwd 新建线程' }));

    await waitFor(() => expect(sendLocalCliMessage).toHaveBeenCalledTimes(1));
    expect(syncPartnerWorkspace).not.toHaveBeenCalled();
    expect(sendLocalCliMessage.mock.calls[0][2]).toBe('grant-current');
    expect(sendLocalCliMessage.mock.calls[0][4].sessionId).toBeUndefined();
  });
});
