import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { AppUpdateService } from '../settings/AppUpdateService';

export function registerAppUpdateIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  options: { updates?: AppUpdateService },
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  const requireUpdates = () => { if (!options.updates) throw new Error('UPDATES_UNAVAILABLE'); return options.updates; };
  ipcMain.handle(AGENT_IPC.updatesGet, event => { requireSender(event); return requireUpdates().get(); });
  ipcMain.handle(AGENT_IPC.updatesCheck, event => { requireSender(event); return requireUpdates().check(); });
  ipcMain.handle(AGENT_IPC.updatesDownload, event => { requireSender(event); return requireUpdates().download(); });
  ipcMain.handle(AGENT_IPC.updatesCancel, event => { requireSender(event); requireUpdates().cancel(); });
  ipcMain.handle(AGENT_IPC.updatesInstall, event => { requireSender(event); return requireUpdates().install(); });
  ipcMain.handle(AGENT_IPC.updatesOpenReleases, event => { requireSender(event); return requireUpdates().openReleases(); });
}
