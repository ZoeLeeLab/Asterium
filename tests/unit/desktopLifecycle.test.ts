import { expect, it, vi } from 'vitest';
import { DesktopLifecycle } from '../../src/main/settings/DesktopLifecycle';

function setup(action: 'tray' | 'quit' = 'tray') {
  const window = { isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), hide: vi.fn() };
  const tray = { destroy: vi.fn() }, createTray = vi.fn(() => tray), trayError = vi.fn(), dispose = vi.fn(async () => undefined), exit = vi.fn();
  const lifecycle = new DesktopLifecycle({ getWindow: () => window, closeAction: () => action, createTray, trayError, dispose, exit });
  return { lifecycle, window, tray, createTray, trayError, dispose, exit };
}
it('retains the running app in one tray and restores its window', () => {
  const t = setup(), event = { preventDefault: vi.fn() };
  t.lifecycle.close(event); t.lifecycle.close(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2); expect(t.createTray).toHaveBeenCalledOnce(); expect(t.dispose).not.toHaveBeenCalled();
  t.lifecycle.restore(); expect(t.window.restore).toHaveBeenCalledOnce(); expect(t.window.show).toHaveBeenCalledOnce(); expect(t.window.focus).toHaveBeenCalledOnce();
});
it('keeps the window accessible if tray creation fails', () => {
  const t = setup(); t.createTray.mockImplementation(() => { throw Error('tray'); });
  t.lifecycle.close({ preventDefault: vi.fn() }); expect(t.window.hide).not.toHaveBeenCalled(); expect(t.window.show).toHaveBeenCalled(); expect(t.trayError).toHaveBeenCalledOnce();
});
it('runs cleanup once, destroys the tray and allows explicit exit without hiding again', async () => {
  const t = setup(); t.lifecycle.close({ preventDefault: vi.fn() });
  await Promise.all([t.lifecycle.quit(), t.lifecycle.quit()]);
  expect(t.dispose).toHaveBeenCalledOnce(); expect(t.tray.destroy).toHaveBeenCalledOnce(); expect(t.exit).toHaveBeenCalledOnce();
  const event = { preventDefault: vi.fn() }; t.lifecycle.close(event); expect(event.preventDefault).not.toHaveBeenCalled(); expect(t.lifecycle.canExit).toBe(true);
});
it('uses the same cleanup path when close is configured to quit', async () => {
  const t = setup('quit'); t.lifecycle.close({ preventDefault: vi.fn() }); await t.lifecycle.quit();
  expect(t.createTray).not.toHaveBeenCalled(); expect(t.dispose).toHaveBeenCalledOnce(); expect(t.exit).toHaveBeenCalledOnce();
});
