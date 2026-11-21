import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { TaskGateResolutionRequest } from '../../shared/projectTaskExecution';
import type { ProjectTaskOrchestrator } from '../project/ProjectTaskOrchestrator';
import type { PartnerRuntimePort } from '../runtime/PartnerRuntimePort';

export function registerProjectTaskExecutionIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { projectTaskOrchestrator, getPartnerRuntimePort }: {
    projectTaskOrchestrator: Pick<ProjectTaskOrchestrator, 'snapshot' | 'activate' | 'enqueue' | 'pause' | 'resume' | 'cancel' | 'retry' | 'resolveGate'>;
    getPartnerRuntimePort: () => PartnerRuntimePort;
  },
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectTaskExecutionGet, async (event, value: unknown) => {
    requireSender(event);
    if (value !== undefined && typeof value !== 'string') throw new Error('INVALID_PROJECT_TASK_EXECUTION_QUERY');
    return projectTaskOrchestrator.snapshot(value);
  });

  ipcMain.handle(AGENT_IPC.projectTaskExecutionEnqueue, async (event, value: unknown) => {
    requireSender(event);
    const request = assertTaskAttemptRequest(value);
    await projectTaskOrchestrator.activate(getPartnerRuntimePort());
    return projectTaskOrchestrator.enqueue(request.projectId, request.taskId);
  });

  ipcMain.handle(AGENT_IPC.projectTaskExecutionPause, async (event, value: unknown) => {
    requireSender(event);
    const request = assertTaskAttemptControlRequest(value);
    return projectTaskOrchestrator.pause(request.attemptId, request.reason);
  });

  ipcMain.handle(AGENT_IPC.projectTaskExecutionResume, async (event, value: unknown) => {
    requireSender(event);
    const request = assertTaskAttemptControlRequest(value);
    return projectTaskOrchestrator.resume(request.attemptId, request.reason);
  });

  ipcMain.handle(AGENT_IPC.projectTaskExecutionCancel, async (event, value: unknown) => {
    requireSender(event);
    const request = assertTaskAttemptControlRequest(value);
    return projectTaskOrchestrator.cancel(request.attemptId, request.reason);
  });

  ipcMain.handle(AGENT_IPC.projectTaskExecutionRetry, async (event, value: unknown) => {
    requireSender(event);
    const request = assertTaskAttemptControlRequest(value);
    return projectTaskOrchestrator.retry(request.attemptId);
  });

  ipcMain.handle(AGENT_IPC.projectTaskExecutionResolve, async (event, value: unknown) => {
    requireSender(event);
    return projectTaskOrchestrator.resolveGate(assertTaskGateResolutionRequest(value));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertTaskAttemptRequest(value: unknown) {
  if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.taskId !== 'string') throw new Error('INVALID_TASK_ATTEMPT_REQUEST');
  return { projectId: value.projectId, taskId: value.taskId };
}

function assertTaskAttemptControlRequest(value: unknown) {
  if (!isRecord(value) || typeof value.attemptId !== 'string' || (value.reason !== undefined && typeof value.reason !== 'string')) {
    throw new Error('INVALID_TASK_ATTEMPT_CONTROL_REQUEST');
  }
  return { attemptId: value.attemptId, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) };
}

function assertTaskGateResolutionRequest(value: unknown): TaskGateResolutionRequest {
  if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.taskId !== 'string'
    || (value.action !== 'accept' && value.action !== 'request_changes')
    || (value.feedback !== undefined && typeof value.feedback !== 'string')
    || (value.affectedCriteria !== undefined && (!Array.isArray(value.affectedCriteria) || value.affectedCriteria.some((item) => typeof item !== 'string')))) {
    throw new Error('INVALID_TASK_GATE_RESOLUTION_REQUEST');
  }
  return value as unknown as TaskGateResolutionRequest;
}
