import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { assertSessionCommandTarget } from '../../shared/sessionCommands';
import type { SessionCommandService } from '../runtime/SessionCommandService';

export function registerSessionStatusIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  sessionCommands: Pick<SessionCommandService, 'inspect'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.getSessionStatus, async (event, value: unknown) => {
    requireSender(event); assertSessionCommandTarget(value);
    return sessionCommands.inspect(value);
  });
}
