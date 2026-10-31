import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/renderer/components/ui/Composer';

describe('Composer attachments', () => {
  afterEach(() => { window.asteriumAttachments = undefined; });

  it('previews a selected image and warns while still allowing a metadata-only partner to send it', async () => {
    const pending = { selectionId: 'pending-image', name: '无法识别.png', mediaType: 'image/png', sizeBytes: 512 };
    window.asteriumAttachments = {
      choose: vi.fn(async () => [pending]),
      discard: vi.fn(async () => undefined),
      commit: vi.fn(), list: vi.fn(), inspect: vi.fn(), read: vi.fn(), open: vi.fn(), reveal: vi.fn(), copyPath: vi.fn(), exportAs: vi.fn(), saveToProject: vi.fn(), deleteConversation: vi.fn(),
      thumbnail: vi.fn(async () => 'data:image/png;base64,aW1hZ2U='),
    };
    const onSend = vi.fn(async () => true);
    render(<Composer placeholder="发送消息" onSend={onSend} attachmentsEnabled attachmentCapabilities={{ supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' }} />);

    fireEvent.click(screen.getByRole('button', { name: '添加图片或文件' }));
    expect(await screen.findByAltText('无法识别.png')).toBeInTheDocument();
    expect(screen.getByText('当前伙伴无法查看其中的图片；仍可发送，但伙伴只会收到附件元数据。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('', [pending]));
  });

  it('uses a two-line input and exposes source-neutral permission modes plus Plan in the command menu', () => {
    const onPermissionModeChange = vi.fn();
    const onPlanModeChange = vi.fn();
    const { container } = render(<Composer placeholder="发送消息" onSend={vi.fn()} permissionMode="full" onPermissionModeChange={onPermissionModeChange} planMode="default" planAvailable onPlanModeChange={onPlanModeChange} />);

    expect(container.querySelector('textarea')).toHaveAttribute('rows', '2');
    expect(screen.getByRole('button', { name: '添加图片或文件' })).toHaveTextContent('附件');
    expect(screen.getByRole('button', { name: '发送' })).toHaveTextContent('发送');
    expect(screen.queryByRole('button', { name: '语音（后续开放）' })).not.toBeInTheDocument();
    const permission = screen.getByRole('button', { name: '权限模式：完整权限' });
    expect(permission).toHaveTextContent('完整权限');
    expect(permission).toHaveClass('permission-button--full');
    fireEvent.click(permission);
    expect(screen.getByRole('menuitemradio', { name: /只读/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /手动审批/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /自动审批/ })).toBeInTheDocument();
    expect(screen.getByText('变更操作逐次询问')).toBeInTheDocument();
    expect(screen.getByText('安全写入自动执行，高风险操作仍询问')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /只读/ }));
    expect(onPermissionModeChange).toHaveBeenCalledWith('read_only');

    fireEvent.click(screen.getByRole('button', { name: '指令' }));
    const plan = screen.getByRole('menuitemcheckbox', { name: /计划模式/ });
    expect(plan).toHaveAttribute('title', '使用计划模式');
    fireEvent.click(plan);
    expect(onPlanModeChange).toHaveBeenCalledWith('plan');
  });

  it('keeps the compact studio composer on the original icon-only control row', () => {
    render(<Composer compact placeholder="发送群聊消息" onSend={vi.fn()} attachmentsEnabled />);
    expect(screen.getByRole('textbox', { name: '发送群聊消息' })).toHaveAttribute('rows', '1');
    expect(screen.getByRole('button', { name: '语音（后续开放）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toHaveTextContent('发送');
    expect(document.querySelector('.composer-toolbar')).toBeNull();
  });

  it('keeps separate drafts when switching directly between conversations', () => {
    const view = render(<Composer key="chat:draft-test" draftKey="chat:draft-test" placeholder="发送消息" onSend={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '切走以后还要继续输入' } });
    view.rerender(<Composer key="chat:another" draftKey="chat:another" placeholder="发送消息" onSend={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '另一个对话的草稿' } });
    view.rerender(<Composer key="chat:draft-test" draftKey="chat:draft-test" placeholder="发送消息" onSend={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: '发送消息' })).toHaveValue('切走以后还要继续输入');
  });

  it('stages a mid-run message before its explicit send action', async () => {
    const onSend = vi.fn(async () => true);
    const onCancel = vi.fn();
    const onSendPendingGuidance = vi.fn();
    const onDiscardPendingGuidance = vi.fn();
    const { rerender } = render(<Composer placeholder="补充要求" onSend={onSend} busy allowBusySend onCancel={onCancel} attachmentsEnabled />);

    expect(screen.getByRole('button', { name: '添加图片或文件' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '暂存中途消息' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '补充要求' }), { target: { value: '请先检查测试' } });
    fireEvent.click(screen.getByRole('button', { name: '暂存中途消息' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('请先检查测试', []));

    rerender(<Composer placeholder="补充要求" onSend={onSend} busy allowBusySend onCancel={onCancel} pendingGuidance={{ content: '请先检查测试', state: 'staged' }} onSendPendingGuidance={onSendPendingGuidance} onDiscardPendingGuidance={onDiscardPendingGuidance} attachmentsEnabled />);
    const pending = screen.getByLabelText('待发送的中途消息');
    expect(within(pending).getByText('请先检查测试')).toBeInTheDocument();
    fireEvent.click(within(pending).getByRole('button', { name: '发送' }));
    expect(onSendPendingGuidance).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '停止当前任务' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows one expandable quote, requires user text, and passes the structured snapshot', async () => {
    const quote = { sourceMessageId: 'assistant-1', sourcePartnerId: 'partner-1', sourcePartnerName: '测试助手', kind: 'full' as const, text: '这是完整引用的第一行。\n这是第二行。' };
    const onSend = vi.fn(async () => true);
    const onRemove = vi.fn();
    render(<Composer placeholder="发送消息" onSend={onSend} pendingQuote={quote} onRemovePendingQuote={onRemove} />);

    const card = screen.getByLabelText('引用 测试助手 的完整回复');
    expect(card.querySelector('strong')).toHaveTextContent('这是完整引用的第一行。 这是第二行。');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    const expander = within(card).getByRole('button', { name: '展开引用' });
    fireEvent.click(expander);
    expect(within(card).getByRole('button', { name: '收起引用' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '发送消息' }), { target: { value: '请根据这段继续' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('请根据这段继续', [], quote));
    fireEvent.click(within(card).getByRole('button', { name: '移除引用' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
