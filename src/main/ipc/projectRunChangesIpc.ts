import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ProjectRunChangeRecorder } from '../project/ProjectRunChangeRecorder';

export function registerProjectRunChangesIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectChanges: ProjectRunChangeRecorder,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectRunChangesList, async (event, projectId) => {
    requireSender(event);
    if (typeof projectId !== 'string') throw new Error('INVALID_PROJECT_ID');
    return projectChanges.list(projectId);
  });
  ipcMain.handle(AGENT_IPC.projectRunChangesRead, async (event, request) => {
    requireSender(event);
    if (!isRecord(request) || typeof request.projectId !== 'string' || typeof request.id !== 'string' || typeof request.path !== 'string') throw new Error('INVALID_PROJECT_CHANGE_REQUEST');
    return projectChanges.read({ projectId: request.projectId, id: request.id, path: request.path });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
