import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/app/App';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { createTestState } from '../fixtures/applicationState';
import type { SingleChatHistorySnapshot } from '../../src/shared/singleChatHistory';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete window.asteriumConversations; delete (window as Window & { asteriumStartup?: unknown }).asteriumStartup; });

function connect() {
  let resolve!: (snapshot: SingleChatHistorySnapshot) => void;
  const pending = new Promise<SingleChatHistorySnapshot>(done => { resolve = done; });
  const open = vi.fn(() => pending);
  window.asteriumConversations = {
    openHistory: open, migrateHistory: vi.fn(), writeHistory: vi.fn(async () => undefined),
    readHistoryPage: vi.fn(), listDeleted: vi.fn(async () => []), delete: vi.fn(),
  } as unknown as NonNullable<typeof window.asteriumConversations>;
  const { conversations, ...profile } = createTestState();
  return { open, finish: () => resolve({ generation: 'fixture-generation', profile, conversations }) };
}

function mount() {
  return render(<MemoryRouter initialEntries={['/chat']}><PrototypeProvider><App /></PrototypeProvider></MemoryRouter>);
}

it('shows a draggable startup view while history is pending and enters the original chat when ready', async () => {
  const fixture = connect();
  const view = mount();
  expect(screen.getByRole('status')).toHaveTextContent('伙伴们正在归来');
  expect(screen.queryByText(/星丛|Asterium/)).not.toBeInTheDocument();
  expect(view.container.querySelector('.window-drag-strip')).not.toBeNull();
  expect(screen.queryByText('添加你的第一位伙伴')).not.toBeInTheDocument();
  await act(async () => { fixture.finish(); });
  expect(screen.queryByText('伙伴们正在归来')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '给 测试伙伴 A 发送消息…' })).toBeInTheDocument();
});

it('preserves the failed-read warning and retries only on request before entering the original page', async () => {
  const fixture = connect();
  fixture.open.mockRejectedValueOnce(Error('fixture-storage-unavailable'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('单聊资料暂时无法打开');
  expect(fixture.open).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(screen.getByRole('status')).toHaveTextContent('伙伴们正在归来');
  expect(fixture.open).toHaveBeenCalledTimes(2);
  await act(async () => { fixture.finish(); });
  expect(screen.getByRole('textbox', { name: '给 测试伙伴 A 发送消息…' })).toBeInTheDocument();
});

it('does not add a startup delay to browser-only rendering', () => {
  mount();
  expect(screen.queryByText('伙伴们正在归来')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '给 测试伙伴 A 发送消息…' })).toBeInTheDocument();
});

it.each([0, 4000, 20000])('enters chat immediately when history resolves after %i ms without waiting for animation completion', async elapsed => {
  vi.useFakeTimers();
  const fixture = connect();
  const view = mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(elapsed); });
  expect(screen.getByRole('status')).toHaveTextContent('伙伴们正在归来');
  // No animationend, transitionend or additional clock tick is sent.
  await act(async () => { fixture.finish(); });
  expect(view.container.querySelector('.startup-view')).toBeNull();
  expect(screen.getByRole('textbox', { name: '给 测试伙伴 A 发送消息…' })).toBeInTheDocument();
});

it('keeps the native main renderer free of the full-screen animation and reports only after chat has had a paint opportunity', async () => {
  vi.useFakeTimers();
  const report = vi.fn(async () => undefined);
  Object.assign(window, { asteriumStartup: { report } });
  const fixture = connect();
  const view = mount();
  expect(view.container.querySelector('.startup-view')).toBeNull();
  expect(report).not.toHaveBeenCalled();
  await act(async () => { fixture.finish(); });
  expect(screen.getByRole('textbox', { name: '给 测试伙伴 A 发送消息…' })).toBeInTheDocument();
  expect(report).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(16); });
  expect(report).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(16); });
  expect(report).toHaveBeenCalledWith('painted');
});
