import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StorageSettingsView } from '../../src/renderer/components/settings/StorageSettingsView';
import type { StorageLocations } from '../../src/shared/generalSettings';

afterEach(() => { window.asteriumStorage = undefined; });
it('shows read-only locations, preserves cancellation and failed edits, and restores the default', async () => {
  const original: StorageLocations = { userDataDirectory: 'C:\\synthetic\\dev', defaultProjectRoot: 'C:\\synthetic\\dev\\Projects', customized: false };
  const custom: StorageLocations = { ...original, defaultProjectRoot: 'D:\\synthetic-projects', customized: true };
  const choose = vi.fn<() => Promise<StorageLocations | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce(custom).mockRejectedValueOnce(new Error('missing'));
  const reset = vi.fn(async () => original), open = vi.fn(async () => undefined);
  window.asteriumStorage = { get: async () => original, chooseProjectRoot: choose, resetProjectRoot: reset, openProjectRoot: open };
  render(<StorageSettingsView />);
  await waitFor(() => expect(screen.getByLabelText('应用资料目录')).toHaveValue(original.userDataDirectory));
  expect(screen.getByLabelText('应用资料目录')).toHaveAttribute('readonly');
  const select = screen.getByRole('button', { name: '选择默认项目位置' });
  fireEvent.click(select); await waitFor(() => expect(select).toBeEnabled());
  expect(screen.getByLabelText('默认项目保存位置')).toHaveValue(original.defaultProjectRoot);
  fireEvent.click(select); await waitFor(() => expect(screen.getByLabelText('默认项目保存位置')).toHaveValue(custom.defaultProjectRoot));
  fireEvent.click(screen.getByRole('button', { name: '打开项目位置' })); await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.click(select); await screen.findByRole('alert');
  expect(screen.getByLabelText('默认项目保存位置')).toHaveValue(custom.defaultProjectRoot);
  fireEvent.click(screen.getByRole('button', { name: '恢复默认项目位置' }));
  await waitFor(() => expect(screen.getByLabelText('默认项目保存位置')).toHaveValue(original.defaultProjectRoot));
  expect(reset).toHaveBeenCalledTimes(1);
});
