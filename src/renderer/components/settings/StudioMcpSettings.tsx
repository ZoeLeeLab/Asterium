import { useEffect, useRef, useState } from 'react';
import { STUDIO_MCP_DEFAULT_PORT, type StudioMcpStatus } from '../../../shared/studioMcp';
import type { Partner } from '../../types/domain';

export function StudioMcpSettings({ partners }: { partners: Partner[] }) {
  const api = window.asteriumStudioMcp;
  const candidates = partners.filter((partner) => !partner.isRemoved && !partner.isPrototype && partner.sourceMode === 'existing_thread');
  const [status, setStatus] = useState<StudioMcpStatus>();
  const [port, setPort] = useState(STUDIO_MCP_DEFAULT_PORT);
  const [publicOrigin, setPublicOrigin] = useState('');
  const [automationManagementEnabled, setAutomationManagementEnabled] = useState(false);
  const [partnerId, setPartnerId] = useState('');
  const [issued, setIssued] = useState<{ partnerId: string; token: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void api?.status().then((value) => {
      if (cancelled) return;
      setStatus(value); setPort(value.configuration.port); setPublicOrigin(value.configuration.publicOrigin);
      setAutomationManagementEnabled(Boolean(value.configuration.automationManagementEnabled));
    }).catch(() => { if (!cancelled) setError('群聊连接设置暂时无法读取。'); });
    return () => { cancelled = true; };
  }, [api]);

  async function perform(operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await operation(); } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      setError(code.includes('STUDIO_MCP_PRIVATE_ORIGIN_REQUIRED') ? '请填写没有路径的 Tailscale 私网 HTTPS 地址。'
        : code.includes('STUDIO_MCP_LISTEN_FAILED') ? '服务未能启动，请检查本地端口是否被占用。'
          : '操作未完成，请刷新连接状态后重试。');
    } finally { locked.current = false; setBusy(false); }
  }

  if (!api) return null;
  const selectedPartnerId = partnerId || candidates[0]?.id || '';
  return <details className="form-section studio-mcp-settings">
    <summary>群聊 MCP 接入 · {status?.running ? '服务已开启' : '服务已关闭'}</summary>
    <p>让现有伙伴在原来的前端读取群消息、公开发言。文字工具可主动调用，自动唤醒需另行配置。</p>
    <label>本地服务端口<input type="number" min={1024} max={65535} value={port} disabled={busy} onChange={(event) => setPort(Number(event.target.value))} /></label>
    <label>私网 HTTPS 地址<input type="url" value={publicOrigin} disabled={busy} placeholder="https://你的电脑.tailnet.ts.net" onChange={(event) => setPublicOrigin(event.target.value.trim().replace(/\/$/, ''))} /></label>
    <label><input type="checkbox" checked={automationManagementEnabled} disabled={busy} onChange={event => setAutomationManagementEnabled(event.target.checked)} />允许外部伙伴管理自己的自动化（每次变更仍需我确认）</label>
    <p>默认关闭。开启只授予任务管理，不代表外部宿主已支持定时执行，也不改变群聊或目录权限。</p>
    <p>服务只监听本机。跨设备接入需要配置 Tailscale Serve；此页面不会自动修改网络配置。开启状态会保存，重启星丛后自动恢复；手动停止也会保存。启动异常时可点击开启重试。</p>
    <div className="studio-mcp-actions">
      <button className="secondary-button" type="button" disabled={busy || !status} onClick={() => void perform(async () => { setStatus(await api.configure({ enabled: !status!.running, port, publicOrigin, automationManagementEnabled })); })}>{status?.running ? '停止群聊接入' : '开启群聊接入'}</button>
      <button className="secondary-button" type="button" disabled={busy || !status} onClick={() => void perform(async () => { setStatus(await api.configure({ enabled: Boolean(status?.running), port, publicOrigin, automationManagementEnabled })); })}>保存连接设置</button>
      <button className="text-button" type="button" disabled={busy} onClick={() => void perform(async () => { setStatus(await api.status()); })}>刷新群聊连接</button>
    </div>
    {status?.error && <p role="alert" className="form-error">群聊 MCP 未能启动，请检查本地端口是否被占用，然后点击开启重试。</p>}
    {status?.running && <p>接入地址：{status.configuration.publicOrigin ? `${status.configuration.publicOrigin}/mcp` : '尚未填写私网地址，仅可在本机测试'}</p>}
    {status?.lastAuthenticatedAt && <p>最近一次认证请求：{new Date(status.lastAuthenticatedAt).toLocaleString()}。这表示工具请求到达，不代表伙伴正在运行。</p>}
    <label>绑定伙伴<select aria-label="群聊接入绑定伙伴" disabled={busy || !candidates.length} value={selectedPartnerId} onChange={(event) => setPartnerId(event.target.value)}>{!candidates.length && <option value="">请先接回一个现有伙伴</option>}{candidates.map((partner) => <option key={partner.id} value={partner.id}>{partner.publicIdentity.displayName}</option>)}</select></label>
    <button className="secondary-button" type="button" disabled={busy || !selectedPartnerId} onClick={() => void perform(async () => {
      const value = await api.issueCredential(selectedPartnerId);
      setIssued({ partnerId: value.credential.partnerId, token: value.token }); setStatus(await api.status());
    })}>生成伙伴接入凭据</button>
    {issued && <div className="studio-mcp-issued"><label>新接入凭据（仅显示一次）<input type="password" readOnly value={issued.token} /></label><p>只交给绑定伙伴的 MCP 配置；它仅能访问该伙伴已加入的群。离开此页面后不再显示。</p><button className="text-button" type="button" onClick={() => void perform(async () => { await navigator.clipboard.writeText(issued.token); })}>复制接入凭据</button><button className="text-button" type="button" onClick={() => setIssued(undefined)}>隐藏接入凭据</button></div>}
    {!!status?.credentials.length && <ul className="studio-mcp-credentials">{status.credentials.map((credential) => <li key={credential.credentialId}><span>{partners.find((partner) => partner.id === credential.partnerId)?.publicIdentity.displayName ?? '已移除伙伴'} · {credential.revokedAt ? '已撤销' : '有效凭据'}</span>{!credential.revokedAt && <button className="text-button text-button--danger" type="button" disabled={busy} aria-label={`撤销群聊凭据 ${credential.credentialId}`} onClick={() => void perform(async () => { setStatus(await api.revokeCredential(credential.credentialId)); if (issued?.partnerId === credential.partnerId) setIssued(undefined); })}>撤销</button>}</li>)}</ul>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </details>;
}
