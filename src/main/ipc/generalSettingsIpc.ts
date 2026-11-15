import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { GeneralSettingsStore } from '../settings/GeneralSettingsStore';

export function registerGeneralSettingsIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  generalSettings: GeneralSettingsStore,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.generalSettingsGet, async event => { requireSender(event); return generalSettings.get(); });
  ipcMain.handle(AGENT_IPC.generalSettingsUpdate, async (event, value: unknown) => { requireSender(event); return generalSettings.update(value); });
}
