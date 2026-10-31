import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { savePrototypeState, STATE_KEY } from '../../src/renderer/app/persistence';
import { createTestState } from '../fixtures/applicationState';
import { SettingsPage } from '../../src/renderer/pages/SettingsPage';
import { ChatPage } from '../../src/renderer/pages/ChatPage';
import { StudioPage } from '../../src/renderer/pages/StudioPage';

function renderSettings(route = '/settings/partners') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <PrototypeProvider>
        <SettingsPage />
      </PrototypeProvider>
    </MemoryRouter>,
  );
}

function renderLifecycleApp() {
  return render(
    <MemoryRouter initialEntries={['/settings/partners']}>
      <PrototypeProvider>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/partners" element={<SettingsPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/studio/:mode" element={<StudioPage />} />
        </Routes>
      </PrototypeProvider>
    </MemoryRouter>,
  );
}

describe('SettingsPage partner workflows', () => {
  afterEach(() => { window.asteriumAgents = undefined; window.asteriumMemory = undefined; window.asteriumStudio = undefined; window.asteriumExtensions = undefined; });
  it('opens Skills settings and preserves dirty inputs when the current section is clicked', async () => {
    window.asteriumExtensions = { get: vi.fn(async () => ({ version: 0, extensions: [], bindings: [] })), mcpStatus: vi.fn(async () => []), upsert: vi.fn(), remove: vi.fn(), setTrust: vi.fn(), setBinding: vi.fn(), connectMcp: vi.fn(), disconnectMcp: vi.fn() };
    renderSettings('/settings/partners?section=skills');
    await screen.findByRole('heading', { name: 'Skills 管理' });
    fireEvent.click(await screen.findByRole('button', { name: '添加 Skill' }));
    fireEvent.change(screen.getByLabelText('Skill 名称'), { target: { value: 'Draft skill' } });
    fireEvent.click(screen.getByRole('button', { name: 'SKILLS' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Skill 配置尚未保存');
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByLabelText('Skill 名称')).toHaveValue('Draft skill');
  });
  it('opens MCP settings from its route and guards an unsaved draft when leaving the section', async () => {
    window.asteriumExtensions = { get: vi.fn(async () => ({ version: 0, extensions: [], bindings: [] })), mcpStatus: vi.fn(async () => []), upsert: vi.fn(), remove: vi.fn(), setTrust: vi.fn(), setBinding: vi.fn(), connectMcp: vi.fn(), disconnectMcp: vi.fn() };
    renderSettings('/settings/partners?section=mcp');
    await screen.findByRole('heading', { name: 'MCP 管理' });
    fireEvent.click(await screen.findByRole('button', { name: '添加 MCP' }));
    fireEvent.change(screen.getByLabelText('服务名称'), { target: { value: 'Unsaved MCP' } });
    fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('服务名称')).toHaveValue('Unsaved MCP');
    fireEvent.click(screen.getByRole('button', { name: '伙伴管理' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('MCP 配置或凭据输入尚未保存');
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByLabelText('服务名称')).toHaveValue('Unsaved MCP');
    fireEvent.click(screen.getByRole('button', { name: '伙伴管理' }));
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    await screen.findByRole('heading', { name: '伙伴管理' });
    expect(window.asteriumExtensions.upsert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
    await screen.findByRole('button', { name: '添加 MCP' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('opens the protected profile directory through the desktop bridge', async () => {
    const openProfileDirectory = vi.fn(async () => undefined);
    window.asteriumAgents = {
      detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(),
      openProfileDirectory,
      onEvent: vi.fn(() => () => undefined),
    };
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '打开资料目录' }));
    await waitFor(() => expect(openProfileDirectory).toHaveBeenCalledTimes(1));
  });

  it('keeps existing-thread, local CLI, and API fields separate', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    expect(screen.getByText('已有服务或线程')).toBeInTheDocument();
    expect(screen.getByLabelText(/认证信息/)).toBeInTheDocument();
    expect(screen.queryByText(/系统 Prompt/)).not.toBeInTheDocument();
    expect(screen.queryByText('性格与相处方式')).not.toBeInTheDocument();
    expect(screen.getByText('记忆由现有伙伴自行管理')).toBeInTheDocument();
    expect(screen.queryByLabelText('记忆管理方式')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '邀请本地伙伴' }));
    expect(screen.getByText('本地 CLI')).toBeInTheDocument();
    expect(screen.getByText('伙伴配置来源与会话')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /向该伙伴提供用户资料/ })).not.toBeChecked();
    expect(screen.getByLabelText('记忆管理方式')).toHaveValue('self_managed');
    expect(screen.queryByLabelText(/认证信息/)).not.toBeInTheDocument();
    expect(screen.queryByText(/系统 Prompt/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '添加新伙伴' }));
    expect(screen.getByText('模型连接')).toBeInTheDocument();
    expect(screen.getAllByText('性格与相处方式')).toHaveLength(2);
    expect(screen.getByText(/系统 Prompt/)).toBeInTheDocument();
    expect(screen.getByText('记忆与会话连续性')).toBeInTheDocument();
    expect(screen.getByText('长期记忆由星丛管理')).toBeInTheDocument();
    expect(screen.getByText(/默认保留同一会话的运行记录/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /保留 API 同一会话运行记录/ })).not.toBeInTheDocument();
    expect(screen.queryByText('伙伴配置来源与会话')).not.toBeInTheDocument();
  });

  it('restores a remembered desktop Codex runtime after restart and remaps an updated runtime id', async () => {
    const state = createTestState();
    const partner = state.partners.find((item) => item.id === 'fixture-local-a');
    if (!partner || partner.sourceMode !== 'local_cli') throw new Error('expected local demo partner');
    Object.assign(partner, {
      isPrototype: false,
      location: 'local',
      connectionKind: 'local_codex',
      adapterType: 'codex_cli',
      codexRuntimeId: 'runtime-desktop-old',
      codexRuntime: {
        executablePath: 'C:\\Users\\fixture-user\\AppData\\Local\\OpenAI\\Codex\\bin\\old\\codex.exe',
        executableLabel: 'codex.exe',
        environment: 'desktop_app',
        environmentLabel: 'Codex 桌面应用',
        codexHome: 'C:\\Users\\fixture-user\\.codex',
        loggedIn: true,
        version: '0.159.2',
        authMethod: 'using ChatGPT',
      },
    });
    savePrototypeState(state);
    const detectCodex = vi.fn(async () => ({
      installed: true,
      loggedIn: true,
      version: '0.144.5',
      executableLabel: 'codex.exe',
      recommendedRuntimeId: 'runtime-global-current',
      runtimes: [
        { runtimeId: 'runtime-global-current', executablePath: 'C:\\npm\\codex.exe', executableLabel: 'codex.exe', environment: 'global_cli' as const, environmentLabel: '全局 npm CLI', codexHome: 'C:\\Users\\fixture-user\\.codex', installed: true, loggedIn: true, version: '0.144.5', authMethod: 'using ChatGPT' },
        { runtimeId: 'runtime-desktop-current', executablePath: 'C:\\Users\\fixture-user\\AppData\\Local\\OpenAI\\Codex\\bin\\new\\codex.exe', executableLabel: 'codex.exe', environment: 'desktop_app' as const, environmentLabel: 'Codex 桌面应用', codexHome: 'C:\\Users\\fixture-user\\.codex', installed: true, loggedIn: true, version: '0.160.0', authMethod: 'using ChatGPT' },
      ],
    }));
    window.asteriumAgents = {
      detectClaude: vi.fn(),
      detectCodex,
      selectWorkspace: vi.fn(),
      sendClaudeMessage: vi.fn(),
      cancelRun: vi.fn(),
      resumeSession: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
    };

    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /测试伙伴 A的头像/ }));
    expect(screen.getByText('上次选择：Codex 桌面应用 · 0.159.2')).toBeInTheDocument();
    expect(localStorage.getItem(STATE_KEY)).not.toContain('AppData');

    fireEvent.click(screen.getByRole('button', { name: '检测 CLI 与登录状态' }));
    await waitFor(() => expect(detectCodex).toHaveBeenCalledTimes(1));
    const desktop = await screen.findByRole('button', { name: '选择 Codex 运行时 Codex 桌面应用 0.160.0' });
    expect(desktop).toHaveClass('active');
    expect(screen.getByRole('button', { name: '选择 Codex 运行时 全局 npm CLI 0.144.5' })).not.toHaveClass('active');
  });

  it('manages one global optional Brave key without a network toggle or renderer persistence', async () => {
    const saveWebSearchCredential = vi.fn(async () => ({ configured: true, masked: '••••••••' }));
    const deleteWebSearchCredential = vi.fn(async () => undefined);
    window.asteriumAgents = {
      detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(),
      webSearchCredentialStatus: vi.fn(async () => ({ configured: false, masked: '' })),
      saveWebSearchCredential,
      deleteWebSearchCredential,
      onEvent: vi.fn(() => () => undefined),
    };
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '权限和安全' }));

    expect(await screen.findByText('免 Key 搜索默认可用')).toBeInTheDocument();
    expect(screen.getByText('始终开启')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const input = screen.getByLabelText(/Brave Search API Key/);
    fireEvent.change(input, { target: { value: 'brave-secret-never-persist' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 Brave Key' }));

    expect(await screen.findByText(/Brave Key 已安全保存/)).toBeInTheDocument();
    expect(saveWebSearchCredential).toHaveBeenCalledWith('brave-secret-never-persist');
    expect(localStorage.getItem(STATE_KEY) ?? '').not.toContain('brave-secret-never-persist');
    expect(input).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: '移除 Key' }));
    expect(await screen.findByText(/Brave Key 已移除/)).toBeInTheDocument();
    expect(deleteWebSearchCredential).toHaveBeenCalledTimes(1);
  });

  it('distinguishes CyberBoss server and local connection forms without guessing a local bridge', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    const serviceType = screen.getByLabelText('服务类型');
    expect(serviceType).toHaveValue('cyberboss_server');
    expect(screen.getByLabelText('服务地址')).toHaveValue('');
    expect(screen.getByLabelText('当前线程 ID')).toBeInTheDocument();

    fireEvent.change(serviceType, { target: { value: 'cyberboss_local' } });
    expect(screen.getByText('本地版暂不能直接套用服务器版连接')).toBeInTheDocument();
    expect(screen.queryByLabelText('服务地址')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('当前线程 ID')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '测试真实连接' })).not.toBeInTheDocument();

    fireEvent.change(serviceType, { target: { value: 'cyberboss_server' } });
    expect(screen.getByRole('button', { name: '测试真实连接' })).toBeInTheDocument();
  });

  it('adds an API partner without persisting the API key', async () => {
    window.asteriumAgents = {
      detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(),
      saveApiCredential: vi.fn(async () => ({ credentialRef: 'credential-test', configured: true, masked: '••••••••' })),
      apiCredentialStatus: vi.fn(async () => ({ credentialRef: 'credential-test', configured: true, masked: '••••••••' })),
      onEvent: vi.fn(() => () => undefined),
    };
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '添加新伙伴' }));
    fireEvent.change(screen.getByLabelText('API 站点'), { target: { value: 'preset-deepseek' } });
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: 'deepseek-v4-flash' } });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'secret-must-not-persist' } });
    fireEvent.change(screen.getByLabelText(/显示名称/), { target: { value: '本地新伙伴' } });
    fireEvent.change(screen.getByLabelText('称呼或 @ 名称'), { target: { value: '新伙伴' } });
    fireEvent.click(screen.getByRole('button', { name: '添加 API 伙伴' }));

    expect(await screen.findByText('本地新伙伴 已加入星丛', {}, { timeout: 2000 })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(STATE_KEY)).toContain('本地新伙伴'));
    expect(localStorage.getItem(STATE_KEY)).not.toContain('secret-must-not-persist');
    expect(screen.queryByDisplayValue('secret-must-not-persist')).not.toBeInTheDocument();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it('persists DeepSeek thinking controls and the authorized Agent workspace', async () => {
    const selectWorkspace = vi.fn(async () => ({ grantId: 'api-workspace-grant', displayPath: 'K:\\API Agent 工作区' }));
    window.asteriumAgents = {
      detectClaude: vi.fn(), selectWorkspace, sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(),
      saveApiCredential: vi.fn(async () => ({ credentialRef: 'credential-agent', configured: true, masked: '••••••••' })),
      apiCredentialStatus: vi.fn(async () => ({ credentialRef: 'credential-agent', configured: true, masked: '••••••••' })),
      onEvent: vi.fn(() => () => undefined),
    };
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '添加新伙伴' }));
    fireEvent.change(screen.getByLabelText('API 站点'), { target: { value: 'preset-deepseek' } });
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: 'deepseek-v4-flash' } });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'temporary-secret' } });
    fireEvent.change(screen.getByLabelText(/显示名称/), { target: { value: 'Agent 测试伙伴' } });
    fireEvent.change(screen.getByLabelText('称呼或 @ 名称'), { target: { value: '测试伙伴' } });
    fireEvent.change(screen.getByLabelText('思考模式'), { target: { value: 'enabled' } });
    fireEvent.change(screen.getByLabelText('思考强度'), { target: { value: 'max' } });
    fireEvent.click(screen.getByRole('button', { name: '添加工作目录' }));
    expect(await screen.findByText('K:\\API Agent 工作区')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加 API 伙伴' }));

    expect(await screen.findByText('Agent 测试伙伴 已加入星丛', {}, { timeout: 2000 })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(STATE_KEY)).toContain('api-workspace-grant'));
    const persisted = localStorage.getItem(STATE_KEY) ?? '';
    expect(persisted).toContain('"thinkingMode":"enabled"');
    expect(persisted).toContain('"reasoningEffort":"max"');
    expect(persisted).toContain('"apiSessionHistoryEnabled":true');
    expect(persisted).toContain('"memoryMode":"asterium"');
    expect(persisted).toContain('"primaryWorkspaceGrantId":"api-workspace-grant"');
    expect(persisted).not.toContain('temporary-secret');
    expect(selectWorkspace).toHaveBeenCalledWith('workspace');
  });

  it('shows the authoritative partner workspace and removes it through the same main-process state', async () => {
    const workspaceListeners: Array<(state: import('../../src/shared/agentProtocol').PartnerWorkspaceState) => void> = [];
    let actual = {
      partnerId: 'fixture-local-a',
      cwd: { grantId: 'cwd-real', displayPath: 'D:\\fixture-workspace' },
      workspaces: [{ grantId: 'extra-real', displayPath: 'K:\\实际目录' }],
      version: 5,
      unavailableGrantIds: [],
    };
    const syncPartnerWorkspace = vi.fn(async (partnerId: string, cwdGrantId: string | undefined, workspaceGrantIds: string[], expectedVersion?: number) => ({
      partnerId,
      ...(cwdGrantId ? { cwd: { grantId: cwdGrantId, displayPath: partnerId === 'fixture-local-a' ? 'D:\\fixture-workspace' : cwdGrantId } } : {}),
      workspaces: workspaceGrantIds.map((grantId) => ({ grantId, displayPath: grantId })),
      version: (expectedVersion ?? 0) + 1,
      unavailableGrantIds: [],
    }));
    window.asteriumAgents = {
      detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(),
      getPartnerWorkspace: vi.fn(async (partnerId) => partnerId === 'fixture-local-a' ? actual : { partnerId, workspaces: [], version: 0, unavailableGrantIds: [] }),
      syncPartnerWorkspace,
      onPartnerWorkspaceChanged: vi.fn((listener) => { workspaceListeners.push(listener); return () => undefined; }),
      onEvent: vi.fn(() => () => undefined),
    };
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /测试伙伴 A的头像/ }));

    expect(await screen.findByText('D:\\fixture-workspace')).toBeInTheDocument();
    expect(screen.getByText('K:\\实际目录')).toBeInTheDocument();

    actual = { ...actual, workspaces: [{ grantId: 'agent-added', displayPath: 'K:\\伙伴新增目录' }], version: 6 };
    act(() => { for (const listener of workspaceListeners) listener(actual); });
    expect(await screen.findByText('K:\\伙伴新增目录')).toBeInTheDocument();
    expect(screen.queryByText('K:\\实际目录')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '移除授权工作区 K:\\伙伴新增目录' }));
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(syncPartnerWorkspace).toHaveBeenCalledWith('fixture-local-a', 'cwd-real', [], 6));
  });

  it('connects an existing CyberBoss thread through the secure bridge without persisting the secret', async () => {
    window.asteriumAgents = {
      detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(),
      saveBridgeCredential: vi.fn(async () => ({ credentialRef: 'bridge-credential-test', configured: true, masked: '••••••••' })),
      testExistingThread: vi.fn(async () => ({
        credentialRef: 'bridge-credential-test', configured: true, masked: '••••••••', authenticated: true,
        threadId: '01a08723-bee6-7640-8917-28257cf5d1ab',
        workspaceRoot: '/home/ubuntu/codex-workspace',
        capabilities: { streamingText: true, cancellation: false, toolEvents: false, fileEvents: false, reconnect: true },
      })),
      deleteBridgeCredential: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
    };
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://cyberboss.example.invalid' } });
    fireEvent.change(screen.getByLabelText(/认证信息/), { target: { value: 'credential-must-not-persist' } });
    fireEvent.change(screen.getByLabelText(/显示名称/), { target: { value: '接回伙伴' } });
    fireEvent.change(screen.getByLabelText('称呼或 @ 名称'), { target: { value: '接回伙伴' } });
    fireEvent.click(screen.getByRole('button', { name: '测试真实连接' }));
    expect(await screen.findByText(/星丛会动态跟随 CyberBoss 当前活跃线程/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接回伙伴' }));
    expect(await screen.findByText('接回伙伴 已加入星丛')).toBeInTheDocument();
    expect(localStorage.getItem(STATE_KEY)).not.toContain('credential-must-not-persist');
    expect(localStorage.getItem(STATE_KEY)).toContain('bridge-credential-test');
    expect(window.asteriumAgents?.testExistingThread).toHaveBeenCalledWith({
      serviceUrl: 'https://cyberboss.example.invalid',
      threadId: '',
      credentialRef: 'bridge-credential-test',
    });
  });

  it('loads DeepSeek models on explicit fetch and keeps manual entry available', async () => {
    const listApiModels = vi.fn(async () => [
      { id: 'deepseek-chat', object: 'model' as const, ownedBy: 'deepseek' },
      { id: 'deepseek-reasoner', object: 'model' as const, ownedBy: 'deepseek' },
    ]);
    window.asteriumAgents = {
      detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(),
      listApiModels,
      onEvent: vi.fn(() => () => undefined),
    };
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '添加新伙伴' }));
    fireEvent.change(screen.getByLabelText('API 站点'), { target: { value: 'preset-deepseek' } });
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: 'deepseek-v4-flash' } });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'temporary-key' } });
    const modelInput = screen.getByRole('combobox', { name: /^模型/ });
    fireEvent.focus(modelInput);
    expect(listApiModels).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }));
    expect(await screen.findByText(/已读取 2 个模型/)).toBeInTheDocument();
    expect(listApiModels).toHaveBeenCalledTimes(1);
    expect(listApiModels).toHaveBeenCalledWith('deepseek', 'https://api.deepseek.com/chat/completions', undefined, 'temporary-key', undefined);
    expect(screen.getByRole('option', { name: /deepseek-chat/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /deepseek-reasoner/ }));
    expect(modelInput).toHaveValue('deepseek-reasoner');
    fireEvent.change(modelInput, { target: { value: 'deepseek-custom-model' } });
    expect(modelInput).toHaveValue('deepseek-custom-model');
  });

  it('edits the same partner and synchronizes its identity into chat references', async () => {
    renderLifecycleApp();
    fireEvent.click(screen.getByRole('button', { name: /测试伙伴 A的头像/ }));
    expect(screen.getByText(/正在查看 测试伙伴 A/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.getByText(/正在编辑 测试伙伴 A/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/显示名称/), { target: { value: '改名后的小伙伴' } });
    fireEvent.change(screen.getByLabelText(/擅长能力/), { target: { value: '跨页面协作' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(screen.getByText('修改已保存；已有单聊需显式重读人设，工作室需退出后重新加入。')).toBeInTheDocument();
    expect(screen.getAllByText('改名后的小伙伴').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '返回应用' }));
    expect(await screen.findAllByText('改名后的小伙伴')).not.toHaveLength(0);
  });

  it('confirms partner removal, keeps its historical chat read-only, and allows cancel', async () => {
    renderLifecycleApp();
    fireEvent.click(screen.getByRole('button', { name: /测试伙伴 A的头像/ }));
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    const dialog = screen.getByRole('dialog', { name: '确认移除伙伴？' });
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.getByText('测试伙伴 A')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    fireEvent.click(screen.getByRole('button', { name: '确认移除伙伴' }));
    expect(screen.queryByText('测试伙伴 A')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回应用' }));
    expect(await screen.findByText('伙伴已移除')).toBeInTheDocument();
    fireEvent.click(screen.getByText('测试对话'));
    expect(screen.getByText('伙伴已移除 · 历史聊天仅供查看')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/给 测试伙伴 A/)).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '归档 测试伙伴 A 及其全部对话' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '归档伙伴的全部对话？' })).getByRole('button', { name: '一键归档全部' }));
    expect(screen.queryByText('测试对话')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '进入设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /归档.*2/ }));
    expect(screen.getByRole('heading', { name: '归档管理' })).toBeInTheDocument();
    expect(screen.getByText('测试对话')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '恢复' })[0]);
    expect(screen.queryByText('测试对话')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));
    const purge = screen.getByRole('dialog', { name: '永久删除归档对话？' });
    fireEvent.click(within(purge).getByRole('button', { name: '永久删除' }));
    expect(await screen.findByRole('heading', { name: '还没有归档单聊' })).toBeInTheDocument();
  });

  it('restores and permanently deletes archived group chats from the group archive tab', async () => {
    const originalProjects = window.asteriumProjects;
    window.asteriumProjects = undefined;
    const state = createTestState();
    const now = new Date().toISOString();
    state.groupChats = [
      { id: 'archived-group-restore', projectId: state.projects[0].id, name: '待恢复群聊', memberIds: [], messages: [], createdAt: now, updatedAt: now, archivedAt: now },
      { id: 'archived-group-delete', projectId: state.projects[0].id, name: '待删除群聊', memberIds: [], messages: [], createdAt: now, updatedAt: now, archivedAt: now },
    ];
    state.activeGroupChatId = '';
    savePrototypeState(state);
    renderLifecycleApp();
    fireEvent.click(screen.getByRole('button', { name: /归档.*2/ }));
    fireEvent.click(screen.getByRole('button', { name: /群聊 2/ }));
    expect(screen.getByText('待恢复群聊')).toBeInTheDocument();
    expect(screen.getByText('待删除群聊')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '恢复' })[0]);
    await waitFor(() => expect(screen.queryByText('待恢复群聊')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));
    const dialog = screen.getByRole('dialog', { name: '永久删除归档群聊？' });
    fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '还没有归档群聊' })).toBeInTheDocument());
    window.asteriumProjects = originalProjects;
  });

  it('opens archived project notebooks read-only and exports a Markdown copy', async () => {
    const originalNotebooks = window.asteriumProjectNotebooks;
    const archivedAt = '2026-10-18T10:00:00.000Z';
    const notebook = {
      partnerId: 'fixture-local-a', projectId: 'deleted-project', projectName: '已删除项目', content: '# 归档笔记\n\n只读内容',
      state: 'archived' as const, revision: 4, contentHash: 'hash', createdAt: archivedAt, updatedAt: archivedAt, archivedAt,
    };
    const exportMarkdown = vi.fn(async () => true);
    window.asteriumProjectNotebooks = {
      get: vi.fn(), replace: vi.fn(), listArchived: vi.fn(async () => [notebook]), exportMarkdown,
      purge: vi.fn(async () => notebook),
    };
    try {
      renderLifecycleApp();
      fireEvent.click(screen.getByRole('button', { name: /归档/ }));
      fireEvent.click(await screen.findByRole('button', { name: /项目工作笔记 1/ }));
      fireEvent.click(screen.getByRole('button', { name: '查看' }));

      const dialog = screen.getByRole('dialog', { name: '已删除项目 · 归档工作笔记' });
      expect(within(dialog).getByLabelText('归档项目工作笔记 Markdown')).toHaveAttribute('readonly');
      expect(within(dialog).queryByRole('button', { name: /保存/ })).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: '导出 Markdown' }));
      await waitFor(() => expect(exportMarkdown).toHaveBeenCalledWith({ partnerId: 'fixture-local-a', projectId: 'deleted-project' }));
    } finally {
      window.asteriumProjectNotebooks = originalNotebooks;
    }
  });

  it('shows only Asterium-managed partner memories and their deterministic briefing', async () => {
    const record = {
      schemaVersion: 1 as const, memoryId: 'memory-1', partnerId: 'fixture-api', type: 'preference_and_collaboration' as const,
      status: 'active' as const, body: '用户偏好先审计再实施。', tags: ['协作'], weight: 5 as const,
      createdAt: '2026-10-18T10:00:00.000Z', updatedAt: '2026-10-18T10:00:00.000Z', comments: [],
      sources: [{ kind: 'single_chat' as const, conversationId: 'conversation-1', messageId: 'message-1' }],
    };
    const query = vi.fn(async () => ({ partnerId: 'fixture-api', archiveVersion: 'v1:test', records: [record] }));
    const readSource = vi.fn(async () => [{ index: 0, result: {
      state: 'changed' as const,
      source: record.sources[0],
      reason: 'content_changed' as const,
      messages: [
        { messageId: 'message-before', authorType: 'partner' as const, authorId: 'fixture-api', content: '前一句', createdAt: '2026-10-18T09:59:00.000Z', contentHash: 'a'.repeat(64), offset: -1 as const },
        { messageId: 'message-1', authorType: 'user' as const, authorId: 'user', content: '冻结的来源消息', createdAt: '2026-10-18T10:00:00.000Z', contentHash: 'b'.repeat(64), offset: 0 as const },
      ],
    } }]);
    const comment = vi.fn(async (request) => ({ ...record, updatedAt: '2026-10-18T11:00:00.000Z', comments: [{ commentId: 'comment-1', content: request.content, createdAt: '2026-10-18T11:00:00.000Z' }] }));
    const update = vi.fn(async (request) => ({ ...record, ...request, updatedAt: '2026-10-18T12:00:00.000Z', comments: [] }));
    window.asteriumMemory = {
      query,
      briefing: vi.fn(async () => ({ schemaVersion: 1, partnerId: 'fixture-api', archiveVersion: 'v1:test', logicalDate: '2026-10-18', generatedAt: '2026-10-18T10:00:00.000Z', content: '[星丛会话记忆简报]\n## 自我认知\n- 暂无' })),
      readSource,
      comment,
      update,
      onChanged: vi.fn(() => () => undefined),
    } as never;

    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    expect(await screen.findByText('用户偏好先审计再实施。')).toBeInTheDocument();
    expect(screen.getByText(/星丛会话记忆简报/)).toBeInTheDocument();
    const briefingCard = screen.getByText('会话记忆简报').closest('details');
    expect(briefingCard).toHaveAttribute('open');
    fireEvent.click(screen.getByText('会话记忆简报').closest('summary')!);
    expect(briefingCard).not.toHaveAttribute('open');
    expect(screen.getByLabelText('选择记忆伙伴').querySelectorAll('button')).toHaveLength(1);
    expect(screen.getByLabelText('偏好与协作方式')).toBeInTheDocument();
    expect(screen.getByLabelText('权重 5')).toHaveTextContent('W5');
    expect(screen.queryByRole('button', { name: '新增记忆' })).not.toBeInTheDocument();
    expect(screen.getByTitle(new Date(record.updatedAt).toLocaleString('zh-CN'))).toHaveTextContent(/\d+(?:小时|天|个月)前/);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'fixture-api', limit: 100 }));

    fireEvent.click(screen.getByRole('button', { name: '偏好与协作方式' }));
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ types: ['preference_and_collaboration'] })));

    fireEvent.change(screen.getByLabelText('搜索记忆'), { target: { value: '协作' } });
    await waitFor(() => expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ text: '协作' })));

    fireEvent.click(screen.getByRole('button', { name: '查看记忆：用户偏好先审计再实施。' }));
    const detail = screen.getByRole('dialog', { name: '记忆详情' });
    fireEvent.click(within(detail).getByRole('button', { name: /单聊消息/ }));
    expect(await within(detail).findByText('原消息内容已变化，以下显示冻结摘录')).toBeInTheDocument();
    expect(within(detail).getByText('冻结的来源消息')).toBeInTheDocument();
    expect(readSource).toHaveBeenCalledWith({ partnerId: 'fixture-api', memoryId: 'memory-1', sourceIndex: 0 });

    fireEvent.change(within(detail).getByLabelText('添加补充'), { target: { value: '后续证据' } });
    fireEvent.click(within(detail).getByRole('button', { name: '添加补充' }));
    await waitFor(() => expect(comment).toHaveBeenCalledWith({ partnerId: 'fixture-api', memoryId: 'memory-1', expectedUpdatedAt: '2026-10-18T10:00:00.000Z', content: '后续证据' }));

    fireEvent.click(within(detail).getByRole('button', { name: '编辑' }));
    const editor = screen.getByRole('dialog', { name: '编辑记忆' });
    fireEvent.change(within(editor).getByLabelText('记忆正文'), { target: { value: '更新后的协作偏好' } });
    fireEvent.change(within(editor).getByLabelText('记忆状态'), { target: { value: 'obsolete' } });
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'fixture-api', memoryId: 'memory-1', expectedUpdatedAt: '2026-10-18T11:00:00.000Z', status: 'obsolete', body: '更新后的协作偏好' })));

  });

  it('moves managed memories through trash, restore, and permanent deletion confirmations', async () => {
    const active = {
      schemaVersion: 1 as const, memoryId: 'active-memory', partnerId: 'fixture-api', type: 'stable_fact' as const,
      status: 'active' as const, body: '仍在档案中的记忆', tags: [], weight: 3 as const,
      createdAt: '2026-10-18T10:00:00.000Z', updatedAt: '2026-10-18T10:00:00.000Z', comments: [], sources: [],
    };
    const deleted = { ...active, memoryId: 'deleted-memory', body: '回收站中的记忆', deletedAt: '2026-10-18T11:00:00.000Z', updatedAt: '2026-10-18T11:00:00.000Z' };
    const query = vi.fn(async (request: { includeDeleted?: boolean }) => ({ partnerId: 'fixture-api', archiveVersion: 'v1:test', records: request.includeDeleted ? [active, deleted] : [active] }));
    const softDelete = vi.fn(async () => ({ ...active, deletedAt: '2026-10-18T12:00:00.000Z' }));
    const restore = vi.fn(async () => ({ ...deleted, deletedAt: undefined, updatedAt: '2026-10-18T12:00:00.000Z' }));
    const purge = vi.fn(async () => deleted);
    window.asteriumMemory = {
      query,
      briefing: vi.fn(async () => ({ schemaVersion: 1, partnerId: 'fixture-api', archiveVersion: 'v1:test', logicalDate: '2026-10-18', generatedAt: '2026-10-18T10:00:00.000Z', content: '[星丛会话记忆简报]' })),
      softDelete,
      restore,
      purge,
      onChanged: vi.fn(() => () => undefined),
    } as never;

    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看记忆：仍在档案中的记忆' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '记忆详情' })).getByRole('button', { name: '移入归档库' }));
    const softDeleteDialog = screen.getByRole('dialog', { name: '移入归档库' });
    expect(within(softDeleteDialog).getByText('仍在档案中的记忆')).toBeInTheDocument();
    expect(within(softDeleteDialog).getByText('这条记忆将离开当前档案')).toBeInTheDocument();
    expect(within(softDeleteDialog).getByText('之后仍可恢复')).toBeInTheDocument();
    fireEvent.click(within(softDeleteDialog).getByRole('button', { name: '确认移入归档库' }));
    await waitFor(() => expect(softDelete).toHaveBeenCalledWith({ partnerId: 'fixture-api', memoryId: 'active-memory', expectedUpdatedAt: '2026-10-18T10:00:00.000Z' }));

    fireEvent.click(screen.getByRole('button', { name: '归档库' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看记忆：回收站中的记忆' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '记忆详情' })).getByRole('button', { name: '恢复' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '恢复记忆' })).getByRole('button', { name: '确认恢复' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith({ partnerId: 'fixture-api', memoryId: 'deleted-memory', expectedUpdatedAt: '2026-10-18T11:00:00.000Z' }));

    fireEvent.click(await screen.findByRole('button', { name: '查看记忆：回收站中的记忆' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '记忆详情' })).getByRole('button', { name: '永久删除' }));
    const purgeDialog = screen.getByRole('dialog', { name: '永久删除记忆' });
    expect(within(purgeDialog).getByText('删除后无法恢复')).toBeInTheDocument();
    expect(within(purgeDialog).getByText(/正文、标签、补充记录和来源锚点/)).toBeInTheDocument();
    expect(within(purgeDialog).getByText('引用保护仍然有效')).toBeInTheDocument();
    fireEvent.click(within(purgeDialog).getByRole('button', { name: '确认永久删除' }));
    await waitFor(() => expect(purge).toHaveBeenCalledWith({ partnerId: 'fixture-api', memoryId: 'deleted-memory', expectedUpdatedAt: '2026-10-18T11:00:00.000Z' }));
  });

  it('soft-deletes selected memory rows in a batch without changing permanent-delete semantics', async () => {
    const records = ['第一条待删除记忆', '第二条待删除记忆'].map((body, index) => ({
      schemaVersion: 1 as const, memoryId: `bulk-${index + 1}`, partnerId: 'fixture-api', type: 'stable_fact' as const,
      status: 'active' as const, body, tags: [], weight: 3 as const,
      createdAt: `2026-10-18T0${index + 8}:00:00.000Z`, updatedAt: `2026-10-18T0${index + 8}:00:00.000Z`, comments: [], sources: [],
    }));
    const softDelete = vi.fn(async (request: { memoryId: string }) => ({ ...records.find((record) => record.memoryId === request.memoryId)!, deletedAt: '2026-10-18T12:00:00.000Z' }));
    window.asteriumMemory = {
      query: vi.fn(async () => ({ partnerId: 'fixture-api', archiveVersion: 'v1:test', records })),
      briefing: vi.fn(async () => ({ schemaVersion: 1, partnerId: 'fixture-api', archiveVersion: 'v1:test', logicalDate: '2026-10-18', generatedAt: '2026-10-18T10:00:00.000Z', content: '[星丛会话记忆简报]' })),
      softDelete,
      onChanged: vi.fn(() => () => undefined),
    } as never;

    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    expect(await screen.findByText('第一条待删除记忆')).toBeInTheDocument();
    expect(screen.queryByLabelText('选择记忆：第一条待删除记忆')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }));
    expect(screen.getByLabelText('选择记忆：第一条待删除记忆')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消删除' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消删除' }));
    expect(screen.queryByLabelText('选择记忆：第一条待删除记忆')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }));
    fireEvent.click(screen.getByLabelText('选择记忆：第一条待删除记忆'));
    fireEvent.click(screen.getByLabelText('选择记忆：第二条待删除记忆'));
    fireEvent.click(screen.getByRole('button', { name: '删除所选（2）' }));
    const dialog = screen.getByRole('dialog', { name: '批量移入归档库' });
    expect(within(dialog).getByText('移入 2 条记忆')).toBeInTheDocument();
    expect(within(dialog).getByText('所选记忆将离开当前档案')).toBeInTheDocument();
    expect(within(dialog).getByText('之后仍可恢复')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认批量删除' }));

    await waitFor(() => expect(softDelete).toHaveBeenCalledTimes(2));
    expect(softDelete).toHaveBeenNthCalledWith(1, { partnerId: 'fixture-api', memoryId: 'bulk-1', expectedUpdatedAt: '2026-10-18T08:00:00.000Z' });
    expect(softDelete).toHaveBeenNthCalledWith(2, { partnerId: 'fixture-api', memoryId: 'bulk-2', expectedUpdatedAt: '2026-10-18T09:00:00.000Z' });
  });

  it('moves an already-removed partner profile to Windows recycle bin and keeps chat history in state', async () => {
    const state = createTestState();
    const partner = state.partners.find((item) => item.id === 'fixture-api');
    if (!partner) throw new Error('expected fixture-api');
    partner.isPrototype = false;
    partner.isRemoved = true;
    partner.removedAt = '2026-10-18T10:00:00.000Z';
    const originalConversationCount = state.conversations.filter((conversation) => conversation.partnerId === partner.id).length;
    savePrototypeState(state);
    const trashPartnerProfile = vi.fn(async () => true);
    window.asteriumAgents = { trashPartnerProfile, onEvent: vi.fn(() => () => undefined) } as never;
    window.asteriumMemory = {
      query: vi.fn(async () => ({ partnerId: 'fixture-api', archiveVersion: 'v1:test', records: [] })),
      briefing: vi.fn(async () => ({ schemaVersion: 1, partnerId: 'fixture-api', archiveVersion: 'v1:test', logicalDate: '2026-10-18', generatedAt: '2026-10-18T10:00:00.000Z', content: '[星丛会话记忆简报]' })),
      onChanged: vi.fn(() => () => undefined),
    } as never;

    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    expect(await screen.findByText('已移除 · 档案保留')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除已移除伙伴 测试伙伴 C' }));
    const dialog = screen.getByRole('dialog', { name: '删除已移除伙伴资料' });
    expect(within(dialog).getByText('测试伙伴 C')).toBeInTheDocument();
    expect(within(dialog).getByText(/记忆、人设和项目工作笔记/)).toBeInTheDocument();
    expect(within(dialog).getByText('聊天记录会保留')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /移入 Windows 回收站/ }));

    await waitFor(() => expect(trashPartnerProfile).toHaveBeenCalledWith('fixture-api'));
    await waitFor(() => expect(screen.queryByText('已移除 · 档案保留')).not.toBeInTheDocument());
    const persisted = JSON.parse(localStorage.getItem(STATE_KEY)!) as ReturnType<typeof createTestState>;
    expect(persisted.partners.find((item) => item.id === 'fixture-api')?.managedDataDeletedAt).toBeTruthy();
    expect(persisted.conversations.filter((conversation) => conversation.partnerId === 'fixture-api')).toHaveLength(originalConversationCount);
  });

  it('opens a live single-chat memory source and highlights the original message', async () => {
    const state = createTestState();
    const sourceConversation = { ...state.conversations[0], id: 'memory-source-chat', partnerId: 'fixture-api', title: '记忆来源单聊', isArchived: false, messages: [{ id: 'memory-source-message', authorId: state.userProfile.id, content: '需要定位的单聊原消息', createdAt: '10:00', status: 'delivered' as const }] };
    state.conversations = [sourceConversation, ...state.conversations];
    state.activeConversationId = state.conversations[1].id;
    savePrototypeState(state);
    const source = { kind: 'single_chat' as const, conversationId: sourceConversation.id, messageId: 'memory-source-message' };
    const record = { schemaVersion: 1 as const, memoryId: 'source-memory', partnerId: 'fixture-api', type: 'stable_fact' as const, status: 'active' as const, body: '可定位的单聊记忆', tags: [], weight: 3 as const, createdAt: '2026-10-18T10:00:00.000Z', updatedAt: '2026-10-18T10:00:00.000Z', comments: [], sources: [source] };
    window.asteriumMemory = {
      query: vi.fn(async () => ({ partnerId: 'fixture-api', archiveVersion: 'v1:test', records: [record] })),
      briefing: vi.fn(async () => ({ schemaVersion: 1, partnerId: 'fixture-api', archiveVersion: 'v1:test', logicalDate: '2026-10-18', generatedAt: '2026-10-18T10:00:00.000Z', content: '[星丛会话记忆简报]' })),
      readSource: vi.fn(async () => [{ index: 0, result: { state: 'live' as const, source, messages: [{ messageId: source.messageId, authorType: 'user' as const, authorId: state.userProfile.id, content: '需要定位的单聊原消息', createdAt: '2026-10-18T10:00:00.000Z', contentHash: 'a'.repeat(64), offset: 0 as const }] } }]),
      onChanged: vi.fn(() => () => undefined),
    } as never;
    renderLifecycleApp();
    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看记忆：可定位的单聊记忆' }));
    const detail = screen.getByRole('dialog', { name: '记忆详情' });
    fireEvent.click(within(detail).getByRole('button', { name: /单聊消息/ }));
    fireEvent.click(await within(detail).findByRole('button', { name: '打开原消息' }));

    expect(await screen.findByText('需要定位的单聊原消息')).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById('chat-message-memory-source-message')).toHaveClass('is-reference-target'));
  });

  it('opens a live Studio memory source and highlights the original message', async () => {
    const state = createTestState();
    const group = state.groupChats[0];
    group.messages = [{ id: 'studio-memory-source', authorId: state.userProfile.id, content: '需要定位的 Studio 原消息', createdAt: '10:00', status: 'delivered', studioSeq: 1 }];
    state.activeProjectId = state.projects.find((project) => project.id !== group.projectId)?.id ?? group.projectId;
    state.activeGroupChatId = state.groupChats.find((item) => item.projectId === state.activeProjectId)?.id ?? '';
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    const source = { kind: 'studio' as const, roomId: group.id, messageId: 'studio-memory-source' };
    const record = { schemaVersion: 1 as const, memoryId: 'studio-source-memory', partnerId: 'fixture-api', type: 'long_term_project' as const, status: 'active' as const, body: '可定位的 Studio 记忆', tags: [], weight: 4 as const, createdAt: '2026-10-18T10:00:00.000Z', updatedAt: '2026-10-18T10:00:00.000Z', comments: [], sources: [source] };
    window.asteriumMemory = {
      query: vi.fn(async () => ({ partnerId: 'fixture-api', archiveVersion: 'v1:test', records: [record] })),
      briefing: vi.fn(async () => ({ schemaVersion: 1, partnerId: 'fixture-api', archiveVersion: 'v1:test', logicalDate: '2026-10-18', generatedAt: '2026-10-18T10:00:00.000Z', content: '[星丛会话记忆简报]' })),
      readSource: vi.fn(async () => [{ index: 0, result: { state: 'live' as const, source, messages: [{ messageId: source.messageId, authorType: 'user' as const, authorId: state.userProfile.id, content: '需要定位的 Studio 原消息', createdAt: '2026-10-18T10:00:00.000Z', contentHash: 'a'.repeat(64), offset: 0 as const }] } }]),
      onChanged: vi.fn(() => () => undefined),
    } as never;
    window.asteriumStudio = {
      getRoom: vi.fn(async () => ({
        metadata: { roomId: group.id, projectId: group.projectId, name: group.name, memberIds: group.memberIds },
        messages: [{ roomId: group.id, messageId: 'studio-memory-source', seq: 1, roundId: 'round-memory', authorType: 'user' as const, authorId: state.userProfile.id, content: '需要定位的 Studio 原消息', createdAt: '2026-10-18T10:00:00.000Z', status: 'completed' as const }],
        cursors: [], mutedPartnerIds: [], settings: { speakingMode: 'free_discussion' as const, selectedPartnerIds: [], discussionProtectionEnabled: true }, rotationOffset: 0, models: {},
      })),
      syncRoom: vi.fn(async () => ({
        metadata: { roomId: group.id, projectId: group.projectId, name: group.name, memberIds: group.memberIds },
        messages: [{ roomId: group.id, messageId: 'studio-memory-source', seq: 1, roundId: 'round-memory', authorType: 'user' as const, authorId: state.userProfile.id, content: '需要定位的 Studio 原消息', createdAt: '2026-10-18T10:00:00.000Z', status: 'completed' as const }],
        cursors: [], mutedPartnerIds: [], settings: { speakingMode: 'free_discussion' as const, selectedPartnerIds: [], discussionProtectionEnabled: true }, rotationOffset: 0, models: {},
      })),
      onRoomChanged: vi.fn(() => () => undefined),
    } as never;

    renderLifecycleApp();
    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看记忆：可定位的 Studio 记忆' }));
    const detail = screen.getByRole('dialog', { name: '记忆详情' });
    fireEvent.click(within(detail).getByRole('button', { name: /Studio 消息/ }));
    fireEvent.click(await within(detail).findByRole('button', { name: '打开原消息' }));

    expect(await screen.findByText('需要定位的 Studio 原消息')).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById('studio-message-studio-memory-source')).toHaveClass('is-reference-target'));
  });

  it('opens a project-deleted group read-only and exports the displayed Markdown', async () => {
    const originalStudio = window.asteriumStudio;
    const state = createTestState();
    const now = '2026-10-18T10:00:00.000Z';
    state.groupChats = [{
      id: 'deleted-project-room', projectId: 'deleted-project', name: '已删除项目群聊', memberIds: ['fixture-local-a'], messages: [],
      createdAt: now, updatedAt: now, archivedAt: now, projectDeletedAt: now,
    }];
    state.activeGroupChatId = '';
    savePrototypeState(state);
    const snapshot = {
      metadata: { roomId: 'deleted-project-room', projectId: 'deleted-project', name: '已删除项目群聊', memberIds: ['fixture-local-a'] },
      messages: [
        { roomId: 'deleted-project-room', messageId: 'message-1', seq: 1, roundId: 'round-1', authorType: 'user' as const, authorId: state.userProfile.id, content: '归档中的用户消息', createdAt: now, status: 'completed' as const },
        { roomId: 'deleted-project-room', messageId: 'message-2', seq: 2, roundId: 'round-1', authorType: 'partner' as const, authorId: 'fixture-local-a', content: '归档中的伙伴回复', createdAt: now, status: 'completed' as const },
      ],
      cursors: [], mutedPartnerIds: [], settings: { speakingMode: 'free_discussion' as const, selectedPartnerIds: [], discussionProtectionEnabled: true },
      rotationOffset: 0, models: {},
    };
    const exportMarkdown = vi.fn(async () => true);
    window.asteriumStudio = { getRoom: vi.fn(async () => snapshot), exportMarkdown, onRoomChanged: vi.fn(() => () => undefined) } as never;
    try {
      renderLifecycleApp();
      fireEvent.click(screen.getByRole('button', { name: /归档/ }));
      fireEvent.click(screen.getByRole('button', { name: /群聊 1/ }));
      expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '查看' }));

      const dialog = await screen.findByRole('dialog', { name: '已删除项目群聊 · 归档群聊' });
      const textarea = within(dialog).getByLabelText('归档群聊 Markdown');
      expect(textarea).toHaveAttribute('readonly');
      await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toContain('归档中的用户消息'));
      expect((textarea as HTMLTextAreaElement).value).toContain('归档中的伙伴回复');
      expect(within(dialog).queryByRole('button', { name: /保存/ })).not.toBeInTheDocument();
      const displayedMarkdown = (textarea as HTMLTextAreaElement).value;
      fireEvent.click(within(dialog).getByRole('button', { name: '导出 Markdown' }));
      await waitFor(() => expect(exportMarkdown).toHaveBeenCalledWith({ roomId: 'deleted-project-room', content: displayedMarkdown }));
    } finally {
      window.asteriumStudio = originalStudio;
    }
  });

  it('deletes all archived conversations from the archive toolbar in one flow', async () => {
    const state = createTestState();
    const archivedAt = new Date().toISOString();
    state.conversations = state.conversations.slice(0, 2).map((conversation, index) => ({
      ...conversation,
      id: `archived-conversation-${index}`,
      title: `待清空对话 ${index + 1}`,
      isArchived: true,
      archivedAt,
      nativeThreadState: undefined,
    }));
    state.activeConversationId = '';
    savePrototypeState(state);
    renderLifecycleApp();
    fireEvent.click(screen.getByRole('button', { name: /归档.*2/ }));

    fireEvent.click(screen.getByRole('button', { name: '一键删除全部' }));
    const dialog = screen.getByRole('dialog', { name: '一键删除全部归档对话？' });
    fireEvent.click(within(dialog).getByRole('button', { name: '全部永久删除' }));

    expect(await screen.findByRole('heading', { name: '还没有归档单聊' })).toBeInTheDocument();
  });

  it('uses an in-app warning card before replacing partner credentials', () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /测试伙伴 C的头像/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('API 站点'), { target: { value: 'preset-deepseek' } });
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), { target: { value: 'deepseek-v4-flash' } });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'replacement-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    const dialog = screen.getByRole('dialog', { name: '确认更新敏感配置？' });
    expect(within(dialog).getByText('现有认证信息将被替换')).toBeInTheDocument();
    expect(within(dialog).getByText(/不会写入伙伴资料、对话记录或浏览器存储/)).toBeInTheDocument();
    expect(nativeConfirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    nativeConfirm.mockRestore();
  });

  it('uses an in-app warning card before changing a partner config source', async () => {
    const state = createTestState();
    const partner = state.partners.find((item) => item.id === 'fixture-local-a');
    if (!partner || partner.sourceMode !== 'local_cli') throw new Error('expected local demo partner');
    Object.assign(partner, {
      isPrototype: false,
      partnerRoot: 'C:\\old-partner-root',
      partnerRootGrantId: 'grant-old-partner-root',
    });
    savePrototypeState(state);
    const nativeConfirm = vi.spyOn(window, 'confirm');
    window.asteriumAgents = {
      detectClaude: vi.fn(),
      selectWorkspace: vi.fn(async () => ({ grantId: 'grant-new-partner-root', displayPath: 'C:\\new-partner-root' })),
      sendClaudeMessage: vi.fn(),
      cancelRun: vi.fn(),
      resumeSession: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
    };
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /测试伙伴 A的头像/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '更改来源' }));
    await waitFor(() => expect(screen.getByText('C:\\new-partner-root')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    const dialog = screen.getByRole('dialog', { name: '确认修改伙伴配置来源？' });
    expect(within(dialog).getByText('旧会话与原生 session 会完整保留')).toBeInTheDocument();
    expect(within(dialog).getByText(/切回原目录后，原会话仍可继续/)).toBeInTheDocument();
    expect(nativeConfirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    nativeConfirm.mockRestore();
  });

  it('resets pending avatar state after save, cancel, partner switch, and same-file selection', async () => {
    renderSettings();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /测试伙伴 A的头像/ }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const input = screen.getByLabelText('选择头像文件');
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('待保存预览')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(screen.queryByText('待保存预览')).not.toBeInTheDocument();
    expect(screen.getByText('当前头像')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('选择头像文件'), { target: { files: [file] } });
    expect(await screen.findByText('待保存预览')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /测试伙伴 B的头像/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '放弃未保存的修改？' })).getByRole('button', { name: '放弃修改' }));
    expect(screen.queryByText('待保存预览')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('选择头像文件'), { target: { files: [file] } });
    expect(await screen.findByText('待保存预览')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
    expect(screen.queryByText('待保存预览')).not.toBeInTheDocument();
    confirm.mockRestore();
  });
});
