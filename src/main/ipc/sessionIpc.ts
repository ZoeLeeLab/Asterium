import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { assertSessionCommandTarget } from '../../shared/sessionCommands';
import type { SessionCommandService } from '../runtime/SessionCommandService';
import { assertSessionCompactRequest } from '../../shared/sessionCompaction';
import type { SessionCompactionService } from '../runtime/SessionCompactionService';

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

interface SessionMaintenanceIpcDependencies {
  sessionCommands: Pick<SessionCommandService, 'execute'>;
  sessionCompactions: Pick<SessionCompactionService, 'compact'>;
}

export function registerSessionMaintenanceIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { sessionCommands, sessionCompactions }: SessionMaintenanceIpcDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.executeSessionCommand, async (event, value: unknown) => {
    requireSender(event); assertSessionCommandTarget(value, true);
    return sessionCommands.execute(value);
  });

  ipcMain.handle(AGENT_IPC.compactSession, async (event, value: unknown) => {
    requireSender(event); assertSessionCompactRequest(value);
    return sessionCompactions.compact(value);
  });
}
