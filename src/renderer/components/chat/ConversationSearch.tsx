import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';

const BODY_SELECTOR = '.message-content--user, .assistant-quote-source > .markdown-content';
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, pre, td, th, dt, dd';
const ALL_HIGHLIGHTS = 'asterium-conversation-search';
const ACTIVE_HIGHLIGHTS = 'asterium-conversation-search-current';

interface MessageMatch {
  message: HTMLElement;
  ranges: Range[];
}

function findMatches(root: HTMLElement, query: string): MessageMatch[] {
  const pattern = new RegExp(query.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'), 'giu');
  const messages = new Map<HTMLElement, Range[]>();
  for (const body of root.querySelectorAll<HTMLElement>(BODY_SELECTOR)) {
    const message = body.closest<HTMLElement>('.message-row');
    if (!message) continue;

    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node instanceof Text) return node.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        if (!(node instanceof Element)) return NodeFilter.FILTER_SKIP;
        if (node.matches('svg, button, figcaption, [aria-hidden="true"], .mermaid-diagram__status')) return NodeFilter.FILTER_REJECT;
        return node.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const fragments: { node: Text; start: number }[] = [];
    let text = '';
    let previousBlock: Element | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node instanceof Text)) {
        text += '\n';
        continue;
      }
      const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? body;
      if (previousBlock && block !== previousBlock) text += '\n';
      previousBlock = block;
      fragments.push({ node, start: text.length });
      text += node.data;
    }

    let fragmentIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      while (fragmentIndex + 1 < fragments.length && fragments[fragmentIndex + 1].start <= match.index) fragmentIndex++;
      const first = fragments[fragmentIndex];
      while (fragmentIndex + 1 < fragments.length && fragments[fragmentIndex + 1].start < end) fragmentIndex++;
      const last = fragments[fragmentIndex];
      const range = document.createRange();
      range.setStart(first.node, match.index - first.start);
      range.setEnd(last.node, end - last.start);
      const ranges = messages.get(message);
      if (ranges) ranges.push(range);
      else messages.set(message, [range]);
    }
  }
  return Array.from(messages, ([message, ranges]) => ({ message, ranges }));
}

type SearchHistory = (query: string, after?: string) => Promise<{ messageIds: string[]; hasMore: boolean; nextCursor?: string; native?: boolean }>;
type RevealMessage = (messageId: string) => Promise<boolean>;

