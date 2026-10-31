import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionCommandNotice } from '../../src/renderer/components/chat/SessionCommandNotice';
import type { SessionStatus } from '../../src/shared/sessionCommands';

afterEach(() => vi.useRealTimers());

it.each(['success', 'info'] as const)('automatically dismisses a completed %s notice after five seconds', (state) => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  render(<SessionCommandNotice result={{ state, message: '已保留原上下文' }} onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(4_999)); expect(dismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1)); expect(dismiss).toHaveBeenCalledOnce();
});

it('keeps status details and errors until the user dismisses them, and keeps running feedback visible', () => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  const session: SessionStatus = { conversationId: 'c', partnerId: 'p', source: 'api_partner', model: 'model', modelStatus: 'configured', state: 'idle', observedAt: '', capabilities: { status: { available: true }, compact: { available: false }, 'reload-user': { available: false }, 'reload-persona': { available: false } } };
  const view = render(<SessionCommandNotice result={{ state: 'success', message: '会话状态已更新', session }} onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(30_000)); expect(dismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '收起会话指令结果' })); expect(dismiss).toHaveBeenCalledOnce();
  dismiss.mockClear();
  view.rerender(<SessionCommandNotice result={{ state: 'error', message: '重读失败' }} onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(30_000)); expect(dismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '收起会话指令结果' })); expect(dismiss).toHaveBeenCalledOnce();
  dismiss.mockClear();
  view.rerender(<SessionCommandNotice result={{ state: 'running', message: '正在压缩' }} onDismiss={dismiss} />);
  act(() => vi.advanceTimersByTime(30_000)); expect(dismiss).not.toHaveBeenCalled();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('cancels the previous timer when a different conversation or command replaces the notice', () => {
  vi.useFakeTimers();
  const previous = vi.fn(), next = vi.fn();
  const view = render(<SessionCommandNotice result={{ state: 'success', message: '人设已重读' }} onDismiss={previous} />);
  act(() => vi.advanceTimersByTime(4_000));
  view.rerender(<SessionCommandNotice result={{ state: 'info', message: '上下文已保留' }} onDismiss={next} />);
  act(() => vi.advanceTimersByTime(1_000)); expect(previous).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(4_000)); expect(next).toHaveBeenCalledOnce();
  view.unmount();
  act(() => vi.advanceTimersByTime(30_000)); expect(previous).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledOnce();
});
