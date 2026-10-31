import { AppearanceCustomizationView } from './AppearanceCustomizationView';
import { Check, Monitor, Moon, Palette, RotateCcw, Sun, Type } from 'lucide-react';
import { usePrototype } from '../../app/PrototypeProvider';
import { CODE_FONTS, COLOR_THEMES, DEFAULT_APPEARANCE, SIZE_LIMITS, TEXT_FONTS, type AppearanceSettings } from '../../app/appearance';

const modes = [{ id: 'light', name: '浅色', Icon: Sun }, { id: 'dark', name: '深色', Icon: Moon }, { id: 'system', name: '随系统变化', Icon: Monitor }] as const;
const sizes = [{ id: 'uiSize', label: '界面字号', description: '导航、按钮、卡片与设置' }, { id: 'contentSize', label: '内容字体大小', description: '聊天正文、输入框与文档预览' }, { id: 'codeSize', label: '代码字体大小', description: '代码块、源码与 diff 预览' }] as const;

export function AppearanceSettingsView() {
  const { appearance, updateAppearance, theme } = usePrototype();
  const themeHint = COLOR_THEMES.find(item => item.id === appearance.theme)?.hint;
  return <>
    <header className="settings-heading"><div><span><Palette size={24} /></span><div><h1>外观</h1><p>选择主题，调整适合自己的阅读方式。修改会自动保存。</p></div></div><button className="secondary-button" type="button" onClick={() => updateAppearance(DEFAULT_APPEARANCE)}><RotateCcw size={14} />恢复默认</button></header>
    <div className="appearance-settings">
      <div className="appearance-options">
        <section className="appearance-card"><h2><Sun size={18} />显示模式</h2>
          <div className="appearance-modes" role="radiogroup" aria-label="显示模式">{modes.map(({ id, name, Icon }) => <button key={id} type="button" role="radio" aria-checked={appearance.mode === id} onClick={() => updateAppearance({ mode: id })}><Icon size={21} /><span>{name}</span>{appearance.mode === id && <Check size={14} />}</button>)}</div>
          <p className="appearance-hint">{appearance.mode === 'system' ? `当前跟随系统使用${theme === 'dark' ? '深色' : '浅色'}模式。` : '固定使用所选模式。'}</p>
        </section>
        <section className="appearance-card"><h2><Palette size={18} />主题选择</h2><div className="appearance-themes">{COLOR_THEMES.map(({ id, name, colors }) => <button key={id} type="button" aria-pressed={appearance.theme === id} onClick={() => updateAppearance({ theme: id })}><span className={`appearance-swatches${id !== 'asterium' ? ` appearance-swatches--${id}` : ''}`} aria-hidden="true">{colors.map((color) => <i key={color} style={{ backgroundColor: color }} />)}</span><span>{name}{appearance.theme === id && <Check size={14} />}</span></button>)}</div>{themeHint && <p className="appearance-hint">{themeHint}</p>}</section>
        <section className="appearance-card"><h2><Type size={18} />字号与字体</h2>
          <div className="appearance-sizes">{sizes.map(({ id, label, description }) => <label key={id}><span><strong>{label}</strong><small>{description}</small></span><input type="range" aria-label={label} min={SIZE_LIMITS[id][0]} max={SIZE_LIMITS[id][1]} step="1" value={appearance[id]} onChange={(event) => updateAppearance({ [id]: Number(event.target.value) })} /><output>{appearance[id]} px</output></label>)}</div>
          <div className="appearance-fonts"><label>界面与内容字体<select aria-label="界面与内容字体" value={appearance.font} onChange={(event) => updateAppearance({ font: event.target.value as AppearanceSettings['font'] })}>{Object.entries(TEXT_FONTS).map(([id, font]) => <option key={id} value={id}>{font.label}</option>)}</select></label><label>代码字体<select aria-label="代码字体" value={appearance.codeFont} onChange={(event) => updateAppearance({ codeFont: event.target.value as AppearanceSettings['codeFont'] })}>{Object.entries(CODE_FONTS).map(([id, font]) => <option key={id} value={id}>{font.label}</option>)}</select></label></div>
          <p className="appearance-hint">字体使用本机安装的版本；未安装时会使用备用字体。界面字号按比例调整，内容与代码字号独立设置。</p>
        </section>
        <AppearanceCustomizationView />
      </div>
      <section className="appearance-card appearance-preview" aria-label="外观预览"><h2>实时预览 <small>已自动保存</small></h2><div className="appearance-preview__ui"><span>星丛 Asterium</span><span className="appearance-preview__tag">进行中</span></div><div className="appearance-mini-panels" aria-label="三栏底色预览"><span data-appearance-panel="left">左栏</span><span data-appearance-panel="center">中栏</span><span data-appearance-panel="right">右栏</span></div><p className="appearance-preview-mine">这是我发出的消息。</p><article className="message-bubble"><p>让想法在星丛中汇合。</p><p>这是聊天内容的预览。The next idea starts here.</p><pre><code>{'const hello = "你好，星丛";\nconsole.log(hello);'}</code></pre></article><p className="appearance-hint">此处会同步显示界面、内容和代码的字号与字体。</p></section>
    </div>
  </>;
}
