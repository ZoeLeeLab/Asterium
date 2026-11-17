import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { PartnerProfileStore } from '../partner/PartnerProfileStore';

export function registerPartnerProfileRefreshIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  partnerProfiles: Pick<PartnerProfileStore, 'refresh'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.refreshPartnerProfiles, async (event) => {
    requireSender(event); return partnerProfiles.refresh();
  });
}
