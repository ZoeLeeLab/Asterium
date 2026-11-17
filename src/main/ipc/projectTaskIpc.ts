import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ProjectTaskCreateRequest, ProjectTaskRemoveRequest, ProjectTaskUpdateRequest } from '../../shared/projectDomain';
import type { ProjectService } from '../project/ProjectService';

export function registerProjectTaskIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectService: Pick<ProjectService, 'createTask' | 'updateTask' | 'removeTask'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectTaskCreate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.title !== 'string') throw new Error('INVALID_PROJECT_TASK_CREATE');
    return projectService.createTask(value as unknown as ProjectTaskCreateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectTaskUpdate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.taskId !== 'string') throw new Error('INVALID_PROJECT_TASK_UPDATE');
    return projectService.updateTask(value as unknown as ProjectTaskUpdateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectTaskRemove, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.taskId !== 'string') throw new Error('INVALID_PROJECT_TASK_REMOVE');
    await projectService.removeTask(value as unknown as ProjectTaskRemoveRequest);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
