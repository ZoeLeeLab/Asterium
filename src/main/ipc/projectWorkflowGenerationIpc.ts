import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ProjectWorkflowGenerationCancelRequest, ProjectWorkflowGenerationRetryRequest, ProjectWorkflowGenerationStartRequest } from '../../shared/projectWorkflowGeneration';
import type { ProjectWorkflowGenerationRuntime } from '../project/ProjectWorkflowGenerationRuntime';
import type { ProjectWorkflowGenerationStore } from '../project/ProjectWorkflowGenerationStore';

interface ProjectWorkflowGenerationDependencies {
  projectWorkflowGenerations: Pick<ProjectWorkflowGenerationStore, 'listProject'>;
  workflowGenerationRuntimeRef: { current?: Pick<ProjectWorkflowGenerationRuntime, 'start' | 'cancel' | 'retry'> };
}

export function registerProjectWorkflowGenerationIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { projectWorkflowGenerations, workflowGenerationRuntimeRef }: ProjectWorkflowGenerationDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectWorkflowGenerationList, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_GENERATION_QUERY');
    return projectWorkflowGenerations.listProject(value);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowGenerationStart, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.requestId !== 'string' || typeof value.projectId !== 'string' || typeof value.roomId !== 'string'
      || typeof value.plannerPartnerId !== 'string' || !Array.isArray(value.messageIds)) throw new Error('INVALID_PROJECT_WORKFLOW_GENERATION_START');
    if (!workflowGenerationRuntimeRef.current) throw new Error('PROJECT_WORKFLOW_GENERATION_RUNTIME_NOT_READY');
    return workflowGenerationRuntimeRef.current.start(value as unknown as ProjectWorkflowGenerationStartRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowGenerationCancel, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.generationId !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_GENERATION_CANCEL');
    if (!workflowGenerationRuntimeRef.current) throw new Error('PROJECT_WORKFLOW_GENERATION_RUNTIME_NOT_READY');
    return workflowGenerationRuntimeRef.current.cancel(value as unknown as ProjectWorkflowGenerationCancelRequest);
  });
  ipcMain.handle(AGENT_IPC.projectWorkflowGenerationRetry, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.generationId !== 'string' || typeof value.requestId !== 'string') throw new Error('INVALID_PROJECT_WORKFLOW_GENERATION_RETRY');
    if (!workflowGenerationRuntimeRef.current) throw new Error('PROJECT_WORKFLOW_GENERATION_RUNTIME_NOT_READY');
    return workflowGenerationRuntimeRef.current.retry(value as unknown as ProjectWorkflowGenerationRetryRequest);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
