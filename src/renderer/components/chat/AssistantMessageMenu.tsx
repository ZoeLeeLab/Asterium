import { Copy, ExternalLink, Quote } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isLocalArtifactLink } from '../../../shared/artifactLinks';

export interface AssistantTextContext {
  text: string;
  selection: boolean;
  href?: string;
  x: number;
  y: number;
}

export function AssistantMessageMenu({ context, onQuote, onOpenLocalLink, onClose }: {
  context: AssistantTextContext;
  onQuote?: () => void;
  onOpenLocalLink: (href: string) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const localLink = Boolean(context.href && isLocalArtifactLink(context.href));
  const canOpen = localLink || /^https?:/i.test(context.href ?? '');

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [context]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onClose();
    } catch {
      setCopyFailed(true);
    }
  };

  return <div ref={menu} className="artifact-context-menu" role="menu" aria-label="回复内容操作"
    style={{ left: Math.max(8, Math.min(context.x, window.innerWidth - 210)), top: Math.max(8, Math.min(context.y, window.innerHeight - 200)) }}
    onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
    <button type="button" role="menuitem" onClick={() => void copy(context.text)}><Copy size={14} />{context.selection ? '复制选中内容' : '复制回复'}</button>
    {onQuote && <button type="button" role="menuitem" onClick={onQuote}><Quote size={14} />{context.selection ? '引用选中内容' : '引用回复'}</button>}
    {context.href && <button type="button" role="menuitem" onClick={() => void copy(context.href!)}><Copy size={14} />复制链接地址</button>}
    {canOpen && <button type="button" role="menuitem" onClick={() => {
      if (localLink) onOpenLocalLink(context.href!);
      else window.open(context.href, '_blank', 'noopener,noreferrer');
      onClose();
    }}><ExternalLink size={14} />{localLink ? '查看交付文件' : '用默认浏览器打开'}</button>}
    {copyFailed && <small role="alert">复制失败，请重试。</small>}
  </div>;
}
