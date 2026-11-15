import { shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ProjectService } from '../project/ProjectService';
import type { ProjectWorkspaceStore } from '../project/ProjectWorkspaceStore';

export function registerProjectWorkspaceIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectService: Pick<ProjectService, 'getWorkspace'>,
  projectWorkspaces: Pick<ProjectWorkspaceStore, 'get'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectGetWorkspace, async (event, projectId: unknown) => {
    requireSender(event);
    if (typeof projectId !== 'string') throw new Error('INVALID_PROJECT_ID');
    return (await projectService.getWorkspace(projectId)) ?? null;
  });
  ipcMain.handle(AGENT_IPC.projectOpenWorkspace, async (event, projectId: unknown) => {
    requireSender(event);
    if (typeof projectId !== 'string') throw new Error('INVALID_PROJECT_ID');
    const project = await projectWorkspaces.get(projectId);
    if (!project) throw new Error('PROJECT_WORKSPACE_NOT_READY');
    const error = await shell.openPath(project.rootPath);
    if (error) throw new Error(error);
  });
}
