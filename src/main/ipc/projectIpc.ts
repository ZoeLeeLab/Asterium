import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { isProjectPermissionMode } from '../../shared/projectExecutionPolicy';
import type { ProjectCreateRequest, ProjectDomainInitializeRequest, ProjectUpdateRequest } from '../../shared/projectDomain';
import type { ProjectLifecycleService } from '../project/ProjectLifecycleService';
import type { ProjectService } from '../project/ProjectService';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerProjectLifecycleIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectLifecycle: Pick<ProjectLifecycleService, 'saveLocationSelection' | 'initializeDomain' | 'previewCreateLocation' | 'createProject'>,
  projectService: Pick<ProjectService, 'updateProject'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectChooseLocation, async (event) => {
    const window = requireSender(event);
    const result = await dialog.showOpenDialog(window, {
      title: '选择项目文件夹',
      buttonLabel: '使用这个文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return projectLifecycle.saveLocationSelection(result.filePaths[0]);
  });
  ipcMain.handle(AGENT_IPC.projectDomainInitialize, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || !Array.isArray(value.legacyProjects)) throw new Error('INVALID_PROJECT_DOMAIN_MIGRATION');
    return projectLifecycle.initializeDomain((value as unknown as ProjectDomainInitializeRequest).legacyProjects);
  });
  function assertProjectCreateRequest(value: unknown) {
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.name !== 'string') throw new Error('INVALID_PROJECT_CREATE_REQUEST');
    if (value.locationSelectionId !== undefined && typeof value.locationSelectionId !== 'string') throw new Error('INVALID_PROJECT_LOCATION_SELECTION');
    return value as unknown as ProjectCreateRequest;
  }
  ipcMain.handle(AGENT_IPC.projectPreviewCreateLocation, async (event, value: unknown) => {
    requireSender(event);
    return projectLifecycle.previewCreateLocation(assertProjectCreateRequest(value));
  });
  ipcMain.handle(AGENT_IPC.projectCreate, async (event, value: unknown) => {
    requireSender(event);
    return projectLifecycle.createProject(assertProjectCreateRequest(value));
  });
  ipcMain.handle(AGENT_IPC.projectUpdate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string') throw new Error('INVALID_PROJECT_UPDATE_REQUEST');
    return projectService.updateProject(value as unknown as ProjectUpdateRequest);
  });
}

export function registerProjectManagementIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectLifecycle: Pick<ProjectLifecycleService, 'removeProject'>,
  projectService: Pick<ProjectService, 'getExecutionPolicy' | 'setExecutionPolicy' | 'syncExistingWorkspaceMemberships' | 'changeMembers'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectGetExecutionPolicy, async (event, projectId: unknown) => {
    requireSender(event);
    if (typeof projectId !== 'string') throw new Error('INVALID_PROJECT_ID');
    return projectService.getExecutionPolicy(projectId);
  });

  ipcMain.handle(AGENT_IPC.projectSetExecutionPolicy, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || !isProjectPermissionMode(value.permissionMode)) throw new Error('INVALID_PROJECT_EXECUTION_POLICY');
    return projectService.setExecutionPolicy(value.projectId, value.permissionMode);
  });

  ipcMain.handle(AGENT_IPC.projectSyncMembers, async (event, value: unknown) => {
    requireSender(event);
    if (!Array.isArray(value) || !value.every((item) => isRecord(item) && typeof item.projectId === 'string'
      && Array.isArray(item.partnerIds) && item.partnerIds.every((id) => typeof id === 'string'))) throw new Error('INVALID_PROJECT_MEMBER_SYNC');
    return projectService.syncExistingWorkspaceMemberships(value as Array<{ projectId: string; partnerIds: string[] }>);
  });

  ipcMain.handle(AGENT_IPC.projectChangeMembers, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value)) throw new Error('INVALID_PROJECT_MEMBER_CHANGE');
    return projectService.changeMembers(value as unknown as import('../../shared/projectWorkspace').ProjectMembershipChangeRequest);
  });

  ipcMain.handle(AGENT_IPC.projectRemove, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || !Array.isArray(value.roomIds)
      || !value.roomIds.every((roomId) => typeof roomId === 'string' && roomId)) throw new Error('INVALID_PROJECT_REMOVE_REQUEST');
    return projectLifecycle.removeProject(value.projectId, value.roomIds as string[]);
  });

}
