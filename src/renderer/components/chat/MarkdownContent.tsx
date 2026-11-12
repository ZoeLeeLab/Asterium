import { Check, Copy } from 'lucide-react';
import { isValidElement, memo, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

let mermaidModule: Promise<typeof import('mermaid')> | undefined;
let mermaidRenderQueue = Promise.resolve();

function loadMermaid() {
  mermaidModule ??= import('mermaid');
  return mermaidModule;
}

async function renderMermaid(id: string, source: string, theme: 'default' | 'dark') {
  const task = mermaidRenderQueue.then(async () => {
    const { default: mermaid } = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme,
    });
    return mermaid.render(id, source);
  });
  mermaidRenderQueue = task.then(() => undefined, () => undefined);
  return task;
}

function textFromNode(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textFromNode).join('');
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') return String(node);
  return '';
}

function MermaidDiagram({ source }: { source: string }) {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
  return <MermaidDiagramRender key={`${theme}:${source}`} source={source} theme={theme} />;
}

function MermaidDiagramRender({ source, theme }: { source: string; theme: 'default' | 'dark' }) {
  const reactId = useId();
  const renderId = `asterium-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const canvasRef = useRef<HTMLDivElement>(null);
  const bindFunctionsRef = useRef<((element: Element) => void) | undefined>(undefined);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    bindFunctionsRef.current = undefined;
    void renderMermaid(renderId, source, theme)
      .then((result) => {
        if (cancelled) return;
        bindFunctionsRef.current = result.bindFunctions;
        setSvg(result.svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [renderId, source, theme]);

  useEffect(() => {
    if (svg && canvasRef.current) bindFunctionsRef.current?.(canvasRef.current);
  }, [svg]);

  useEffect(() => () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
  }, []);

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
      copyResetTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return <figure className="mermaid-diagram">
    <figcaption className="mermaid-diagram__toolbar">
      <span>流程图</span>
      <button type="button" onClick={() => void copySource()} title="复制流程图代码">
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? '已复制' : '复制代码'}
      </button>
    </figcaption>
    {failed
      ? <pre className="mermaid-diagram__fallback"><code className="language-mermaid">{source}</code></pre>
      : <div
          ref={canvasRef}
          className="mermaid-diagram__canvas"
          role="img"
          aria-label="Mermaid 流程图"
          aria-busy={!svg}
          dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
        >{!svg ? <span className="mermaid-diagram__status">正在绘制流程图…</span> : undefined}</div>}
  </figure>;
}

const markdownComponents: Components = {
  img: () => null,
  pre: ({ children: codeBlock }) => {
    const code = Array.isArray(codeBlock) ? codeBlock[0] : codeBlock;
    if (isValidElement<{ className?: string; children?: ReactNode }>(code) && /(?:^|\s)language-mermaid(?:\s|$)/.test(code.props.className ?? '')) {
      return <MermaidDiagram source={textFromNode(code.props.children).replace(/\n$/, '')} />;
    }
    return <pre>{codeBlock}</pre>;
  },
  a: ({ href, children: label }) => (
    <a
      href={href}
      rel="noreferrer"
      title="使用默认浏览器打开"
      onClick={(event) => {
        if (!href || !/^https?:/i.test(href)) return event.preventDefault();
        event.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
      }}
    >{label}</a>
  ),
};

export interface StudioMessageReference {
  seq: number;
  messageId: string;
  authorName: string;
  excerpt: string;
}

export interface StudioRenderedMention {
  partnerId: string;
  label: string;
}

// The active reply can update many times a second; unchanged history needn't be parsed again.
export const MarkdownContent = memo(function MarkdownContent({
  children,
  className = '',
  studioReferences = [],
  studioReferenceAuthors = [],
  studioMentions = [],
  onStudioReference,
}: {
  children: string;
  className?: string;
  studioReferences?: StudioMessageReference[];
  studioReferenceAuthors?: string[];
  studioMentions?: StudioRenderedMention[];
  onStudioReference?: (messageId: string) => void;
}) {
  const annotations = useMemo(() => createStudioAnnotationPlugin(studioReferences, studioReferenceAuthors, studioMentions), [studioMentions, studioReferenceAuthors, studioReferences]);
  const components = useMemo<Components>(() => ({
    ...markdownComponents,
    a: ({ href, children: label, title, className: linkClassName }) => {
      if (href?.startsWith('#studio-message:')) {
        const messageId = decodeURIComponent(href.slice('#studio-message:'.length));
        return <a href={href} className={linkClassName} title={title} onClick={(event) => {
          event.preventDefault();
          onStudioReference?.(messageId);
        }}>{label}</a>;
      }
      if (href?.startsWith('#studio-mention:')) {
        return <span className="studio-mention-token" title={title}>{label}</span>;
      }
      if (href === '#studio-message-unavailable') {
        return <span className="studio-message-reference is-unavailable" title="原消息不可用">{label}</span>;
      }
      return <a
        href={href}
        className={linkClassName}
        rel="noreferrer"
        title="使用默认浏览器打开"
        onClick={(event) => {
          if (!href || !/^https?:/i.test(href)) return event.preventDefault();
          event.preventDefault();
          window.open(href, '_blank', 'noopener,noreferrer');
        }}
      >{label}</a>;
    },
  }), [onStudioReference]);
  return (
    <div className={`markdown-content ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[annotations]}
        components={components}
      >{children}</ReactMarkdown>
    </div>
  );
});

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function createStudioAnnotationPlugin(references: StudioMessageReference[], referenceAuthors: string[], mentions: StudioRenderedMention[]) {
  const referenceTokens = new Map(references.map((reference) => [`${reference.authorName}[${reference.seq}]`, reference]));
  const mentionTokens = new Map(mentions.map((mention) => [`@${mention.label}`, mention]));
  const knownTokens = [...referenceTokens.keys(), ...mentionTokens.keys()].sort((left, right) => right.length - left.length);
  const knownExpression = knownTokens.length ? new RegExp(knownTokens.map(escapeRegExp).join('|'), 'gu') : undefined;
  const authors = [...new Set([...referenceAuthors, ...references.map((reference) => reference.authorName)].map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  const unknownReferenceExpression = authors.length ? new RegExp(`(?:${authors.map(escapeRegExp).join('|')})\\[(\\d+)\\]`, 'gu') : undefined;

  return () => (tree: HastNode) => {
    visitText(tree, undefined, (value) => annotateText(value, referenceTokens, mentionTokens, knownExpression, unknownReferenceExpression));
  };
}

function visitText(node: HastNode, parentTag: string | undefined, replace: (value: string) => HastNode[]) {
  const tag = node.tagName ?? parentTag;
  if (!node.children || ['a', 'code', 'pre'].includes(tag ?? '')) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value) return replace(child.value);
    visitText(child, tag, replace);
    return [child];
  });
}

