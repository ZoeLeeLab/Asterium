import { useId, useState } from 'react';
import { APP_VERSION } from '../../../shared/appRelease';
import { AsteriumLogo } from '../ui/AsteriumLogo';
import { Modal } from '../ui/Modal';
import { useAppUpdates, updateStatusText } from '../../app/useAppUpdates';
import { useGeneralSettings } from '../../app/useGeneralSettings';

const noticeDocuments = [
  { title: '项目许可证（MPL-2.0）', load: () => import('../../../../LICENSE?raw') },
  { title: '版权与授权范围', load: () => import('../../../../COPYRIGHT.md?raw') },
  { title: '素材许可与品牌说明', load: async () => ({ default: [(await import('../../../../ASSET_LICENSE.md?raw')).default, (await import('../../../../BRANDING.md?raw')).default, (await import('../../../../LICENSES/CC-BY-4.0.txt?raw')).default].join('\n\n') }) },
  { title: '致谢', load: () => import('../../../../CREDITS.md?raw') },
  { title: '第三方声明', load: () => import('../../../../THIRD_PARTY_NOTICES.md?raw') },
  { title: '第三方许可证原文', load: () => import('../../../../third_party/licenses/THIRD_PARTY_LICENSES.txt?raw') },
];

function NoticeDocument({ title, load }: typeof noticeDocuments[number]) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const toggle = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (text !== undefined || loading) return;
    setLoading(true);
    setError(false);
    try { setText((await load()).default); }
    catch { setError(true); }
    finally { setLoading(false); }
  };
  return <div className="about-notice">
    <button className="secondary-button" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => void toggle()}>{expanded ? '收起' : '查看'}{title}</button>
    {expanded && <div id={id}>
      {loading && <p role="status">正在读取随应用提供的声明…</p>}
      {error && <p role="alert">声明暂时无法读取，请收起后重试。</p>}
      {text !== undefined && <pre className="about-notice-text" tabIndex={0} aria-label={title}>{text}</pre>}
    </div>}
  </div>;
}

export function AboutSettingsView() {
  const snapshot = useAppUpdates();
  const { settings, available, saving, error: settingsError, update } = useGeneralSettings();
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [operationError, setOperationError] = useState('');
  const busy = ['checking', 'downloading', 'installing'].includes(snapshot.phase);
  const downloaded = Boolean(snapshot.readyToInstall);
  const run = async (action: (() => Promise<unknown>) | undefined) => {
    setOperationError('');
    try { if (action) await action(); }
    catch { setOperationError('操作未完成，请稍后重试。'); }
  };
  return <div className="about-settings">
    <header className="about-brand">
      <AsteriumLogo />
      <h1>星丛 Asterium</h1>
      <p>让熟悉你的 AI 伙伴，在同一个工作台相伴与协作。</p>
      <small>{APP_VERSION}</small>
      <p role="status">{updateStatusText(snapshot)}</p>
      {operationError && <p role="alert">{operationError}</p>}
      <div className="about-update-actions">
        <button className="secondary-button" type="button" disabled={!snapshot.configured || busy || downloaded} onClick={() => void run(window.asteriumUpdates?.check)}>检查更新</button>
        {snapshot.release && !downloaded && !busy && <button className="primary-button" type="button" onClick={() => void run(window.asteriumUpdates?.download)}>下载新版本</button>}
        {snapshot.phase === 'downloading' && <button className="secondary-button" type="button" onClick={() => void run(window.asteriumUpdates?.cancel)}>取消下载</button>}
        {downloaded && <button className="primary-button" type="button" disabled={busy} onClick={() => setConfirmInstall(true)}>退出并安装</button>}
        <button className="secondary-button" type="button" disabled={!snapshot.configured} onClick={() => void run(window.asteriumUpdates?.openReleases)}>更新历史</button>
      </div>
    </header>
    <section className="about-info" aria-label="版本与发行信息">
      <div><span>许可证</span><span>MPL-2.0</span></div>
      <div><span>版权</span><span>© 2026 ZoeLeeLab</span></div>
      <div><span>代码签名</span><span>未签名 · Beta</span></div>
      <div><span>GitHub</span>{snapshot.repository ? <button type="button" className="text-button" onClick={() => void run(window.asteriumUpdates?.openReleases)}>{snapshot.repository}</button> : <span>待配置</span>}</div>
      <label><span>启动时自动检查更新</span><input type="checkbox" checked={settings.checkUpdatesAtStartup} disabled={!snapshot.configured || !available || saving} onChange={event => void update({ checkUpdatesAtStartup: event.target.checked })} /></label>
      <label><span>接收测试版更新</span><input type="checkbox" checked={settings.includePrereleaseUpdates} disabled={!snapshot.configured || !available || saving} onChange={event => void update({ includePrereleaseUpdates: event.target.checked })} /></label>
    </section>
    {settingsError && <p role="alert">{settingsError}</p>}
    {snapshot.release?.notes && <details className="about-details"><summary>新版本说明 · {snapshot.release.version}</summary><pre className="about-notice-text">{snapshot.release.notes}</pre></details>}
    <details className="about-details"><summary>许可证与致谢</summary>
      <p>自有代码采用 MPL-2.0，素材与品牌范围另列。第三方条款各自适用；Electron 与 Chromium 声明另随应用目录提供。</p>
      {noticeDocuments.map(document => <NoticeDocument key={document.title} {...document} />)}
    </details>
    {confirmInstall && <Modal title="退出星丛并安装更新？" description="这会结束当前任务并打开新版安装向导。已有 Beta 资料会保留；请先保存正在编辑的内容。" onClose={() => setConfirmInstall(false)}>
      <footer className="modal-footer"><button className="secondary-button" type="button" onClick={() => setConfirmInstall(false)}>暂不安装</button><button className="primary-button" type="button" onClick={() => { setConfirmInstall(false); void run(window.asteriumUpdates?.install); }}>确认退出并安装</button></footer>
    </Modal>}
  </div>;
}
