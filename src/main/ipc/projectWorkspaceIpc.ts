import { shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ProjectService } from '../project/ProjectService';
import type { ProjectLifecycleService } from '../project/ProjectLifecycleService';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerProjectWorkspaceCreationIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectLifecycle: Pick<ProjectLifecycleService, 'createWorkspace'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectCreateWorkspace, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.name !== 'string') throw new Error('INVALID_PROJECT_WORKSPACE_REQUEST');
    if (value.locationSelectionId !== undefined && typeof value.locationSelectionId !== 'string') throw new Error('INVALID_PROJECT_LOCATION_SELECTION');
    return projectLifecycle.createWorkspace(value as { projectId: string; name: string; description?: unknown; locationSelectionId?: string });
  });
}
