import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { StudioWakeControlService } from '../studio/StudioWakeControlService';

export function registerStudioWakeIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  studioWakeControl: Pick<StudioWakeControlService, 'status' | 'configure' | 'control'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.studioWakeStatus, async (event) => {
    requireSender(event); return studioWakeControl.status();
  });
  ipcMain.handle(AGENT_IPC.studioWakeConfigure, async (event, value: unknown) => {
    requireSender(event); return studioWakeControl.configure(value as import('../../shared/studioWakeControl').StudioWakeBinding);
  });
  ipcMain.handle(AGENT_IPC.studioWakeControl, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.partnerId !== 'string' || typeof value.action !== 'string'
      || (value.triggerId !== undefined && typeof value.triggerId !== 'string')) throw new Error('STUDIO_WAKE_CONTROL_INVALID');
    return studioWakeControl.control(value.partnerId, value.action as import('../../shared/studioWakeControl').StudioWakeAction, value.triggerId as string | undefined);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
