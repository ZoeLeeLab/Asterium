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

describe('MarkdownContent user bubble whitespace', () => {
  const blockContainers = '.markdown-content, ul, ol, li, blockquote, table, thead, tbody, tr';
  const separatorNodes = (container: HTMLElement) => [...container.querySelectorAll(blockContainers)]
    .flatMap((node) => [...node.childNodes])
    .filter((node) => node.nodeType === Node.TEXT_NODE && /^[\t \r\n]*\n[\t \r\n]*$/.test(node.textContent ?? ''));

  it.each(['\n', '\n\n'])('does not preserve generated block separators in user lists (%j)', (separator) => {
    const view = render(<MarkdownContent className="message-content--user">{
      `简介\n\n${['第一项', '第二项', '第三项'].map((text) => `- ${text}`).join(separator)}`
    }</MarkdownContent>);

    expect(view.container.querySelectorAll('li')).toHaveLength(3);
    expect(separatorNodes(view.container)).toHaveLength(0);
  });

  it('handles nested lists, quotes and tables without extra structural lines', () => {
    const view = render(<MarkdownContent className="message-content--user">{
      '> 引用段落\n>\n> - 引用列表\n>\n> 第二段\n\n1. 父项\n   - 子项一\n   - 子项二\n\n2. 下一项\n\n| 列一 | 列二 |\n| --- | --- |\n| 值一 | 值二 |'
    }</MarkdownContent>);

    expect(view.container.querySelector('blockquote')).not.toBeNull();
    expect(view.container.querySelectorAll('li')).toHaveLength(5);
    expect(view.container.querySelector('table')).not.toBeNull();
    expect(separatorNodes(view.container)).toHaveLength(0);
  });

  it('preserves authored soft breaks, spaces, hard breaks and code whitespace', () => {
    const view = render(<MarkdownContent className="message-content--user">{
      '第一行  连续空格\n第二行\n\n[链接一](https://example.com/one)\n[链接二](https://example.com/two)\n\n显式换行  \n下一行\n\n```text\n  缩进一\n\n    缩进二\n```'
    }</MarkdownContent>);

    const paragraphs = view.container.querySelectorAll('p');
    expect(paragraphs[0].textContent).toBe('第一行  连续空格\n第二行');
    expect(paragraphs[1].textContent).toBe('链接一\n链接二');
    expect(paragraphs[2].querySelector('br')).not.toBeNull();
    expect(paragraphs[2].textContent).toBe('显式换行下一行');
    expect(view.container.querySelector('pre code')?.textContent).toBe('  缩进一\n\n    缩进二\n');
  });

  it('keeps inline-only newlines in a list item even when it also has a nested list', () => {
    const view = render(<MarkdownContent className="message-content--user">{
      '- [链接一](https://example.com/one)\n  [链接二](https://example.com/two)\n  - 嵌套项'
    }</MarkdownContent>);

    const item = view.container.querySelector('li')!;
    const links = item.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0].nextSibling?.textContent).toBe('\n');
    expect(item.querySelector('ul li')?.textContent).toBe('嵌套项');
  });

  it('retains studio annotations and leaves assistant rendering unchanged', () => {
    const view = render(<MarkdownContent className="extra message-content--user"
      studioReferences={[{ seq: 2, messageId: 'fixture-message-2', authorName: '测试伙伴', excerpt: '合成摘要' }]}
      studioMentions={[{ partnerId: 'fixture-partner', label: '测试伙伴' }]}
    >{'测试伙伴[2]\n\n- @测试伙伴\n- 下一项'}</MarkdownContent>);

    expect(screen.getByRole('link', { name: '测试伙伴[2]' })).toBeInTheDocument();
    expect(screen.getByTitle('已提到 @测试伙伴')).toBeInTheDocument();
    expect(separatorNodes(view.container)).toHaveLength(0);

    view.rerender(<MarkdownContent>{'简介\n\n- 第一项\n- 第二项'}</MarkdownContent>);
    expect(separatorNodes(view.container).length).toBeGreaterThan(0);
  });
});
