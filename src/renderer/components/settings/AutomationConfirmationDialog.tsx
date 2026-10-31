import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarClock, Clock3, MessageCircle, ShieldCheck, Trash2 } from 'lucide-react';
import type { AutomationConfirmation, AutomationSchedule } from '../../../shared/automations';
import { Modal } from '../ui/Modal';

export function AutomationConfirmationHost() {
  const [pending, setPending] = useState<AutomationConfirmation[]>([]);
  useEffect(() => {
    const api = window.asteriumAutomations; if (!api?.confirmations) return;
    let live = true, revision = 0;
    const refresh = () => { const current = ++revision; void api.confirmations().then(items => { if (live && current === revision) setPending(items); }).catch(() => { if (live && current === revision) setPending([]); }); };
    const off = api.onConfirmationsChanged(refresh); refresh();
    return () => { live = false; off(); };
  }, []);
  const proposal = pending[0];
  return proposal ? createPortal(<Confirmation key={proposal.id} proposal={proposal} more={pending.length - 1} />, document.body) : null;
}
function Confirmation({ proposal, more }: { proposal: AutomationConfirmation; more: number }) {
  const { task } = proposal, deleting = proposal.action === 'remove';
  const cancelRef = useRef<HTMLButtonElement>(null), locked = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function decide(approved: boolean) {
    if (locked.current) return; locked.current = true; setBusy(true); setError('');
    try { await window.asteriumAutomations!.resolveConfirmation({ id: proposal.id, approved }); }
    catch { setError('确认未完成，请重试。若任务已取消，此请求会自动关闭。'); }
    finally { locked.current = false; setBusy(false); }
  }
  return <Modal size="md" title={deleting ? '删除这项自动化？' : proposal.action === 'create' ? '保存这项自动化？' : '更新这项自动化？'} description={`${proposal.partnerName} 提出了${deleting ? '删除' : proposal.action === 'create' ? '新任务' : '变更'}，请核对后确认。`} initialFocusRef={cancelRef} onClose={() => { if (!busy) void decide(false); }}>
    <div className="automation-confirm-body modal-body">
      <div className="automation-confirm-heading"><span><CalendarClock size={23} /></span><div><h3>{task.name}</h3><small>{deleting ? '删除后停止后续计划' : task.enabled ? '保存后启用' : '保持暂停'}{more > 0 ? ` · 另有 ${more} 项待确认` : ''}</small></div></div>
      <dl className="automation-confirm-details"><div><dt><Clock3 size={15} />执行时间</dt><dd>{scheduleLabel(task.schedule, task.timezone)}<small>{task.timezone}</small></dd></div><div><dt><MessageCircle size={15} />结果位置</dt><dd>{proposal.targetLabel}<small>沿用原对话与原线程</small></dd></div></dl>
      <section className="automation-confirm-task"><h4>任务内容</h4><p>{task.instructions}</p></section>
      {!deleting && <p className="automation-confirm-catchup">{task.catchUp === 'skip' ? '错过时跳过' : task.schedule.type === 'once' ? '错过后下次打开补执行一次' : task.schedule.type === 'interval' ? '错过多轮时合并最近一轮' : '错过后当天补执行一次'} · {task.notifications === 'always' ? '每次通知' : '仅变化或失败时通知'}</p>}
      <div className="modal-warning"><ShieldCheck size={19} /><span><strong>这一步确认未来的执行安排</strong><small>当前发起权限需要确认计划变更；完整权限下由伙伴直接保存。执行时沿用原会话权限与保护规则。</small></span></div>
      {deleting && <p className="automation-confirm-catchup">删除会取消后续计划和未启动的排队，不会停止已经开始的运行。</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
    <footer className="modal-footer"><button ref={cancelRef} className="secondary-button" type="button" disabled={busy} onClick={() => void decide(false)}>取消</button><button className={deleting ? 'danger-button' : 'primary-button'} type="button" disabled={busy} onClick={() => void decide(true)}>{deleting && <Trash2 size={15} />}{busy ? '处理中…' : deleting ? '确认删除' : '确认保存'}</button></footer>
  </Modal>;
}
function scheduleLabel(schedule: AutomationSchedule, timezone: string) {
  if (schedule.type === 'once') return new Date(schedule.at).toLocaleString('zh-CN', { timeZone: timezone, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (schedule.type === 'daily') return `每天 ${schedule.time}`;
  if (schedule.type === 'weekly') return `每周${schedule.weekdays.map(n => '日一二三四五六'[n]).join('、')} ${schedule.time}`;
  return `每 ${schedule.minutes} 分钟`;
}
