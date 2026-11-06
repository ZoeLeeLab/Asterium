import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

interface ModalProps {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg';
  backdrop?: 'blur' | 'dim';
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function Modal({ title, description, children, onClose, size = 'sm', backdrop = 'blur', initialFocusRef }: ModalProps) {
  const titleId = useId(), sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!initialFocusRef) return;
    const previous = document.activeElement as HTMLElement | null;
    initialFocusRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [initialFocusRef]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className={`modal-backdrop${backdrop === 'dim' ? ' modal-backdrop--dim' : ''}`} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={sectionRef} className={`modal-card modal-card--${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
        if (!initialFocusRef) return;
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key === 'Tab') {
          const focusable = [...(sectionRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])];
          const first = focusable[0], last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
        <header>
          <div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        {children}
      </section>
    </div>
  );
}
