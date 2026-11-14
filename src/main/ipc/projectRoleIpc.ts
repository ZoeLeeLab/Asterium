import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ProjectWorkRoleArchiveRequest, ProjectWorkRoleCreateRequest, ProjectWorkRoleRemoveRequest, ProjectWorkRoleUpdateRequest } from '../../shared/projectRoles';
import type { ProjectService } from '../project/ProjectService';

export function registerProjectRoleIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectService: ProjectService,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectRoleList, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string') throw new Error('INVALID_PROJECT_ROLE_QUERY');
    return projectService.listRoles(value);
  });
  ipcMain.handle(AGENT_IPC.projectRoleCreate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || (value.scope !== 'global' && value.scope !== 'project')) throw new Error('INVALID_PROJECT_ROLE_CREATE');
    return projectService.createRole(value as unknown as ProjectWorkRoleCreateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectRoleUpdate, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roleId !== 'string') throw new Error('INVALID_PROJECT_ROLE_UPDATE');
    return projectService.updateRole(value as unknown as ProjectWorkRoleUpdateRequest);
  });
  ipcMain.handle(AGENT_IPC.projectRoleArchive, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roleId !== 'string' || typeof value.archived !== 'boolean') throw new Error('INVALID_PROJECT_ROLE_ARCHIVE');
    return projectService.archiveRole(value as unknown as ProjectWorkRoleArchiveRequest);
  });
  ipcMain.handle(AGENT_IPC.projectRoleRemove, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roleId !== 'string') throw new Error('INVALID_PROJECT_ROLE_REMOVE');
    await projectService.removeRole(value as unknown as ProjectWorkRoleRemoveRequest);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
