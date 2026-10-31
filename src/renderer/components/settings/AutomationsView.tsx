import { useEffect, useRef, useState } from 'react';
import { Clock3, Plus, ArrowLeft, Trash2, CircleAlert } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Modal } from '../ui/Modal';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePrototype } from '../../app/PrototypeProvider';
import { automationWallTime } from '../../../shared/automationTime';
import type { Automation, AutomationInput, AutomationMutation, AutomationRun, AutomationView } from '../../../shared/automations';
import { automationInputSchema, automationTargetKey } from '../../../shared/automations';

const states: Record<AutomationRun['state'], string> = { queued: '排队中', starting: '正在启动', running: '运行中', waiting_approval: '等待审批', succeeded: '已完成', failed: '失败', cancelled: '已取消', skipped: '已跳过', uncertain: '结果待确认' };
const templates = [
  { name: '自定义', title: '', prompt: '' },
  { name: '项目日报', title: '整理项目日报', prompt: '检查当前已授权项目的进展，整理本次变化、完成事项和待办；列出需要我决定的问题，汇报依据。不修改项目文件。' },
  { name: '文件整理', title: '整理文件夹', prompt: '整理以下已授权目录：【填写目录】。整理规则：【填写分类及命名规则】。保留文件内容，沿用现有审批；汇报实际移动或修改的文件。信息不足时先提问。' },
  { name: '条件巡检', title: '定时检查变化', prompt: '检查以下内容：【填写检查目标和变化条件】。与上次已确认的检查结果比较，报告变化及依据。无法核实就明确说明未知，不把未知视为没有变化。' },
];
const describe = (d: Automation) => d.schedule.type === 'once' ? `一次 · ${new Date(d.schedule.at).toLocaleString('zh-CN')}` : d.schedule.type === 'interval' ? `每 ${d.schedule.minutes} 分钟` : `${d.schedule.type === 'daily' ? '每天' : `每周 ${d.schedule.weekdays.map(n => '日一二三四五六'[n]).join('、')}`} ${d.schedule.time}`;
export function AutomationsView() {
  const location = useLocation(), navigate = useNavigate();
  const { selectConversation, selectProject, selectGroupChat } = usePrototype();
  const createRequest = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const [view, setView] = useState<AutomationView>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Automation | 'new' | null>(null), [selected, setSelected] = useState<string>('');
  const requestedAutomation = new URLSearchParams(location.search).get('automation');
  const notificationSelection = view ? requestedAutomation && view.automations.some(d => d.id === requestedAutomation && !d.deletedAt) ? requestedAutomation : '' : undefined;
  useEffect(() => {
    if (!requestedAutomation || notificationSelection === undefined) return;
    const frame = requestAnimationFrame(() => setSelected(notificationSelection));
    return () => cancelAnimationFrame(frame);
  }, [requestedAutomation, notificationSelection]);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [runNowNotice, setRunNowNotice] = useState('');
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const [form, setForm] = useState({ name: '', instructions: '', target: '', type: 'daily', time: '10:00', once: '', interval: 60, weekdays: [1, 2, 3, 4, 5], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, catchUp: 'same_day', notifications: 'always' });
  useEffect(() => {
    let live = true;
    const refresh = () => { void window.asteriumAutomations?.get().then(data => { if (live) setView(data); }).catch(() => { if (live) setError('自动化读取失败，请重试。'); }); };
    refresh(); const unsubscribe = window.asteriumAutomations?.onChanged(refresh);
    return () => { live = false; unsubscribe?.(); };
  }, []);
  function begin(d?: Automation) {
    const params = new URLSearchParams(location.search), preferred = view?.targets.findIndex(t => params.get('room') ? t.target.roomId === params.get('room') : t.target.conversationId === params.get('conversation')) ?? -1;
    const index = d ? view?.targets.findIndex(t => automationTargetKey(t.target) === automationTargetKey(d.target)) ?? -1 : preferred >= 0 ? preferred : 0;
    setForm({ name: d?.name ?? '', instructions: d?.instructions ?? '', target: view?.targets[index] ? automationTargetKey(view.targets[index].target) : 'null', type: d?.schedule.type ?? 'daily',
      time: d?.schedule.type === 'daily' || d?.schedule.type === 'weekly' ? d.schedule.time : '10:00',
      once: d?.schedule.type === 'once' ? localInput(d.schedule.at, d.timezone) : '', interval: d?.schedule.type === 'interval' ? d.schedule.minutes : 60,
      weekdays: d?.schedule.type === 'weekly' ? d.schedule.weekdays : [1, 2, 3, 4, 5], timezone: d?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      catchUp: d?.catchUp ?? 'same_day', notifications: d?.notifications ?? 'always' });
    setError(''); setEditing(d ?? 'new');
  }
  async function mutate(request: AutomationMutation) {
    if (!window.asteriumAutomations) return;
    setBusy(true); setError(''); setRunNowNotice(request.action === 'run_now' ? '伙伴正在安排本次执行…' : '');
    try { setView(await window.asteriumAutomations.mutate(request)); if (request.action === 'run_now') setRunNowNotice('伙伴把任务排进队列了'); return true; }
    catch (e) { setError(`操作未完成：${e instanceof Error ? e.message : '请重试'}`); if (request.action === 'run_now') setRunNowNotice('伙伴没能安排本次执行'); return false; }
    finally { setBusy(false); }
  }
  async function save() {
    const target = view?.targets.find(t => automationTargetKey(t.target) === form.target)?.target; if (!target) { setError('请先与伙伴完成一次对话，建立原线程，再选择目标。'); return; }
    try {
      const schedule = form.type === 'once' ? { type: 'once', at: new Date(automationWallTime(form.once.slice(0, 10), form.once.slice(11, 16), form.timezone) ?? NaN).toISOString() } : form.type === 'interval' ? { type: 'interval', minutes: form.interval } : form.type === 'weekly' ? { type: 'weekly', time: form.time, weekdays: form.weekdays } : { type: 'daily', time: form.time };
      const input = automationInputSchema.parse({ target, schedule, enabled: editing !== 'new' && editing ? editing.enabled : true,
        name: form.name, instructions: form.instructions, timezone: form.timezone, catchUp: form.catchUp, notifications: form.notifications,
        // Form-only fields must not reach the strict public schema.
      } as unknown);
      const fingerprint = JSON.stringify(input);
      if (createRequest.current?.fingerprint !== fingerprint) createRequest.current = { fingerprint, id: crypto.randomUUID() };
      if (await mutate(editing === 'new' ? { action: 'create', input, requestId: createRequest.current.id } : { action: 'update', id: editing!.id, revision: editing!.revision, input })) setEditing(null);
    } catch { setError('请填写名称、任务内容、有效时间和时区；每周至少选择一天。'); }
  }
  const definitions = view?.automations.filter(d => !d.deletedAt) ?? [];
  const runs = (view?.runs ?? []).filter(r => !selected || r.automationId === selected).slice().reverse();
  return <>
    <header className="settings-heading"><div><span><Clock3 size={24} /></span><div><h1>自动化</h1><p>安排伙伴定时工作，结果回到原对话。</p></div></div><button className="secondary-button" type="button" disabled={!view || busy} onClick={() => begin()}><Plus size={15} />新建自动化</button></header>
    <div className="automation-view scroll-region">
      {!window.asteriumAutomations && <p className="appearance-notice">请在星丛桌面程序中使用自动化。</p>}
      {error && <p role="alert" className="appearance-notice">{error}</p>}
      {runNowNotice && <p role="status" className="appearance-notice">{runNowNotice}</p>}
      {view && !view.runtimeReady && <p className="appearance-notice">管理与保存已开放，执行端尚未接入，本阶段不会启动伙伴。</p>}
      {editing ? <section className="appearance-card automation-form"><h2>{editing === 'new' ? '新建自动化' : '编辑自动化'}</h2>
        <label>使用模板<select aria-label="自动化模板" defaultValue="自定义" onChange={event => { const t = templates.find(t => t.name === event.target.value)!; setForm({ ...form, name: t.title, instructions: t.prompt }); }}>{templates.map(t => <option key={t.name}>{t.name}</option>)}</select></label>
        <label>名称<input aria-label="自动化名称" maxLength={120} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        <label>任务内容<textarea aria-label="自动化任务内容" maxLength={32000} value={form.instructions} onChange={e => setForm({ ...form, instructions: e.target.value })} placeholder="描述伙伴每次需要做什么、目录和完成标准…" /></label>
        <label>执行伙伴与原对话<select aria-label="自动化目标" value={form.target} onChange={e => setForm({ ...form, target: e.target.value })}><option value="null">请选择已有原线程</option>{view?.targets.map((t) => <option key={`${t.target.partnerId}:${t.target.conversationId}`} value={automationTargetKey(t.target)}>{t.label}{!t.available ? ' · 待就绪' : ''}</option>)}</select></label>
        <div className="automation-form-grid"><label>重复方式<select aria-label="重复方式" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}><option value="once">一次</option><option value="daily">每天</option><option value="weekly">每周</option><option value="interval">固定间隔</option></select></label>
          {form.type === 'once' ? <label>执行时间<input aria-label="一次执行时间" type="datetime-local" value={form.once} onChange={e => setForm({ ...form, once: e.target.value })} /></label> : form.type === 'interval' ? <label>间隔分钟<input aria-label="间隔分钟" type="number" min={1} max={525600} value={form.interval} onChange={e => setForm({ ...form, interval: Number(e.target.value) })} /></label> : <label>每天时间<input aria-label="每天时间" type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} /></label>}
          <label>时区<input aria-label="自动化时区" value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} /></label>
          <label>错过时间时<select aria-label="补执行策略" value={form.catchUp} onChange={e => setForm({ ...form, catchUp: e.target.value })}><option value="same_day">当天打开后补一次</option><option value="skip">跳过错过的时间</option></select></label>
        </div>
        {form.type === 'weekly' && <fieldset className="automation-weekdays"><legend>每周哪几天</legend>{[1, 2, 3, 4, 5, 6, 0].map(n => <label key={n}><input type="checkbox" checked={form.weekdays.includes(n)} onChange={e => setForm({ ...form, weekdays: e.target.checked ? [...form.weekdays, n] : form.weekdays.filter(x => x !== n) })} />周{'日一二三四五六'[n]}</label>)}</fieldset>}
        <label>通知<select aria-label="自动化通知" value={form.notifications} onChange={e => setForm({ ...form, notifications: e.target.value })}><option value="always">每次完成通知</option><option value="changes_or_failure">仅变化、未知或失败时通知</option></select></label>
        <p className="appearance-hint">沿用原线程、工作区与现有审批；星丛关闭时不会执行。新任务从下一计划时间生效，暂停期间不补跑。一次性任务错过后下次打开执行一次，固定间隔错过多轮只合并最近一轮。</p>
        <div className="automation-form-actions"><button className="primary-button" disabled={busy} type="button" onClick={() => void save()}>保存自动化</button><button className="secondary-button" disabled={busy} type="button" onClick={() => setEditing(null)}>取消编辑</button></div>
      </section> : <>
        <div className="automation-list">{definitions.map(d => <section className="appearance-card automation-card" key={d.id}><h2>{d.name}<small>{d.enabled ? '已启用' : '已暂停'}</small></h2><p>{d.instructions}</p><small>{describe(d)} · {d.timezone} · {view?.targets.find(t => automationTargetKey(t.target) === automationTargetKey(d.target))?.label ?? '目标暂不可用'}</small><small>下次：{view?.nextRuns[d.id] ? new Date(view.nextRuns[d.id]!).toLocaleString('zh-CN') : '无未来计划时间'} · {d.catchUp === 'same_day' ? '错过后补一次' : '不补执行'}</small>
          <div className="appearance-actions"><button className="secondary-button" disabled={busy} onClick={() => begin(d)}>编辑</button><button className="secondary-button" disabled={busy} onClick={() => void mutate({ action: 'update', id: d.id, revision: d.revision, input: pickInput(d, { enabled: !d.enabled }) })}>{d.enabled ? '暂停' : '恢复'}</button><button className="secondary-button" disabled={busy || !view?.runtimeReady} onClick={() => void mutate({ action: 'run_now', id: d.id, requestId: crypto.randomUUID() })}>立即运行</button><button className="secondary-button" onClick={() => setSelected(selected === d.id ? '' : d.id)}>执行记录</button><button className="secondary-button automation-delete-trigger" disabled={busy} onClick={() => { setError(''); setDeleting(d); }}><Trash2 size={14} />删除</button></div>
        </section>)}</div>
        {!definitions.length && view && <div className="friendly-empty"><Clock3 size={32} /><h2>还没有自动化</h2><p>选择模板或写下自定义任务，交给伙伴按时执行。</p></div>}
        <section className="appearance-card automation-runs"><h2>执行记录 {selected && <button className="text-button" onClick={() => setSelected('')}><ArrowLeft size={13} />全部</button>}</h2>{!runs.length && <p className="appearance-hint">暂无执行记录</p>}{runs.map(r => <article key={r.id}><header><strong>{r.definition.name}</strong><span>{states[r.state]}</span><time>{new Date(r.scheduledAt).toLocaleString('zh-CN')}</time></header>{(r.summary || r.reason) && <p>{r.summary || r.reason}</p>}<div className="appearance-actions">{r.state === 'failed' && <button className="secondary-button" disabled={busy || !view?.runtimeReady} onClick={() => void mutate({ action: 'retry', runId: r.id })}>重试本次</button>}{r.state === 'uncertain' && <><button className="secondary-button" disabled={busy} onClick={() => void mutate({ action: 'resolve', runId: r.id, outcome: 'succeeded' })}>确认已完成</button><button className="secondary-button" disabled={busy} onClick={() => void mutate({ action: 'resolve', runId: r.id, outcome: 'cancelled' })}>忽略本次</button></>}{['queued', 'running', 'waiting_approval'].includes(r.state) && <button className="secondary-button" disabled={busy} onClick={() => void mutate({ action: 'cancel', runId: r.id })}>取消本次</button>}<button className="text-button" onClick={() => { const t = r.definition.target; if (t.roomId) { selectProject(t.projectId!); selectGroupChat(t.roomId); navigate('/studio/discussion'); } else { selectConversation(t.conversationId); navigate('/chat'); } }}>返回原对话</button></div></article>)}</section>
      </>}
    </div>
    {deleting && createPortal(<Modal title="删除这项自动化？" description="移除后续计划，保留执行记录。" initialFocusRef={deleteCancelRef} onClose={() => { if (!busy) setDeleting(null); }}>
      <div className="modal-body automation-confirm-body automation-delete-confirm">
        <div className="automation-confirm-heading"><span><Trash2 size={22} /></span><div><h3>{deleting.name}</h3><small>{describe(deleting)} · {deleting.timezone}</small></div></div>
        <section className="automation-confirm-task"><h4>任务内容</h4><p>{deleting.instructions}</p></section>
        <div className="modal-warning"><CircleAlert size={19} /><span><strong>不会停止已经开始的运行</strong><small>删除会取消后续计划和未启动的排队。需要停止当前运行时，请在执行记录中选择“取消本次”。</small></span></div>
        {error && <p role="alert" className="form-error">{error}</p>}
      </div>
      <footer className="modal-footer"><button ref={deleteCancelRef} className="secondary-button" type="button" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="danger-button" type="button" disabled={busy} onClick={() => { void mutate({ action: 'remove', id: deleting.id, revision: deleting.revision }).then(saved => { if (saved) setDeleting(null); }); }}><Trash2 size={14} />{busy ? '删除中…' : '确认删除'}</button></footer>
    </Modal>, document.body)}
  </>;
}
function pickInput(d: Automation, patch: Partial<AutomationInput>): AutomationInput { return { name: d.name, instructions: d.instructions, target: d.target, schedule: d.schedule, timezone: d.timezone, catchUp: d.catchUp, notifications: d.notifications, enabled: d.enabled, ...patch }; }
function localInput(iso: string, timezone: string) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map(p => [p.type, p.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; }
