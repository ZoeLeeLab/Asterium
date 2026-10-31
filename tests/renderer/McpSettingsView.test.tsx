import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpSettingsView } from '../../src/renderer/components/extensions/McpSettingsView';
import { mcpDraft, mcpRequest } from '../../src/renderer/components/extensions/mcpSettingsForm';
import type { ApiExtensionSummary, ApiExtensionsSnapshot, AsteriumExtensionsApi } from '../../src/shared/apiExtensions';
import type { ApiPartner, Partner } from '../../src/renderer/types/domain';
import { createTestState } from '../fixtures/applicationState';

const id = 'extension-11111111-1111-1111-1111-111111111111';
const skillId = 'extension-22222222-2222-2222-2222-222222222222';
const entry: ApiExtensionSummary = { id, kind: 'mcp', name: 'Fixture', enabled: true, configuration: { type: 'mcp_stdio', command: 'node', args: ['server.mjs'], cwd: 'K:\\fixture', workspaceGrantId: 'workspace-11111111-1111-1111-1111-111111111111' }, secretNames: ['TOKEN'], hasSecrets: true, generation: 1, inventoryKnown: false, trust: 'untrusted' };
const apiPartner: ApiPartner = { ...createTestState().partners[0], id: 'api-one', sourceMode: 'api_partner', publicIdentity: { displayName: 'API 一', introduction: '', expertise: '', mentionName: 'api' }, provider: 'deepseek', model: 'test', personality: '', apiSessionHistoryEnabled: true, thinkingMode: 'disabled', reasoningEffort: 'low', configured: true, isPrototype: false };
const partners: Partner[] = [apiPartner, { ...apiPartner, id: 'removed', isRemoved: true, publicIdentity: { ...apiPartner.publicIdentity, displayName: '已移除 API' } }, { ...apiPartner, id: 'prototype', isPrototype: true, publicIdentity: { ...apiPartner.publicIdentity, displayName: '演示 API' } }, ...createTestState().partners];
afterEach(() => { window.asteriumExtensions = undefined; vi.useRealTimers(); });
function setup(extensions: ApiExtensionSummary[] = [entry], bindings: ApiExtensionsSnapshot['bindings'] = []) {
  let state: ApiExtensionsSnapshot = { version: 1, extensions: structuredClone(extensions), bindings };
  const api = {
    get: vi.fn(async () => structuredClone(state)), mcpStatus: vi.fn(async () => []),
    upsert: vi.fn<AsteriumExtensionsApi['upsert']>(async () => structuredClone(state)), remove: vi.fn(async () => { state = { version: state.version + 1, extensions: [], bindings: [] }; return structuredClone(state); }),
    setBinding: vi.fn(async () => structuredClone(state)),
    setTrust: vi.fn(async (request) => { state = { ...state, version: state.version + 1, extensions: state.extensions.map((item) => item.id === request.id ? { ...item, generation: item.generation + 1, trust: request.action === 'request' ? 'pending' : 'untrusted' } : item) }; return structuredClone(state); }),
    connectMcp: vi.fn(), disconnectMcp: vi.fn(),
  } satisfies AsteriumExtensionsApi;
  window.asteriumExtensions = api;
  const onDirtyChange = vi.fn();
  const result = render(<McpSettingsView partners={partners} onDirtyChange={onDirtyChange} />);
  return { api, onDirtyChange, ...result, setState: (value: ApiExtensionsSnapshot) => { state = structuredClone(value); } };
}
async function ready() { await screen.findByRole('heading', { name: '服务与连接' }); }
function detail() { return document.querySelector('.mcp-detail') as HTMLElement; }

