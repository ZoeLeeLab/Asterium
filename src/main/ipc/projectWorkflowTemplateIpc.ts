import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type {
  ProjectWorkflowTemplateRemoveRequest,
  ProjectWorkflowTemplateSaveRequest,
  ProjectWorkflowTemplateUpdateRequest,
} from '../../shared/projectWorkflows';
import type { ProjectService } from '../project/ProjectService';

export function registerProjectWorkflowTemplateIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectService: ProjectService,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectWorkflowTemplateSave, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.workflowId !== 'string' || typeof value.name !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_TEMPLATE_SAVE');
    return projectService.saveWorkflowTemplate(value as unknown as ProjectWorkflowTemplateSaveRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowTemplateUpdate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.workflowId !== 'string' || typeof value.templateId !== 'string' || typeof value.name !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_TEMPLATE_UPDATE');
    return projectService.updateWorkflowTemplate(value as unknown as ProjectWorkflowTemplateUpdateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowTemplateRemove, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.templateId !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_TEMPLATE_REMOVE');
    await projectService.removeWorkflowTemplate(value as unknown as ProjectWorkflowTemplateRemoveRequest);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
