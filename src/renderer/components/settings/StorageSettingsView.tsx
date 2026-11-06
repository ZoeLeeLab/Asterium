import { useEffect, useState } from 'react';
import type { StorageLocations } from '../../../shared/generalSettings';

export function StorageSettingsView() {
  const [locations, setLocations] = useState<StorageLocations>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void window.asteriumStorage?.get().then(value => { if (active) setLocations(value); }).catch(() => { if (active) setError('文件位置读取失败，请重新打开设置。'); });
    return () => { active = false; };
  }, []);
  async function change(action: 'chooseProjectRoot' | 'resetProjectRoot' | 'openProjectRoot') {
    const api = window.asteriumStorage; if (!api || busy) return;
    setBusy(true); setError('');
    try { const next = await api[action](); if (next) setLocations(next); }
    catch { setError('文件位置操作失败：请确认目录存在、可写且当前可访问。原设置保留。'); }
    finally { setBusy(false); }
  }
  return <section className="general-settings-card"><h2>文件与存储</h2>
    <p>默认位置只影响新项目。已有项目继续使用原文件夹，创建时也可以另选位置。</p>
    <label className="modal-field">应用资料目录<input className="storage-settings__app-data" readOnly value={locations?.userDataDirectory ?? ''} aria-label="应用资料目录" /></label>
    <label className="modal-field">默认项目保存位置<input readOnly value={locations?.defaultProjectRoot ?? ''} aria-label="默认项目保存位置" /></label>
    <div className="storage-settings-actions">
      <button className="secondary-button" type="button" disabled={busy || !locations} onClick={() => void change('chooseProjectRoot')}>选择默认项目位置</button>
      <button className="secondary-button" type="button" disabled={busy || !locations} onClick={() => void change('openProjectRoot')}>打开项目位置</button>
      <button className="text-button" type="button" disabled={busy || !locations?.customized} onClick={() => void change('resetProjectRoot')}>恢复默认项目位置</button>
    </div>
    {!window.asteriumStorage && <p>请在星丛桌面应用中设置文件位置。</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