export function ConversationSearch({ listRef, onNavigate, onClose, searchIndexed: search, onReveal: reveal }: {
  listRef: RefObject<HTMLDivElement | null>;
  onNavigate: () => void;
  onClose: () => void;
  searchIndexed?: SearchHistory;
  onReveal?: RevealMessage;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<MessageMatch[]>();
  const [selection, setSelection] = useState(0);
  const [composing, setComposing] = useState(false);
  const [indexed, setIndexed] = useState<{ term: string; native?: boolean; ids: string[]; more: boolean; cursor?: string; failed?: boolean }>();
  const moreRequest = useRef(0);
  const [morePending, setMorePending] = useState(false);
  const [revealFailedId, setRevealFailedId] = useState('');
  const term = composing ? '' : query.trim();
  const result = indexed?.term === term ? indexed : undefined;
  const local = new Map((matches ?? []).map(match => [match.message.id.replace(/^chat-message-/, ''), match]));
  const includeRenderedMatches = !result?.native;
  const ids = [...new Set([...(result?.ids ?? []), ...(includeRenderedMatches ? local.keys() : [])])];
  const matchCount = ids.length;
  const index = matchCount ? selection % matchCount : 0;
  const activeId = search && !result ? undefined : ids[index];
  const active = activeId ? local.get(activeId) : undefined;
  const requestedId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!search || !term) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void search(term).then(response => {
        if (live) setIndexed({ term, native: response.native, ids: response.messageIds, more: response.hasMore, cursor: response.nextCursor });
      }).catch(() => { if (live) setIndexed({ term, ids: [], more: false, failed: true }); });
    }, 100);
    return () => { live = false; window.clearTimeout(timer); };
  }, [search, term]);

  const loadMore = () => {
    const after = result?.cursor ?? result?.ids.at(-1);
    if (!search || !result || !after || morePending) return;
    const version = ++moreRequest.current;
    setMorePending(true);
    void search(term, after).then(response => {
      if (version !== moreRequest.current) return;
      const nextIds = [...new Set([...result.ids, ...response.messageIds])];
      setIndexed(current => current === result
        ? { term, native: result.native, ids: nextIds, more: response.hasMore, cursor: response.nextCursor } : current);
      if (nextIds.length > result.ids.length) setSelection(result.ids.length);
    }).catch(() => {
      if (version === moreRequest.current) setIndexed(current => current === result ? { ...result, failed: true } : current);
    }).finally(() => { if (version === moreRequest.current) setMorePending(false); });
  };

  useEffect(() => {
    if (active) requestedId.current = activeId;
    if (!activeId || active || !reveal || requestedId.current === activeId) return;
    requestedId.current = activeId;
    setRevealFailedId('');
    void reveal(activeId).then(found => {
      if (!found && requestedId.current === activeId) setRevealFailedId(activeId);
    });
  }, [active, activeId, reveal]);

  useEffect(() => {
    const root = listRef.current;
    if (!root || !term) return;
    let frame: number | undefined;
    const refresh = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        setMatches(findMatches(root, term));
      });
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [listRef, term]);

  useEffect(() => {
    if (!matches?.length) return;
    const registry = globalThis.CSS?.highlights;
    if (!registry || typeof Highlight === 'undefined') return;
    const others = new Highlight();
    for (const match of matches) {
      if (match !== active) for (const range of match.ranges) others.add(range);
    }
    const current = new Highlight();
    for (const range of active?.ranges ?? []) current.add(range);
    registry.set(ALL_HIGHLIGHTS, others);
    registry.set(ACTIVE_HIGHLIGHTS, current);
    return () => {
      registry.delete(ALL_HIGHLIGHTS);
      registry.delete(ACTIVE_HIGHLIGHTS);
    };
  }, [active, matches]);

  const lastScrolledMessage = useRef<HTMLElement | undefined>(undefined);
  useEffect(() => {
    const list = listRef.current;
    if (!list || !active) {
      lastScrolledMessage.current = undefined;
      return;
    }
    const { message, ranges } = active;
    if (message !== lastScrolledMessage.current) {
      lastScrolledMessage.current = message;
      onNavigate();
      const hit = ranges[0].getBoundingClientRect?.();
      if (hit?.height) {
        const listRect = list.getBoundingClientRect();
        list.scrollTop += hit.top - listRect.top - (list.clientHeight - hit.height) / 2;
      } else {
        message.scrollIntoView?.({ block: 'center' });
      }
    }
  }, [active, listRef, onNavigate]);

  const move = (direction: number) => {
    if (morePending || !matchCount) return;
    if (direction > 0 && index === matchCount - 1 && result?.more) {
      loadMore();
      return;
    }
    setSelection((current) => (current + direction + matchCount) % matchCount);
  };

  return <div id="conversation-search" className="conversation-search" role="search" aria-label="当前对话搜索" onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Enter' && event.target === inputRef.current) {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    }
  }}>
    <Search size={15} aria-hidden="true" />
    <input ref={inputRef} type="search" autoFocus aria-label="搜索当前对话正文" placeholder="搜索当前对话" value={query}
      maxLength={512} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onChange={(event) => {
      const value = event.target.value;
      if (value.trim() !== term) {
        setMatches(undefined);
        setIndexed(undefined);
        moreRequest.current++;
        setMorePending(false);
        requestedId.current = undefined;
        setRevealFailedId('');
        setSelection(0);
      }
      setQuery(value);
    }} />
    <span role="status" className="conversation-search__count">{term && (
      search && (!result || morePending) ? '查找中…' : activeId && revealFailedId === activeId ? '无法跳转'
        : matchCount ? (index + 1) + ' / ' + matchCount + (result?.more ? '+' : '')
          : result?.failed ? '历史搜索暂不可用' : matches || result ? '无匹配' : '查找中…'
    )}</span>
    <button className="icon-button" type="button" disabled={matchCount < 2} onClick={() => move(-1)} aria-label="上一条匹配" title="上一条匹配"><ChevronUp size={16} /></button>
    <button className="icon-button" type="button" disabled={morePending || (matchCount < 2 && !result?.more)} onClick={() => move(1)} aria-label="下一条匹配" title="下一条匹配"><ChevronDown size={16} /></button>
    <button className="icon-button" type="button" onClick={onClose} aria-label="关闭当前对话搜索" title="关闭（Esc）"><X size={16} /></button>
  </div>;
}
