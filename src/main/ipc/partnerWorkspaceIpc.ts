import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { PartnerWorkspaceStore } from '../security/PartnerWorkspaceStore';

export function registerPartnerWorkspaceIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  partnerWorkspaces: Pick<PartnerWorkspaceStore, 'configuredState'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.getPartnerWorkspace, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string' || !value) throw new Error('INVALID_PARTNER_ID');
    return partnerWorkspaces.configuredState(value);
  });
}
