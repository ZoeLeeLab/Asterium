import { spawn } from 'node:child_process';
import path from 'node:path';
import { app, dialog, type BrowserWindow, type Input } from 'electron';
import { WINDOWS_SCREENSHOT_SHORTCUT } from '../../shared/generalSettings';

function matchesShortcut(input: Input) {
  if (input.type !== 'keyDown' || input.isComposing || !input.control || !input.shift || input.alt || input.meta) return false;
  return WINDOWS_SCREENSHOT_SHORTCUT === `Ctrl+Shift+${input.key.toUpperCase()}`;
}

async function openSnippingTool() {
  const localAppData = process.env.LOCALAPPDATA || path.resolve(app.getPath('appData'), '..', 'Local');
  const executablePaths = [path.join(localAppData, 'Microsoft', 'WindowsApps', 'SnippingTool.exe')];
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (systemRoot) executablePaths.push(path.join(systemRoot, 'System32', 'SnippingTool.exe'));
  for (const executable of executablePaths) {
    const started = await new Promise<boolean>(resolve => {
      const child = spawn(executable, ['/clip'], { detached: true, stdio: 'ignore', shell: false });
      child.once('spawn', () => { child.unref(); resolve(true); });
      child.once('error', () => resolve(false));
    });
    if (started) return true;
  }
  return false;
}

export function installWindowsScreenshotShortcut(window: BrowserWindow) {
  if (process.platform !== 'win32') return;
  let opening = false;
  window.webContents.on('before-input-event', (event, input) => {
    if (!matchesShortcut(input) || !window.isFocused()) return;
    event.preventDefault();
    if (input.isAutoRepeat || opening) return;
    opening = true;
    void (async () => {
      try {
        if (!(await openSnippingTool()) && !window.isDestroyed()) {
          await dialog.showMessageBox(window, {
            type: 'warning', title: '截图工具未能打开',
            message: '暂时无法打开 Windows 截图工具。你可以按 Win+Shift+S 截图。',
          });
        }
      } finally {
        opening = false;
      }
    })().catch(() => undefined);
  });
}
