import { mkdir } from 'node:fs/promises';
import { shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';

export function registerProfileDirectoryIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  profileDataRoot: string,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.openProfileDirectory, async (event) => {
    requireSender(event);
    await mkdir(profileDataRoot, { recursive: true });
    const error = await shell.openPath(profileDataRoot);
    if (error) throw new Error(error);
  });
}
