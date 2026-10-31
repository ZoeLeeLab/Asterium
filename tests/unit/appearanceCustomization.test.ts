import { describe, expect, it, vi } from 'vitest';
import { normalizeAppearance, DEFAULT_APPEARANCE } from '../../src/renderer/app/appearance';
import { compileCustomCss, customizationCss, normalizeCustomization } from '../../src/renderer/app/appearanceCustomization';
import { installAppearanceRecovery } from '../../src/main/titlebar';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { BrowserWindow } from 'electron';

describe('appearance overrides', () => {
  it('migrates old preferences without changing any existing appearance choice', () => {
    expect(normalizeAppearance({ theme: 'olympian-garden', contentSize: 22 })).toEqual({ ...DEFAULT_APPEARANCE, theme: 'olympian-garden', contentSize: 22 });
  });
  it('bounds imported values and rejects style or path injection', () => {
    const c = normalizeCustomization({ light: { panels: { left: { color: 'red;}body{display:none}', opacity: -30, blur: 999 } }, background: { imageId: 'file:///private', x: 900, blur: -5 } }, css: 'x'.repeat(70_000) });
    expect(c.light.panels.left).toEqual({ color: null, opacity: 0, blur: 30 });
    expect(c.light.background).toMatchObject({ imageId: null, x: 100, blur: 0 });
    expect(c.css).toHaveLength(64_000);
  });
  it('keeps modes and zones independent and changes background alpha only', () => {
    const c = normalizeCustomization({ light: { panels: { left: { color: '#123456', opacity: 0 }, right: { blur: 0 } } } });
    const css = customizationCss(c, 'light');
    expect(css).toContain('background:rgba(18, 52, 86, 0)'); expect(css).toContain('backdrop-filter:blur(0px)');
    expect(css).not.toContain('opacity:'); expect(css).not.toContain('.studio-center');
    expect(customizationCss(c, 'dark')).toBe('');
  });
  it('does not reintroduce bubble backgrounds in plain mode', () => {
    const c = normalizeCustomization({ messageStyle: 'plain', light: { bubbles: { mine: { color: '#ffffff' }, radius: 32 } } });
    expect(customizationCss(c, 'light')).not.toContain('message-bubble');
  });
  it.each(['@import "https://example.test/a.css";', '.x{background:url(https://example.test/a)}', '.x{background:u\\72l/**/(https://example.test/a)}', '.x{background:image-set("https://example.test/a" 1x)}'])('rejects resource loading before CSS parsing: %s', css => {
    expect(() => compileCustomCss(css)).toThrow(/不支持/);
  });
  it('captures recovery in Electron before hidden renderer UI or page shortcuts', () => {
    const callbacks = new Map<string, (...args: unknown[]) => void>(), send = vi.fn();
    const window = { webContents: { on: (event: string, callback: (...args: unknown[]) => void) => callbacks.set(event, callback), send } };
    installAppearanceRecovery(window as unknown as BrowserWindow);
    const preventDefault = vi.fn(), trigger = callbacks.get('before-input-event')!;
    trigger({ preventDefault }, { type: 'keyUp', key: 'F12', control: true, shift: true }); expect(send).not.toHaveBeenCalled();
    trigger({ preventDefault }, { type: 'keyDown', key: 'F12', control: true, shift: true });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledWith(DESKTOP_IPC.appearanceRecovery);
  });
});
