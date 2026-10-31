import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Pencil, PlugZap, Plus, Power, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import type { ApiExtensionSummary, ApiExtensionsSnapshot, McpConnectionStatus } from '../../../shared/apiExtensions';
import type { Partner } from '../../types/domain';
import { Modal } from '../ui/Modal';
import { mcpDraft, mcpRequest, mcpSettingsError, type McpDraft } from './mcpSettingsForm';
import { StudioMcpSettings } from '../settings/StudioMcpSettings';
import { StudioWakeSettings } from '../settings/StudioWakeSettings';

const trustLabels = { untrusted: '未信任', pending: '待首次确认', trusted: '已信任' };
const connectionLabels = { connecting: '正在连接', ready: '测试连接已就绪', refreshing: '正在刷新目录', closed: '测试连接已关闭', failed: '测试连接失败' };

export function McpSettingsView({ partners, onDirtyChange }: { partners: Partner[]; onDirtyChange: (dirty: boolean) => void }) {
  const api = window.asteriumExtensions;
  const [snapshot, setSnapshot] = useState<ApiExtensionsSnapshot>();
  const [statuses, setStatuses] = useState<McpConnectionStatus[]>([]);
  const [readFailed, setReadFailed] = useState(false);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<McpDraft>();
  const [dirty, setDirty] = useState(false);
  const [discardAction, setDiscardAction] = useState<(() => void)>();
  const [deleting, setDeleting] = useState<{ entry: ApiExtensionSummary; version: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false), locked = useRef(false), reading = useRef(false);
  const latest = useRef<ApiExtensionsSnapshot | undefined>(undefined);
  const accept = useCallback((value: ApiExtensionsSnapshot) => {
    if (!mounted.current || (latest.current && value.version < latest.current.version)) return;
    latest.current = value; setSnapshot(value);
  }, []);
  const refresh = useCallback(async (report = false) => {
    if (!api || reading.current) return;
    reading.current = true;
    try {
      const [value, connections] = await Promise.allSettled([api.get(), api.mcpStatus()]);
      if (mounted.current) {
        setReadFailed(value.status === 'rejected');
        setStatusUnavailable(connections.status === 'rejected');
      }
      if (value.status === 'fulfilled') accept(value.value);
      else if (mounted.current && report) setError('MCP 配置暂时无法读取，请点击刷新重试。');
      if (connections.status === 'fulfilled') { if (mounted.current) setStatuses(connections.value); }
    } catch { if (mounted.current && report) setError('MCP 配置暂时无法读取，请点击刷新重试。'); }
    finally { reading.current = false; }
  }, [api, accept]);
  useEffect(() => {
    mounted.current = true;
    const initial = window.setTimeout(() => { void refresh(true); }, 0);
    const tick = () => { if (document.visibilityState !== 'hidden' && !locked.current) void refresh(); };
    const timer = window.setInterval(tick, 2_000);
    window.addEventListener('focus', tick);
    return () => { mounted.current = false; window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener('focus', tick); };
  }, [refresh]);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);

  const entries = snapshot?.extensions.filter((entry) => entry.kind === 'mcp') ?? [];
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];
  const connection = statuses.find((status) => status.extensionId === selected?.id && status.generation === selected.generation);
  const eligible = partners.filter((partner) => partner.sourceMode === 'api_partner' && !partner.isRemoved && !partner.isPrototype && partner.configured);
  const bound = snapshot?.bindings.filter((binding) => selected && binding.extensionIds.includes(selected.id)) ?? [];
  const unavailableBindings = bound.filter((binding) => !eligible.some((partner) => partner.id === binding.partnerId));
  const guard = (action: () => void) => {
    if (locked.current) return;
    if (dirty) setDiscardAction(() => action);
    else action();
  };
  const run = async (operation: () => Promise<void>) => {
    if (!api || locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (failure) {
      if (mounted.current) {
        setError(mcpSettingsError(failure));
        // Refresh the authority, but never replay a failed mutation against a newer version.
        try { accept(await api.get()); } catch { /* Keep the last known snapshot and the editable draft. */ }
      }
    } finally { locked.current = false; if (mounted.current) { setBusy(false); void refresh(); } }
  };
  const save = (event: FormEvent) => {
    event.preventDefault(); if (!draft || !api) return;
    let request;
    try { request = mcpRequest(draft); }
    catch (failure) { setError(mcpSettingsError(failure)); return; }
    void run(async () => {
      const next = await api.upsert(request); accept(next);
      if (!mounted.current) return;
      const id = request.id ?? next.extensions.find((entry) => !snapshot?.extensions.some((old) => old.id === entry.id))?.id;
      if (id) setSelectedId(id);
      setDraft(undefined); setDirty(false); setNotice('MCP 配置已保存。保存本身不会启动服务。');
    });
  };
  const edit = (entry?: ApiExtensionSummary) => guard(() => { setError(''); setNotice(''); setDraft(mcpDraft(snapshot!.version, entry)); setDirty(false); if (entry) setSelectedId(entry.id); });
  const updateDraft = (value: McpDraft) => { setDraft(value); setDirty(true); };
  const staleDraft = draft && snapshot && draft.expectedVersion !== snapshot.version;
  const testConnection = () => {
    if (!api || !selected) return;
    if (selected.configuration.type === 'mcp_stdio' && !selected.configuration.workspaceGrantId) { setError(mcpSettingsError(new Error('MCP_AUTHORIZED_WORKSPACE_REQUIRED'))); return; }
    void run(async () => { await api.connectMcp({ id: selected.id, expectedGeneration: selected.generation }); accept(await api.get()); setNotice('测试连接成功。工具发现不等于已建立持续信任。'); });
  };

  return <>
    <header className="settings-heading"><div><span><PlugZap size={24} /></span><div><h1>MCP 管理</h1><p>为 API 伙伴配置扩展服务，并管理共享信任。</p></div></div><button className="secondary-button" type="button" disabled={busy || !api} onClick={() => { setError(''); void refresh(true); }}><RefreshCw size={14} />刷新</button></header>
    <section className="mcp-settings-view">
      <StudioMcpSettings partners={partners} />
      <StudioWakeSettings partners={partners} />
      <p className="mcp-intro">本地和接回伙伴继续使用原有 MCP 配置。这里只管理 API 伙伴；管理测试连接与伙伴会话分别建立。本地测试跟随全局沙箱设置，并使用此配置单独授权的工作区。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {readFailed && snapshot && <p className="form-error" role="alert">配置暂时无法刷新，当前显示上次读取结果。请刷新后重新核对信任状态。</p>}
      {notice && <p className="form-success" role="status"><Check size={15} />{notice}</p>}
      {!api ? <p className="mcp-empty">请在桌面应用中管理 MCP。</p> : !snapshot ? <p className="mcp-empty">正在读取 MCP 配置…</p> : <div className="mcp-columns">
        <aside className="mcp-service-list" aria-label="MCP 服务列表">
          <button className="primary-button" type="button" disabled={busy} onClick={() => edit()}><Plus size={15} />添加 MCP</button>
          {!entries.length && <p className="mcp-empty">还没有配置 MCP。添加后，为需要使用它的 API 伙伴开启绑定。</p>}
          {entries.map((entry) => <button className={`mcp-service${selected?.id === entry.id ? ' active' : ''}`} type="button" key={entry.id} disabled={busy} aria-pressed={selected?.id === entry.id} onClick={() => guard(() => { setSelectedId(entry.id); setDraft(undefined); setDirty(false); setError(''); setNotice(''); })}>
            <PlugZap size={17} /><span><strong>{entry.name}</strong><small>{entry.configuration.type === 'mcp_stdio' ? '本地进程 · stdio' : 'HTTP 服务'} · {entry.enabled ? '已启用' : '已停用'}</small><em className={`mcp-trust mcp-trust--${entry.trust}`}>{trustLabels[entry.trust]}</em></span>
          </button>)}
        </aside>
        <div className="mcp-detail">
          {draft ? <McpEditor key={draft.id ?? 'new'} draft={draft} busy={busy} stale={Boolean(staleDraft)} existing={entries.find((entry) => entry.id === draft.id)} onChange={updateDraft} onSubmit={save} onError={failure => setError(mcpSettingsError(failure))}
            onRebase={() => { if (snapshot) { setDraft({ ...draft, expectedVersion: snapshot.version }); setError(''); } }}
            onCancel={() => guard(() => { setDraft(undefined); setDirty(false); setError(''); })} />
            : selected ? <>
              <div className="mcp-detail-heading"><div><h2>{selected.name}</h2><small>{selected.configuration.type === 'mcp_stdio' ? '本地进程 · stdio' : 'HTTP 服务'}</small></div><button className="secondary-button" type="button" disabled={busy} onClick={() => edit(selected)}><Pencil size={14} />编辑配置</button></div>
              <section className="mcp-card"><h3>服务与连接</h3><dl><dt>{selected.configuration.type === 'mcp_stdio' ? '启动程序' : '服务地址'}</dt><dd>{selected.configuration.type === 'mcp_stdio' ? selected.configuration.command : selected.configuration.type === 'mcp_http' ? selected.configuration.url : ''}</dd>
                {selected.configuration.type === 'mcp_stdio' && <><dt>启动参数</dt><dd><code>{JSON.stringify(selected.configuration.args)}</code></dd><dt>工作目录</dt><dd>{selected.configuration.cwd || '使用配置的授权目录'}</dd><dt>测试工作区授权</dt><dd>{selected.configuration.workspaceGrantId ? '已关联；连接前由 Main 重新核验' : '尚未授权，不能测试本地连接'}</dd></>}
                <dt>凭据</dt><dd>{selected.hasSecrets ? `已安全保存：${selected.secretNames.join('、')}` : '未配置'}<small>已保存的值不会回显。</small></dd>
                <dt>测试状态</dt><dd aria-live="polite">{statusUnavailable ? '连接状态暂时无法读取，配置仍可管理。' : connection ? connectionLabels[connection.state] : '尚未测试当前配置'}{!statusUnavailable && connection?.state === 'ready' && ` · 已发现 ${connection.toolCount} 个工具`}{!statusUnavailable && connection?.errorCode && <small>{mcpSettingsError(new Error(connection.errorCode))}</small>}</dd></dl>
                <p>测试连接会启动配置的程序或访问服务地址，仅发现工具，不执行工具。{selected.configuration.type === 'mcp_http' ? 'HTTP 连接不受本地进程沙箱隔离。' : connection?.sandboxed === true ? '最近一次启动已确认使用 Windows 沙箱。' : connection?.state === 'ready' && connection.backend === 'native' ? '当前连接使用 Native（无沙箱）。' : '本地连接跟随全局沙箱设置，以实际启动结果为准。'}</p>
                <div className="mcp-actions"><button className="secondary-button" type="button" disabled={busy || !selected.enabled || connection?.state === 'ready' || connection?.state === 'connecting' || connection?.state === 'refreshing'} onClick={testConnection}><PlugZap size={14} />测试连接</button>
                  <button className="secondary-button" type="button" disabled={busy || !connection || ['closed', 'failed'].includes(connection.state)} onClick={() => void run(async () => { await api.disconnectMcp({ id: selected.id }); setNotice('管理测试连接已断开；伙伴会话连接独立管理。'); })}>断开测试连接</button>
                  <button className="secondary-button" type="button" disabled={busy} onClick={() => void run(async () => { accept(await api.upsert({ expectedVersion: snapshot.version, id: selected.id, name: selected.name, enabled: !selected.enabled, configuration: selected.configuration })); setNotice(selected.enabled ? 'MCP 已停用，相关旧连接将关闭。' : 'MCP 已启用，服务将在需要时连接。'); })}><Power size={14} />{selected.enabled ? '停用服务' : '启用服务'}</button></div>
              </section>
              <section className="mcp-card"><h3><ShieldCheck size={17} />共享信任 <span className={`mcp-trust mcp-trust--${selected.trust}`}>{trustLabels[selected.trust]}</span></h3>
                <p>信任适用于已绑定此 MCP 的 API 伙伴。普通模式免逐次确认；只读、Plan 和工作区限制仍然生效。服务配置、凭据或工具目录变更后需要重新确认。</p>
                {selected.trust === 'pending' && <p>已加入待信任名单。下次真实工具审批中，只有选择“允许并持续信任此 MCP”才会激活；允许一次不会激活。</p>}
                <div className="mcp-actions">{selected.trust === 'untrusted' ? <button className="secondary-button" type="button" disabled={busy || !selected.enabled} onClick={() => void run(async () => { accept(await api.setTrust({ expectedVersion: snapshot.version, id: selected.id, action: 'request' })); setNotice('已申请持续信任，等待下次真实工具审批明确确认。'); })}>申请持续信任</button>
                  : <button className="secondary-button" type="button" disabled={busy} onClick={() => void run(async () => { accept(await api.setTrust({ expectedVersion: snapshot.version, id: selected.id, action: 'revoke' })); setNotice('信任已撤销。后续调用恢复现有审批规则，旧审批不能恢复信任。'); })}>{selected.trust === 'trusted' ? '撤销信任' : '取消待信任'}</button>}</div>
              </section>
              <section className="mcp-card"><h3>可用 API 伙伴</h3><p>为伙伴开启绑定后，才会在允许的模式下提供此服务；共享信任不会自动添加绑定。</p>
                {!eligible.length && <p className="mcp-empty">暂无可绑定的 API 伙伴。请先在伙伴管理中添加并配置 API 伙伴。</p>}
                {eligible.map((partner) => <label className="mcp-partner" key={partner.id}><input type="checkbox" disabled={busy} checked={bound.some((binding) => binding.partnerId === partner.id)} onChange={(event) => {
                  const enabled = event.target.checked;
                  void run(async () => {
                    const ids = snapshot.bindings.find((binding) => binding.partnerId === partner.id)?.extensionIds ?? [];
                    accept(await api.setBinding({ expectedVersion: snapshot.version, partnerId: partner.id, extensionIds: enabled ? [...new Set([...ids, selected.id])] : ids.filter((id) => id !== selected.id) }));
                    setNotice(enabled ? '伙伴绑定已开启。' : '伙伴绑定已移除，相关旧连接将关闭。');
                  });
                }} /><span>{partner.publicIdentity.displayName}</span></label>)}
                {!!unavailableBindings.length && <small>另有 {unavailableBindings.length} 个不可用或已移除伙伴的绑定，当前不生效。</small>}
              </section>
              <div className="mcp-delete"><button className="secondary-button secondary-button--danger" type="button" disabled={busy} onClick={() => { setError(''); setDeleting({ entry: selected, version: snapshot.version }); }}><Trash2 size={14} />删除 MCP</button><small>删除会移除配置、凭据、信任与所有伙伴绑定。</small></div>
            </> : <div className="mcp-empty mcp-card"><PlugZap size={28} /><h2>让 API 伙伴使用 MCP</h2><p>添加本地 stdio 或 HTTP 服务，然后选择可用伙伴。</p></div>}
        </div>
      </div>}
    </section>
    {discardAction && <Modal title="放弃未保存的 MCP 配置？" description="未保存的配置和凭据输入将被丢弃。" onClose={() => setDiscardAction(undefined)}><footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setDiscardAction(undefined)}>继续编辑</button><button className="primary-button" type="button" onClick={() => { const action = discardAction; setDiscardAction(undefined); setDirty(false); action(); }}>放弃修改</button></footer></Modal>}
    {deleting && <Modal title="删除 MCP？" description={`将删除「${deleting.entry.name}」的配置、凭据、信任与所有伙伴绑定，并关闭相关连接。`} onClose={() => { if (!busy) setDeleting(undefined); }}><footer className="modal-footer"><button className="secondary-button" type="button" disabled={busy} onClick={() => setDeleting(undefined)}>取消</button><button className="danger-button" type="button" disabled={busy} onClick={() => void run(async () => { try { accept(await api!.remove({ expectedVersion: deleting.version, id: deleting.entry.id })); } finally { setDeleting(undefined); } setNotice('MCP 已删除。'); })}>确认删除</button></footer></Modal>}
  </>;
}

