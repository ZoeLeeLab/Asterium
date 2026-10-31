import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioWakeSettings } from '../../src/renderer/components/settings/StudioWakeSettings';
import type { ExistingThreadPartner } from '../../src/renderer/types/domain';
import type { StudioWakeStatus } from '../../src/shared/studioWakeControl';

const partner: ExistingThreadPartner = { id: 'chuan', sourceMode: 'existing_thread', serviceType: 'cyberboss_server', serviceUrl: 'https://server.tail-test.ts.net', threadId: 'original-thread',
  publicIdentity: { displayName: '外部伙伴', introduction: '', expertise: '', mentionName: '外部伙伴' }, status: 'online', accent: '#fff', createdAt: new Date(0).toISOString(), isPrototype: false, configured: true, connectionLabel: '服务器', connectionStatus: 'connected' };
afterEach(() => { window.asteriumStudioWake = undefined; });
function setup(initial: StudioWakeStatus = { entries: [] }) {
  let status = initial;
  const api = { status: vi.fn(async () => status), configure: vi.fn(async (binding) => { status = { entries: [{ ...binding, ready: true, state: 'stopped' }] }; return status; }),
    control: vi.fn(async () => status) } satisfies NonNullable<Window['asteriumStudioWake']>;
  window.asteriumStudioWake = api;
  const view = render(<StudioWakeSettings partners={[partner, { ...partner, id: 'removed', isRemoved: true }]} />);
  fireEvent.click(screen.getByText(/群聊自动唤醒 ·/)); return { api, view };
}
describe('minimal wake controls', () => {
  it('loads local status without contacting the server, saves a binding, and only reconnects on explicit click', async () => {
    const { api } = setup(); await screen.findByLabelText('服务器连接绑定 ID'); expect(api.control).not.toHaveBeenCalled();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('服务器连接绑定 ID'), { target: { value: ' server-binding ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存唤醒绑定' }));
    await waitFor(() => expect(api.configure).toHaveBeenCalledWith({ partnerId: 'chuan', connectionBindingId: 'server-binding', connectOnLaunch: true }));
    fireEvent.click(await screen.findByRole('button', { name: '重新连接群唤醒' }));
    await waitFor(() => expect(api.control).toHaveBeenCalledWith('chuan', 'connect_once', undefined));
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新唤醒状态' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '刷新唤醒状态' }));
    await waitFor(() => expect(api.control).toHaveBeenLastCalledWith('chuan', 'status', undefined));
  });
  it('disables reconnect before MCP readiness and clearly reports missing server support', async () => {
    setup({ entries: [{ partnerId: 'chuan', connectionBindingId: 'binding', connectOnLaunch: true, ready: false, state: 'unavailable', error: 'STUDIO_WAKE_CONTROL_UNSUPPORTED' }] });
    expect(await screen.findByRole('button', { name: '重新连接群唤醒' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '刷新唤醒状态' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('服务器尚未安装');
  });
  it('sends manual retry / ignore for the original trigger ID without automatically acting on reviews', async () => {
    const triggerId = 'c8d190f7-c564-4a32-811b-9a68eabec5cd';
    const { api } = setup({ entries: [{ partnerId: 'chuan', connectionBindingId: 'binding', connectOnLaunch: true, ready: true, state: 'connected',
      remote: { protocolVersion: 2, requestId: 'ef97ab55-e71c-4f05-81ee-f16f95b7ed9b', connectionBindingId: 'binding', connection: { phase: 'connected' }, duplicate: false,
        reviews: [{ roomId: 'A', membershipGeneration: 1, eventId: 7, triggerId, reason: 'uncertain' }] } }] });
    await screen.findByRole('button', { name: '重试' }); expect(api.control).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(api.control).toHaveBeenCalledWith('chuan', 'retry', triggerId));
    await waitFor(() => expect(screen.getByRole('button', { name: '忽略' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: '忽略' }));
    await waitFor(() => expect(api.control).toHaveBeenLastCalledWith('chuan', 'ignore', triggerId));
  });
});
