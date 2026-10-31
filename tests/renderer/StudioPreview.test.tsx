import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStudioPreview } from '../../src/renderer/components/studio/useStudioPreview';
function Harness({ projectId }: { projectId: string }) {
  const preview = useStudioPreview(projectId);
  return <><button onClick={() => void preview.open({ projectId, action: 'file', fileId: 'f' }, `${projectId}:f`, 'result.md')}>预览</button>{preview.pane}</>;
}
afterEach(() => { delete window.asteriumProjects; });
describe('Studio preview lifecycle', () => {
  it('is closed by default, opens an internal preview and collapses after the last tab closes', async () => {
    window.asteriumProjects = { browse: vi.fn(async () => ({ content: { name: 'result.md', path: 'result.md', info: { previewKind: 'markdown' }, text: '# 项目文件内容' } })) } as never;
    render(<Harness projectId="a" />);
    expect(screen.queryByLabelText('文件预览')).toBeNull();
    fireEvent.click(screen.getByText('预览'));
    expect(await screen.findByText('项目文件内容')).toBeVisible();
    fireEvent.click(screen.getByLabelText('关闭 result.md'));
    expect(screen.queryByLabelText('文件预览')).toBeNull();
  });
  it('discards a late response after project switching and does not restore old project tabs', async () => {
    let resolve!: (value: unknown) => void;
    window.asteriumProjects = { browse: vi.fn(() => new Promise((done) => { resolve = done; })) } as never;
    const view = render(<Harness projectId="a" />);
    fireEvent.click(screen.getByText('预览'));
    view.rerender(<Harness projectId="b" />);
    await act(async () => resolve({ content: { name: 'result.md', path: 'result.md', info: { previewKind: 'text' }, text: '旧数据' } }));
    expect(screen.queryByText('旧数据')).toBeNull();
    view.rerender(<Harness projectId="a" />);
    await waitFor(() => expect(screen.queryByLabelText('文件预览')).toBeNull());
  });
  it('ignores an older request for the same file and refreshes current content on focus', async () => {
    const pending: Array<(value: unknown) => void> = [];
    window.asteriumProjects = { browse: vi.fn(() => new Promise((resolve) => pending.push(resolve))) } as never;
    render(<Harness projectId="a" />);
    fireEvent.click(screen.getByText('预览')); fireEvent.click(screen.getByText('预览'));
    const content = (text: string) => ({ content: { name: 'result.md', path: 'result.md', info: { previewKind: 'text' }, text } });
    await act(async () => pending[1](content('new response')));
    await act(async () => pending[0](content('old response')));
    expect(screen.getByLabelText('文件预览')).not.toHaveTextContent('old response'); expect(screen.getByLabelText('文件预览')).toHaveTextContent('new response');
    fireEvent(window, new Event('focus'));
    await act(async () => pending[2](content('fresh disk content')));
    expect(screen.getByLabelText('文件预览')).toHaveTextContent('fresh disk content');
    fireEvent.click(screen.getByLabelText('关闭 result.md'));
    fireEvent(window, new Event('focus')); expect(pending).toHaveLength(3);
  });
});