function McpEditor({ draft, existing, busy, stale, onChange, onSubmit, onCancel, onRebase, onError }: {
  draft: McpDraft; existing?: ApiExtensionSummary; busy: boolean; stale: boolean;
  onChange: (draft: McpDraft) => void; onSubmit: (event: FormEvent) => void; onCancel: () => void; onRebase: () => void;
  onError: (error: unknown) => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const selectWorkspace = async () => {
    if (selecting || busy) return;
    setSelecting(true);
    try {
      if (!window.asteriumAgents) throw new Error('MCP_AUTHORIZED_WORKSPACE_REQUIRED');
      const grant = await window.asteriumAgents.selectWorkspace('mcp_workspace');
      if (grant) onChange({ ...draft, workspaceGrantId: grant.grantId, cwd: grant.displayPath });
    } catch (error) { onError(error); } finally { setSelecting(false); }
  };
  return <form className="mcp-editor" onSubmit={onSubmit} autoComplete="off">
    <h2>{draft.id ? '编辑 MCP 配置' : '添加 MCP'}</h2>
    {stale && <div className="mcp-conflict" role="alert"><p>{draft.id && !existing ? '此服务已被删除，请取消编辑后重新添加。' : '服务列表已更新。请核对已保存配置，再选择是否基于当前版本保留你的编辑。'}</p>
      {existing && <details><summary>查看当前已保存配置</summary><strong>{existing.name} · {existing.enabled ? '已启用' : '已停用'} · {trustLabels[existing.trust]}</strong><p>{existing.configuration.type === 'mcp_stdio' ? `${existing.configuration.command}\n${JSON.stringify(existing.configuration.args)}\n工作目录：${existing.configuration.cwd || '用户主目录'}` : existing.configuration.type === 'mcp_http' ? existing.configuration.url : ''}</p><small>凭据：{existing.secretNames.join('、') || '未配置'}</small></details>}
      <button className="secondary-button" type="button" disabled={busy || (Boolean(draft.id) && !existing)} onClick={onRebase}>已核对，使用当前版本</button></div>}
    <fieldset className="form-section" disabled={busy}><legend>连接配置</legend>
      <label>服务名称<input aria-label="服务名称" required maxLength={120} value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
      <label>连接方式<select aria-label="连接方式" value={draft.transport} onChange={(event) => onChange({ ...draft, transport: event.target.value as McpDraft['transport'], secrets: [] })}><option value="mcp_stdio">本地进程（stdio）</option><option value="mcp_http">HTTP 服务</option></select></label>
      {draft.transport === 'mcp_stdio' ? <>
        <label>启动程序<input aria-label="启动程序" required placeholder="例如 node 或程序的完整路径" value={draft.command} onChange={(event) => onChange({ ...draft, command: event.target.value })} /></label>
        <label>启动参数（JSON 数组）<textarea aria-label="启动参数（JSON 数组）" rows={4} spellCheck={false} value={draft.args} onChange={(event) => onChange({ ...draft, args: event.target.value })} /></label>
        <small>每个参数单独放在数组中，例如 ["C:\\tools\\server.mjs", "--flag"]；不作为 shell 命令执行。</small>
        <label>工作目录（可选）<input aria-label="工作目录（可选）" placeholder="授权工作区内的绝对路径；留空使用授权目录" value={draft.cwd} onChange={(event) => onChange({ ...draft, cwd: event.target.value })} /></label>
        <div><button className="secondary-button" type="button" disabled={busy || selecting} onClick={() => void selectWorkspace()}>{selecting ? '正在选择…' : '选择并授权测试工作区'}</button><small>{draft.workspaceGrantId ? '已关联目录授权，保存后用于此 MCP 的管理测试。' : '本地测试连接需要单独的目录授权，仅填写路径不会授权。'}</small></div>
      </> : <label>服务地址<input aria-label="服务地址" type="url" required placeholder="http://127.0.0.1:3000/mcp" value={draft.url} onChange={(event) => onChange({ ...draft, url: event.target.value })} /></label>}
      <label className="mcp-inline-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} />启用此服务</label>
    </fieldset>
    <fieldset className="form-section" disabled={busy}><legend>{draft.transport === 'mcp_stdio' ? '环境变量凭据' : '认证请求头'}</legend>
      <p>{existing?.hasSecrets ? `已保存的名称：${existing.secretNames.join('、')}。` : '尚未保存凭据。'}值保存在系统安全凭据库，不会回显。请把认证值放在这里，避免写入启动参数或 URL。</p>
      <label>凭据处理<select aria-label="凭据处理" value={draft.secretMode} onChange={(event) => onChange({ ...draft, secretMode: event.target.value as McpDraft['secretMode'], secrets: event.target.value === 'replace' ? [{ name: '', value: '' }] : [] })}><option value="keep">保留现有凭据</option><option value="replace">替换全部凭据</option><option value="clear">清除全部凭据</option></select></label>
      {existing && existing.configuration.type !== draft.transport && <p>更换连接方式会清除原凭据，请按需重新填写。</p>}
      {draft.secretMode === 'replace' && <><p>替换会移除原有全部名称；请填写需要保留的每一项。HTTP 会话和协议请求头由星丛管理。</p>
        {draft.secrets.map((secret, index) => <div className="mcp-secret-row" key={index}><label>名称 {index + 1}<input aria-label={`凭据名称 ${index + 1}`} value={secret.name} onChange={(event) => onChange({ ...draft, secrets: draft.secrets.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} /></label><label>值 {index + 1}<input type="password" autoComplete="new-password" aria-label={`凭据值 ${index + 1}`} value={secret.value} onChange={(event) => onChange({ ...draft, secrets: draft.secrets.map((item, i) => i === index ? { ...item, value: event.target.value } : item) })} /></label><button className="icon-button" type="button" aria-label={`移除凭据 ${index + 1}`} onClick={() => onChange({ ...draft, secrets: draft.secrets.filter((_, i) => i !== index) })}><Trash2 size={15} /></button></div>)}
        <button className="secondary-button" type="button" disabled={draft.secrets.length >= 128} onClick={() => onChange({ ...draft, secrets: [...draft.secrets, { name: '', value: '' }] })}><Plus size={14} />添加凭据</button>
      </>}
    </fieldset>
    <p className="mcp-editor-note">保存不会连接服务或建立信任。更改连接配置、凭据或启用状态会使现有信任需要重新确认；仅改名称不会。</p>
    <footer className="mcp-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>取消编辑</button><button className="primary-button" type="submit" disabled={busy || stale}>{busy ? '正在保存…' : '保存 MCP'}</button></footer>
  </form>;
}
