import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Composer } from '../../src/renderer/components/ui/Composer';
import { SessionCommandNotice } from '../../src/renderer/components/chat/SessionCommandNotice';
import type { SessionCommandName } from '../../src/shared/sessionCommands';

it.each<SessionCommandName>(['status', 'compact', 'reload-user', 'reload-persona'])('preserves a draft typed while /%s is pending, including after reopening the composer', async (name) => {
  let finish!: () => void;
  const command = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })), send = vi.fn();
  const props = { placeholder: '消息', draftKey: `pending-${name}`, onSend: send, onSessionCommand: command };
  const view = render(<Composer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: `/${name}` } });
  fireEvent.submit(screen.getByRole('textbox').closest('form')!);
  expect(command).toHaveBeenCalledWith(name); expect(screen.getByRole('textbox')).toHaveValue('');
  view.rerender(<Composer {...props} disabled busy />);
  expect(screen.getByRole('textbox')).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '等待期间的新草稿' } });
  await act(async () => { finish(); });
  expect(screen.getByRole('textbox')).toHaveValue('等待期间的新草稿'); expect(send).not.toHaveBeenCalled();
  view.unmount(); render(<Composer {...props} />);
  expect(screen.getByRole('textbox')).toHaveValue('等待期间的新草稿');
});

it('keeps a blocked maintenance command in the input', () => {
  const command = vi.fn(); render(<Composer placeholder="消息" onSend={vi.fn()} onSessionCommand={command} compactDisabledReason="等待任务结束" />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/compact' } });
  fireEvent.submit(screen.getByRole('textbox').closest('form')!);
  expect(command).not.toHaveBeenCalled(); expect(screen.getByRole('textbox')).toHaveValue('/compact');
});

it('uses the same handler for menu and exact slash commands and preserves the menu draft', async () => {
  const command = vi.fn(), send = vi.fn(); render(<Composer placeholder="消息" onSend={send} onSessionCommand={command} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '指令' })); fireEvent.click(screen.getByRole('menuitem', { name: /查看会话状态/ }));
  expect(command).toHaveBeenCalledWith('status'); expect(screen.getByRole('textbox')).toHaveValue('草稿');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/status' } }); fireEvent.submit(screen.getByRole('textbox').closest('form')!);
  await waitFor(() => expect(command).toHaveBeenCalledTimes(2)); expect(send).not.toHaveBeenCalled();
});
it('allows status while busy but does not turn ordinary slash references into commands', async () => {
  const command = vi.fn(), send = vi.fn(); const view = render(<Composer placeholder="消息" onSend={send} onSessionCommand={command} busy allowBusySend />);
  fireEvent.click(screen.getByRole('button', { name: '指令' })); expect(screen.getByRole('menuitem', { name: /查看会话状态/ })).toBeEnabled();
  expect(screen.getByRole('menuitem', { name: /压缩当前对话/ })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/status' } }); fireEvent.click(screen.getByRole('button', { name: '查询状态' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('status'));
  view.rerender(<Composer placeholder="消息" onSend={send} onSessionCommand={command} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '请解释 /status' } }); fireEvent.submit(screen.getByRole('textbox').closest('form')!);
  await waitFor(() => expect(send).toHaveBeenCalledWith('请解释 /status', [])); expect(command).toHaveBeenCalledOnce();
});
it('shows an uncreated session clearly and labels selected modes', () => {
  render(<SessionCommandNotice onDismiss={vi.fn()} result={{ state: 'success', message: '会话状态已更新', session: { conversationId: 'c', partnerId: 'p', source: 'api_partner', model: 'test', modelStatus: 'configured', state: 'idle', permissionMode: 'read_only', planMode: 'plan', observedAt: '', capabilities: { status: { available: true }, compact: { available: false }, 'reload-user': { available: false }, 'reload-persona': { available: false } } } }} />);
  expect(screen.getByText('尚未建立')).toBeInTheDocument(); expect(screen.getByText('只读')).toBeInTheDocument(); expect(screen.getByText('计划模式')).toBeInTheDocument();
});

it('shows native profile recovery instructions for an idle session', () => {
  render(<SessionCommandNotice onDismiss={vi.fn()} result={{ state: 'success', message: '会话状态已更新', session: { conversationId: 'c', partnerId: 'p', source: 'local_cli', model: 'test', modelStatus: 'recent', state: 'idle', observedAt: '', profileRecoveryRequired: true, capabilities: { status: { available: true }, compact: { available: false }, 'reload-user': { available: true }, 'reload-persona': { available: true } } } }} />);
  expect(screen.getByText('上次资料重读需要恢复，普通续聊已暂停。请重试资料重读，或新建对话。')).toBeInTheDocument();
});
