import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { SettingsPage } from '../../src/renderer/pages/SettingsPage';
import { APP_VERSION } from '../../src/shared/appRelease';
import notices from '../../THIRD_PARTY_NOTICES.md?raw';
import licenses from '../../third_party/licenses/THIRD_PARTY_LICENSES.txt?raw';

function renderSettings(route = '/settings') {
  return render(<MemoryRouter initialEntries={[route]}><PrototypeProvider><SettingsPage /></PrototypeProvider></MemoryRouter>);
}

it('opens About from the settings menu and can return to other settings', () => {
  renderSettings();
  const nav = screen.getByRole('navigation', { name: '设置菜单' });
  const about = within(nav).getByRole('button', { name: '关于' });
  expect(about).toBeEnabled();
  fireEvent.click(about);
  expect(screen.getByRole('heading', { name: '星丛 Asterium' })).toBeInTheDocument();
  expect(screen.getByText(APP_VERSION, { exact: true })).toBeInTheDocument();
  fireEvent.click(within(nav).getByRole('button', { name: '通用' }));
  expect(screen.getByRole('heading', { name: '通用' })).toBeInTheDocument();
});

it('supports a direct About route and accurately describes incomplete release features', () => {
  renderSettings('/settings?section=about');
  expect(screen.getByRole('heading', { name: '星丛 Asterium' })).toBeInTheDocument();
  expect(screen.getByText('待正式确定（拟 MPL-2.0）')).toBeInTheDocument();
  expect(screen.getByText('未签名 · Beta')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('更新源待配置');
  expect(screen.getByRole('button', { name: '检查更新' })).toBeDisabled();
});

it('displays the exact bundled third-party texts on demand without remote navigation', async () => {
  renderSettings('/settings?section=about');
  expect(screen.queryByLabelText('第三方声明')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('第三方声明与许可证'));
  fireEvent.click(screen.getByRole('button', { name: '查看第三方声明' }));
  expect((await screen.findByLabelText('第三方声明')).textContent).toBe(notices);
  fireEvent.click(screen.getByRole('button', { name: '收起第三方声明' }));
  expect(screen.queryByLabelText('第三方声明')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查看第三方许可证原文' }));
  expect((await screen.findByLabelText('第三方许可证原文')).textContent).toBe(licenses);
});
