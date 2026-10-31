import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock3, Package } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePrototype } from '../../app/PrototypeProvider';
import { Modal } from '../ui/Modal';

export function WorkspaceShortcuts({ studio = false }: { studio?: boolean }) {
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const { state } = usePrototype(); const navigate = useNavigate(), location = useLocation();
  const openSettings = (section: string) => { setPluginsOpen(false); navigate(`/settings/partners?section=${section}`, { state: { from: location.pathname } }); };
  return <>
    <button type="button" onClick={() => setPluginsOpen(true)}><Package size={18} />插件</button>
    <button type="button" onClick={() => navigate(`/settings/partners?section=automations&${studio ? `room=${encodeURIComponent(state.activeGroupChatId)}` : `conversation=${encodeURIComponent(state.activeConversationId)}`}`, { state: { from: location.pathname } })}><Clock3 size={18} />自动化</button>
    {pluginsOpen && createPortal(<Modal title="插件" description="为 API 伙伴配置 MCP 扩展服务。本地与接回伙伴沿用原有配置。" onClose={() => setPluginsOpen(false)}>
      <div className="placeholder-list"><button className="primary-button" type="button" onClick={() => openSettings('mcp')}><Package size={18} />管理 MCP</button><button className="secondary-button" type="button" onClick={() => openSettings('skills')}><Package size={18} />管理 Skills</button></div>
    </Modal>, document.body)}
  </>;
}
