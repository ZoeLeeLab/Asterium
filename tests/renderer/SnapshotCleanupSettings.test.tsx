import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SnapshotCleanupSettings } from '../../src/renderer/components/settings/SnapshotCleanupSettings';

afterEach(() => {
  window.asteriumConversations = undefined;
  window.asteriumAttachments = undefined;
});

it('requires confirmation separately for history and attachment cleanup even with no preview cache', async () => {
  const historyClear = vi.fn(async () => ({ clearedCount: 2, freedBytes: 512, skippedCount: 0 }));
  const attachmentClear = vi.fn(async () => ({ clearedCount: 1, freedBytes: 256, skippedCount: 0 }));
  window.asteriumConversations = {
    delete: vi.fn(), listDeleted: vi.fn(),
    previewSnapshotCleanup: vi.fn(async () => ({ count: 2, bytes: 512, skippedCount: 0, planId: 'history' })),
    clearSnapshots: historyClear,
  };
  window.asteriumAttachments = {
    previewSnapshotCleanup: vi.fn(async () => ({ count: 1, bytes: 256, skippedCount: 0, planId: 'attachment' })),
    clearSnapshots: attachmentClear,
  } as unknown as NonNullable<typeof window.asteriumAttachments>;
  render(<SnapshotCleanupSettings formatSize={bytes => bytes + ' B'} />);

  fireEvent.click(screen.getByRole('button', { name: '清除 AI 过期快照' }));
  const history = within(await screen.findByRole('dialog', { name: '清除 AI 过期快照' }));
  expect(history.getByText('512 B')).toBeInTheDocument();
  expect(historyClear).not.toHaveBeenCalled();
  fireEvent.click(history.getByRole('button', { name: '取消' }));
  expect(historyClear).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: '清除用户重复快照' }));
  const attachments = within(await screen.findByRole('dialog', { name: '清除用户重复快照' }));
  expect(attachments.getByText('256 B')).toBeInTheDocument();
  expect(attachments.getByText(/源文件、内容不同的版本/)).toBeInTheDocument();
  fireEvent.click(attachments.getByRole('button', { name: '确认清理' }));
  expect(await screen.findByRole('status')).toHaveTextContent('已处理 1 项，释放 256 B');
  expect(attachmentClear).toHaveBeenCalledWith('attachment');
  expect(historyClear).not.toHaveBeenCalled();
});
