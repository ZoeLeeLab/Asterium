import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AutomationsView } from '../../src/renderer/components/settings/AutomationsView';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import type { AutomationView } from '../../src/shared/automations';

afterEach(() => vi.unstubAllGlobals());
it.each([true, false])('reports immediate execution as queue acceptance rather than task completion (accepted=%s)', async accepted => {
  const now = new Date().toISOString();
  const view: AutomationView = { version: 1, automations: [{ id: 'auto', revision: 1, scheduleRevision: 1, requestId: 'created', requestFingerprint: '', createdAt: now, updatedAt: now, effectiveFrom: now, name: '测试排队', instructions: '合成任务', target: { partnerId: 'p', conversationId: 'c', sourceMode: 'local_cli', nativeThreadId: 't', bindingGeneration: 1 }, schedule: { type: 'daily', time: '10:00' }, timezone: 'Asia/Shanghai', catchUp: 'skip', notifications: 'always', enabled: false }], runs: [], nextRuns: {}, runtimeReady: true, targets: [] };
  let resolve!: (value: AutomationView) => void, reject!: (error: Error) => void;
  const pending = new Promise<AutomationView>((done, fail) => { resolve = done; reject = fail; });
  const mutate = vi.fn(() => pending);
  vi.stubGlobal('asteriumAutomations', { get: async () => view, mutate, onChanged: () => () => undefined });
  render(<MemoryRouter><PrototypeProvider><AutomationsView /></PrototypeProvider></MemoryRouter>);
  const button = await screen.findByRole('button', { name: '立即运行' }); fireEvent.click(button);
  expect(screen.getByRole('status')).toHaveTextContent('伙伴正在安排本次执行…'); expect(button).toBeDisabled();
  await act(async () => { if (accepted) resolve(view); else reject(new Error('QUEUE_UNAVAILABLE')); });
  expect(screen.getByRole('status')).toHaveTextContent(accepted ? '伙伴把任务排进队列了' : '伙伴没能安排本次执行');
  expect(screen.queryByText(/伙伴完成了任务|伙伴正在完成任务|伙伴没能完成任务/)).not.toBeInTheDocument();
  expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'run_now', id: 'auto' }));
  expect(mutate).toHaveBeenCalledOnce();
});
it('creates free-form scheduled work on the selected existing thread without starting it', async () => {
  const view: AutomationView = { version: 1, automations: [], runs: [], nextRuns: {}, runtimeReady: false, targets: [{ label: '本地伙伴 · 本地对话', available: true,
    target: { partnerId: 'p', conversationId: 'c', sourceMode: 'local_cli', nativeThreadId: 'thread', bindingGeneration: 1 } }] };
  const mutate = vi.fn(async () => view), unsubscribe = vi.fn();
  vi.stubGlobal('asteriumAutomations', { get: async () => view, mutate, onChanged: () => unsubscribe });
  const ui = render(<MemoryRouter initialEntries={['/settings/partners?section=automations&conversation=c']}><PrototypeProvider><AutomationsView /></PrototypeProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('button', { name: '新建自动化' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '新建自动化' }));
  fireEvent.change(screen.getByLabelText('自动化名称'), { target: { value: '我的任意任务' } });
  fireEvent.change(screen.getByLabelText('自动化任务内容'), { target: { value: '每天帮我整理指定目录，不删除文件。' } });
  fireEvent.change(screen.getByLabelText('自动化时区'), { target: { value: 'Asia/Shanghai' } });
  fireEvent.click(screen.getByRole('button', { name: '保存自动化' }));
  await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
  expect(mutate.mock.calls[0]).toEqual([expect.objectContaining({ action: 'create', input: expect.objectContaining({ name: '我的任意任务', schedule: { type: 'daily', time: '10:00' }, timezone: 'Asia/Shanghai', catchUp: 'same_day', target: view.targets[0].target }) })]);
  ui.unmount(); expect(unsubscribe).toHaveBeenCalledTimes(2);
});
it('allows editing the file-organizing preset and rejects missing established targets', async () => {
  const view: AutomationView = { version: 1, automations: [], runs: [], nextRuns: {}, runtimeReady: false, targets: [] };
  const mutate = vi.fn(); vi.stubGlobal('asteriumAutomations', { get: async () => view, mutate, onChanged: () => () => undefined });
  render(<MemoryRouter><PrototypeProvider><AutomationsView /></PrototypeProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('button', { name: '新建自动化' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: '新建自动化' }));
  fireEvent.change(screen.getByLabelText('自动化模板'), { target: { value: '文件整理' } }); expect((screen.getByLabelText('自动化任务内容') as HTMLTextAreaElement).value).toContain('填写目录');
  fireEvent.click(screen.getByRole('button', { name: '保存自动化' })); expect(await screen.findByRole('alert')).toHaveTextContent('建立原线程'); expect(mutate).not.toHaveBeenCalled();
});
