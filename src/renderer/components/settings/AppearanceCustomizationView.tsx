import { useRef, useState } from 'react';
import { Code, Download, ImagePlus, MessageSquare, PanelsTopLeft, Upload } from 'lucide-react';
import { usePrototype } from '../../app/PrototypeProvider';
import { compileCustomCss, CSS_LIMIT, normalizeMode, PANEL_ZONES, type ModeCustomization, type SurfaceOverride } from '../../app/appearanceCustomization';
import { BUNDLE_BYTES, pruneWallpapers, saveWallpaper } from '../../app/appearanceImages';
import { loadAppearance } from '../../app/appearance';
import { exportAppearance, installAppearanceBundle, readAppearanceBundle } from '../../app/appearanceBundle';

const panelNames = { left: '左栏', center: '中栏', right: '右栏', canvas: '聊天画布', cards: '右栏卡片' };
function Slider({ label, value, min = 0, max = 100, unit = '%', onChange }: { label: string; value: number; min?: number; max?: number; unit?: string; onChange: (value: number) => void }) {
  return <label className="appearance-control"><span>{label}</span><input type="range" aria-label={label} min={min} max={max} value={value} onChange={event => onChange(Number(event.target.value))} /><output>{value}{unit}</output></label>;
}
function Surface({ name, value, defaultColor, change, blur = true }: { name: string; value: SurfaceOverride; defaultColor: string; change: (value: SurfaceOverride) => void; blur?: boolean }) {
  return <fieldset className="appearance-surface"><legend>{name}</legend>
    <label className="appearance-control"><span>自定义底色</span><input type="checkbox" aria-label={`${name}自定义底色`} checked={value.color !== null || value.opacity !== null} onChange={event => change({ ...value, color: event.target.checked ? defaultColor : null, opacity: event.target.checked ? 90 : null })} /></label>
    {(value.color !== null || value.opacity !== null) && <>
      <label className="appearance-control"><span>颜色</span><input type="color" aria-label={`${name}颜色`} value={value.color ?? defaultColor} onChange={event => change({ ...value, color: event.target.value })} /></label>
      <Slider label={`${name}背景不透明度`} value={value.opacity ?? 100} onChange={opacity => change({ ...value, color: value.color ?? defaultColor, opacity })} />
    </>}
    {blur && <><label className="appearance-control"><span>自定义磨砂</span><input type="checkbox" aria-label={`${name}自定义磨砂`} checked={value.blur !== null} onChange={event => change({ ...value, blur: event.target.checked ? 12 : null })} /></label>
      {value.blur !== null && <Slider label={`${name}磨砂强度`} max={30} unit="px" value={value.blur} onChange={next => change({ ...value, blur: next })} />}</>}
  </fieldset>;
}
function CssEditor({ css, enabled, save }: { css: string; enabled: boolean; save: (css: string, enabled: boolean) => void }) {
  const [draft, setDraft] = useState(css), [error, setError] = useState('');
  function apply() {
    try { compileCustomCss(draft); save(draft, true); setError(''); } catch (error) { setError(error instanceof Error ? error.message : 'CSS 无法应用。'); }
  }
  return <>
    <p className="appearance-hint">CSS 覆盖主题和上方设置。输入不会立即生效，点击应用后保存。支持深浅色选择器；图片请通过背景导入，不支持 @import 和图片地址。</p>
    <textarea className="appearance-css" aria-label="自定义 CSS" spellCheck={false} maxLength={CSS_LIMIT} value={draft} onChange={event => setDraft(event.target.value)} placeholder={":root[data-theme='dark'] .message-bubble {\n  border-radius: 18px;\n}"} />
    <div className="appearance-actions"><button className="secondary-button" type="button" onClick={apply}>应用 CSS</button><button className="secondary-button" type="button" disabled={!enabled} onClick={() => save(css, false)}>停用 CSS</button><button className="secondary-button" type="button" onClick={() => setDraft(".message-bubble { border-radius: 18px !important; }\n:root[data-theme='dark'] { --text-strong: #f0eadc; }")}>填入示例</button><small>{enabled ? '已启用' : '已停用'} · {draft.length}/{CSS_LIMIT}</small></div>
    {error && <p className="appearance-notice" role="alert">{error}</p>}
    <p className="appearance-hint">界面被隐藏时按 Ctrl+Shift+F12：停用 CSS 和自定义外观，保留主题、字体字号与 CSS 草稿。下方可查看常用选择器。</p>
    <details><summary>常用样式入口</summary><p className="appearance-hint">.message-bubble：消息正文框；.message-row--mine：自己的消息；.chat-left / .studio-left：左栏；.center-stage / .studio-center：中栏；.right-rail：右栏。深浅色用 :root[data-theme='light'] 或 :root[data-theme='dark'] 区分。优先修改 --text、--text-strong、--muted 等颜色变量。</p></details>
  </>;
}

