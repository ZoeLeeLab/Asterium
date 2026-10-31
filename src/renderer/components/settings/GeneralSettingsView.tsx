import { Settings2 } from 'lucide-react';
import { useGeneralSettings } from '../../app/useGeneralSettings';

export function GeneralSettingsView() {
  const { settings, startupSupported, loading, saving, error, update, reload, available } = useGeneralSettings();
  const disabled = loading || saving || !available;
  return <>
    <header className="settings-heading"><div><span><Settings2 size={24} /></span><div><h1>通用</h1><p>设置星丛的启动、消息发送与通知方式。修改会自动保存。</p></div></div><small role="status">{loading ? '正在读取…' : saving ? '正在保存…' : available && !error ? '已保存' : ''}</small></header>
    <div className="general-settings">
      {error && <div role="alert">{error}<button type="button" className="secondary-button" onClick={() => void reload()}>重新读取</button></div>}
      {!loading && !available && !error && <p role="status">桌面设置暂不可用，请在星丛桌面应用中打开。</p>}
      <section className="general-settings-card"><h2>启动与关闭</h2>
        <label className="general-settings-row"><span><strong>开启自启动</strong><small>{startupSupported ? '登录 Windows 时自动打开星丛。' : '自启动仅在支持的 Windows 打包应用中可用。'}</small></span><input type="checkbox" checked={settings.launchAtLogin} disabled={disabled || !startupSupported} onChange={e => void update({ launchAtLogin: e.target.checked })} /></label>
        <label className="general-settings-row"><span><strong>关闭主窗口时</strong><small>托盘运行时，任务和自动化会继续执行。</small></span><select aria-label="关闭主窗口时" value={settings.closeAction} disabled={disabled} onChange={e => void update({ closeAction: e.target.value as 'tray' | 'quit' })}><option value="tray">最小化到托盘</option><option value="quit">彻底退出</option></select></label>
      </section>
      <section className="general-settings-card"><h2>消息发送</h2><label className="general-settings-row"><span><strong>发送快捷键</strong><small>适用于单聊和群聊，Shift+Enter 始终换行。</small></span><select aria-label="发送快捷键" value={settings.sendShortcut} disabled={disabled} onChange={e => void update({ sendShortcut: e.target.value as 'enter' | 'ctrl_enter' })}><option value="enter">Enter 发送</option><option value="ctrl_enter">Ctrl+Enter 发送</option></select></label></section>
      <section className="general-settings-card"><h2>系统通知</h2><p>仅在星丛处于后台、最小化或收进托盘时发送。</p>{([{ key: 'completed', label: '任务完成' }, { key: 'approval', label: '等待审批' }, { key: 'automationFailed', label: '自动化失败' }] as const).map(({ key, label }) => <label className="general-settings-row" key={key}><span><strong>{label}</strong></span><input type="checkbox" checked={settings.notifications[key]} disabled={disabled} onChange={e => void update({ notifications: { [key]: e.target.checked } })} /></label>)}</section>
      <section className="general-settings-card"><h2>本地工具沙箱</h2><p>作用于 API 伙伴的命令、Skill 脚本、MCP stdio，以及 MCP 管理页的本地测试连接。切换会结束受影响的本地任务与连接，需重新发起操作。</p>
        <label className="general-settings-row"><span><strong>启用沙箱</strong><small>Full 始终使用 Native。管理员启动的星丛无法使用沙箱；不可用时会明确报错。</small></span><input type="checkbox" checked={settings.sandboxEnabled} disabled={disabled} onChange={e => void update({ sandboxEnabled: e.target.checked })} /></label>
        <label className="general-settings-row"><span><strong>允许沙箱进程联网</strong><small>不影响网页工具、HTTP MCP、模型连接或 Native 进程。</small></span><input type="checkbox" checked={settings.sandboxAllowNetwork} disabled={disabled || !settings.sandboxEnabled} onChange={e => void update({ sandboxAllowNetwork: e.target.checked })} /></label>
      </section>
      <section className="general-settings-card"><h2>语言</h2><label className="general-settings-row"><span><strong>界面语言</strong><small>目前支持简体中文。</small></span><select aria-label="界面语言" value="zh-CN" disabled><option value="zh-CN">简体中文</option></select></label></section>
      <section className="general-settings-card"><h2>更新</h2><label className="general-settings-row"><span><strong>启动时自动检查更新</strong><small>尚未配置更新源，暂不可用。</small></span><input type="checkbox" checked={false} disabled readOnly /></label></section>
    </div>
  </>;
}
