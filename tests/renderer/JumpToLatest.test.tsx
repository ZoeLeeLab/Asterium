import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JumpToLatest } from '../../src/renderer/components/chat/JumpToLatest';

let resized: ResizeObserverCallback;
const disconnect = vi.fn();
class TestResizeObserver {
  constructor(callback: ResizeObserverCallback) { resized = callback; }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = disconnect;
}
afterEach(() => vi.unstubAllGlobals());

function Harness({ streaming = false, onJump = vi.fn(), conversation = 'one' }) {
  const ref = useRef<HTMLDivElement>(null);
  return <><div ref={ref} data-testid="messages" key={`messages:${conversation}`}><p>历史消息</p></div><JumpToLatest key={conversation} scrollRef={ref} streaming={streaming} onJump={onJump} /></>;
}
function metrics(height: number, top: number, viewport = 200) {
  const root = screen.getByTestId('messages');
  Object.defineProperties(root, { scrollHeight: { configurable: true, value: height }, clientHeight: { configurable: true, value: viewport } });
  root.scrollTop = top;
  fireEvent.scroll(root);
  return root;
}

describe('jump to latest messages', () => {
  it('appears only away from the bottom, jumps once and resumes following', () => {
    const onJump = vi.fn();
    render(<Harness onJump={onJump} />);
    metrics(1000, 712);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    const root = metrics(1000, 711);
    fireEvent.click(screen.getByRole('button', { name: '回到底部' }));
    expect(root.scrollTop).toBe(1000);
    expect(onJump).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('changes from active reply to idle without moving a reader of history', () => {
    const view = render(<Harness streaming />);
    const root = metrics(1200, 50);
    expect(screen.getByRole('button', { name: '回到底部（伙伴正在回复）' }).parentElement).toHaveAttribute('data-state', 'streaming');
    view.rerender(<Harness />);
    expect(screen.getByRole('button', { name: '回到底部' }).parentElement).toHaveAttribute('data-state', 'idle');
    expect(root.scrollTop).toBe(50);
    metrics(1200, 1000);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('remeasures resized content and clears visibility when switching conversations', async () => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    const view = render(<Harness />);
    const root = metrics(1000, 800);
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 1500 });
    act(() => resized([], {} as ResizeObserver));
    await screen.findByRole('button', { name: '回到底部' });
    view.rerender(<Harness conversation="two" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(disconnect).toHaveBeenCalled();
    metrics(1000, 0);
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('detects new content without a scroll event and preserves the current reading position', async () => {
    render(<Harness />);
    const root = metrics(1000, 800);
    act(() => {
      Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 1600 });
      root.appendChild(document.createElement('p'));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '回到底部' })).toBeInTheDocument());
    expect(root.scrollTop).toBe(800);
  });
});
