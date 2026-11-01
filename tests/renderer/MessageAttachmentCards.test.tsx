import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageAttachmentCards } from '../../src/renderer/components/chat/MessageAttachmentCards';
import type { MessageAttachment } from '../../src/shared/agentProtocol';

const attachment: MessageAttachment = { id: 'attachment-synthetic', name: 'synthetic.png', mediaType: 'image/png', sizeBytes: 32 };
afterEach(() => { window.asteriumAttachments = undefined; });
function setup(availability = 'available') {
  const inspect = vi.fn(async () => ({ ...attachment, availability })), thumbnail = vi.fn(async () => '');
  window.asteriumAttachments = { inspect, thumbnail } as never;
  return { inspect, thumbnail };
}
function cards(conversationId = 'conversation-synthetic', onPreview = vi.fn()) {
  return <MessageAttachmentCards attachments={[attachment]} conversationId={conversationId} onPreview={onPreview} onContextMenu={vi.fn()} />;
}
it('keeps a delayed thumbnail alive after availability state renders, without duplicate requests', async () => {
  const { inspect, thumbnail } = setup(); let finish!: (value: string) => void;
  thumbnail.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { container } = render(cards()); await waitFor(() => expect(thumbnail).toHaveBeenCalledOnce());
  await act(async () => { finish('data:image/png;base64,c3ludGhldGlj'); });
  await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,c3ludGhldGlj'));
  expect(inspect).toHaveBeenCalledOnce(); expect(thumbnail).toHaveBeenCalledOnce();
});
it('keeps valid snapshots previewable when thumbnail generation rejects or returns no image', async () => {
  const { thumbnail } = setup(), onPreview = vi.fn(); thumbnail.mockRejectedValue(new Error('synthetic thumbnail failure'));
  const view = render(cards('conversation-synthetic', onPreview));
  await waitFor(() => expect(thumbnail).toHaveBeenCalledOnce());
  expect(screen.queryByText('附件快照不可用')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /synthetic.png/ })); expect(onPreview).toHaveBeenCalledWith(attachment);
  thumbnail.mockResolvedValue(''); view.rerender(cards('another-conversation', onPreview));
  await waitFor(() => expect(thumbnail).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: /synthetic.png/ })).toBeEnabled();
});
it('disables actually missing or unauthorized snapshots without requesting a thumbnail', async () => {
  const { inspect, thumbnail } = setup('missing'); const view = render(cards());
  await screen.findByText('附件快照不可用'); expect(screen.getByRole('button')).toBeDisabled(); expect(thumbnail).not.toHaveBeenCalled();
  inspect.mockRejectedValue(new Error('ATTACHMENT_SCOPE_NOT_REGISTERED')); view.rerender(cards('denied-conversation'));
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2)); expect(screen.getByRole('button')).toBeDisabled(); expect(thumbnail).not.toHaveBeenCalled();
});
it('does not reuse a thumbnail across conversation scopes or accept a stale response', async () => {
  const { inspect, thumbnail } = setup(); let finish!: (value: string) => void;
  thumbnail.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(cards()); await waitFor(() => expect(thumbnail).toHaveBeenCalledOnce());
  inspect.mockRejectedValue(new Error('ATTACHMENT_SCOPE_NOT_REGISTERED')); view.rerender(cards('denied-conversation'));
  await screen.findByText('附件快照不可用'); await act(async () => { finish('data:image/png;base64,c3RhbGU='); });
  expect(view.container.querySelector('img')).toBeNull(); expect(screen.getByRole('button')).toBeDisabled();
});