describe('API MCP settings', () => {
  it('does not claim Native execution before a local connection actually starts', async () => {
    setup(); await ready();
    expect(screen.getByText(/本地连接跟随全局沙箱设置，以实际启动结果为准/)).toBeInTheDocument();
    expect(screen.queryByText(/当前使用原生运行环境，未启用沙箱/)).not.toBeInTheDocument();
  });
  it('stops an ungranted local management test before calling the desktop API', async () => {
    const s = setup([{ ...entry, configuration: { type: 'mcp_stdio', command: 'node', args: [], cwd: 'K:\\typed-path' } }]); await ready();
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('选择并授权'); expect(s.api.connectMcp).not.toHaveBeenCalled();
  });
  it('saves the grant returned by the MCP-specific directory picker, rather than granting a typed path', async () => {
    const previous = window.asteriumAgents;
    const selectWorkspace = vi.fn(async () => ({ grantId: 'workspace-44444444-4444-4444-4444-444444444444', displayPath: 'K:\\chosen-workspace' }));
    window.asteriumAgents = { ...previous, selectWorkspace } as NonNullable<typeof window.asteriumAgents>;
    try {
      const s = setup(); await ready(); fireEvent.click(screen.getByRole('button', { name: '编辑配置' }));
      fireEvent.click(screen.getByRole('button', { name: '选择并授权测试工作区' }));
      await waitFor(() => expect(screen.getByLabelText('工作目录（可选）')).toHaveValue('K:\\chosen-workspace'));
      fireEvent.submit(document.querySelector('form.mcp-editor')!);
      await waitFor(() => expect(s.api.upsert).toHaveBeenCalledWith(expect.objectContaining({ configuration: expect.objectContaining({ cwd: 'K:\\chosen-workspace', workspaceGrantId: 'workspace-44444444-4444-4444-4444-444444444444' }) })));
      expect(selectWorkspace).toHaveBeenCalledWith('mcp_workspace');
    } finally { window.asteriumAgents = previous; }
  });
  it('loads metadata without automatically connecting or granting trust and excludes native/prototype/removed partners', async () => {
    const s = setup(); await ready();
    expect(s.api.connectMcp).not.toHaveBeenCalled(); expect(s.api.setTrust).not.toHaveBeenCalled();
    expect(screen.getByText('已安全保存：TOKEN')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'API 一' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /已移除|演示/ })).not.toBeInTheDocument();
    expect(screen.getByText(/只读、Plan 和工作区限制仍然生效/)).toBeInTheDocument();
  });

  it('requests pending trust without exposing an activate action, and lets the user cancel it', async () => {
    const s = setup(); await ready();
    fireEvent.click(screen.getByRole('button', { name: '申请持续信任' }));
    await screen.findByRole('button', { name: '取消待信任' });
    expect(s.api.setTrust).toHaveBeenLastCalledWith({ id, expectedVersion: 1, action: 'request' });
    expect(screen.getByText(/允许一次不会激活/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消待信任' }));
    await screen.findByRole('button', { name: '申请持续信任' });
    expect(s.api.setTrust).toHaveBeenLastCalledWith({ id, expectedVersion: 2, action: 'revoke' });
    expect(screen.queryByRole('button', { name: '激活信任' })).not.toBeInTheDocument();
  });

  it('shows established trust and revokes it immediately without an activation fallback', async () => {
    const s = setup([{ ...entry, trust: 'trusted', inventoryKnown: true }]); await ready();
    fireEvent.click(screen.getByRole('button', { name: '撤销信任' }));
    await screen.findByRole('button', { name: '申请持续信任' });
    expect(s.api.setTrust).toHaveBeenCalledExactlyOnceWith({ id, expectedVersion: 1, action: 'revoke' });
    expect(screen.getByRole('status')).toHaveTextContent('信任已撤销');
  });

  it('still loads configuration and allows revocation if connection-status reads fail', async () => {
    const s = setup([{ ...entry, trust: 'trusted' }]);
    s.api.mcpStatus.mockRejectedValue(new Error('private-status-error'));
    await ready();
    expect(screen.getByText('连接状态暂时无法读取，配置仍可管理。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '撤销信任' }));
    await screen.findByRole('button', { name: '申请持续信任' });
    expect(s.api.setTrust).toHaveBeenCalledExactlyOnceWith({ id, expectedVersion: 1, action: 'revoke' });
    expect(document.body.textContent).not.toContain('private-status-error');
  });

  it('makes no automatic mutation after a stale delete and shows its error outside the closed modal', async () => {
    const s = setup(); await ready();
    s.api.remove.mockRejectedValue(new Error('API_EXTENSIONS_VERSION_CONFLICT'));
    fireEvent.click(screen.getByRole('button', { name: '删除 MCP' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('配置或信任状态刚刚发生变化');
    expect(s.api.remove).toHaveBeenCalledTimes(1);
  });

  it('binds/unbinds one MCP without discarding other MCP or future skill bindings', async () => {
    const s = setup([entry], [{ partnerId: apiPartner.id, extensionIds: [skillId] }]); await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: 'API 一' }));
    await waitFor(() => expect(s.api.setBinding).toHaveBeenCalledWith({ expectedVersion: 1, partnerId: 'api-one', extensionIds: [skillId, id] }));
    s.setState({ version: 2, extensions: [entry], bindings: [{ partnerId: 'api-one', extensionIds: [skillId, id] }] });
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'API 一' })).toBeChecked());
    fireEvent.click(screen.getByRole('checkbox', { name: 'API 一' }));
    await waitFor(() => expect(s.api.setBinding).toHaveBeenLastCalledWith({ expectedVersion: 2, partnerId: 'api-one', extensionIds: [skillId] }));
  });

  it('saves a new process config and masked credentials only through the extension bridge', async () => {
    const s = setup([]); await screen.findByRole('button', { name: '添加 MCP' });
    s.api.upsert.mockImplementation(async (input) => ({ version: 2, extensions: [{ ...entry, name: input.name }], bindings: [] }));
    fireEvent.click(screen.getByRole('button', { name: '添加 MCP' }));
    fireEvent.change(screen.getByLabelText('服务名称'), { target: { value: 'New MCP' } });
    fireEvent.change(screen.getByLabelText('启动程序'), { target: { value: 'node' } });
    fireEvent.change(screen.getByLabelText('启动参数（JSON 数组）'), { target: { value: '["C:\\\\tools\\\\server.mjs", "two words"]' } });
    fireEvent.change(screen.getByLabelText('凭据处理'), { target: { value: 'replace' } });
    fireEvent.change(screen.getByLabelText('凭据名称 1'), { target: { value: 'TOKEN' } });
    const secret = screen.getByLabelText('凭据值 1'); expect(secret).toHaveAttribute('type', 'password');
    fireEvent.change(secret, { target: { value: 'never-persist-in-renderer' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP' }));
    await ready();
    expect(s.api.upsert).toHaveBeenCalledWith({ expectedVersion: 1, name: 'New MCP', enabled: true, configuration: { type: 'mcp_stdio', command: 'node', args: ['C:\\tools\\server.mjs', 'two words'] }, secrets: { TOKEN: 'never-persist-in-renderer' } });
    expect(document.body.textContent).not.toContain('never-persist-in-renderer');
    expect(JSON.stringify(localStorage)).not.toContain('never-persist-in-renderer');
    expect(s.api.connectMcp).not.toHaveBeenCalled(); expect(s.api.setTrust).not.toHaveBeenCalled();
  });

  it('keeps encrypted credentials by omission when only editing the display name', async () => {
    const s = setup(); await ready();
    fireEvent.click(screen.getByRole('button', { name: '编辑配置' }));
    expect(screen.queryByLabelText('凭据值 1')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('服务名称'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP' }));
    await waitFor(() => expect(s.api.upsert).toHaveBeenCalled());
    expect(s.api.upsert.mock.calls[0][0]).not.toHaveProperty('secrets');
    expect(s.api.upsert.mock.calls[0][0]).not.toHaveProperty('trust');
  });

  it('explicitly clears credentials and configures HTTP without parsing inactive stdio fields', async () => {
    const s = setup(); await ready();
    fireEvent.click(screen.getByRole('button', { name: '编辑配置' }));
    fireEvent.change(screen.getByLabelText('启动参数（JSON 数组）'), { target: { value: 'bad inactive JSON' } });
    fireEvent.change(screen.getByLabelText('连接方式'), { target: { value: 'mcp_http' } });
    expect(screen.getByText(/更换连接方式会清除原凭据/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'http://127.0.0.1:3000/mcp' } });
    fireEvent.change(screen.getByLabelText('凭据处理'), { target: { value: 'clear' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP' }));
    await waitFor(() => expect(s.api.upsert).toHaveBeenCalled());
    expect(s.api.upsert.mock.calls[0][0]).toMatchObject({ configuration: { type: 'mcp_http', url: 'http://127.0.0.1:3000/mcp' }, secrets: null });
  });

  it.each(['bad json', '{}', '[42]'])('rejects malformed process args %s without sending IPC', async (args) => {
    const s = setup(); await ready(); fireEvent.click(screen.getByRole('button', { name: '编辑配置' }));
    fireEvent.change(screen.getByLabelText('启动参数（JSON 数组）'), { target: { value: args } });
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument(); expect(s.api.upsert).not.toHaveBeenCalled();
  });

  it('does not leak a rejected credential or raw IPC error to the page', async () => {
    const s = setup(); await ready();
    s.api.setTrust.mockRejectedValue(new Error('private-fixture-secret-error-value'));
    fireEvent.click(screen.getByRole('button', { name: '申请持续信任' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法完成');
    expect(document.body.textContent).not.toContain('private-fixture-secret');
  });

  it('retains an edit after a real version conflict and requires explicit rebase before retry', async () => {
    const s = setup(); await ready();
    s.api.upsert.mockRejectedValueOnce(new Error('API_EXTENSIONS_VERSION_CONFLICT'));
    fireEvent.click(screen.getByRole('button', { name: '编辑配置' }));
    fireEvent.change(screen.getByLabelText('服务名称'), { target: { value: 'My draft' } });
    s.setState({ version: 2, extensions: [{ ...entry, trust: 'pending' }], bindings: [] });
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP' }));
    await screen.findByRole('button', { name: '已核对，使用当前版本' });
    fireEvent.click(screen.getByText('查看当前已保存配置'));
    expect(screen.getByText(/Fixture · 已启用 · 待首次确认/)).toBeInTheDocument();
    expect(screen.getByLabelText('服务名称')).toHaveValue('My draft');
    expect(screen.getByRole('button', { name: '保存 MCP' })).toBeDisabled();
    expect(s.api.upsert).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '已核对，使用当前版本' }));
    fireEvent.click(screen.getByRole('button', { name: '保存 MCP' }));
    await waitFor(() => expect(s.api.upsert).toHaveBeenCalledTimes(2));
    expect(s.api.upsert.mock.calls[1][0]).toMatchObject({ expectedVersion: 2, name: 'My draft' });
  });

  it('protects unsaved credentials when changing service or cancelling an edit', async () => {
    const s = setup([entry, { ...entry, id: skillId, name: 'Second' }]); await ready();
    fireEvent.click(screen.getByRole('button', { name: '编辑配置' }));
    fireEvent.change(screen.getByLabelText('服务名称'), { target: { value: 'Unsaved' } });
    expect(s.onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: /Second/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }));
    expect(screen.getByLabelText('服务名称')).toHaveValue('Unsaved');
    fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '放弃修改' }));
    expect(screen.queryByLabelText('服务名称')).not.toBeInTheDocument(); expect(s.api.upsert).not.toHaveBeenCalled();
  });

  it('never replays a stale delete and requires confirmation before removing config', async () => {
    const s = setup(); await ready();
    fireEvent.click(screen.getByRole('button', { name: '删除 MCP' }));
    expect(s.api.remove).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
    expect(s.api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '删除 MCP' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(s.api.remove).toHaveBeenCalledExactlyOnceWith({ id, expectedVersion: 1 }));
    expect(await screen.findByText('MCP 已删除。')).toBeInTheDocument();
  });

  it('does not display raw credential values in service summaries or initial editor drafts', () => {
    const draft = mcpDraft(3, entry);
    expect(draft.secrets).toEqual([]); expect(mcpRequest(draft)).not.toHaveProperty('secrets');
    expect(() => mcpRequest({ ...draft, secretMode: 'replace', secrets: [{ name: 'Authorization', value: 'one' }, { name: 'authorization', value: 'two' }], transport: 'mcp_http', url: 'https://example.invalid/mcp' })).toThrow('MCP_FORM_SECRETS');
  });

  it('retains the newer trust snapshot when an earlier read completes late', async () => {
    const s = setup(); await ready();
    let release!: (value: ApiExtensionsSnapshot) => void;
    s.api.get.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    fireEvent.click(screen.getByRole('button', { name: '申请持续信任' }));
    await screen.findByRole('button', { name: '取消待信任' });
    await act(async () => { release({ version: 1, extensions: [entry], bindings: [] }); });
    expect(within(detail()).getByRole('button', { name: '取消待信任' })).toBeInTheDocument();
  });

  it('labels an old trust snapshot as stale after a failed refresh and clears the notice after recovery', async () => {
    const s = setup([{ ...entry, trust: 'trusted' }]); await ready();
    s.api.get.mockRejectedValueOnce(new Error('private-read-error'));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByText(/当前显示上次读取结果/);
    expect(document.body.textContent).not.toContain('private-read-error');
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(screen.queryByText(/当前显示上次读取结果/)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '撤销信任' })).toBeInTheDocument();
  });
});
