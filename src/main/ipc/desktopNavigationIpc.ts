import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { RuntimeEnvironment } from '../../shared/runtimeEnvironment';
import type { DesktopNotifications } from '../settings/DesktopNotifications';

export function registerDesktopNavigationIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  notifications: DesktopNotifications | undefined,
  options: { environment?: RuntimeEnvironment },
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.desktopNavigationTake, event => { requireSender(event); return notifications?.takeNavigation(); });
  ipcMain.handle(AGENT_IPC.environmentGet, event => { requireSender(event); if (!options.environment) throw new Error('ENVIRONMENT_UNAVAILABLE'); return options.environment; });
}
