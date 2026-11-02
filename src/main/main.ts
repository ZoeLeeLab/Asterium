import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { DESKTOP_IPC } from '../shared/desktopIpc';
import { DesktopNotifications } from './settings/DesktopNotifications';
import { GeneralSettingsStore } from './settings/GeneralSettingsStore';
import { DesktopLifecycle } from './settings/DesktopLifecycle';
import { windowsStartupRegistration } from './settings/windowsStartup';
import appIcon from '../../assets/asterium-icon.png?inline';
import path from 'node:path';
import { registerTitlebarThemeChannel, installAppearanceRecovery } from './titlebar';
import { registerAgentIpc } from './agentIpc';
import { loadClaudeCliRuntime } from './adapters/ClaudeCodeAdapter';
import { spawn } from 'node:child_process';
import { AppUpdateService } from './settings/AppUpdateService';
import { PUBLIC_UPDATE_REPOSITORY } from '../shared/appUpdates';
import { APP_VERSION } from '../shared/appRelease';
import { normalizeExternalHttpUrl } from './security/externalUrl';
import { BETA_APP_NAME } from '../shared/appRelease';
import { activateRuntimeEnvironment } from './settings/runtimeEnvironment';

app.setName(BETA_APP_NAME);
const environment = (() => {
  try {
    if (app.commandLine.getSwitchValue('asterium-background-services')) throw new Error('ASTERIUM_PROFILE_BACKGROUND_FLAG_INVALID');
    return activateRuntimeEnvironment(app, {
      isPackaged: app.isPackaged, appData: app.getPath('appData'),
      localAppData: process.env.LOCALAPPDATA || path.resolve(app.getPath('appData'), '..', 'Local'),
      documents: app.getPath('documents'), temp: app.getPath('temp'),
      profile: app.commandLine.hasSwitch('asterium-profile') ? app.commandLine.getSwitchValue('asterium-profile') : undefined,
      userData: app.commandLine.hasSwitch('user-data-dir') ? app.commandLine.getSwitchValue('user-data-dir') : undefined,
      acceptanceBatch: app.commandLine.getSwitchValue('asterium-acceptance-batch') || undefined,
      mcpPort: app.commandLine.hasSwitch('asterium-mcp-port') ? app.commandLine.getSwitchValue('asterium-mcp-port') : undefined,
      backgroundServices: app.commandLine.hasSwitch('asterium-background-services'),
    });
  } catch (error) {
    console.error('ASTERIUM_PROFILE_STARTUP_FAILED', error);
    dialog.showErrorBox('星丛启动隔离检查失败', `${error instanceof Error ? error.message : 'ASTERIUM_PROFILE_INVALID'}\n请检查启动参数与资料目录。未加载聊天或连接配置。`);
    app.exit(1);
    throw error;
  }
})();

let mainWindow: BrowserWindow | null = null;
const generalSettings = new GeneralSettingsStore(() => path.join(app.getPath('userData'), 'general-settings.v1.json'),
  environment.allowStartup && process.platform === 'win32' ? windowsStartupRegistration(app, process.execPath) : undefined);
let disposeAgentIpc: () => Promise<void> = async () => undefined;
const lifecycle = new DesktopLifecycle({
  getWindow: () => mainWindow, closeAction: () => generalSettings.current().closeAction,
  createTray: (restore, quit) => {
    const tray = new Tray(nativeImage.createFromDataURL(appIcon));
    try {
      tray.setToolTip(environment.label);
      tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开星丛', click: restore }, { type: 'separator' }, { label: '退出星丛', click: quit }]));
      tray.on('click', restore);
      return tray;
    } catch (error) { tray.destroy(); throw error; }
  },
  trayError: () => { if (mainWindow) void dialog.showMessageBox(mainWindow, { type: 'error', message: '未能创建托盘图标，窗口已保留。', detail: '你可以在通用设置中选择“彻底退出”。' }); },
  dispose: async () => {
    notifications.dispose();
    for (const notification of activeNotifications) { try { notification.close(); } catch { /* OS state must not prevent runtime cleanup. */ } }
    activeNotifications.clear(); await disposeAgentIpc();
  }, exit: () => app.quit(),
});

const activeNotifications = new Set<Notification>();
const updates = new AppUpdateService({
  repository: PUBLIC_UPDATE_REPOSITORY, version: APP_VERSION,
  directory: path.join(app.getPath('userData'), 'updates'),
  includePrerelease: () => generalSettings.current().includePrereleaseUpdates,
  openExternal: url => shell.openExternal(url),
  install: async file => {
    if (!environment.allowUpdates || process.platform !== 'win32') throw new Error('UPDATE_INSTALL_UNAVAILABLE');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
    await lifecycle.quit();
  },
});
const notifications = new DesktopNotifications({
  settings: () => generalSettings.current(),
  background: () => !mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized() || !mainWindow.isFocused(),
  supported: () => Notification.isSupported(),
  show: (message, click) => {
    const notification = new Notification({ ...message, icon: nativeImage.createFromDataURL(appIcon) });
    activeNotifications.add(notification);
    notification.once('click', click);
    notification.once('close', () => activeNotifications.delete(notification));
    notification.once('failed', () => activeNotifications.delete(notification));
    try { notification.show(); } catch (error) { activeNotifications.delete(notification); throw error; }
  },
  restore: () => { if (!mainWindow) createWindow(); else lifecycle.restore(); },
  navigationReady: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(DESKTOP_IPC.desktopNavigationReady); },
});

function createWindow() {
  mainWindow = new BrowserWindow({
    title: environment.label,
    width: 1536,
    height: 1024,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    icon: nativeImage.createFromDataURL(appIcon),
    backgroundColor: '#071321',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#dbe9ff',
      height: 34,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  installAppearanceRecovery(mainWindow);
  mainWindow.on('page-title-updated', event => { event.preventDefault(); mainWindow?.setTitle(environment.label); });
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = normalizeExternalHttpUrl(url);
    if (externalUrl) void shell.openExternal(externalUrl);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const expectedPrefix = MAIN_WINDOW_VITE_DEV_SERVER_URL || 'file://';
    if (!url.startsWith(expectedPrefix)) event.preventDefault();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.on('close', event => lifecycle.close(event));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
registerTitlebarThemeChannel(ipcMain, () => mainWindow);
disposeAgentIpc = registerAgentIpc(ipcMain, () => mainWindow, { generalSettings, notifications, updates, environment });

app.on('second-instance', () => { void app.whenReady().then(() => { if (!mainWindow) createWindow(); else lifecycle.restore(); }); });
app.on('before-quit', event => { if (!lifecycle.canExit) { event.preventDefault(); void lifecycle.quit(); } });

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId(environment.appUserModelId);
  try { await generalSettings.get(); } catch { console.error('GENERAL_SETTINGS_LOAD_FAILED'); }
  if (process.env.ASTERIUM_STARTUP_SMOKE === '1') {
    const runtime = await loadClaudeCliRuntime();
    if (typeof runtime.query !== 'function' || typeof runtime.createClaudeToolSet !== 'function' || typeof runtime.tool !== 'function') {
      throw new Error('CLAUDE_CLI_RUNTIME_INCOMPLETE');
    }
    await runtime.verifyClaudeBridgeResources();
  }
  createWindow();

  if (environment.allowUpdates && generalSettings.current().checkUpdatesAtStartup) void updates.check();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error('ASTERIUM_STARTUP_FAILED', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') void lifecycle.quit();
});
}
