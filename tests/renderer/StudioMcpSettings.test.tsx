import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioMcpSettings } from '../../src/renderer/components/settings/StudioMcpSettings';
import type { ExistingThreadPartner } from '../../src/renderer/types/domain';
import type { StudioMcpStatus } from '../../src/shared/studioMcp';

const partner: ExistingThreadPartner = {
  id: 'chuan', sourceMode: 'existing_thread', serviceType: 'cyberboss_server', serviceUrl: 'https://server.tail-test.ts.net', threadId: 'thread-existing',
  publicIdentity: { displayName: '外部伙伴', introduction: '', expertise: '', mentionName: '外部伙伴' },
  status: 'online', accent: '#fff', createdAt: new Date(0).toISOString(), isPrototype: false, configured: true, connectionLabel: '服务器', connectionStatus: 'connected',
};
afterEach(() => { window.asteriumStudioMcp = undefined; });

function setup() {
  let status: StudioMcpStatus = { running: false, configuration: { enabled: false, port: 17361, publicOrigin: '' }, credentials: [] };
  const credential = { credentialId: 'credential-one', partnerId: partner.id, createdAt: new Date(0).toISOString() };
  const api = {
    status: vi.fn(async () => structuredClone(status)),
    configure: vi.fn(async (configuration) => { status = { ...status, configuration, running: configuration.enabled }; return structuredClone(status); }),
    issueCredential: vi.fn(async () => { status.credentials.push(credential); return { credential, token: 'one-time-secret' }; }),
    revokeCredential: vi.fn(async () => { status.credentials = [{ ...credential, revokedAt: new Date().toISOString() }]; return structuredClone(status); }),
  } satisfies NonNullable<Window['asteriumStudioMcp']>;
  window.asteriumStudioMcp = api;
  const view = render(<StudioMcpSettings partners={[partner, { ...partner, id: 'removed', isRemoved: true }]} />);
  return { api, view };
}

describe('group MCP connection settings', () => {
  it('loads default-off status without starting a service or issuing credentials', async () => {
    const { api } = setup();
    await waitFor(() => expect(screen.getByText('群聊 MCP 接入 · 服务已关闭')).toBeInTheDocument());
    expect(api.configure).not.toHaveBeenCalled();
    expect(api.issueCredential).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('群聊 MCP 接入 · 服务已关闭'));
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '开启群聊接入' })).toBeEnabled();
  });

  it('shows enabled only after Main confirms and retains off state on a failed start', async () => {
    const { api } = setup();
    fireEvent.click(screen.getByText('群聊 MCP 接入 · 服务已关闭'));
    await waitFor(() => expect(screen.getByRole('button', { name: '开启群聊接入' })).toBeEnabled());
    api.configure.mockRejectedValueOnce(new Error('STUDIO_MCP_LISTEN_FAILED'));
    fireEvent.click(screen.getByRole('button', { name: '开启群聊接入' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('端口');
    expect(screen.getByText('群聊 MCP 接入 · 服务已关闭')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('私网 HTTPS 地址'), { target: { value: 'https://computer.tail-test.ts.net/' } });
    fireEvent.click(screen.getByRole('button', { name: '开启群聊接入' }));
    await screen.findByText('群聊 MCP 接入 · 服务已开启');
    expect(api.configure).toHaveBeenLastCalledWith({ enabled: true, port: 17361, publicOrigin: 'https://computer.tail-test.ts.net', automationManagementEnabled: false });
    fireEvent.click(screen.getByRole('checkbox', { name: '允许外部伙伴管理自己的自动化（每次变更仍需我确认）' }));
    fireEvent.click(screen.getByRole('button', { name: '保存连接设置' }));
    await waitFor(() => expect(api.configure).toHaveBeenLastCalledWith(expect.objectContaining({ automationManagementEnabled: true })));
  });

  it('keeps the issued credential only in component state and supports revocation', async () => {
    const { api, view } = setup();
    fireEvent.click(screen.getByText('群聊 MCP 接入 · 服务已关闭'));
    fireEvent.click(screen.getByRole('button', { name: '生成伙伴接入凭据' }));
    const input = await screen.findByLabelText('新接入凭据（仅显示一次）');
    expect(input).toHaveValue('one-time-secret');
    expect(input).toHaveAttribute('type', 'password');
    expect(JSON.stringify(localStorage)).not.toContain('one-time-secret');
    fireEvent.click(screen.getByRole('button', { name: '撤销群聊凭据 credential-one' }));
    await waitFor(() => expect(screen.queryByLabelText('新接入凭据（仅显示一次）')).not.toBeInTheDocument());
    expect(api.revokeCredential).toHaveBeenCalledWith('credential-one');
    view.unmount();
    render(<StudioMcpSettings partners={[partner]} />);
    expect(screen.queryByLabelText('新接入凭据（仅显示一次）')).not.toBeInTheDocument();
  });
});
