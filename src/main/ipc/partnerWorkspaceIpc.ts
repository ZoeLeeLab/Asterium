import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { PartnerWorkspaceStore } from '../security/PartnerWorkspaceStore';

export function registerPartnerWorkspaceIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  partnerWorkspaces: Pick<PartnerWorkspaceStore, 'configuredState' | 'sync'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.syncPartnerWorkspace, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.partnerId !== 'string' || !value.partnerId
      || (value.cwdGrantId !== undefined && typeof value.cwdGrantId !== 'string')
      || !Array.isArray(value.workspaceGrantIds)
      || !value.workspaceGrantIds.every((item) => typeof item === 'string')
      || (value.expectedVersion !== undefined && !Number.isSafeInteger(value.expectedVersion))) throw new Error('INVALID_PARTNER_WORKSPACE_SYNC');
    return partnerWorkspaces.sync(value.partnerId, value.cwdGrantId as string | undefined, value.workspaceGrantIds as string[], value.expectedVersion as number | undefined);
  });

  ipcMain.handle(AGENT_IPC.getPartnerWorkspace, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string' || !value) throw new Error('INVALID_PARTNER_ID');
    return partnerWorkspaces.configuredState(value);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
