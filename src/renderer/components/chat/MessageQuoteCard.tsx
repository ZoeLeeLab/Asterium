import { ChevronDown, Quote, X } from 'lucide-react';
import { useState } from 'react';
import type { MessageQuote } from '../../types/domain';

interface MessageQuoteCardProps {
  quote: MessageQuote;
  removable?: boolean;
  onRemove?: () => void;
  className?: string;
}

export function MessageQuoteCard({ quote, removable = false, onRemove, className = '' }: MessageQuoteCardProps) {
  const [expanded, setExpanded] = useState(false);
  const label = quote.kind === 'full' ? '完整回复' : '选中片段';
  return <section className={`message-quote-card ${expanded ? 'is-expanded' : ''} ${className}`.trim()} aria-label={`引用 ${quote.sourcePartnerName} 的${label}`}>
    <button className="message-quote-card__content" type="button" aria-expanded={expanded} aria-label={expanded ? '收起引用' : '展开引用'} onClick={() => setExpanded((value) => !value)} title={expanded ? '收起引用' : '展开引用'}>
      <Quote size={14} />
      <span><small>{quote.sourcePartnerName} · {label}</small><strong>{quote.text}</strong></span>
      <ChevronDown size={13} />
    </button>
    {removable && <button className="message-quote-card__remove" type="button" onClick={onRemove} aria-label="移除引用" title="移除引用"><X size={13} /></button>}
  </section>;
}
