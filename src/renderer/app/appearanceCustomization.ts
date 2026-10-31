export const PANEL_ZONES = ['left', 'center', 'right', 'canvas', 'cards'] as const;
export type PanelZone = typeof PANEL_ZONES[number];
export type AppearanceMode = 'light' | 'dark';
export interface SurfaceOverride { color: string | null; opacity: number | null; blur: number | null }
export interface ModeCustomization {
  background: { imageId: string | null; visible: boolean; fit: 'cover' | 'contain'; x: number; y: number; blur: number; overlayColor: string; overlayOpacity: number };
  panels: Record<PanelZone, SurfaceOverride>;
  bubbles: { mine: SurfaceOverride; partner: SurfaceOverride; radius: number | null };
}
export interface AppearanceCustomization {
  messageStyle: 'bubble' | 'plain';
  light: ModeCustomization;
  dark: ModeCustomization;
  css: string;
  cssEnabled: boolean;
}
export const CSS_LIMIT = 64_000;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown, min: number, max: number, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(min, Math.min(max, v))) : fallback;
const hex = (v: unknown): string | null => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v) ? v.toLowerCase() : null;
function surface(v: unknown): SurfaceOverride {
  const r = record(v);
  return { color: hex(r.color), opacity: r.opacity == null ? null : number(r.opacity, 0, 100, 100), blur: r.blur == null ? null : number(r.blur, 0, 30, 0) };
}
export function normalizeMode(v: unknown, mode: AppearanceMode): ModeCustomization {
  const r = record(v), b = record(r.background), panels = record(r.panels), bubbles = record(r.bubbles);
  return {
    background: { imageId: typeof b.imageId === 'string' && /^[a-f0-9]{64}$/.test(b.imageId) ? b.imageId : null, visible: b.visible !== false,
      fit: b.fit === 'contain' ? 'contain' : 'cover', x: number(b.x, 0, 100, 50), y: number(b.y, 0, 100, 50), blur: number(b.blur, 0, 24, 0),
      overlayColor: hex(b.overlayColor) ?? (mode === 'dark' ? '#0b1424' : '#ffffff'), overlayOpacity: number(b.overlayOpacity, 0, 100, 0) },
    panels: Object.fromEntries(PANEL_ZONES.map(zone => [zone, surface(panels[zone])])) as ModeCustomization['panels'],
    bubbles: { mine: surface(bubbles.mine), partner: surface(bubbles.partner), radius: bubbles.radius == null ? null : number(bubbles.radius, 0, 32, 8) },
  };
}
export function normalizeCustomization(v: unknown): AppearanceCustomization {
  const r = record(v);
  return { messageStyle: r.messageStyle === 'plain' ? 'plain' : 'bubble', light: normalizeMode(r.light, 'light'), dark: normalizeMode(r.dark, 'dark'),
    css: typeof r.css === 'string' ? r.css.slice(0, CSS_LIMIT) : '', cssEnabled: r.cssEnabled === true };
}
export function rgba(color: string, opacity: number) {
  return `rgba(${[1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)).join(', ')}, ${opacity / 100})`;
}
const selectors: Record<PanelZone, string> = {
  left: ':is(.app-grid > .chat-left, .app-grid > .studio-left, [data-appearance-panel=left])', center: ':is(.app-grid > .center-stage, .app-grid > .studio-center, [data-appearance-panel=center])',
  right: ':is(.app-grid > .right-rail, .app-grid > .studio-right, [data-appearance-panel=right])', canvas: ':is(.message-canvas, .discussion-view, .workspace-view)',
  cards: ':is(.right-rail > .side-section, .right-rail > .partner-quick-card, .studio-right > .studio-side-card)',
};
// Generated rules have validated values only. Unset fields continue inheriting the chosen theme.
export function customizationCss(settings: AppearanceCustomization, mode: AppearanceMode): string {
  const value = settings[mode];
  const rule = (selector: string, s: SurfaceOverride) => {
    const bg = s.color ? `background:${rgba(s.color, s.opacity ?? 100)};` : s.opacity != null ? `background:color-mix(in srgb,var(--surface-strong) ${s.opacity}%,transparent);` : '';
    return bg || s.blur != null ? `:root:root ${selector}{${bg}${s.blur != null ? `backdrop-filter:blur(${s.blur}px);` : ''}}` : '';
  };
  const rules = PANEL_ZONES.map(zone => rule(selectors[zone], value.panels[zone]));
  if (settings.messageStyle === 'bubble') {
    rules.push(rule(':is(.message-row--mine .message-bubble, .appearance-preview-mine)', value.bubbles.mine), rule(':is(.message-row:not(.message-row--mine) .message-bubble, .appearance-preview .message-bubble)', value.bubbles.partner));
    if (value.bubbles.radius != null) rules.push(`:root:root :is(.message-row .message-bubble, .appearance-preview .message-bubble, .appearance-preview-mine){border-radius:${value.bubbles.radius}px;}`);
  }
  return rules.filter(Boolean).join('\n');
}

// No network resources in pasted CSS. Backgrounds use the managed local image picker.
export function compileCustomCss(source: string): string {
  if (source.length > CSS_LIMIT) throw new Error('CSS 最多 64000 个字符。');
  const decoded = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([\da-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex, char) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char);
  if (/@import\b|url\s*\(|image-set\s*\(/i.test(decoded)) throw new Error('CSS 不支持外部导入或图片地址；背景请使用图片导入。');
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(source);
  const css = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
  if (decoded.trim() && !css) throw new Error('没有识别到有效 CSS 规则，请检查语法。');
  return css;
}
