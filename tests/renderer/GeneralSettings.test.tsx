import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { GeneralSettingsView } from '../../src/renderer/components/settings/GeneralSettingsView';
import { SettingsPage } from '../../src/renderer/pages/SettingsPage';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { DEFAULT_GENERAL_SETTINGS, type GeneralSettingsSnapshot } from '../../src/shared/generalSettings';

afterEach(() => { window.asteriumGeneralSettings = undefined; });
it('orders the five menu groups and opens general settings without breaking partner links', async () => {
  const view = render(<MemoryRouter initialEntries={['/settings']}><PrototypeProvider><SettingsPage /></PrototypeProvider></MemoryRouter>);
  await screen.findByRole('heading', { name: '通用' });
  const nav = screen.getByRole('navigation', { name: '设置菜单' });
  expect(within(nav).getAllByRole('button').map(button => button.textContent?.replace(/浅色|深色|\d+/g, '').trim())).toEqual(['通用', '外观', '伙伴管理', '记忆', '自动化', 'MCP', 'SKILLS', '权限和安全', '归档', '文件缓存', '关于']);
  expect(nav.querySelectorAll('.settings-nav-group')).toHaveLength(5);
  fireEvent.click(within(nav).getByRole('button', { name: '伙伴管理' })); await screen.findByRole('heading', { name: '伙伴管理' });
  view.unmount(); render(<MemoryRouter initialEntries={['/settings/partners']}><PrototypeProvider><SettingsPage /></PrototypeProvider></MemoryRouter>);
  await screen.findByRole('heading', { name: '伙伴管理' });
});
it('applies committed changes, handles push updates and retains the old value on a failed save', async () => {
  let snapshot: GeneralSettingsSnapshot = { revision: 0, settings: structuredClone(DEFAULT_GENERAL_SETTINGS), startupSupported: false };
  let changed!: (s: GeneralSettingsSnapshot) => void;
  const update = vi.fn(async () => { throw new Error('disk'); });
  window.asteriumGeneralSettings = { get: vi.fn(async () => snapshot), update, onChanged: listener => { changed = listener; return vi.fn(); } };
  render(<GeneralSettingsView />);
  await waitFor(() => expect(screen.getByLabelText('发送快捷键')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('发送快捷键'), { target: { value: 'ctrl_enter' } });
  await screen.findByRole('alert'); expect(screen.getByLabelText('发送快捷键')).toHaveValue('enter');
  await act(async () => { snapshot = { ...snapshot, revision: 2, settings: { ...snapshot.settings, sendShortcut: 'ctrl_enter' } }; changed(snapshot); });
  expect(screen.getByLabelText('发送快捷键')).toHaveValue('ctrl_enter');
  await act(async () => { changed({ ...snapshot, revision: 1, settings: DEFAULT_GENERAL_SETTINGS }); });
  expect(screen.getByLabelText('发送快捷键')).toHaveValue('ctrl_enter');
  expect(screen.getByRole('checkbox', { name: /开启自启动/ })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /启动时自动检查更新/ })).toBeDisabled();
  expect(screen.getByText('尚未配置更新源，暂不可用。')).toBeInTheDocument();
});
