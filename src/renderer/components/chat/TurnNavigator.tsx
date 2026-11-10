import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Message } from '../../types/domain';

interface TurnNavigatorProps {
  turns: Message[];
  messageListRef: RefObject<HTMLDivElement | null>;
  streaming: boolean;
  turnOffset?: number;
  onJump: () => void;
}

export function TurnNavigator({ turns, messageListRef, streaming, turnOffset = 0, onJump }: TurnNavigatorProps) {
  const viewportRef = useRef<HTMLElement>(null);
  const latestTurnId = turns.at(-1)?.id;
  const firstTurnId = turns[0]?.id;
  const [activeTurnId, setActiveTurnId] = useState(latestTurnId);
  const [focusTurnId, setFocusTurnId] = useState<string>();
  const [preview, setPreview] = useState<{ text: string; y: number }>();
  const currentTurnId = turns.some(turn => turn.id === activeTurnId) ? activeTurnId : latestTurnId;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const button = viewport?.querySelector<HTMLButtonElement>('[aria-current="true"]');
    if (!viewport || !button) return;
    const top = button.offsetTop;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + button.offsetHeight > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = top + button.offsetHeight - viewport.clientHeight;
    }
  }, [currentTurnId, firstTurnId]);

  useEffect(() => {
    const root = messageListRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<HTMLElement>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.3 && target.parentElement === root) visible.add(target);
        else visible.delete(target);
      }
      const rootTop = root.getBoundingClientRect().top;
      let closest: HTMLElement | undefined;
      let distance = Infinity;
      for (const element of visible) {
        const offset = Math.abs(element.getBoundingClientRect().top - rootTop);
        if (offset < distance) {
          closest = element;
          distance = offset;
        }
      }
      if (closest?.dataset.turnId) setActiveTurnId(closest.dataset.turnId);
    }, { root, threshold: 0.3 });
    const isTurn = (node: Node): node is HTMLElement => node instanceof HTMLElement && Boolean(node.dataset.turnId);
    for (const child of root.children) if (isTurn(child)) observer.observe(child);
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) if (isTurn(node)) {
          visible.delete(node);
          observer.unobserve(node);
        }
        for (const node of record.addedNodes) if (isTurn(node)) observer.observe(node);
      }
    });
    mutations.observe(root, { childList: true });
    return () => {
      mutations.disconnect();
      observer.disconnect();
    };
  }, [messageListRef]);

  const showPreview = (button: HTMLButtonElement, text: string) => {
    const wrapper = viewportRef.current?.parentElement;
    if (!wrapper) return;
    const rect = button.getBoundingClientRect();
    setPreview({ text, y: rect.top - wrapper.getBoundingClientRect().top + rect.height / 2 });
  };

  return <div className="turn-navigator">
    <nav
      className="turn-navigator__viewport"
      aria-label="快速选择对话回合"
      ref={viewportRef}
      onScroll={() => setPreview(undefined)}
      onPointerLeave={() => setPreview(undefined)}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setFocusTurnId(undefined);
        setPreview(undefined);
      }}
      onKeyDown={(event) => {
        if (!(event.target instanceof HTMLButtonElement)) return;
        const next = event.key === 'ArrowDown' ? event.target.nextElementSibling
          : event.key === 'ArrowUp' ? event.target.previousElementSibling
          : event.key === 'Home' ? event.currentTarget.firstElementChild
          : event.key === 'End' ? event.currentTarget.lastElementChild
          : null;
        if (next instanceof HTMLButtonElement) {
          event.preventDefault();
          next.focus();
        }
      }}
    >
      {turns.map((turn, index) => {
        const summary = turn.content.trim().slice(0, 48);
        const label = `第 ${turnOffset + index + 1} 轮${summary ? `：${summary}` : ''}`;
        return <button
          key={turn.id}
          type="button"
          aria-current={currentTurnId === turn.id ? true : undefined}
          aria-label={label}
          tabIndex={(focusTurnId ?? currentTurnId) === turn.id ? 0 : -1}
          onPointerEnter={(event) => showPreview(event.currentTarget, label)}
          onFocus={(event) => {
            setFocusTurnId(turn.id);
            showPreview(event.currentTarget, label);
          }}
          onClick={() => {
            const target = document.getElementById(`chat-message-${turn.id}`);
            if (!target || !messageListRef.current?.contains(target)) return;
            onJump();
            setActiveTurnId(turn.id);
            // During a reply, jump before the next streamed update can pull the view back down.
            const smooth = !streaming && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            target.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'start' });
          }}
        />;
      })}
    </nav>
    {preview && <div className="turn-navigator__preview" style={{ top: preview.y }} aria-hidden="true">{preview.text}</div>}
  </div>;
}
