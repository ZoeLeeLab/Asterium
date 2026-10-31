import type { BrowserWindow, IpcMain } from 'electron';
import { DESKTOP_IPC } from '../shared/desktopIpc';

export type TitlebarTheme = 'light' | 'dark';

const overlayByTheme: Record<TitlebarTheme, { color: string; symbolColor: string; height: number }> = {
  light: { color: '#00000000', symbolColor: '#173d76', height: 34 },
  dark: { color: '#00000000', symbolColor: '#dbe9ff', height: 34 },
};

export function registerTitlebarThemeChannel(ipcMain: IpcMain, getWindow: () => BrowserWindow | null) {
  ipcMain.on(DESKTOP_IPC.titlebarTheme, (event, requestedTheme: unknown) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents) return;
    if (requestedTheme !== 'light' && requestedTheme !== 'dark') return;

    window.setTitleBarOverlay(overlayByTheme[requestedTheme]);
  });
}

// Captured by Electron before page handling, even if user CSS hides the renderer UI.
export function installAppearanceRecovery(window: BrowserWindow) {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && input.control && input.shift && !input.alt && !input.meta) {
      event.preventDefault();
      window.webContents.send(DESKTOP_IPC.appearanceRecovery);
    }
  });
}
