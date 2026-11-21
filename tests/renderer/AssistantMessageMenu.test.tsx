import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantMessageMenu } from '../../src/renderer/components/chat/AssistantMessageMenu';

afterEach(() => vi.unstubAllGlobals());

it('copies a selection, navigates the menu by keyboard, and delegates a local file to the existing opener', async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const close = vi.fn();
  const openLocal = vi.fn();
  const quote = vi.fn();
  render(<AssistantMessageMenu context={{ text: '合成选中内容', selection: true, href: 'C:/fixture/delivered.md', x: 20, y: 20 }}
    onQuote={quote} onOpenLocalLink={openLocal} onClose={close} />);
  const copy = screen.getByRole('menuitem', { name: '复制选中内容' });
  expect(copy).toHaveFocus();
  fireEvent.keyDown(copy, { key: 'ArrowDown' });
  expect(screen.getByRole('menuitem', { name: '引用选中内容' })).toHaveFocus();
  fireEvent.click(screen.getByRole('menuitem', { name: '引用选中内容' }));
  expect(quote).toHaveBeenCalledOnce();
  fireEvent.click(copy);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('合成选中内容'));
  fireEvent.click(screen.getByRole('menuitem', { name: '复制链接地址' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('C:/fixture/delivered.md'));
  fireEvent.click(screen.getByRole('menuitem', { name: '查看交付文件' }));
  expect(openLocal).toHaveBeenCalledWith('C:/fixture/delivered.md');
  expect(close).toHaveBeenCalled();
});

it('offers copy while streaming and reports clipboard failures without opening unsafe links', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('Fixture denied'); }) } });
  render(<AssistantMessageMenu context={{ text: '尚在回复', selection: false, href: 'javascript:fixture()', x: 20, y: 20 }}
    onOpenLocalLink={vi.fn()} onClose={vi.fn()} />);
  expect(screen.queryByRole('menuitem', { name: /引用/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: /打开|查看/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: '复制回复' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('复制失败');
});
