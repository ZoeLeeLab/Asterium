interface WindowPort {
  isDestroyed(): boolean; isMinimized(): boolean; restore(): void; show(): void; focus(): void; hide(): void;
}
export interface TrayPort { destroy(): void; }
export class DesktopLifecycle {
  private tray?: TrayPort;
  private stopping?: Promise<void>;
  private exiting = false;
  constructor(private readonly options: {
    getWindow: () => WindowPort | null;
    closeAction: () => 'tray' | 'quit';
    createTray: (restore: () => void, quit: () => void) => TrayPort;
    trayError: () => void;
    dispose: () => Promise<void>;
    exit: () => void;
  }) {}
  get canExit() { return this.exiting; }
  restore() {
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  }
  close(event: { preventDefault(): void }) {
    if (this.exiting) return;
    event.preventDefault();
    if (this.stopping) return;
    if (this.options.closeAction() === 'quit') { void this.quit(); return; }
    try {
      this.tray ??= this.options.createTray(() => this.restore(), () => { void this.quit(); });
      this.options.getWindow()?.hide();
    } catch {
      this.restore(); this.options.trayError();
    }
  }
  quit() {
    if (this.stopping) return this.stopping;
    this.stopping = Promise.resolve().then(() => this.options.dispose()).catch(() => {
      console.error('DESKTOP_SHUTDOWN_CLEANUP_FAILED');
    }).finally(() => {
      try { this.tray?.destroy(); } catch { /* A failed tray teardown must not trap the process. */ }
      this.tray = undefined; this.exiting = true; this.options.exit();
    });
    return this.stopping;
  }
}
