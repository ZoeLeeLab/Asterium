import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ContextHandoffDialog } from '../../src/renderer/components/chat/ContextHandoffDialog';

it('renders outside the chat container and stages only the selected message IDs', () => {
  const onStage = vi.fn();
  const { container } = render(<ContextHandoffDialog source={{ kind: 'group', id: 'group-one' }}
    targets={[
      { kind: 'single', id: 'single-a', partnerId: 'a', label: '小A · 单聊' },
      { kind: 'single', id: 'single-b', partnerId: 'b', label: '小B · 单聊' },
    ]}
    messages={[
      { id: 'older', authorId: 'a', content: '较早的一句', createdAt: '00:00' },
      { id: 'one', authorId: 'a', content: '这句不带过去', createdAt: '00:01' },
      { id: 'middle', authorId: 'a', content: '中间一句', createdAt: '00:02' },
      { id: 'two', authorId: 'b', content: '这一句直接带过去', createdAt: '00:01' },
    ]} partners={[]} onStage={onStage} onClose={() => undefined} />);
  expect(container).not.toContainElement(screen.getByRole('dialog', { name: '带上下文去单聊' }));
  fireEvent.change(screen.getByLabelText('接收聊天与伙伴'), { target: { value: 'single-b' } });
  expect(screen.getByRole('status')).toHaveTextContent('已选 3 / 4 条');
  fireEvent.click(screen.getByRole('checkbox', { name: /较早的一句/ }));
  expect(screen.getByRole('status')).toHaveTextContent('已选 4 / 4 条');
  fireEvent.click(screen.getByRole('checkbox', { name: /这句不带过去/ }));
  expect(screen.getByRole('status')).toHaveTextContent('已选 3 / 4 条');
  fireEvent.click(screen.getByRole('button', { name: '清空选择' }));
  expect(screen.getByRole('button', { name: '带过去（0 条）' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /这一句直接带过去/ }));
  fireEvent.click(screen.getByRole('button', { name: '带过去（1 条）' }));
  expect(onStage).toHaveBeenCalledWith(expect.objectContaining({
    source: { kind: 'group', id: 'group-one' }, target: { kind: 'single', id: 'single-b' }, partnerId: 'b', messageIds: ['two'],
  }));
});
