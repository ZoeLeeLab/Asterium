import { useCallback, useEffect, useState } from 'react';
import { APPEARANCE_KEY, CODE_FONTS, TEXT_FONTS, loadAppearance, normalizeAppearance, type AppearanceUpdate } from './appearance';
import { compileCustomCss, customizationCss, normalizeCustomization, rgba } from './appearanceCustomization';
import { readWallpaper } from './appearanceImages';
import type { ThemeMode } from '../types/domain';

export function useAppearance() {
  const [appearanceError, setAppearanceError] = useState<string | null>(null);
  const [appearance, setAppearance] = useState(loadAppearance);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const theme: ThemeMode = appearance.mode === 'system' ? systemDark ? 'dark' : 'light' : appearance.mode;
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.colorTheme = appearance.theme;
    root.style.setProperty('--ui-font-scale', String(appearance.uiSize / 14));
    root.style.setProperty('--ui-font-size', `${appearance.uiSize}px`);
    root.style.setProperty('--content-font-size', `${appearance.contentSize}px`);
    root.style.setProperty('--code-font-size', `${appearance.codeSize}px`);
    root.style.setProperty('--app-font-family', TEXT_FONTS[appearance.font].family);
    root.style.setProperty('--code-font-family', CODE_FONTS[appearance.codeFont].family);
    try {
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
      localStorage.setItem('asterium.theme.v1', appearance.mode);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- report external storage failures to the settings UI.
    } catch { setAppearanceError('外观保存失败，重启后可能无法保留。请检查本地存储空间。'); }
    void window.asteriumAppearance?.setTitlebarTheme(theme);
  }, [appearance, theme]);
  const updateAppearance = useCallback((patch: AppearanceUpdate) => { setAppearanceError(null); setAppearance((current) => normalizeAppearance({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) })); }, []);
  useEffect(() => {
    const recover = () => {
      setAppearance(current => ({ ...current, customization: { ...normalizeCustomization(null), css: current.customization.css } }));
      setAppearanceError('已恢复主题默认外观，自定义 CSS 已停用，草稿保留。');
      window.location.hash = '#/settings/partners?section=appearance&recovery=' + Date.now();
    };
    return window.asteriumAppearance?.onRecovery?.(recover);
  }, []);
  useEffect(() => {
    const root = document.documentElement, custom = appearance.customization;
    root.dataset.messageStyle = custom.messageStyle;
    const overrides = document.createElement('style'); overrides.id = 'asterium-appearance-overrides';
    overrides.textContent = customizationCss(custom, theme); document.head.append(overrides);
    const style = document.createElement('style'); style.id = 'asterium-user-css';
    if (custom.cssEnabled && custom.css.trim()) {
      try { style.textContent = compileCustomCss(custom.css); }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- recover from invalid persisted external CSS before it can hide the UI.
      catch (error) { setAppearanceError(String(error instanceof Error ? error.message : error)); setAppearance(current => ({ ...current, customization: { ...current.customization, cssEnabled: false } })); }
    }
    document.head.append(style);
    return () => { overrides.remove(); style.remove(); };
  }, [appearance.customization, theme]);
  const background = appearance.customization[theme].background;
  useEffect(() => {
    const root = document.documentElement;
    const isCustom = background.imageId || !background.visible || background.fit !== 'cover' || background.x !== 50 || background.y !== 50 || background.blur || background.overlayOpacity;
    root.toggleAttribute('data-custom-background', Boolean(isCustom));
    root.style.setProperty('--appearance-wallpaper-fit', background.fit);
    root.style.setProperty('--appearance-wallpaper-position', `${background.x}% ${background.y}%`);
    root.style.setProperty('--appearance-wallpaper-blur', `${background.blur}px`);
    root.style.setProperty('--appearance-wallpaper-overlay', rgba(background.overlayColor, background.overlayOpacity));
  }, [background]);
  const imageId = background.imageId, imageVisible = background.visible;
  useEffect(() => {
    const root = document.documentElement; let disposed = false, objectUrl: string | undefined;
    root.style.setProperty('--appearance-wallpaper', imageVisible ? 'var(--page-image)' : 'none');
    if (imageId && imageVisible) void readWallpaper(imageId).then(blob => {
      if (disposed) return;
      if (!blob) throw new Error('自定义背景已丢失，暂时显示主题原图，请重新导入。');
      objectUrl = URL.createObjectURL(blob); root.style.setProperty('--appearance-wallpaper', `url("${objectUrl}")`);
    }).catch(error => { if (!disposed) setAppearanceError(error instanceof Error ? error.message : '背景读取失败。'); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [imageId, imageVisible]);
  const setTheme = useCallback((mode: ThemeMode) => updateAppearance({ mode }), [updateAppearance]);
  const toggleTheme = useCallback(() => updateAppearance({ mode: theme === 'light' ? 'dark' : 'light' }), [theme, updateAppearance]);
  return { appearanceError, appearance, updateAppearance, theme, setTheme, toggleTheme };
}