function annotateText(
  value: string,
  references: Map<string, StudioMessageReference>,
  mentions: Map<string, StudioRenderedMention>,
  knownExpression: RegExp | undefined,
  unknownReferenceExpression: RegExp | undefined,
) {
  const nodes: HastNode[] = [];
  let cursor = 0;
  const matches: Array<{ start: number; end: number; token: string; unavailable?: boolean }> = [];
  if (knownExpression) {
    knownExpression.lastIndex = 0;
    for (const match of value.matchAll(knownExpression)) matches.push({ start: match.index, end: match.index + match[0].length, token: match[0] });
  }
  if (unknownReferenceExpression) {
    unknownReferenceExpression.lastIndex = 0;
    for (const match of value.matchAll(unknownReferenceExpression)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!matches.some((item) => start < item.end && end > item.start)) matches.push({ start, end, token: match[0], unavailable: true });
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);
  for (const match of matches) {
    if (match.start < cursor) continue;
    if (match.start > cursor) nodes.push({ type: 'text', value: value.slice(cursor, match.start) });
    const reference = references.get(match.token);
    const mention = mentions.get(match.token);
    if (reference) nodes.push(annotationLink(match.token, `#studio-message:${encodeURIComponent(reference.messageId)}`, reference.excerpt, 'studio-message-reference'));
    else if (mention) nodes.push(annotationLink(match.token, `#studio-mention:${encodeURIComponent(mention.partnerId)}`, `已提到 ${match.token}`, 'studio-mention-token'));
    else nodes.push(annotationLink(match.token, '#studio-message-unavailable', '原消息不可用', 'studio-message-reference is-unavailable'));
    cursor = match.end;
  }
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) });
  return nodes.length ? nodes : [{ type: 'text', value }];
}

function annotationLink(label: string, href: string, title: string, className: string): HastNode {
  return { type: 'element', tagName: 'a', properties: { href, title, className: [className] }, children: [{ type: 'text', value: label }] };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
