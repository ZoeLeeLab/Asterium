import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { STARTUP_IPC, type StartupWindowSnapshot } from '../../shared/startupWindow';

/** Owns only the initial window handoff, never conversation state or animation time. */
export class StartupWindowService {
  private main?: BrowserWindow;
  private splash?: BrowserWindow;
  private ipc?: IpcMain;
  private nativeReady = false;
  private painted = false;
  private complete = false;
  private disposed = false;
  private snapshot: StartupWindowSnapshot = { phase: 'loading', revision: 0 };

  constructor(private readonly options: {
    createSplash: () => BrowserWindow;
    loadSplash: (window: BrowserWindow) => Promise<unknown>;
    quit: () => void | Promise<void>;
    fatal: () => void;
  }) {}

  register(ipc: IpcMain) {
    if (this.ipc || this.disposed) throw Error('STARTUP_ALREADY_REGISTERED');
    this.ipc = ipc;
    ipc.handle(STARTUP_IPC.control, (event, action: unknown) => this.control(event, action));
  }

  attach(main: BrowserWindow) {
    if (this.disposed || (this.main && !this.main.isDestroyed())) throw Error('STARTUP_WINDOW_ALREADY_ATTACHED');
    this.main = main; this.complete = false; this.nativeReady = false; this.painted = false;
    this.update('loading');
    const splash = this.splash = this.options.createSplash();
    splash.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    splash.webContents.on('will-navigate', event => event.preventDefault());
    splash.once('ready-to-show', () => {
      if (this.splash !== splash || this.complete || this.disposed || splash.isDestroyed()) return;
      splash.show(); splash.focus();
    });
    splash.on('close', event => {
      if (this.complete || this.disposed) return;
      event.preventDefault(); void this.options.quit();
    });
    const splashFailed = () => { if (this.splash === splash && !this.complete && !this.disposed) this.options.fatal(); };
    splash.webContents.on('render-process-gone', splashFailed);
    splash.webContents.on('preload-error', splashFailed);
    void this.options.loadSplash(splash).catch(splashFailed);

    main.once('ready-to-show', () => { if (this.main === main) { this.nativeReady = true; this.reveal(); } });
    main.webContents.on('did-start-loading', () => { if (this.main === main && !this.complete) this.painted = false; });
    main.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (this.main === main && isMainFrame && code !== -3) this.fail();
    });
    main.webContents.on('render-process-gone', () => { if (this.main === main) this.fail(); });
    main.webContents.on('preload-error', () => { if (this.main === main) this.fail(); });
    main.once('closed', () => {
      if (this.main !== main) return;
      this.main = undefined; this.destroySplash();
    });
  }

  /** Second-instance/tray activation must never reveal a still-empty main window. */
  get restoreTarget() { return this.complete ? this.main : this.splash; }

  private control(event: IpcMainInvokeEvent, action: unknown): StartupWindowSnapshot | void {
    const from = (window?: BrowserWindow) => window && !window.isDestroyed()
      && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
    if (this.disposed) throw Error('STARTUP_CLOSED');
    if (from(this.main)) {
      if (action === 'main-failed') { this.fail(); return; }
      if (action !== 'main-painted') throw Error('STARTUP_ACTION_REJECTED');
      if (this.snapshot.phase === 'loading' && !this.main!.webContents.isLoadingMainFrame()) { this.painted = true; this.reveal(); }
      return;
    }
    if (!from(this.splash)) throw Error('STARTUP_SENDER_REJECTED');
    if (action === 'get') return { ...this.snapshot };
    if (action === 'quit') { void this.options.quit(); return; }
    if (action !== 'retry') throw Error('STARTUP_ACTION_REJECTED');
    if (this.snapshot.phase !== 'failed' || !this.main || this.main.isDestroyed()) return;
    this.painted = false; this.update('loading');
    try { this.main.webContents.reload(); } catch { this.fail(); }
  }

  private reveal() {
    if (this.disposed || this.complete || !this.nativeReady || !this.painted || !this.main || this.main.isDestroyed()) return;
    this.complete = true;
    this.main.show(); this.main.focus();
    this.destroySplash();
  }
  private fail() { if (!this.disposed && !this.complete) { this.painted = false; this.update('failed'); } }
  private update(phase: StartupWindowSnapshot['phase']) {
    this.snapshot = { phase, revision: this.snapshot.revision + 1 };
    if (this.splash && !this.splash.isDestroyed()) this.splash.webContents.send(STARTUP_IPC.state, { ...this.snapshot });
  }
  private destroySplash() {
    const splash = this.splash; this.splash = undefined;
    if (splash && !splash.isDestroyed()) splash.destroy();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ipc?.removeHandler(STARTUP_IPC.control); this.ipc = undefined;
    this.destroySplash(); this.main = undefined;
  }
}
