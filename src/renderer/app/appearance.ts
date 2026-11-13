import { normalizeCustomization, type AppearanceCustomization } from './appearanceCustomization';
export type ColorMode = 'light' | 'dark' | 'system';
export type ColorTheme = 'asterium' | 'rainy-study' | 'sea-letter' | 'olympian-garden' | 'alice-wonderland';
export const COLOR_THEMES = [
  { id: 'asterium', name: '星海', colors: ['#edf3fa', '#8eaad0', '#385474'], hint: '' },
  { id: 'rainy-study', name: '雨窗书房', colors: ['#f5eee1', '#b99563', '#263345'], hint: '雨日的暖纸色，雨夜的墨蓝与灯光。书房背景随显示模式切换。' },
  { id: 'sea-letter', name: '海风来信', colors: ['#f4f8f7', '#7eafc5', '#192e50'], hint: '晴日的海盐白，月下的海蓝与灯火。海边背景随显示模式切换。' },
  { id: 'olympian-garden', name: '众神的后花园', colors: ['#f8f7f1', '#b09a66', '#28354b'], hint: '日光下的白花与石柱，月色中的神殿与花园。背景随显示模式切换。' },
  { id: 'alice-wonderland', name: '爱丽丝梦游仙境', colors: ['#deedf7', '#586d91', '#383b52'], hint: '浅色是洛可可茶会，深色是月下奇境花园。' },
] as const satisfies readonly { id: ColorTheme; name: string; colors: readonly string[]; hint: string }[];
export const APPEARANCE_KEY = 'asterium.appearance.v1';
export const TEXT_FONTS = {
  system: { label: '系统默认', family: '"Segoe UI Variable", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif' },
  yahei: { label: '微软雅黑', family: '"Microsoft YaHei", "Microsoft YaHei UI", sans-serif' },
  song: { label: '宋体', family: 'SimSun, "Noto Serif CJK SC", serif' },
  kai: { label: '楷体', family: 'KaiTi, STKaiti, serif' },
} as const;
export const CODE_FONTS = {
  consolas: { label: 'Consolas', family: 'Consolas, "Cascadia Code", monospace' },
  cascadia: { label: 'Cascadia Code', family: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  courier: { label: 'Courier New', family: '"Courier New", Consolas, monospace' },
} as const;
export interface AppearanceSettings {
  customization: AppearanceCustomization;
  mode: ColorMode;
  theme: ColorTheme;
  uiSize: number;
  contentSize: number;
  codeSize: number;
  font: keyof typeof TEXT_FONTS;
  codeFont: keyof typeof CODE_FONTS;
}
export type AppearanceUpdate = Partial<AppearanceSettings> | ((current: AppearanceSettings) => Partial<AppearanceSettings>);
export const DEFAULT_APPEARANCE: AppearanceSettings = { customization: normalizeCustomization(null), mode: 'system', theme: 'asterium', uiSize: 14, contentSize: 14, codeSize: 12, font: 'system', codeFont: 'consolas' };
export const SIZE_LIMITS = { uiSize: [12, 18], contentSize: [12, 24], codeSize: [10, 22] } as const;
function size(value: unknown, fallback: number, range: readonly [number, number]) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(range[1], Math.max(range[0], Math.round(value))) : fallback;
}
export function normalizeAppearance(input: unknown): AppearanceSettings {
  const value = input && typeof input === 'object' ? input as Partial<AppearanceSettings> : {};
  return {
    customization: normalizeCustomization(value.customization),
    mode: ['light', 'dark', 'system'].includes(value.mode ?? '') ? value.mode! : DEFAULT_APPEARANCE.mode,
    // Retired forest/violet preferences fall back without resetting reading settings.
    theme: COLOR_THEMES.some(theme => theme.id === value.theme) ? value.theme! : DEFAULT_APPEARANCE.theme,
    uiSize: size(value.uiSize, 14, SIZE_LIMITS.uiSize), contentSize: size(value.contentSize, 14, SIZE_LIMITS.contentSize), codeSize: size(value.codeSize, 12, SIZE_LIMITS.codeSize),
    font: Object.hasOwn(TEXT_FONTS, value.font ?? '') ? value.font! : 'system',
    codeFont: Object.hasOwn(CODE_FONTS, value.codeFont ?? '') ? value.codeFont! : 'consolas',
  };
}
export function loadAppearance(): AppearanceSettings {
  try {
    const saved = localStorage.getItem(APPEARANCE_KEY);
    if (saved) return normalizeAppearance(JSON.parse(saved));
  } catch { /* A damaged preference falls back to the previous color setting. */ }
  const oldMode = localStorage.getItem('asterium.theme.v1');
  return { ...DEFAULT_APPEARANCE, ...(oldMode === 'dark' || oldMode === 'light' ? { mode: oldMode } : {}) };
}
