import { BookOpen, ChevronDown, Download, Feather, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { usePrototype } from '../../app/PrototypeProvider';
import { Modal } from '../ui/Modal';
import { MarkdownContent } from '../chat/MarkdownContent';
import type { Conversation, Partner } from '../../types/domain';
import type { PartnerDiaryConfig, PartnerDiaryDocument, PartnerDiaryEntry, PartnerDiarySnapshot } from '../../../shared/partnerDiary';

const stateLabels = { running: '正在写作', completed: '已完成', skipped: '已跳过', failed: '未完成' };
const reasons: Record<string, string> = {
  source_busy: '到点时来源会话正在回复，今天已跳过。', no_messages: '指定会话今天没有可用的完整内容，今天已跳过。',
  missed_time: '应用休眠或错过了指定时间，不补写。', source_deleted: '来源会话已永久删除。', file_exists: '当天 Markdown 已存在，未覆盖。',
  configuration_changed: '配置、来源或日期发生变化，本次日记未保存。', interrupted: '上次写作被关闭或重启中断，今天不自动重试。',
  DIARY_TIMEOUT: '本次写作超时，今天不自动重试。', DIARY_RUNTIME_UNAVAILABLE: '伙伴运行时不可用，今天不自动重试。',
  DIARY_UPSTREAM_THREAD_MISMATCH: '上游线程已变化，请重新选择来源并保存。', DIARY_SOURCE_TOO_LARGE: '当天材料超出本版长度限制，未截断或生成。',
  DIARY_TOOL_NOT_ALLOWED: '日记回合尝试调用不允许的工具，已停止。',
};
export function DiaryModal({ partnerId, onClose }: { partnerId: string; onClose: () => void }) {
  const { state } = usePrototype();
  const partners = state.partners.filter((partner) => !partner.managedDataDeletedAt);
  const [selectedId, setSelectedId] = useState(partnerId);
  const [snapshot, setSnapshot] = useState<PartnerDiarySnapshot>({ configs: [], entries: [] });
  const [selectedDate, setSelectedDate] = useState<string>();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const reading = useRef(false);
  const partner = partners.find((item) => item.id === selectedId) ?? partners.find((item) => !item.isRemoved) ?? partners[0];
  const entries = snapshot.entries.filter((entry) => entry.partnerId === partner?.id).sort((a, b) => b.date.localeCompare(a.date));
  const date = selectedDate === undefined ? entries[0]?.date ?? '' : entries.some((entry) => entry.date === selectedDate) ? selectedDate : '';
  useEffect(() => {
    const opener = document.activeElement;
    host.current?.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  const load = useCallback(async () => {
    if (!window.asteriumPartnerDiary || reading.current) return;
    reading.current = true; setBusy(true); setError('');
    try { setSnapshot(await window.asteriumPartnerDiary.get()); }
    catch { setError('日记本暂时无法读取，请稍后刷新。'); }
    finally { reading.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 30_000); // Status reads only; never starts a generation.
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [load]);
  const config = snapshot.configs.find((item) => item.partnerId === partner?.id);
  return <div ref={host} className="diary-modal-host" onKeyDown={(event) => {
    if (event.key !== 'Tab') return;
    const controls = [...(host.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]') ?? [])].filter((node) => node.getClientRects().length > 0);
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><Modal title={partner ? `${partner.publicIdentity.displayName}的日记本` : '伙伴日记本'} description="留住这一天的记录与思考 · 日记只读，不进入记忆档案" size="lg" onClose={onClose}>
    <div className="diary-modal-toolbar"><label>伙伴<select aria-label="日记伙伴" value={partner?.id ?? ''} onChange={(event) => { setSelectedId(event.target.value); setSelectedDate(undefined); }}>{partners.map((item) => <option key={item.id} value={item.id}>{item.publicIdentity.displayName}{item.isRemoved ? '（已移除 · 历史只读）' : ''}</option>)}</select></label><span>{entries.filter((item) => item.state === 'completed').length} 篇日记 · 只读</span><button className="icon-button" type="button" disabled={busy} aria-label="刷新日记" onClick={() => void load()}><RefreshCw size={16} className={busy ? 'diary-refreshing' : ''} /></button></div>
    <div className="diary-modal-scroll">
      {partner && <DiaryConfig key={`${partner.id}:${config?.revision ?? 0}`} partner={partner} conversations={state.conversations} config={config} notice={snapshot.notices?.[partner.id]} onSaved={load} />}
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="diary-paper-stack" aria-label="日记记录">{partner && entries.map((entry) => <DiaryPaper key={`${partner.id}:${entry.date}`} entry={entry} partner={partner} sourceTitle={state.conversations.find((item) => item.id === entry.conversationId)?.title} expanded={entry.date === date} onExpand={() => setSelectedDate(entry.date === date ? '' : entry.date)} />)}
        {!entries.length && <div className="diary-empty"><span><Feather size={28} /></span><h3>下一页，留给今天</h3><p>还没有日记。展开每日写作设置，选择来源单聊和时间。</p><small>错过时间不补写，每天最多一次尝试。</small></div>}
      </section>
      <p className="diary-endnote"><BookOpen size={14} />{entries.length ? '一页一天，慢慢翻阅。' : '日记独立于伙伴记忆和项目工作笔记本。'}</p>
    </div>
  </Modal></div>;
}
function DiaryPaper({ entry, partner, sourceTitle, expanded, onExpand }: { entry: PartnerDiaryEntry; partner: Partner; sourceTitle?: string; expanded: boolean; onExpand: () => void }) {
  const [loaded, setLoaded] = useState<{ key: string; document?: PartnerDiaryDocument }>();
  const request = useRef<{ key: string; work: Promise<PartnerDiaryDocument | undefined> } | undefined>(undefined);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [exporting, setExporting] = useState(false);
  const key = `${entry.state}:${entry.finishedAt}`;
  const content = loaded?.key === key ? loaded.document?.content : undefined;
  useEffect(() => {
    if (!expanded || !window.asteriumPartnerDiary) return;
    let disposed = false;
    if (request.current?.key !== key) request.current = { key, work: window.asteriumPartnerDiary.read({ partnerId: partner.id, date: entry.date }) };
    void request.current.work.then((value) => { if (!disposed) { setLoaded({ key, document: value }); setError(''); } }).catch(() => { if (!disposed) setError('这篇日记暂时无法读取，原始文件可能已变化。'); });
    return () => { disposed = true; };
  }, [expanded, partner.id, entry.date, key]);
  const day = new Date(`${entry.date}T12:00:00`);
  return <article className={`diary-paper${expanded ? ' is-open' : ''}`}><button type="button" className="diary-paper-heading" aria-expanded={expanded} aria-label={`阅读 ${entry.date} 日记`} onClick={onExpand}><span><time dateTime={entry.date}>{day.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</time><small>{day.toLocaleDateString('zh-CN', { weekday: 'long' })} · {day.getFullYear()}</small></span><span className="diary-paper-state">{stateLabels[entry.state]}<ChevronDown size={16} /></span></button>
    {expanded && <div className="diary-paper-content"><div className="diary-body">{content ? <MarkdownContent>{content.replace(/^\s*#\s+\d{4}-\d{2}-\d{2}[^\r\n]*(?:\r?\n)*/u, '')}</MarkdownContent> : <p className="diary-status" role="status">{error || (entry.state === 'completed' ? '正在翻开这一页…' : diaryEntryReason(entry))}</p>}</div>
      <footer className="diary-paper-footer"><span>—— {partner.publicIdentity.displayName}<small>来源：{sourceTitle ?? '原会话已不在'}</small></span><div><time>{entry.state === 'completed' ? '写于' : '记录于'} {new Date(entry.finishedAt ?? entry.attemptedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><button className="diary-export" type="button" disabled={!content || exporting || entry.state !== 'completed'} onClick={async () => {
        if (exporting || !window.asteriumPartnerDiary) return; setExporting(true); setNotice('');
        try { if (await window.asteriumPartnerDiary.exportMarkdown({ partnerId: partner.id, date: entry.date })) setNotice('已导出 Markdown。'); }
        catch { setNotice('导出未完成，请稍后重试。'); } finally { setExporting(false); }
      }}><Download size={14} />导出 Markdown</button></div></footer>{notice && <p className="diary-export-notice" role="status">{notice}</p>}
    </div>}
  </article>;
}
function diaryEntryReason(entry: PartnerDiaryEntry) {
  if (entry.state === 'running') return '伙伴正在写作，无需再次触发。接回伙伴的请求和回复仍会保留在上游线程。';
  return reasons[entry.reason ?? ''] ?? '本次未生成完整日记，今天不自动重试或补写。';
}
function DiaryConfig({ partner, conversations, config, notice, onSaved }: { partner: Partner; conversations: Conversation[]; config?: PartnerDiaryConfig; notice?: string; onSaved: () => Promise<void> }) {
  const sources = conversations.filter((conversation) => conversation.partnerId === partner.id);
  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [conversationId, setConversationId] = useState(config?.conversationId ?? sources[0]?.id ?? '');
  const [time, setTime] = useState(config?.time ?? '21:00');
  const [acknowledged, setAcknowledged] = useState(Boolean(config?.upstreamThreadId && partner.sourceMode === 'existing_thread' && config.upstreamThreadId === partner.threadId));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const upstream = partner.sourceMode === 'existing_thread';
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!window.asteriumPartnerDiary || busy) return; setBusy(true); setError('');
    try { await window.asteriumPartnerDiary.configure({ partnerId: partner.id, enabled, conversationId, time, ...(upstream ? { acknowledgeUpstreamHistory: acknowledged } : {}) }); await onSaved(); }
    catch { setError('未能保存，请检查来源归属、上游线程及风险确认后重试。'); }
    finally { setBusy(false); }
  };
  return <details className="memory-briefing-card diary-config"><summary><strong>每日写作设置</strong><small>{partner.isRemoved ? '已停止调度' : config?.enabled ? `已开启 · 每日 ${config.time}` : '默认关闭'}</small></summary><div className="memory-fallback-content">
    {partner.isRemoved ? <p className="memory-muted">伙伴已移除，不再自动写日记；历史日记仍可阅读和导出。</p> : <form className="memory-editor" onSubmit={(event) => void submit(event)}>
      <label className="diary-enable"><input type="checkbox" aria-label="开启伙伴日记" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />开启此伙伴的每日写作</label>
      <label>本机时间<input aria-label="日记写作时间" type="time" value={time} required onChange={(event) => setTime(event.target.value)} /></label>
      <label className="memory-editor-wide">来源单聊<select aria-label="日记来源会话" value={conversationId} onChange={(event) => { setConversationId(event.target.value); setAcknowledged(false); }}><option value="" disabled>请选择该伙伴的一条单聊</option>{config?.conversationId && !sources.some((item) => item.id === config.conversationId) && <option value={config.conversationId}>来源会话已不在</option>}{sources.map((item) => <option key={item.id} value={item.id}>{item.title}{item.isArchived ? '（已归档）' : ''}</option>)}</select></label>
      <p className="memory-muted memory-editor-wide">只取所选单聊当天已完成的内容。每天最多一次；无内容、忙碌、不可用或错过时间则跳过，不自动重试、不过日补写。日记不进入记忆搜索、简报或新会话。</p>
      {upstream && <label className="diary-enable memory-editor-wide diary-upstream-warning"><input type="checkbox" aria-label="确认上游日记历史风险" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>我知道：这是接回伙伴，日记请求和回复会进入上游现有线程，不能像本地/API 伙伴一样隔离历史。上游已有上下文及权限仍由上游管理，线程变化后需重新选择。</span></label>}
      {(notice || error) && <p className="form-error memory-editor-wide" role="alert">{error || notice}</p>}
      <footer className="memory-editor-wide"><button className="primary-button" disabled={busy || !conversationId || !time || (enabled && upstream && !acknowledged)}><Save size={15} />{busy ? '保存中…' : '保存日记设置'}</button></footer>
    </form>}
  </div></details>;
}
