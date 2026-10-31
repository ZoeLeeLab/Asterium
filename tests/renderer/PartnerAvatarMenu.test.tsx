import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/app/App';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { STATE_KEY } from '../../src/renderer/app/persistence';
import { createTestState } from '../fixtures/applicationState';

afterEach(() => { delete window.asteriumMemory; });
function RouteProbe() { const location = useLocation(); return <output aria-label="route">{location.pathname}{location.search}</output>; }
function setup(entry = '/chat') {
  const state = createTestState(); state.partners[1].profileManagement = { userProfile: false, personality: false, memoryMode: 'asterium' };
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  window.asteriumMemory = {
    query: vi.fn(async ({ partnerId }) => ({ partnerId, archiveVersion: 'sqlite-test', records: [] })),
    briefing: vi.fn(async (partnerId) => ({ partnerId, schemaVersion: 1 as const, archiveVersion: 'sqlite-test', logicalDate: '2026-10-21', generatedAt: '2026-10-21T00:00:00.000Z', content: '简报' })),
    create: vi.fn(), update: vi.fn(), comment: vi.fn(), softDelete: vi.fn(), restore: vi.fn(), purge: vi.fn(), readSource: vi.fn(), onChanged: vi.fn(() => () => {}),
  };
  return render(<MemoryRouter initialEntries={[entry]}><PrototypeProvider><App /><RouteProbe /></PrototypeProvider></MemoryRouter>);
}
it('opens the exact partner editor from an avatar without triggering its parent selection', async () => {
  const { container } = setup(); const avatar = container.querySelector<HTMLElement>('[data-partner-id="fixture-local-b"]')!;
  fireEvent.contextMenu(avatar, { clientX: 100, clientY: 100 });
  fireEvent.click(within(screen.getByRole('menu', { name: '测试伙伴 B的快捷菜单' })).getByRole('menuitem', { name: '编辑伙伴' }));
  await waitFor(() => expect(screen.getByDisplayValue('测试伙伴 B')).toBeEnabled());
  expect(screen.getByLabelText('route')).toHaveTextContent('section=partners&partner=fixture-local-b');
});
it('deep-links to the requested memory partner rather than the first managed partner', async () => {
  const { container } = setup(); fireEvent.contextMenu(container.querySelector('[data-partner-id="fixture-api"]')!);
  fireEvent.click(screen.getByRole('menuitem', { name: '记忆管理' }));
  await waitFor(() => expect(window.asteriumMemory!.query).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'fixture-api' })));
  expect(container.querySelector('.memory-partner-item.active')).toHaveTextContent('测试伙伴 C');
  expect(screen.getByLabelText('route')).toHaveTextContent('section=memory&partner=fixture-api');
});
it('supports keyboard dismissal and disables unmanaged memory without offering it on user avatars', () => {
  const { container } = setup(); const avatar = container.querySelector<HTMLElement>('[data-partner-id="fixture-local-a"]')!;
  avatar.focus(); fireEvent.keyDown(avatar, { key: 'F10', shiftKey: true });
  expect(screen.getByRole('menuitem', { name: '记忆管理' })).toBeDisabled();
  fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(avatar).toHaveFocus();
  fireEvent.contextMenu(screen.getAllByLabelText(/用户的头像/)[0]); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});
it('reselects the requested archive even when the shortcut URL is already current', async () => {
  const { container } = setup('/settings/partners?section=memory&partner=fixture-api');
  const list = screen.getByLabelText('选择记忆伙伴');
  fireEvent.click(within(list).getByRole('button', { name: /测试伙伴 B/ }));
  await waitFor(() => expect(container.querySelector('.memory-partner-item.active')).toHaveTextContent('测试伙伴 B'));
  fireEvent.contextMenu(list.querySelector('[data-partner-id="fixture-api"]')!); fireEvent.click(screen.getByRole('menuitem', { name: '记忆管理' }));
  await waitFor(() => expect(container.querySelector('.memory-partner-item.active')).toHaveTextContent('测试伙伴 C'));
});
it('keeps the unsaved-edit confirmation when navigating from settings avatars', async () => {
  const { container } = setup('/settings/partners?section=partners&partner=fixture-local-b');
  const name = await screen.findByDisplayValue('测试伙伴 B'); await waitFor(() => expect(name).toBeEnabled());
  fireEvent.change(name, { target: { value: '尚未保存' } });
  fireEvent.contextMenu(container.querySelector('[data-partner-id="fixture-api"]')!); fireEvent.click(screen.getByRole('menuitem', { name: '记忆管理' }));
  expect(screen.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
  await waitFor(() => expect(container.querySelector('.memory-partner-item.active')).toHaveTextContent('测试伙伴 C'));
});
it('removes the chat placeholder and only hides the workspace composer', async () => {
  const chat = setup(); expect(screen.queryByText('敬请期待…')).not.toBeInTheDocument(); chat.unmount();
  const workspace = setup('/studio/workspace'); expect(workspace.container.querySelector('.composer')).toBeNull(); workspace.unmount();
  const discussion = setup('/studio/discussion'); expect(discussion.container.querySelector('.studio-composer')).toBeInTheDocument();
});
