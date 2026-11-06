import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { PrototypeProvider, usePrototype } from '../../src/renderer/app/PrototypeProvider';

afterEach(() => { delete window.asteriumProjects; localStorage.clear(); });

function CreateButton() {
  const { createProject } = usePrototype();
  return <button type="button" onClick={() => void createProject('测试项目').catch(() => undefined)}>开始创建</button>;
}

it('shows the resolved path in the app modal and sends create only after confirmation', async () => {
  const path = 'K:\\合成测试目录\\测试项目';
  const previewCreateLocation = vi.fn(async () => path);
  const create = vi.fn(async () => { throw new Error('synthetic stop after request'); });
  window.asteriumProjects = { previewCreateLocation, create, syncMembers: vi.fn(async () => undefined) } as unknown as NonNullable<typeof window.asteriumProjects>;
  render(<MemoryRouter><PrototypeProvider><CreateButton /></PrototypeProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '开始创建' }));
  const dialog = await screen.findByRole('dialog', { name: '确认项目保存位置' });
  expect(within(dialog).getByText(path)).toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '开始创建' }));
  const second = await screen.findByRole('dialog', { name: '确认项目保存位置' });
  fireEvent.click(within(second).getByRole('button', { name: '创建项目' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: '测试项目', confirmedRoot: path })));
  expect(create.mock.calls[0]).toEqual([expect.objectContaining({ projectId: expect.any(String) })]);
});
