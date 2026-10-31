import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TurnTimeline } from '../../src/renderer/components/chat/TurnTimeline';
import type { UserInputQuestion } from '../../src/shared/agentProtocol';
import type { Message } from '../../src/renderer/types/domain';

const single: UserInputQuestion = { id: 'single', prompt: '选择格式', options: [{ label: 'Markdown (Recommended)' }, { label: '纯文本' }] };
const multi: UserInputQuestion = { id: 'multi', prompt: '选择内容', multiple: true, options: [{ label: '测试' }, { label: '文档' }] };
function card(questions: UserInputQuestion[], onResolve = vi.fn(), requestId = 'request-1') {
  const message: Message = { id: 'assistant', authorId: 'partner', content: '', createdAt: '12:00', timeline: [{ id: 'question-row', sequence: 1, kind: 'user_input', requestId, state: 'running', questions }] };
  return <TurnTimeline message={message} partnerName="伙伴" pendingUserInput={{ requestId, questions }} onResolveUserInput={onResolve} onResolveAuthorization={vi.fn()} onOpenArtifact={vi.fn()} />;
}
function other(group?: HTMLElement) { return (group ? within(group) : screen).getByRole('radio', { name: /其他／自行填写/ }); }

describe('free-form question choices', () => {
  it('requires text for Other, excludes it after choosing an option, and sends original option labels', async () => {
    const submit = vi.fn(); render(card([single], submit));
    fireEvent.click(other());
    const input = screen.getByRole('textbox', { name: '自行填写：选择格式' });
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: '提交回答' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '自填推荐方案' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Markdown（推荐）' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ single: ['Markdown (Recommended)'] }, undefined, 'request-1'));
  });

  it('combines existing multi-select choices with actual custom text and omits a deselected custom draft', async () => {
    const submit = vi.fn(); const view = render(card([multi], submit));
    fireEvent.click(screen.getByRole('checkbox', { name: '测试' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /其他／自行填写/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '其他：保留 recommended.md\n并增加示例' } });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ multi: ['测试', '其他：保留 recommended.md\n并增加示例'] }, { multi: '其他：保留 recommended.md\n并增加示例' }, 'request-1'));
    view.rerender(card([multi], submit, 'request-2'));
    fireEvent.click(screen.getByRole('checkbox', { name: '文档' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /其他／自行填写/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '不应提交' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /其他／自行填写/ }));
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(submit).toHaveBeenLastCalledWith({ multi: ['文档'] }, undefined, 'request-2'));
  });

  it('keeps every question independent, requires all answers, and leaves pure text questions as one textarea', async () => {
    const submit = vi.fn(); render(card([single, multi, { id: 'text', prompt: '补充说明' }], submit));
    expect(screen.getAllByText('其他／自行填写')).toHaveLength(2);
    fireEvent.click(other(screen.getByRole('group', { name: '选择格式' })));
    fireEvent.change(screen.getByRole('textbox', { name: '自行填写：选择格式' }), { target: { value: 'JSON' } });
    fireEvent.click(within(screen.getByRole('group', { name: '选择内容' })).getByRole('checkbox', { name: '文档' }));
    expect(screen.getByRole('button', { name: '提交回答' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '回答：补充说明' }), { target: { value: '保留换行\nrecommended 原文' } });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ single: ['JSON'], multi: ['文档'], text: ['保留换行\nrecommended 原文'] }, { single: 'JSON' }, 'request-1'));
  });

  it('prevents duplicate submission and retains text after a failed submission for retry', async () => {
    let reject!: (error: Error) => void;
    const submit = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
    render(card([single], submit)); fireEvent.click(other());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '先调整计划' } });
    const button = screen.getByRole('button', { name: '提交回答' });
    fireEvent.click(button); fireEvent.click(button);
    expect(submit).toHaveBeenCalledOnce(); expect(button).toBeDisabled();
    await act(async () => { reject(new Error('synthetic failure')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时未能提交，请重试。');
    expect(screen.getByRole('textbox')).toHaveValue('先调整计划');
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  });

  it('resets the draft when a revised plan asks a new question and preserves custom text in history', () => {
    const view = render(card([single])); fireEvent.click(other());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '旧草稿' } });
    view.rerender(card([single], vi.fn(), 'request-2'));
    expect(other()).not.toBeChecked(); expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    const custom = '开始执行 (Recommended)';
    const message: Message = { id: 'assistant', authorId: 'partner', content: '', createdAt: '12:00', timeline: [{ id: 'record', sequence: 2, kind: 'user_input', requestId: 'done', state: 'success', questions: [{ ...single, options: [{ label: custom }] }], answers: { single: [custom] }, customAnswers: { single: custom } }] };
    view.rerender(<TurnTimeline message={message} partnerName="伙伴" onResolveUserInput={vi.fn()} onResolveAuthorization={vi.fn()} onOpenArtifact={vi.fn()} />);
    expect(screen.getByText(custom)).toBeInTheDocument();
    expect(screen.queryByText('开始执行（推荐）')).not.toBeInTheDocument();
  });
});
