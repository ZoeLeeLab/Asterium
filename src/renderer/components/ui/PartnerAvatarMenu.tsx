import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brain, Pencil } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePrototype } from '../../app/PrototypeProvider';
import { PARTNER_SETTINGS_NAVIGATION, type PartnerSettingsNavigation } from '../../app/partnerSettingsNavigation';

/** A single delegated menu for explicitly identified partner avatars, never user/project avatars. */
export function PartnerAvatarMenu() {
  const { state } = usePrototype();
  const navigate = useNavigate(); const location = useLocation();
  const [menu, setMenu] = useState<{ partnerId: string; x: number; y: number; trigger: HTMLElement }>();
  const menuRef = useRef<HTMLDivElement>(null);
  const partner = state.partners.find((item) => item.id === menu?.partnerId);
  useEffect(() => {
    const open = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      const trigger = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-partner-id]') : null;
      if (!trigger || !state.partners.some((item) => item.id === trigger.dataset.partnerId)) { if (event.type === 'contextmenu') setMenu(undefined); return; }
      event.preventDefault(); event.stopPropagation();
      const rect = trigger.getBoundingClientRect();
      const pointer = event instanceof MouseEvent && (event.clientX || event.clientY);
      setMenu({ partnerId: trigger.dataset.partnerId!, x: pointer ? event.clientX : rect.left, y: pointer ? event.clientY : rect.bottom, trigger });
    };
    document.addEventListener('contextmenu', open, true); document.addEventListener('keydown', open, true);
    return () => { document.removeEventListener('contextmenu', open, true); document.removeEventListener('keydown', open, true); };
  }, [state.partners]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenu(undefined); menu.trigger.focus(); }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...menuRef.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length].focus();
    };
    const close = () => setMenu(undefined);
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', keyboard);
    window.addEventListener('resize', close); window.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', keyboard); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [menu]);
  if (!menu || !partner) return null;
  const go = (section: 'partners' | 'memory') => {
    const from = location.pathname.startsWith('/settings/') ? (location.state as { from?: string } | null)?.from ?? '/chat' : `${location.pathname}${location.search}`;
    const detail: PartnerSettingsNavigation = { target: `/settings/partners?section=${section}&partner=${encodeURIComponent(partner.id)}`, from };
    const event = new CustomEvent(PARTNER_SETTINGS_NAVIGATION, { detail, cancelable: true });
    window.dispatchEvent(event); setMenu(undefined);
    if (!event.defaultPrevented) navigate(detail.target, { state: { from } });
  };
  const memoryAvailable = partner.sourceMode !== 'existing_thread' && partner.profileManagement?.memoryMode === 'asterium' && !partner.managedDataDeletedAt;
  return createPortal(<div ref={menuRef} className="artifact-context-menu partner-avatar-menu" role="menu" aria-label={`${partner.publicIdentity.displayName}的快捷菜单`} style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 212)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 100)) }}>
    <button role="menuitem" type="button" disabled={partner.isRemoved} onClick={() => go('partners')}><Pencil size={15} />编辑伙伴</button>
    <button role="menuitem" type="button" disabled={!memoryAvailable} title={memoryAvailable ? undefined : '此伙伴未启用星丛记忆托管'} onClick={() => go('memory')}><Brain size={15} />记忆管理</button>
  </div>, document.body);
}
