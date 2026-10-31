import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectBrowserPane } from '../../src/renderer/components/studio/ProjectBrowserPane';
import { CodePreview } from '../../src/renderer/components/chat/CodePreview';
afterEach(() => { delete window.asteriumProjects; });
describe('project directory browser', () => {
  it('only reads visible directories and preserves expansion while collapsed', async () => {
    const browse = vi.fn(async (request: { path?: string }) => ({ entries: request.path === 'src' ? [{ path: 'src/a.ts', name: 'a.ts', directory: false }] : [{ path: 'src', name: 'src', directory: true }, { path: 'node_modules', name: 'node_modules', directory: true }] }));
    window.asteriumProjects = { browse } as never;
    const onOpenFile = vi.fn();
    const props = { projectId: 'p', open: false, tab: 'files' as const, onTab: vi.fn(), onClose: vi.fn(), onOpenFile };
    const view = render(<ProjectBrowserPane {...props} />);
    expect(browse).not.toHaveBeenCalled();
    view.rerender(<ProjectBrowserPane {...props} open />);
    fireEvent.click(await screen.findByRole('button', { name: 'src' }));
    fireEvent.click(await screen.findByRole('button', { name: 'a.ts' }));
    expect(onOpenFile).toHaveBeenCalledWith({ projectId: 'p', action: 'file', path: 'src/a.ts' }, 'p:current:src/a.ts', 'a.ts');
    expect(browse.mock.calls.some(([request]) => request.path === 'node_modules')).toBe(false);
    view.rerender(<ProjectBrowserPane {...props} />); view.rerender(<ProjectBrowserPane {...props} open />);
    expect(await screen.findByRole('button', { name: 'src' })).toHaveAttribute('aria-expanded', 'true');
  });
  it('renders code as escaped text with line numbers', () => {
    const view = render(<CodePreview text={'const x = "<script>bad()</script>";\nreturn x;'} />);
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelectorAll('.code-line-number')).toHaveLength(2);
    expect(view.container.querySelector('.code-keyword')).toHaveTextContent('const');
  });
});
