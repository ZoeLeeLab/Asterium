import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ProjectService } from '../project/ProjectService';
import type { ProjectTaskOrchestrator } from '../project/ProjectTaskOrchestrator';
import type { PartnerRuntimePort } from '../runtime/PartnerRuntimePort';
import type { ProjectWorkflowActivateRequest, ProjectWorkflowCreateRequest, ProjectWorkflowRemoveRequest, ProjectWorkflowUpdateRequest, ProjectWorkflowTemplateRemoveRequest, ProjectWorkflowTemplateSaveRequest, ProjectWorkflowTemplateUpdateRequest } from '../../shared/projectWorkflows';

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

export function registerProjectWorkflowMutationIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { projectService, projectTaskOrchestrator, getPartnerRuntimePort }: {
    projectService: Pick<ProjectService, 'createWorkflow' | 'updateWorkflow' | 'removeWorkflow' | 'activateWorkflow'>;
    projectTaskOrchestrator: Pick<ProjectTaskOrchestrator, 'activate'>;
    getPartnerRuntimePort(): PartnerRuntimePort;
  },
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectWorkflowCreate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.templateId !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_CREATE');
    return projectService.createWorkflow(value as unknown as ProjectWorkflowCreateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowUpdate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.workflowId !== 'string' || !Array.isArray(value.nodes)) throw new Error('INVALID_PROJECT_WORKFLOW_UPDATE');
    return projectService.updateWorkflow(value as unknown as ProjectWorkflowUpdateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowRemove, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.workflowId !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_REMOVE');
    await projectService.removeWorkflow(value as unknown as ProjectWorkflowRemoveRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowActivate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.workflowId !== 'string' || typeof value.activationId !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_ACTIVATE');
    const result = await projectService.activateWorkflow(value as unknown as ProjectWorkflowActivateRequest);
    await projectTaskOrchestrator.activate(getPartnerRuntimePort());
    return result;
  });
}

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
