// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { STARTUP_IPC } from '../../src/shared/startupWindow';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import { StartupWindowService } from '../../src/main/settings/StartupWindowService';

function fakeWindow() {
  let destroyed = false;
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame: {}, send: vi.fn(), setWindowOpenHandler: vi.fn(), reload: vi.fn(), isLoadingMainFrame: vi.fn(() => false),
  });
  const window = Object.assign(new EventEmitter(), {
    webContents, show: vi.fn(), focus: vi.fn(), isDestroyed: () => destroyed,
    destroy: vi.fn(() => { destroyed = true; window.emit('closed'); }),
  });
  return window;
}
function setup() {
  const main = fakeWindow(), splash = fakeWindow();
  let handler!: (event: IpcMainInvokeEvent, action: unknown) => unknown;
  const ipc = { handle: vi.fn((_channel, listener) => { handler = listener; }), removeHandler: vi.fn() };
  const quit = vi.fn(), fatal = vi.fn();
  const service = new StartupWindowService({ createSplash: () => splash as unknown as BrowserWindow, loadSplash: async () => undefined, quit, fatal });
  service.register(ipc as unknown as IpcMain); service.attach(main as unknown as BrowserWindow);
  const control = async (action: unknown, sender = main, frame: unknown = sender.webContents.mainFrame) => handler({ sender: sender.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent, action);
  return { main, splash, service, ipc, control, quit, fatal };
}

describe('native startup window handoff', () => {
  it('shows only the small splash on native readiness, then reveals main without an animation-end signal', async () => {
    const t = setup();
    t.main.emit('ready-to-show'); t.splash.emit('ready-to-show');
    expect(t.main.show).not.toHaveBeenCalled(); expect(t.splash.show).toHaveBeenCalledOnce();
    expect(t.service.restoreTarget).toBe(t.splash);
    await t.control('main-painted');
    expect(t.main.show).toHaveBeenCalledOnce(); expect(t.main.focus).toHaveBeenCalledOnce(); expect(t.splash.destroy).toHaveBeenCalledOnce();
    expect(t.service.restoreTarget).toBe(t.main);
    await t.control('main-painted'); expect(t.main.show).toHaveBeenCalledOnce();
  });
  it('does not depend on which readiness signal arrives first or flash a late splash', async () => {
    const t = setup(); await t.control('main-painted'); expect(t.main.show).not.toHaveBeenCalled();
    t.main.emit('ready-to-show'); t.splash.emit('ready-to-show');
    expect(t.main.show).toHaveBeenCalledOnce(); expect(t.splash.show).not.toHaveBeenCalled();
  });
  it('keeps main hidden after a failed read and retries through the same main window', async () => {
    const t = setup(); t.main.emit('ready-to-show'); await t.control('main-failed');
    expect(await t.control('get', t.splash)).toMatchObject({ phase: 'failed' });
    const failed = await t.control('get', t.splash) as { revision: number };
    expect(t.main.show).not.toHaveBeenCalled();
    await t.control('main-painted'); expect(t.main.show).not.toHaveBeenCalled();
    await t.control('retry', t.splash);
    expect(t.main.webContents.reload).toHaveBeenCalledOnce();
    expect(await t.control('get', t.splash)).toEqual({ phase: 'loading', revision: failed.revision + 1 });
    expect(t.main.show).not.toHaveBeenCalled();
    await t.control('main-painted'); expect(t.main.show).toHaveBeenCalledOnce();
  });
  it('ignores painted reports during navigation and rejects stale reports after loading starts', async () => {
    const t = setup(); await t.control('main-painted'); t.main.webContents.emit('did-start-loading');
    t.main.emit('ready-to-show'); expect(t.main.show).not.toHaveBeenCalled();
    t.main.webContents.isLoadingMainFrame.mockReturnValue(true); await t.control('main-painted'); expect(t.main.show).not.toHaveBeenCalled();
    t.main.webContents.isLoadingMainFrame.mockReturnValue(false); await t.control('main-painted'); expect(t.main.show).toHaveBeenCalledOnce();
  });
  it('reports actual load and renderer failures but ignores cancelled navigations and subframes', async () => {
    const t = setup(); t.main.webContents.emit('did-fail-load', {}, -3, '', '', true);
    t.main.webContents.emit('did-fail-load', {}, -2, '', '', false);
    expect(await t.control('get', t.splash)).toMatchObject({ phase: 'loading' });
    t.main.webContents.emit('did-fail-load', {}, -2, '', '', true);
    expect(await t.control('get', t.splash)).toMatchObject({ phase: 'failed' });
    await t.control('retry', t.splash); t.main.webContents.emit('render-process-gone');
    expect(await t.control('get', t.splash)).toMatchObject({ phase: 'failed' });
  });
  it('rejects other windows, subframes and cross-role or arbitrary actions', async () => {
    const t = setup();
    await expect(t.control('main-painted', fakeWindow())).rejects.toThrow('STARTUP_SENDER_REJECTED');
    await expect(t.control('main-painted', t.main, {})).rejects.toThrow('STARTUP_SENDER_REJECTED');
    await expect(t.control('main-painted', t.splash)).rejects.toThrow('STARTUP_ACTION_REJECTED');
    await expect(t.control('retry')).rejects.toThrow('STARTUP_ACTION_REJECTED');
    await expect(t.control({ action: 'quit' }, t.splash)).rejects.toThrow('STARTUP_ACTION_REJECTED');
    expect(t.main.show).not.toHaveBeenCalled(); expect(t.quit).not.toHaveBeenCalled();
  });
  it('quits on splash close/action and removes its one handler exactly once on shutdown', async () => {
    const t = setup(), event = { preventDefault: vi.fn() };
    t.splash.emit('close', event); expect(event.preventDefault).toHaveBeenCalledOnce(); expect(t.quit).toHaveBeenCalledOnce();
    await t.control('quit', t.splash); expect(t.quit).toHaveBeenCalledTimes(2);
    t.service.dispose(); t.service.dispose();
    expect(t.ipc.removeHandler).toHaveBeenCalledExactlyOnceWith(STARTUP_IPC.control);
    expect(t.splash.destroy).toHaveBeenCalledOnce();
    await expect(t.control('main-painted')).rejects.toThrow('STARTUP_CLOSED');
  });
  it('destroys a remaining splash when main closes and keeps startup channels disjoint from agent channels', () => {
    const t = setup(); t.main.emit('closed'); expect(t.splash.destroy).toHaveBeenCalledOnce();
    expect(Object.values(STARTUP_IPC).some(channel => Object.values(DESKTOP_IPC).includes(channel as never))).toBe(false);
    expect(() => t.service.register(t.ipc as unknown as IpcMain)).toThrow('STARTUP_ALREADY_REGISTERED');
  });
});
