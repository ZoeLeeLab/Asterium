import { Clock3, Menu, MessageCircleMore, Moon, Search, Sun, UsersRound } from 'lucide-react';
import { WindowRailControls, type RailControls } from './WindowRailControls';
import type { RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePrototype } from '../../app/PrototypeProvider';
import { readLastStudioRoute } from '../../app/navigationPersistence';
import { AsteriumLogo } from '../ui/AsteriumLogo';

export function Brand() {
  const navigate = useNavigate();
  const currentLocation = useLocation();

  return (
    <div className="brand-block">
      <div className="brand-row">
        <AsteriumLogo />
        <div className="brand-copy"><strong>Asterium</strong><span>Your AI Companions</span></div>
        <button
          className="icon-button"
          type="button"
          onClick={() => navigate('/settings', { state: { from: currentLocation.pathname } })}
          aria-label="进入设置"
          title="设置"
        >
          <Menu size={21} />
        </button>
      </div>
    </div>
  );
}

export function MainHeader({ rails, conversationSearch }: {
  rails?: RailControls;
  conversationSearch?: { open: boolean; onToggle: () => void; triggerRef: RefObject<HTMLButtonElement | null> };
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, theme, toggleTheme } = usePrototype();
  const studio = location.pathname.startsWith('/studio');

  return (
    <header className={`main-header${rails ? ' main-header--rails' : ''}`}>
      {rails && <WindowRailControls rails={rails} />}
      <nav className="mode-switch" aria-label="主要页面">
        <button className={!studio ? 'active' : ''} type="button" onClick={() => navigate('/chat')}>
          <MessageCircleMore size={19} />单聊
        </button>
        <button className={studio ? 'active' : ''} type="button" onClick={() => navigate(readLastStudioRoute())}>
          <UsersRound size={19} />工作室
        </button>
      </nav>
      <div className="header-actions"><button className="icon-button icon-button--large" type="button" aria-label="自动化" title="自动化" onClick={() => navigate(`/settings/partners?section=automations&${studio ? `room=${encodeURIComponent(state.activeGroupChatId)}` : `conversation=${encodeURIComponent(state.activeConversationId)}`}`, { state: { from: location.pathname } })}><Clock3 size={20} /></button>
        <button ref={conversationSearch?.triggerRef} className="icon-button icon-button--large" type="button"
          disabled={!conversationSearch} title={conversationSearch ? '搜索当前对话' : '请在单聊中搜索当前对话'}
          aria-label="搜索当前对话" aria-expanded={conversationSearch?.open} aria-controls={conversationSearch?.open ? 'conversation-search' : undefined}
          onClick={conversationSearch?.onToggle}>
          <Search size={22} />
        </button>
        <button className="icon-button icon-button--large" type="button" onClick={toggleTheme} title={`切换到${theme === 'light' ? '深色' : '浅色'}模式`}>
          {theme === 'light' ? <Sun size={22} /> : <Moon size={22} />}
          <span className="sr-only">切换主题</span>
        </button>
      </div>
    </header>
  );
}
