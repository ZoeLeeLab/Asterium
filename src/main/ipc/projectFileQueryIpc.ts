import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ArtifactDeliveryService } from '../project/ArtifactDeliveryService';
import type { ProjectBrowserService } from '../project/ProjectBrowserService';

export function registerProjectFileQueryIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectBrowser: ProjectBrowserService,
  artifactDelivery: ArtifactDeliveryService,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectBrowse, async (event, request) => {
    requireSender(event);
    return projectBrowser.query(request);
  });
  ipcMain.handle(AGENT_IPC.projectListFiles, async (event, projectId: unknown) => {
    requireSender(event);
    if (typeof projectId !== 'string') throw new Error('INVALID_PROJECT_ID');
    return artifactDelivery.listProjectFiles(projectId);
  });
}
