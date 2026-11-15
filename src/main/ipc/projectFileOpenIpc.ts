import { shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ProjectFileStore } from '../project/ProjectFileStore';

export function registerProjectFileOpenIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectFiles: Pick<ProjectFileStore, 'resolve'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectOpenFile, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.fileId !== 'string') throw new Error('INVALID_PROJECT_FILE_REQUEST');
    const error = await shell.openPath(await projectFiles.resolve(value.projectId, value.fileId));
    if (error) throw new Error(error);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
