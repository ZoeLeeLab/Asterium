import { useEffect, useRef, useState } from 'react';
import type { StudioWakeAction, StudioWakeEntry, StudioWakeStatus } from '../../../shared/studioWakeControl';
import type { Partner } from '../../types/domain';

const labels = { waiting: '等待接入就绪', requesting: '正在请求服务器', unknown: '请求结果未确认', unavailable: '服务器尚未支持', stopped: '连接已停止', connecting: '正在建立连接', connected: '已连接' };

export function StudioWakeSettings({ partners }: { partners: Partner[] }) {
  const api = window.asteriumStudioWake;
  const [status, setStatus] = useState<StudioWakeStatus>();
  const [partnerId, setPartnerId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void api?.status().then((value) => { if (!cancelled) setStatus(value); })
      .catch(() => { if (!cancelled) setError('群唤醒设置暂时无法读取。'); });
    return () => { cancelled = true; };
  }, [api]);
  if (!api) return null;
  const candidates = partners.filter((partner) => partner.sourceMode === 'existing_thread' && partner.configured && !partner.isRemoved && !partner.isPrototype);
  const selectedId = candidates.some((partner) => partner.id === partnerId) ? partnerId : candidates[0]?.id ?? '';
  const entry = status?.entries.find((item) => item.partnerId === selectedId);
  async function perform(operation: () => Promise<StudioWakeStatus>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { setStatus(await operation()); }
    catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      setError(code.includes('STUDIO_WAKE_MCP_NOT_READY') ? '请先开启群聊 MCP、填写私网地址并生成该伙伴的有效接入凭据。'
        : '操作未完成。请刷新状态后核对；系统不会自动重试。');
    } finally { locked.current = false; setBusy(false); }
  }
  const control = (action: StudioWakeAction, triggerId?: string) => void perform(() => api.control(selectedId, action, triggerId));
  return <details className="form-section studio-wake-settings">
    <summary>群聊自动唤醒 · {entry ? labels[entry.state] : '尚未配置'}</summary>
    <p>让群消息提醒伙伴回到原线程。需要服务器安装群唤醒接口，沿用现有小门登录。</p>
    <label>唤醒伙伴<select aria-label="群唤醒伙伴" value={selectedId} disabled={busy || !candidates.length} onChange={(event) => setPartnerId(event.target.value)}>
      {!candidates.length && <option value="">请先接回一个现有伙伴</option>}
      {candidates.map((partner) => <option value={partner.id} key={partner.id}>{partner.publicIdentity.displayName}</option>)}
    </select></label>
    {selectedId && status && <WakeBindingForm key={`${selectedId}:${entry?.connectionBindingId ?? ''}:${entry?.connectOnLaunch ?? ''}`} entry={entry} busy={busy}
      onSave={(connectionBindingId, connectOnLaunch) => void perform(() => api.configure({ partnerId: selectedId, connectionBindingId, connectOnLaunch }))} />}
    <p>每次启动星丛后，在群聊 MCP 就绪时连接一次。只限制建立 SSE 连接的等待时间；连接后的心跳继续维持，断开后停止，不自动重连。取消启动连接只影响下次启动。</p>
    {entry && <>
      <p role="status">最近状态：{labels[entry.state]}{entry.remote?.connection.reason ? `（${entry.remote.connection.reason}）` : ''}。点击刷新可向服务器核对。</p>
      {!entry.ready && <p>请先开启群聊 MCP、填写私网地址并生成该伙伴的有效接入凭据。</p>}
      {entry.error && <p className="form-error" role="alert">{entry.error === 'STUDIO_WAKE_CONTROL_UNSUPPORTED' ? '服务器尚未安装群唤醒控制功能，请完成服务器侧接入。'
        : entry.error === 'STUDIO_WAKE_PARTNER_UNAVAILABLE' ? '当前伙伴或小门凭据不可用，请在伙伴管理中修复后手动重新连接。'
          : ['STUDIO_WAKE_CONTROL_UNAUTHORIZED', 'CYBERBOSS_AUTH_FAILED'].includes(entry.error) ? '小门登录失效或权限不足，请修复后手动重新连接。'
            : '这次请求的结果无法确认；不会自动重试，请刷新状态后再决定。'}</p>}
      <div className="studio-mcp-actions">
        <button type="button" className="secondary-button" disabled={busy || !entry.ready} onClick={() => control('connect_once')}>重新连接群唤醒</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => control('status')}>刷新唤醒状态</button>
        {entry.remote?.paused === 'quota' && <button type="button" className="secondary-button" disabled={busy || !entry.ready} onClick={() => control('resume')}>恢复自动投递</button>}
      </div>
      {entry.remote?.paused && <p>自动投递已暂停（{entry.remote.paused === 'quota' ? '达到启动频率限制' : '待处理群达到上限'}），未读消息仍保留。{entry.remote.paused === 'quota' ? '恢复不会绕过频率限制。' : '请重新连接以同步未处理提醒。'}</p>}
      {!!entry.remote?.reviews.length && <div><p>以下群需要人工决定。重试可能继续已被接受的任务，请先核对原线程；忽略只略过唤醒提醒，不会标记群消息已处理，其他群仍可继续。</p>
        <ul>{entry.remote.reviews.map((review) => <li key={review.triggerId}>群 {review.roomId} · {review.reason === 'uncertain' ? '交付结果未确认' : review.reason === 'replay' ? '恢复后待核对' : '宿主未接受'}
          <button type="button" className="text-button" disabled={busy || !entry.ready} onClick={() => control('retry', review.triggerId)}>重试</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => control('ignore', review.triggerId)}>忽略</button>
        </li>)}</ul></div>}
    </>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </details>;
}

function WakeBindingForm({ entry, busy, onSave }: { entry?: StudioWakeEntry; busy: boolean; onSave: (id: string, connect: boolean) => void }) {
  const [id, setId] = useState(entry?.connectionBindingId ?? '');
  const [connect, setConnect] = useState(entry?.connectOnLaunch ?? true);
  return <div>
    <label>服务器连接绑定 ID<input value={id} maxLength={200} disabled={busy} placeholder="由服务器侧配置提供" onChange={(event) => setId(event.target.value)} /></label>
    <label className="studio-wake-launch"><input type="checkbox" checked={connect} disabled={busy} onChange={(event) => setConnect(event.target.checked)} />星丛启动后连接一次</label>
    <button type="button" className="secondary-button" disabled={busy || !id.trim()} onClick={() => onSave(id.trim(), connect)}>保存唤醒绑定</button>
  </div>;
}
