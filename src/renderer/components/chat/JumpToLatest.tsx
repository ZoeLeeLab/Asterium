import { ArrowDown } from 'lucide-react';
import { useEffect, useState, type RefObject } from 'react';

interface JumpToLatestProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  streaming: boolean;
  hasNewerMessages?: boolean;
  partnerName?: string;
  onJump: () => void;
}

/** Observe the actual message viewport, including late image/code layout changes. */
export function JumpToLatest({ scrollRef, streaming, hasNewerMessages, partnerName, onJump }: JumpToLatestProps) {
  const [away, setAway] = useState(false);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      setAway(root.scrollHeight - root.clientHeight - root.scrollTop > 88);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    const observed = new Set<Element>();
    const observeChildren = () => {
      for (const child of observed) {
        if (child.parentElement === root) continue;
        resize?.unobserve(child);
        observed.delete(child);
      }
      for (const child of root.children) {
        if (observed.has(child)) continue;
        observed.add(child);
        resize?.observe(child);
      }
    };
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'childList' && record.target === root)) observeChildren();
      schedule();
    });
    root.addEventListener('scroll', measure, { passive: true });
    resize?.observe(root);
    observeChildren();
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    schedule();
    return () => {
      root.removeEventListener('scroll', measure);
      cancelAnimationFrame(frame);
      resize?.disconnect();
      mutations.disconnect();
    };
  }, [scrollRef]);

  if (!away && !hasNewerMessages) return null;
  return <div className="jump-to-latest" data-state={streaming ? 'streaming' : 'idle'}>
    <button type="button" aria-label={streaming ? '回到底部（' + (partnerName ?? '伙伴') + '正在回复）' : '回到底部'} onClick={() => {
      const root = scrollRef.current;
      if (!root) return;
      onJump();
      root.scrollTop = root.scrollHeight;
      setAway(false);
    }}>
      {streaming && <span className="jump-to-latest__dot" aria-hidden="true" />}
      <span>{streaming ? (partnerName ?? '') + '正在回复 · 回到底部' : '回到底部'}</span>
      <ArrowDown className="jump-to-latest__arrow" size={15} aria-hidden="true" />
    </button>
  </div>;
}
