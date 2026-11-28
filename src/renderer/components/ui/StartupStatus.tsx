import '../../styles/startup.css';

export function StartupStatus({ failed, onRetry, onQuit }: { failed: boolean; onRetry: () => void; onQuit?: () => void }) {
  // Readiness belongs to the history provider. This view never delays unmount
  // for a timer, animationend or an exit transition.
  return <div className="app-viewport startup-view" data-failed={failed || undefined}>
    <div className="window-drag-strip" aria-hidden="true" />
    <section className="startup-scene" aria-label="资料加载">
      <div className="startup-dust" aria-hidden="true" />
      <div className="startup-glow" aria-hidden="true" />
      <div className="startup-orbit" aria-hidden="true" />
      <div className="startup-envelope" aria-hidden="true"><div className="startup-envelope-back" /><div className="startup-envelope-front" /><span>· · ·</span></div>
      <div className="startup-hero" aria-hidden="true"><StartupStar hero /></div>
      <div className="startup-companions" aria-hidden="true">
        {[0, 1, 2, 3].map(index => <div className="startup-companion" key={index}>
          <StartupStar />
          <div className="startup-carried"><span /><span /><span /></div>
        </div>)}
      </div>
      <div className="startup-status" role={failed ? 'alert' : 'status'} aria-live="polite">
        <p>{failed ? '单聊资料暂时无法打开。' : '伙伴们正在归来'}</p>
        {failed && <><p className="startup-error-detail">请检查磁盘空间和访问权限，再重试。</p><button className="primary-button" type="button" onClick={onRetry}>重试</button>{onQuit && <button className="startup-quit" type="button" onClick={onQuit}>退出</button>}</>}
      </div>
    </section>
  </div>;
}

function StartupStar({ hero = false }: { hero?: boolean }) {
  return <div className={`startup-character${hero ? ' startup-character--hero' : ''}`}>
    <div className="startup-star-body"><div className="startup-star-shine" /></div>
    <div className="startup-face">
      <span className="startup-eye startup-eye--left"><i /></span><span className="startup-eye startup-eye--right"><i /></span>
      <span className="startup-cheek startup-cheek--left" /><span className="startup-cheek startup-cheek--right" /><span className="startup-mouth" />
    </div>
  </div>;
}
