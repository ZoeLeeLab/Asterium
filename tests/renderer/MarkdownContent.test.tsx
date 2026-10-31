import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from '../../src/renderer/components/chat/MarkdownContent';

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg data-testid="rendered-mermaid"></svg>' })),
}));

vi.mock('mermaid', () => ({ default: mermaidMocks }));

describe('MarkdownContent external links', () => {
  it('routes Markdown and bare HTTPS links through the Electron window handler', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MarkdownContent>{'[星丛文档](https://example.com/docs)\n\nhttps://example.com/help'}</MarkdownContent>);

    fireEvent.click(screen.getByRole('link', { name: '星丛文档' }));
    fireEvent.click(screen.getByRole('link', { name: 'https://example.com/help' }));
    expect(open).toHaveBeenNthCalledWith(1, 'https://example.com/docs', '_blank', 'noopener,noreferrer');
    expect(open).toHaveBeenNthCalledWith(2, 'https://example.com/help', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('does not open non-HTTP schemes', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MarkdownContent>{'[邮件](mailto:fixture-user@example.com)'}</MarkdownContent>);

    fireEvent.click(screen.getByRole('link', { name: '邮件' }));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('renders Mermaid fences on demand and copies their source', async () => {
    mermaidMocks.render.mockClear();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = render(<MarkdownContent>{'```mermaid\nflowchart LR\n  A --> B\n```'}</MarkdownContent>);

    const diagram = screen.getByRole('img', { name: 'Mermaid 流程图' });
    await waitFor(() => expect(diagram.querySelector('svg')).not.toBeNull());
    expect(mermaidMocks.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', startOnLoad: false }));
    expect(mermaidMocks.render).toHaveBeenCalledWith(expect.stringMatching(/^asterium-mermaid-/), 'flowchart LR\n  A --> B');

    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('flowchart LR\n  A --> B'));
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument();

    view.rerender(<MarkdownContent>{'```mermaid\nflowchart LR\n  A --> B\n```\n\n后续回复'}</MarkdownContent>);
    expect(screen.getByText('后续回复')).toBeInTheDocument();
    expect(mermaidMocks.render).toHaveBeenCalledTimes(1);
  });

  it('turns valid studio message references into exact jump targets', () => {
    const onReference = vi.fn();
    render(<MarkdownContent
      studioReferences={[{ seq: 9, messageId: 'message-9', authorName: '测试伙伴', excerpt: '原文摘要' }]}
      onStudioReference={onReference}
    >测试伙伴[9] 说得对</MarkdownContent>);

    const reference = screen.getByRole('link', { name: '测试伙伴[9]' });
    expect(reference).toHaveAttribute('title', '原文摘要');
    fireEvent.click(reference);
    expect(onReference).toHaveBeenCalledWith('message-9');
  });

  it('marks mismatched studio references unavailable instead of jumping elsewhere', () => {
    const onReference = vi.fn();
    render(<MarkdownContent
      studioReferences={[{ seq: 9, messageId: 'message-9', authorName: '测试伙伴', excerpt: '原文摘要' }]}
      studioReferenceAuthors={['测试伙伴', '本地伙伴']}
      onStudioReference={onReference}
    >本地伙伴[9] 也提过</MarkdownContent>);

    expect(screen.getByTitle('原消息不可用')).toHaveTextContent('本地伙伴[9]');
    expect(onReference).not.toHaveBeenCalled();
  });

  it('highlights only structured studio mentions', () => {
    const view = render(<MarkdownContent studioMentions={[{ partnerId: 'partner-1', label: '本地伙伴' }]}>@本地伙伴 请继续，@外部伙伴 只是文字</MarkdownContent>);
    expect(screen.getByTitle('已提到 @本地伙伴')).toHaveTextContent('@本地伙伴');
    expect(view.container.querySelectorAll('.studio-mention-token')).toHaveLength(1);
  });
});
