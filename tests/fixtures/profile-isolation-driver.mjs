// Narrow real-Electron fixture. Uses the production startup function and settings store.
import { app, BrowserWindow, session } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { activateRuntimeEnvironment } from '../../src/main/settings/runtimeEnvironment';
import { GeneralSettingsStore } from '../../src/main/settings/GeneralSettingsStore';
import { BETA_APP_NAME } from '../../src/shared/appRelease';

const config = JSON.parse(readFileSync(process.env.ASTERIUM_PROFILE_DRIVER_CONFIG, 'utf8'));
app.setName(BETA_APP_NAME);
app.disableHardwareAcceleration();
function report(result) { writeFileSync(config.report, JSON.stringify(result)); }
try {
  const environment = activateRuntimeEnvironment(app, config.options);
  if (!app.requestSingleInstanceLock()) {
    report({ status: 'duplicate', environment }); app.quit();
  } else {
    app.on('second-instance', () => {});
    app.whenReady().then(async () => {
      if (process.platform === 'win32') app.setAppUserModelId(environment.appUserModelId);
      const store = new GeneralSettingsStore(path.join(environment.userDataDirectory, 'general-settings.v1.json'));
      if (config.shortcut) await store.update({ sendShortcut: config.shortcut });
      const window = new BrowserWindow({ show: false, title: environment.label, webPreferences: { sandbox: true } });
      await window.loadURL('data:text/html,<title>Isolation fixture</title>');
      report({ status: 'ready', environment, settings: (await store.get()).settings,
        paths: Object.fromEntries(['userData', 'sessionData', 'temp', 'logs', 'crashDumps'].map(key => [key, app.getPath(key)])),
        browserStorage: session.defaultSession.getStoragePath() });
      const timer = setInterval(() => { if (existsSync(config.stop)) { clearInterval(timer); window.destroy(); app.quit(); } }, 50);
    }).catch(error => { report({ status: 'error', error: String(error) }); app.exit(1); });
  }
} catch (error) { report({ status: 'error', error: String(error) }); app.exit(1); }
