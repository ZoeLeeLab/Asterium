import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ProjectService } from '../project/ProjectService';

export function registerProjectWorkflowQueryIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectService: ProjectService,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectWorkflowCatalog, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_QUERY');
    return projectService.workflowCatalog(value);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowList, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_QUERY');
    return projectService.listWorkflows(value);
  });
}
