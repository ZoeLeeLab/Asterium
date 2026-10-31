import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StudioComposer, type StudioMentionOption } from '../../src/renderer/components/studio/StudioComposer';

const members: StudioMentionOption[] = [
  { partnerId: 'partner-1', displayName: '本地伙伴', mentionName: '成员', expertise: '前端' },
  { partnerId: 'partner-2', displayName: '外部伙伴', mentionName: '外部伙伴', expertise: '架构' },
];

describe('StudioComposer mentions', () => {
  it('keeps two lines initially and grows with multiline input up to the cap', () => {
    render(<StudioComposer placeholder="群聊消息" members={members} onSend={vi.fn()} />);
    expect(screen.getByRole('button', { name: '添加图片或文件（后续开放）' })).toBeDisabled();
    const input = screen.getByRole('textbox', { name: '群聊消息' });

    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 96 });
    fireEvent.change(input, { target: { value: '第一行\n第二行\n第三行' } });
    expect(input).toHaveStyle({ height: '96px', overflowY: 'hidden' });

    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 220 });
    fireEvent.change(input, { target: { value: '第一行\n第二行\n第三行\n第四行' } });
    expect(input).toHaveStyle({ height: '144px', overflowY: 'auto' });
  });

  it('keeps typing enabled but replaces send with a stop action while a round is running', () => {
    const onCancel = vi.fn();
    render(<StudioComposer placeholder="伙伴正在发言" members={members} busy onCancel={onCancel} onSend={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '停止本轮' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    const input = screen.getByRole('textbox', { name: '伙伴正在发言' });
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: '等你们说完我再补充' } });
    expect(input).toHaveValue('等你们说完我再补充');
  });

  it('keeps separate drafts when switching directly between groups', () => {
    const view = render(<StudioComposer key="studio:one" draftKey="studio:one" placeholder="群聊消息" members={members} onSend={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: '群聊消息' }), { target: { value: '还没发完的群聊草稿' } });
    view.rerender(<StudioComposer key="studio:two" draftKey="studio:two" placeholder="群聊消息" members={members} onSend={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: '群聊消息' })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: '群聊消息' }), { target: { value: '第二个群的草稿' } });
    view.rerender(<StudioComposer key="studio:one" draftKey="studio:one" placeholder="群聊消息" members={members} onSend={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: '群聊消息' })).toHaveValue('还没发完的群聊草稿');
  });

  it('resolves a uniquely typed mention to a partner id', async () => {
    const onSend = vi.fn(async () => true);
    render(<StudioComposer placeholder="群聊消息" members={members} onSend={onSend} />);
    const input = screen.getByRole('textbox', { name: '群聊消息' });
    fireEvent.change(input, { target: { value: '@成员 帮我看看', selectionStart: 3 } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('@成员 帮我看看', [expect.objectContaining({ partnerId: 'partner-1', label: '成员', source: 'user' })]));
  });

  it('keeps a duplicate typed name as ordinary text', async () => {
    const onSend = vi.fn(async () => true);
    render(<StudioComposer placeholder="群聊消息" members={[
      ...members,
      { partnerId: 'partner-3', displayName: '另一个外部伙伴', mentionName: '外部伙伴', expertise: '测试' },
    ]} onSend={onSend} />);
    const input = screen.getByRole('textbox', { name: '群聊消息' });
    fireEvent.change(input, { target: { value: '@外部伙伴 请回答', selectionStart: 3 } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('@外部伙伴 请回答', []));
  });

  it('opens the picker on @ and keeps the caret after the inserted mention', async () => {
    render(<StudioComposer placeholder="群聊消息" members={members} onSend={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: '群聊消息' });
    fireEvent.change(input, { target: { value: '@', selectionStart: 1 } });
    expect(screen.getByRole('listbox', { name: '选择要提到的伙伴' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /@成员/ }));
    expect(input).toHaveValue('@成员 ');
    await waitFor(() => expect(input).toHaveProperty('selectionStart', 4));
    expect(input).toHaveProperty('selectionEnd', 4);
  });

  it('opens the picker when @ follows ordinary prose without a separating space', () => {
    render(<StudioComposer placeholder="群聊消息" members={members} onSend={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: '群聊消息' });
    fireEvent.change(input, { target: { value: '请问@外', selectionStart: 4 } });
    expect(screen.getByRole('listbox', { name: '选择要提到的伙伴' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /@外部伙伴/ })).toBeInTheDocument();
  });
});
