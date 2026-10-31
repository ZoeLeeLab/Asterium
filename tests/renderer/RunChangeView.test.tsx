import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunChangeSummary } from '../../src/renderer/components/studio/RunChangeSummary';
import { ProjectBrowserPane } from '../../src/renderer/components/studio/ProjectBrowserPane';
import type { ProjectRunChange } from '../../src/shared/projectRunChanges';
const change: ProjectRunChange = { version: 1, id: 'record-1', projectId: 'p', partnerId: 'a', title: '登录页任务', status: 'completed', runIds: ['run-1'], startedAt: '', files: [{ path: 'src/login.ts', status: 'M' }], commits: [], verification: [], complete: true, warnings: [] };
afterEach(() => { delete window.asteriumProjects; });
describe('run change entry and temporary view', () => {
  it('does not infer tests passed from task completion and opens the exact record', () => {
    const onView = vi.fn(); render(<RunChangeSummary change={change} onView={onView} />);
    expect(screen.getByText('1 个文件')).toBeVisible(); expect(screen.getByText('测试未运行')).toBeVisible(); expect(screen.queryByText('测试通过')).toBeNull();
    fireEvent.click(screen.getByText('查看本次改动')); expect(onView).toHaveBeenCalledWith(change);
  });
  it('returns to the original expanded directory and scroll position without adding a permanent tab', async () => {
    window.asteriumProjects = { browse: vi.fn(async ({ path }: { path?: string }) => ({ entries: path === 'src' ? [{ path: 'src/a.ts', name: 'a.ts', directory: false }] : [{ path: 'src', name: 'src', directory: true }] })) } as never;
    const onCloseChange = vi.fn(); const onOpenChange = vi.fn();
    const props = { projectId: 'p', open: true, tab: 'files' as const, onTab: vi.fn(), onClose: vi.fn(), onOpenFile: vi.fn(), onCloseChange, onOpenChange };
    const view = render(<ProjectBrowserPane {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'src' })); await screen.findByRole('button', { name: 'a.ts' });
    const body = view.container.querySelector('.project-browser-normal .project-browser-body')!; body.scrollTop = 80;
    view.rerender(<ProjectBrowserPane {...props} change={change} />);
    expect(screen.queryByRole('button', { name: 'a.ts' })).toBeNull();
    expect(screen.getByText('src/login.ts')).toBeVisible(); fireEvent.click(screen.getByText('src/login.ts')); expect(onOpenChange).toHaveBeenCalledWith('src/login.ts');
    fireEvent.click(screen.getByLabelText('关闭本次改动')); expect(onCloseChange).toHaveBeenCalled();
    view.rerender(<ProjectBrowserPane {...props} />);
    expect(await screen.findByRole('button', { name: 'src' })).toHaveAttribute('aria-expanded', 'true'); expect(body.scrollTop).toBe(80);
    expect(screen.getByRole('navigation', { name: '项目浏览视图' }).querySelectorAll('button')).toHaveLength(3);
  });
});
