import { Check } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HANDOFF_MAX_MESSAGES, HANDOFF_MAX_TEXT, type ContextHandoff } from '../../../shared/contextHandoff';
import type { Message, Partner } from '../../types/domain';
import { isAsteriumUser } from '../../../shared/identity';
import { Modal } from '../ui/Modal';

export type HandoffTarget = ContextHandoff['target'] & { partnerId: string; label: string };

export function ContextHandoffDialog({ source, targets, messages, partners, onClose, onStage }: {
  source: ContextHandoff['source'];
  targets: HandoffTarget[];
  messages: Message[];
  partners: Partner[];
  onClose(): void;
  onStage(draft: ContextHandoff): void;
}) {
  const [recent] = useState(() => messages.filter(message => message.content.trim() && !message.isStreaming && !message.automation && message.authorId !== 'system'
    && !message.error && (!message.runState || message.runState === 'completed')
    && (!message.status || message.status === 'delivered')).slice(-HANDOFF_MAX_MESSAGES));
  const [selected, setSelected] = useState(() => new Set(recent.slice(-3).map(message => message.id)));
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const focus = useRef<HTMLSelectElement>(null);
  const target = targets.find(item => item.id === targetId);
  const speaker = (id: string) => isAsteriumUser(id) ? '用户' : partners.find(partner => partner.id === id)?.publicIdentity.displayName ?? '伙伴';
  const picked = recent.filter(message => selected.has(message.id));
  const tooLong = picked.map(message => `${speaker(message.authorId)}：${message.content}`).join('\n\n').length > HANDOFF_MAX_TEXT;

  return createPortal(<Modal title={source.kind === 'single' ? '带上下文去群聊' : '带上下文去单聊'} description="选中的原话只随目标伙伴的下一轮发送。伙伴在群聊的回复可能复述这些内容。" onClose={onClose} size="md" backdrop="dim" initialFocusRef={focus}>
    <div className="modal-body">
      <label className="modal-field">接收聊天与伙伴<select ref={focus} value={targetId} onChange={event => setTargetId(event.target.value)}>
        {targets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      {recent.length > 0 && <div className="context-handoff-selection">
        <span role="status">已选 {picked.length} / {recent.length} 条</span>
        <button type="button" className="text-button" disabled={!picked.length} onClick={() => setSelected(new Set())}>清空选择</button>
      </div>}
      <div className="context-handoff-sources" role="group" aria-label="选择原话">
        {recent.map(message => <button type="button" role="checkbox" aria-checked={selected.has(message.id)} key={message.id} onClick={() => {
          setSelected(current => {
            const next = new Set(current);
            if (next.has(message.id)) next.delete(message.id); else next.add(message.id);
            return next;
          });
        }}>
          <span className="context-handoff-check" aria-hidden="true">{selected.has(message.id) && <Check size={12} />}</span>
          <span><strong>{speaker(message.authorId)}</strong><span>{message.content}</span></span>
        </button>)}
      </div>
      {recent.length === 0 && <p>这段聊天暂无可交接的已完成文本消息。</p>}
      {tooLong && <p className="form-error" role="alert">选中的原话超过 {HANDOFF_MAX_TEXT} 字符，请减少勾选。</p>}
    </div>
    <footer className="modal-footer">
      <button type="button" className="secondary-button" onClick={onClose}>取消</button>
      <button type="button" className="primary-button" disabled={!target || !picked.length || tooLong} onClick={() => {
        if (target) onStage({ id: crypto.randomUUID(), source, target: { kind: target.kind, id: target.id }, partnerId: target.partnerId, messageIds: picked.map(message => message.id) });
      }}>带过去（{picked.length} 条）</button>
    </footer>
  </Modal>, document.body);
}

export function ContextHandoffDraftCard({ draft, partnerName, onRemove, disabled }: {
  draft: ContextHandoff;
  partnerName: string;
  onRemove(): void;
  disabled?: boolean;
}) {
  return <div className="context-handoff-draft">
    <span>下次发送时交接给 {partnerName} · {draft.messageIds.length} 条原话</span>
    <button className="text-button" type="button" disabled={disabled} onClick={onRemove}>移除交接</button>
  </div>;
}
