import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectGitPane } from '../../src/renderer/components/studio/ProjectGitPane';
afterEach(() => { delete window.asteriumProjects; });
describe('project Git views', () => {
  it('opens committed files using their exact SHA and shows original commit summary', async () => {
    const sha = 'a'.repeat(40);
    window.asteriumProjects = { browse: vi.fn(async (request: { action: string }) => request.action === 'history' ? { git: 'ready', commits: [{ sha, shortSha: 'aaaaaaa', author: '用户', date: '2026-10-24T08:00:00Z', subject: '登录页', body: '支持键盘登录' }] } : { changes: [{ path: 'src/login.tsx', status: 'M' }] }) } as never;
    const onOpenFile = vi.fn();
    render(<ProjectGitPane projectId="p" open tab="history" refresh={0} onOpenFile={onOpenFile} />);
    fireEvent.click(await screen.findByText('登录页'));
    expect(await screen.findByText('支持键盘登录')).toBeVisible();
    fireEvent.click(await screen.findByText('src/login.tsx'));
    expect(onOpenFile.mock.calls[0][0]).toMatchObject({ action: 'diff', revision: sha, path: 'src/login.tsx' });
  });
  it('keeps staged and unstaged actions distinct for the same path', async () => {
    window.asteriumProjects = { browse: vi.fn(async () => ({ git: 'ready', changes: [{ path: 'a.ts', status: 'M', group: 'staged' }, { path: 'a.ts', status: 'M', group: 'unstaged' }] })) } as never;
    const onOpenFile = vi.fn();
    render(<ProjectGitPane projectId="p" open tab="status" refresh={0} onOpenFile={onOpenFile} />);
    const files = await screen.findAllByText('a.ts'); fireEvent.click(files[0]); fireEvent.click(files[1]);
    expect(onOpenFile.mock.calls.map(([request]) => request.group)).toEqual(['staged', 'unstaged']);
  });
});
