import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AboutSettingsView } from '../../src/renderer/components/settings/AboutSettingsView';
import { UpdateNotice } from '../../src/renderer/app/UpdateNotice';
import { DEFAULT_GENERAL_SETTINGS } from '../../src/shared/generalSettings';
import type { UpdateSnapshot } from '../../src/shared/appUpdates';

afterEach(() => { window.asteriumUpdates = undefined; window.asteriumGeneralSettings = undefined; });
function mockUpdates() {
  let snapshot: UpdateSnapshot = { configured: true, currentVersion: '0.1.0-beta.1', repository: 'example/asterium', phase: 'available', release: { version: '0.1.0-beta.2', notes: 'Synthetic notes', publishedAt: '', pageUrl: 'https://github.com/example/asterium/releases' } };
  const listeners = new Set<(next: UpdateSnapshot) => void>();
  const publish = (patch: Partial<UpdateSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener(snapshot)); return snapshot; };
  const api = {
    get: vi.fn(async () => snapshot), check: vi.fn(async () => publish({ phase: 'up-to-date' })),
    download: vi.fn(async () => publish({ phase: 'downloaded', readyToInstall: true, receivedBytes: 20, totalBytes: 20 })),
    install: vi.fn(async () => publish({ phase: 'installing' })), cancel: vi.fn(async () => undefined), openReleases: vi.fn(async () => undefined),
    onChanged: (listener: (next: UpdateSnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  window.asteriumUpdates = api;
  window.asteriumGeneralSettings = { get: vi.fn(async () => ({ revision: 0, settings: DEFAULT_GENERAL_SETTINGS, startupSupported: false })), update: vi.fn(async () => ({ revision: 1, settings: DEFAULT_GENERAL_SETTINGS, startupSupported: false })), onChanged: () => () => undefined };
  return { api, publish };
}
it('keeps About concise and requires separate consent for downloading and installation', async () => {
  const { api } = mockUpdates(); render(<AboutSettingsView />);
  await screen.findByText('发现新版本 0.1.0-beta.2');
  expect(screen.queryByText('Synthetic notes')).not.toBeVisible();
  expect(api.download).not.toHaveBeenCalled(); expect(api.install).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '下载新版本' }));
  await screen.findByRole('button', { name: '退出并安装' }); expect(api.install).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '退出并安装' }));
  expect(screen.getByRole('dialog', { name: '退出星丛并安装更新？' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '暂不安装' })); expect(api.install).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '退出并安装' }));
  fireEvent.click(screen.getByRole('button', { name: '确认退出并安装' }));
  await waitFor(() => expect(api.install).toHaveBeenCalledTimes(1));
});
it('displays progress, lets the user cancel and never installs a failed checksum', async () => {
  const { api, publish } = mockUpdates(); render(<AboutSettingsView />);
  await screen.findByText('发现新版本 0.1.0-beta.2');
  act(() => { publish({ phase: 'downloading', receivedBytes: 50, totalBytes: 100 }); });
  expect(screen.getByRole('status')).toHaveTextContent('50%');
  fireEvent.click(screen.getByRole('button', { name: '取消下载' })); expect(api.cancel).toHaveBeenCalledTimes(1);
  act(() => { publish({ phase: 'error', readyToInstall: false, receivedBytes: 100, totalBytes: 100, error: 'UPDATE_CHECKSUM_MISMATCH' }); });
  expect(screen.getByRole('status')).toHaveTextContent('校验失败');
  expect(screen.queryByRole('button', { name: '退出并安装' })).not.toBeInTheDocument(); expect(api.install).not.toHaveBeenCalled();
});
it('persists update preferences and opens only the configured history action', async () => {
  const { api } = mockUpdates(); render(<AboutSettingsView />);
  const checkbox = await screen.findByRole('checkbox', { name: '启动时自动检查更新' });
  await waitFor(() => expect(checkbox).toBeEnabled()); fireEvent.click(checkbox);
  expect(window.asteriumGeneralSettings!.update).toHaveBeenCalledWith({ checkUpdatesAtStartup: false });
  fireEvent.click(screen.getByRole('button', { name: '更新历史' })); expect(api.openReleases).toHaveBeenCalledTimes(1);
});
it('notifies about a new version without starting any download', async () => {
  const { api } = mockUpdates(); render(<MemoryRouter initialEntries={['/chat']}><UpdateNotice /></MemoryRouter>);
  await screen.findByRole('dialog', { name: '星丛有新版本' });
  expect(api.download).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '稍后再说' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(api.download).not.toHaveBeenCalled();
});
