import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, loadAppearance, normalizeAppearance } from '../../src/renderer/app/appearance';
import { useAppearance } from '../../src/renderer/app/useAppearance';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { SettingsPage } from '../../src/renderer/pages/SettingsPage';

afterEach(() => vi.unstubAllGlobals());
function systemTheme(dark = false) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = { matches: dark, addEventListener: vi.fn((_name, callback) => listeners.add(callback)), removeEventListener: vi.fn((_name, callback) => listeners.delete(callback)) };
  vi.stubGlobal('matchMedia', () => media);
  return { listeners, change: (matches: boolean) => { media.matches = matches; act(() => listeners.forEach((listener) => listener({ matches } as MediaQueryListEvent))); } };
}

describe('appearance preferences', () => {
  it('reports storage exhaustion without crashing or changing the visible preference', () => {
    const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    try {
      const view = renderHook(useAppearance);
      expect(view.result.current.appearance).toEqual(DEFAULT_APPEARANCE);
      expect(view.result.current.appearanceError).toMatch(/保存失败/);
      act(() => view.result.current.updateAppearance({ contentSize: 20 }));
      expect(view.result.current.appearance.contentSize).toBe(20);
      expect(view.result.current.appearanceError).toMatch(/保存失败/);
    } finally { fail.mockRestore(); }
  });
  it('recovers hidden UI customization while retaining theme, reading preferences and CSS draft', () => {
    let recover: (() => void) | undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal('asteriumAppearance', { setTitlebarTheme: vi.fn(), onRecovery: (callback: () => void) => { recover = callback; return unsubscribe; } });
    const view = renderHook(useAppearance);
    act(() => view.result.current.updateAppearance({ theme: 'sea-letter', contentSize: 20, customization: { ...DEFAULT_APPEARANCE.customization, messageStyle: 'plain', css: 'body { display:none; }', cssEnabled: false } }));
    act(() => recover!());
    expect(view.result.current.appearance).toMatchObject({ theme: 'sea-letter', contentSize: 20, customization: { messageStyle: 'bubble', cssEnabled: false, css: 'body { display:none; }' } });
    view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it.each(['forest', 'violet'])('migrates retired %s to Star while keeping mode, sizes and fonts', (retired) => {
    const expected = { ...DEFAULT_APPEARANCE, mode: 'dark', theme: 'asterium', uiSize: 16, contentSize: 20, codeSize: 14, font: 'kai', codeFont: 'courier' };
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ ...expected, theme: retired }));
    expect(loadAppearance()).toEqual(expected);
    const view = renderHook(useAppearance);
    expect(view.result.current.appearance).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!)).toEqual(expected);
  });
  it.each(['rainy-study', 'olympian-garden'] as const)('persists %s while light/dark follows the system and keeps independent reading preferences', (palette) => {
    const system = systemTheme();
    const view = renderHook(useAppearance);
    act(() => view.result.current.updateAppearance({ theme: palette, contentSize: 20, codeSize: 16, font: 'yahei' }));
    system.change(true);
    expect(document.documentElement.dataset).toMatchObject({ colorTheme: palette, theme: 'dark' });
    system.change(false);
    expect(document.documentElement.dataset).toMatchObject({ colorTheme: palette, theme: 'light' });
    view.unmount();
    const reopened = renderHook(useAppearance);
    expect(reopened.result.current.appearance).toMatchObject({ theme: palette, mode: 'system', contentSize: 20, codeSize: 16, font: 'yahei' });
    act(() => reopened.result.current.updateAppearance({ theme: 'asterium' }));
    expect(reopened.result.current.appearance).toMatchObject({ theme: 'asterium', contentSize: 20, codeSize: 16, font: 'yahei' });
  });
  it('migrates legacy light/dark and safely recovers damaged preferences', () => {
    localStorage.setItem('asterium.theme.v1', 'dark');
    expect(loadAppearance()).toEqual({ ...DEFAULT_APPEARANCE, mode: 'dark' });
    localStorage.setItem(APPEARANCE_KEY, '{broken');
    expect(loadAppearance().mode).toBe('dark');
    localStorage.removeItem('asterium.theme.v1');
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
  });
  it('clamps sizes and rejects unknown palettes and font keys', () => {
    expect(normalizeAppearance({ uiSize: 100, contentSize: -5, codeSize: NaN, mode: 'unknown', theme: 'custom', font: '__proto__', codeFont: 'unknown' })).toEqual({ ...DEFAULT_APPEARANCE, uiSize: 18, contentSize: 12 });
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  });
  it('follows live system changes only in system mode and cleans up listeners', () => {
    const system = systemTheme();
    const view = renderHook(useAppearance);
    expect(view.result.current.theme).toBe('light');
    expect(view.result.current.appearance.mode).toBe('system');
    system.change(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!).mode).toBe('system');
    act(() => view.result.current.setTheme('light'));
    system.change(false); system.change(true);
    expect(view.result.current.theme).toBe('light');
    act(() => view.result.current.updateAppearance({ mode: 'system' }));
    expect(view.result.current.theme).toBe('dark');
    view.unmount();
    expect(system.listeners.size).toBe(0);
  });
  it('saves independent sizes and fonts and restores them after remounting', () => {
    const view = renderHook(useAppearance);
    act(() => view.result.current.updateAppearance({ uiSize: 18, contentSize: 20, codeSize: 16, font: 'song', codeFont: 'cascadia', theme: 'sea-letter' }));
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--ui-font-scale')).toBe(String(18 / 14));
    expect(root.style.getPropertyValue('--content-font-size')).toBe('20px');
    expect(root.style.getPropertyValue('--code-font-size')).toBe('16px');
    expect(root.style.getPropertyValue('--app-font-family')).toContain('SimSun');
    expect(root.style.getPropertyValue('--code-font-family')).toContain('Cascadia Code');
    view.unmount();
    const next = renderHook(useAppearance);
    expect(next.result.current.appearance).toMatchObject({ uiSize: 18, contentSize: 20, codeSize: 16, theme: 'sea-letter', font: 'song', codeFont: 'cascadia' });
  });
  it('keeps titlebar colors synchronized with the resolved system mode', () => {
    const titlebar = vi.fn();
    vi.stubGlobal('asteriumAppearance', { setTitlebarTheme: titlebar });
    const system = systemTheme();
    renderHook(useAppearance);
    expect(titlebar).toHaveBeenLastCalledWith('light');
    system.change(true);
    expect(titlebar).toHaveBeenLastCalledWith('dark');
  });
});

