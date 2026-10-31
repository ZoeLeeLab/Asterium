import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';
import { extensionUpsertSchema, type ApiExtensionSummary, type ApiExtensionsSnapshot } from '../../../shared/apiExtensions';
import type { Partner } from '../../types/domain';
import { Modal } from '../ui/Modal';
import { mcpSettingsError } from './mcpSettingsForm';

interface Draft { expectedVersion: number; id?: string; name: string; directory: string; enabled: boolean }
const labels = { untrusted: '未信任', pending: '待首次确认', trusted: '已信任' };
export function SkillSettingsView({ partners, onDirtyChange }: { partners: Partner[]; onDirtyChange: (value: boolean) => void }) {
  const api = window.asteriumExtensions;
  const [snapshot, setSnapshot] = useState<ApiExtensionsSnapshot>();
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [readFailed, setReadFailed] = useState(false);
  const [discard, setDiscard] = useState<() => void>();
  const [deleting, setDeleting] = useState<{ entry: ApiExtensionSummary; version: number }>();
  const latest = useRef<ApiExtensionsSnapshot | undefined>(undefined), mounted = useRef(false), locked = useRef(false), reading = useRef(false);
  const accept = useCallback((value: ApiExtensionsSnapshot) => {
    if (!mounted.current || (latest.current && value.version < latest.current.version)) return;
    latest.current = value; setSnapshot(value);
  }, []);
  const refresh = useCallback(async () => {
    if (!api || reading.current) return;
    reading.current = true;
    try { const value = await api.get(); if (mounted.current) { accept(value); setReadFailed(false); } }
    catch { if (mounted.current) setReadFailed(true); }
    finally { reading.current = false; }
  }, [api, accept]);
  useEffect(() => {
    mounted.current = true; const initial = window.setTimeout(() => void refresh(), 0);
    const tick = () => { if (document.visibilityState !== 'hidden' && !locked.current) void refresh(); };
    const timer = window.setInterval(tick, 2000); window.addEventListener('focus', tick);
    return () => { mounted.current = false; clearTimeout(initial); clearInterval(timer); window.removeEventListener('focus', tick); };
  }, [refresh]);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const run = async (operation: () => Promise<void>) => {
    if (!api || locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (failure) { if (mounted.current) { setError(mcpSettingsError(failure)); await refresh(); } }
    finally { locked.current = false; if (mounted.current) { setBusy(false); void refresh(); } }
  };
  const guard = (action: () => void) => { if (locked.current) return; if (dirty) setDiscard(() => action); else action(); };
  const entries = snapshot?.extensions.filter((entry) => entry.kind === 'skill') ?? [];
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];
  const eligible = partners.filter((partner) => partner.sourceMode === 'api_partner' && partner.configured && !partner.isRemoved && !partner.isPrototype);
  const edit = (entry?: ApiExtensionSummary) => guard(() => { setDraft({ expectedVersion: snapshot!.version, id: entry?.id, name: entry?.name ?? '', directory: entry?.configuration.type === 'skill' ? entry.configuration.directory : '', enabled: entry?.enabled ?? true }); setDirty(false); });
  const save = (event: FormEvent) => {
    event.preventDefault(); if (!draft || !api) return;
    const parsed = extensionUpsertSchema.safeParse({ expectedVersion: draft.expectedVersion, ...(draft.id ? { id: draft.id } : {}), name: draft.name, enabled: draft.enabled, configuration: { type: 'skill', directory: draft.directory } });
    if (!parsed.success) { setError('请填写名称和 Skill 文件夹的 Windows 绝对路径。'); return; }
    void run(async () => {
      const next = await api.upsert(parsed.data); accept(next);
      setSelectedId(draft.id ?? next.extensions.find((entry) => !snapshot?.extensions.some((old) => old.id === entry.id))?.id ?? '');
      setDraft(undefined); setDirty(false); setNotice('Skill 已保存。保存不会执行脚本或建立信任。');
    });
  };
  return <>
    <header className="settings-heading"><div><span><BookOpen size={24} /></span><div><h1>Skills 管理</h1><p>为 API 伙伴绑定本地技能包，按需读取说明和参考文件。</p></div></div><button className="secondary-button" disabled={busy || !api} onClick={() => void refresh()}><RefreshCw size={14} />刷新</button></header>
    <section className="mcp-settings-view">
      <p className="mcp-intro">选择含 SKILL.md 的文件夹。文件需有 name、description 的 YAML 头部；本地和接回伙伴继续使用原有 Skills。</p>
      {error && <p className="form-error" role="alert">{error}</p>}{readFailed && <p className="form-error" role="alert">配置暂时无法读取；已有显示可能过期，请刷新后核对。</p>}{notice && <p className="form-success" role="status">{notice}</p>}
      {!api ? <p>请在桌面应用中管理 Skills。</p> : !snapshot ? <p>正在读取 Skills…</p> : <div className="mcp-columns"><aside className="mcp-service-list" aria-label="Skills 列表">
        <button className="primary-button" disabled={busy} onClick={() => edit()}>添加 Skill</button>
        {!entries.length && <p className="mcp-empty">暂无 Skill。添加后为 API 伙伴开启绑定。</p>}
        {entries.map((entry) => <button className={`mcp-service${selected?.id === entry.id ? ' active' : ''}`} key={entry.id} disabled={busy} onClick={() => guard(() => { setSelectedId(entry.id); setDraft(undefined); setDirty(false); })}><BookOpen size={17} /><span><strong>{entry.name}</strong><small>{entry.enabled ? '已启用' : '已停用'} · {labels[entry.trust]}</small></span></button>)}
      </aside><div className="mcp-detail">{draft ? <form className="mcp-editor" onSubmit={save}>
        <h2>{draft.id ? '编辑 Skill' : '添加 Skill'}</h2>
        <label>显示名称<input aria-label="Skill 名称" disabled={busy} value={draft.name} maxLength={120} onChange={(event) => { setDraft({ ...draft, name: event.target.value }); setDirty(true); }} /></label>
        <label>文件夹绝对路径<input aria-label="Skill 文件夹" disabled={busy} value={draft.directory} onChange={(event) => { setDraft({ ...draft, directory: event.target.value }); setDirty(true); }} /></label>
        {draft.expectedVersion !== snapshot.version && <div className="form-error" role="alert"><p>配置已更新。请核对当前配置再重新编辑；未保存输入已保留，不能覆盖新版本。</p><pre>{JSON.stringify(entries.find((entry) => entry.id === draft.id)?.configuration ?? null, null, 2)}</pre></div>}
        <p>文件夹只授予本技能包的读取能力；说明不会增加工作区或授予命令、MCP 权限。更改目录或包内容会使脚本信任需要重新确认。</p>
        <footer className="mcp-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => guard(() => { setDraft(undefined); setDirty(false); })}>取消编辑</button><button className="primary-button" disabled={busy || draft.expectedVersion !== snapshot.version}>保存 Skill</button></footer>
      </form> : selected ? <>
        <div className="mcp-detail-heading"><h2>{selected.name}</h2><button className="secondary-button" disabled={busy} onClick={() => edit(selected)}>编辑 Skill</button></div>
        <section className="mcp-card"><h3>技能包</h3><p>{selected.configuration.type === 'skill' ? selected.configuration.directory : ''}</p><p>伙伴仅发现已启用且绑定的技能。说明和文本参考文件可在只读及 Plan 模式读取；脚本不可在这些模式执行。链接和二进制不会自动打开。</p><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { accept(await api.upsert({ expectedVersion: snapshot.version, id: selected.id, name: selected.name, enabled: !selected.enabled, configuration: selected.configuration })); })}>{selected.enabled ? '停用 Skill' : '启用 Skill'}</button></section>
        <section className="mcp-card"><h3>脚本共享信任 · {labels[selected.trust]}</h3><p>信任仅适用于此技能包的 scripts/ 脚本，不授权通用命令或 MCP。加入名单后仍需在真实脚本审批选择持续信任；允许一次不激活。内容变更后重新审批。</p>
          <button className="secondary-button" disabled={busy || (!selected.enabled && selected.trust === 'untrusted')} onClick={() => void run(async () => { accept(await api.setTrust({ expectedVersion: snapshot.version, id: selected.id, action: selected.trust === 'untrusted' ? 'request' : 'revoke' })); setNotice(selected.trust === 'untrusted' ? '已申请持续信任，等待真实脚本审批。' : '信任已撤销，后续脚本恢复审批。'); })}>{selected.trust === 'untrusted' ? '申请脚本持续信任' : selected.trust === 'trusted' ? '撤销信任' : '取消待信任'}</button>
        </section><section className="mcp-card"><h3>可用 API 伙伴</h3>{!eligible.length && <p>暂无可绑定的 API 伙伴。</p>}{eligible.map((partner) => <label className="mcp-partner" key={partner.id}><input type="checkbox" disabled={busy} checked={snapshot.bindings.some((binding) => binding.partnerId === partner.id && binding.extensionIds.includes(selected.id))} onChange={(event) => {
          const enabled = event.target.checked;
          void run(async () => { const ids = snapshot.bindings.find((binding) => binding.partnerId === partner.id)?.extensionIds ?? []; accept(await api.setBinding({ expectedVersion: snapshot.version, partnerId: partner.id, extensionIds: enabled ? [...new Set([...ids, selected.id])] : ids.filter((id) => id !== selected.id) })); });
        }} /><span>{partner.publicIdentity.displayName}</span></label>)}</section>
        <div className="mcp-delete"><button className="secondary-button secondary-button--danger" disabled={busy} onClick={() => setDeleting({ entry: selected, version: snapshot.version })}>删除 Skill</button></div>
      </> : <p className="mcp-empty">添加技能包，供 API 伙伴按需使用。</p>}</div></div>}
    </section>
    {discard && <Modal title="放弃未保存的 Skill？" onClose={() => setDiscard(undefined)}><footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setDiscard(undefined)}>继续编辑</button><button className="primary-button" type="button" onClick={() => { const action = discard; setDiscard(undefined); setDirty(false); action(); }}>放弃修改</button></footer></Modal>}
    {deleting && <Modal title="删除 Skill？" description="移除配置、绑定与信任；保留原技能文件夹。" onClose={() => { if (!busy) setDeleting(undefined); }}><footer className="modal-footer"><button className="secondary-button" type="button" disabled={busy} onClick={() => setDeleting(undefined)}>取消</button><button className="danger-button" type="button" disabled={busy} onClick={() => void run(async () => { try { accept(await api!.remove({ expectedVersion: deleting.version, id: deleting.entry.id })); } finally { setDeleting(undefined); } })}>确认删除</button></footer></Modal>}
  </>;
}
