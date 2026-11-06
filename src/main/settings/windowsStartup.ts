import type { App } from 'electron';
import type { StartupRegistration } from './GeneralSettingsStore';

export function windowsStartupRegistration(app: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'>, executable: string): StartupRegistration {
  return {
    get: () => {
      // Electron 44.2 parses the lookup path as a command line on Windows.
      const current = app.getLoginItemSettings({ path: `"${executable}"`, args: [] });
      return current.openAtLogin && current.executableWillLaunchAtLogin;
    },
    set: enabled => app.setLoginItemSettings({ openAtLogin: enabled, enabled, path: executable, args: [] }),
  };
}