describe('appearance settings page', () => {
  it('offers the four supported themes and supports choosing Sea Letter', () => {
    render(<MemoryRouter initialEntries={['/settings/partners?section=appearance']}><PrototypeProvider><SettingsPage /></PrototypeProvider></MemoryRouter>);
    for (const name of ['星海', '雨窗书房', '海风来信', '众神的后花园']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '森林' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '暮紫' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '海风来信' }));
    expect(document.documentElement.dataset.colorTheme).toBe('sea-letter');
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!)).toEqual(DEFAULT_APPEARANCE);
  });
  it('offers the study theme in the existing appearance page and restores the original default', () => {
    render(<MemoryRouter initialEntries={['/settings/partners?section=appearance']}><PrototypeProvider><SettingsPage /></PrototypeProvider></MemoryRouter>);
    const choice = screen.getByRole('button', { name: '雨窗书房' });
    fireEvent.click(choice);
    expect(choice).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.dataset.colorTheme).toBe('rainy-study');
    expect(screen.getByText(/书房背景随显示模式切换/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(choice).toHaveAttribute('aria-pressed', 'false');
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!)).toEqual(DEFAULT_APPEARANCE);
  });
  it('opens a dedicated page from the navigation without toggling colors', () => {
    render(<MemoryRouter initialEntries={['/settings/partners']}><PrototypeProvider><SettingsPage /></PrototypeProvider></MemoryRouter>);
    const mode = document.documentElement.dataset.theme;
    fireEvent.click(screen.getByRole('button', { name: /^外观/ }));
    expect(screen.getByRole('heading', { name: '外观' })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe(mode);
    expect(screen.getByRole('radio', { name: '随系统变化' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    fireEvent.click(screen.getByRole('button', { name: '海风来信' }));
    fireEvent.change(screen.getByRole('slider', { name: '内容字体大小' }), { target: { value: '22' } });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.colorTheme).toBe('sea-letter');
    expect(document.documentElement.style.getPropertyValue('--content-font-size')).toBe('22px');
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!)).toEqual(DEFAULT_APPEARANCE);
  });
  it('supports a direct appearance settings link', () => {
    render(<MemoryRouter initialEntries={['/settings/partners?section=appearance']}><PrototypeProvider><SettingsPage /></PrototypeProvider></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '外观' })).toBeInTheDocument();
    expect(screen.getByLabelText('界面与内容字体')).toBeInTheDocument();
    expect(screen.getByLabelText('代码字体')).toBeInTheDocument();
  });
});