export function AppearanceCustomizationView() {
  const { appearance, updateAppearance, theme, appearanceError } = usePrototype();
  const custom = appearance.customization, mode = custom[theme];
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Awaited<ReturnType<typeof readAppearanceBundle>> | null>(null);
  const imageInput = useRef<HTMLInputElement>(null), bundleInput = useRef<HTMLInputElement>(null);
  const patch = (next: Partial<typeof custom>) => updateAppearance({ customization: { ...custom, ...next } });
  const patchMode = (next: Partial<ModeCustomization>) => patch({ [theme]: { ...mode, ...next } });
  async function task(action: () => Promise<void>) {
    setBusy(true); setNotice('');
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败，请重试。'); } finally { setBusy(false); }
  }
  return <div className="appearance-extra">
    {appearanceError && <p className="appearance-notice" role="status">{appearanceError}</p>}
    <section className="appearance-card"><h2><MessageSquare size={18} />消息样式</h2><div className="appearance-message-style">{([{ id: 'bubble', name: '气泡', hint: '保留独立气泡与左右对话' }, { id: 'plain', name: '简洁', hint: '去掉气泡，自己在右、伙伴在左' }] as const).map(item => <button type="button" key={item.id} aria-pressed={custom.messageStyle === item.id} onClick={() => patch({ messageStyle: item.id })}><strong>{item.name}</strong><small>{item.hint}</small></button>)}</div><p className="appearance-hint">适用于单聊和群聊，所有主题均可使用。简洁模式默认加上阅读底色，可在聊天画布设置中覆盖。</p></section>
    <details className="appearance-card"><summary><ImagePlus size={18} />自定义背景 · {theme === 'dark' ? '深色' : '浅色'}</summary>
      <p className="appearance-hint">这里修改当前显示模式，浅色和深色分别保存。切换上方显示模式可编辑另一套。PNG、JPEG、WebP，单张不超过 10 MB；导入后移动原文件不影响背景。</p>
      <label className="appearance-control"><span>显示背景图</span><input type="checkbox" aria-label="显示背景图" checked={mode.background.visible} onChange={event => patchMode({ background: { ...mode.background, visible: event.target.checked } })} /></label>
      <input ref={imageInput} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="背景图片文件" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
        const target = theme;
        void task(async () => { const id = await saveWallpaper(file); updateAppearance(current => ({ customization: { ...current.customization, [target]: { ...current.customization[target], background: { ...current.customization[target].background, imageId: id, visible: true } } } })); setNotice('背景已导入并保存。'); });
      }} />
      <div className="appearance-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => imageInput.current?.click()}>选择背景图片</button><button className="secondary-button" type="button" onClick={() => patchMode({ background: normalizeMode(null, theme).background })}>恢复此模式的主题背景</button><small>{mode.background.imageId ? '已使用本地导入图片' : '使用主题背景'}</small></div>
      <label className="appearance-control"><span>图片适配</span><select aria-label="图片适配" value={mode.background.fit} onChange={event => patchMode({ background: { ...mode.background, fit: event.target.value as 'cover' | 'contain' } })}><option value="cover">铺满（裁切边缘）</option><option value="contain">完整显示</option></select></label>
      <Slider label="背景水平位置" value={mode.background.x} onChange={x => patchMode({ background: { ...mode.background, x } })} />
      <Slider label="背景垂直位置" value={mode.background.y} onChange={y => patchMode({ background: { ...mode.background, y } })} />
      <Slider label="背景模糊" max={24} unit="px" value={mode.background.blur} onChange={blur => patchMode({ background: { ...mode.background, blur } })} />
      <label className="appearance-control"><span>背景遮罩颜色</span><input type="color" aria-label="背景遮罩颜色" value={mode.background.overlayColor} onChange={event => patchMode({ background: { ...mode.background, overlayColor: event.target.value } })} /></label>
      <Slider label="背景遮罩不透明度" value={mode.background.overlayOpacity} onChange={overlayOpacity => patchMode({ background: { ...mode.background, overlayOpacity } })} />
    </details>
    <details className="appearance-card"><summary><PanelsTopLeft size={18} />三栏与消息外观 · {theme === 'dark' ? '深色' : '浅色'}</summary>
      <p className="appearance-hint">只调整底色，文字与按钮不会一起变淡。0% 完全透明，100% 不透明；磨砂独立控制。未开启的项目继续使用主题默认。</p>
      {PANEL_ZONES.map(zone => <Surface key={zone} name={panelNames[zone]} value={mode.panels[zone]} defaultColor={theme === 'dark' ? '#202c40' : '#f8faf7'} change={value => patchMode({ panels: { ...mode.panels, [zone]: value } })} />)}
      {custom.messageStyle === 'bubble' && <><Surface name="自己的气泡" value={mode.bubbles.mine} defaultColor={theme === 'dark' ? '#354655' : '#e8eff0'} blur={false} change={mine => patchMode({ bubbles: { ...mode.bubbles, mine } })} /><Surface name="伙伴的气泡" value={mode.bubbles.partner} defaultColor={theme === 'dark' ? '#202c40' : '#f8faf7'} blur={false} change={partner => patchMode({ bubbles: { ...mode.bubbles, partner } })} /><label className="appearance-control"><span>自定义气泡圆角</span><input type="checkbox" aria-label="自定义气泡圆角" checked={mode.bubbles.radius !== null} onChange={event => patchMode({ bubbles: { ...mode.bubbles, radius: event.target.checked ? 12 : null } })} /></label>{mode.bubbles.radius !== null && <Slider label="气泡圆角" max={32} unit="px" value={mode.bubbles.radius} onChange={radius => patchMode({ bubbles: { ...mode.bubbles, radius } })} />}</>}
      <div className="appearance-actions"><button className="secondary-button" type="button" onClick={() => { const defaults = normalizeMode(null, theme); patchMode({ panels: defaults.panels, bubbles: defaults.bubbles }); }}>恢复此模式的面板与气泡</button></div>
    </details>
    <details className="appearance-card"><summary><Code size={18} />自定义 CSS · 高级</summary><CssEditor key={custom.css} css={custom.css} enabled={custom.cssEnabled} save={(css, cssEnabled) => patch({ css, cssEnabled })} /></details>
    <details className="appearance-card"><summary><Download size={18} />导入与导出</summary>
      <p className="appearance-hint">导出当前主题、深浅色覆盖、字体字号、CSS 和两张自定义背景。不会包含聊天、伙伴或凭据。导入的 CSS 默认停用，查看后再应用。</p>
      <input ref={bundleInput} hidden type="file" accept=".json,application/json" aria-label="外观配置文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; void task(async () => { if (file.size > BUNDLE_BYTES) throw new Error('主题包最多 30 MB。'); setPending(await readAppearanceBundle(await file.text())); }); }} />
      <div className="appearance-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => bundleInput.current?.click()}><Upload size={14} />导入外观</button><button className="secondary-button" type="button" disabled={busy} onClick={() => void task(async () => { const text = await exportAppearance(appearance), url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = '星丛外观.asterium-theme.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('外观配置已导出。'); })}><Download size={14} />导出外观</button></div>
      {pending && <div className="appearance-notice"><p>将导入 {pending.images.size} 张背景，替换当前外观设置；CSS 保持停用。</p><div className="appearance-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => void task(async () => { updateAppearance(await installAppearanceBundle(pending)); setPending(null); setNotice('外观已导入，CSS 草稿可在高级区查看。'); })}>导入并应用</button><button className="secondary-button" type="button" onClick={() => setPending(null)}>取消导入</button></div></div>}
    </details>
    <button className="text-button" type="button" disabled={busy} onClick={() => void task(async () => { const saved = loadAppearance().customization; await pruneWallpapers([saved.light.background.imageId, saved.dark.background.imageId, custom.light.background.imageId, custom.dark.background.imageId].filter((id): id is string => Boolean(id))); setNotice('未使用的背景图片已清理，当前深浅背景保留。'); })}>清理未使用的背景图片</button>
    {(notice || busy) && <p className="appearance-notice" role="status">{busy ? '正在处理…' : notice}</p>}
  </div>;
}
