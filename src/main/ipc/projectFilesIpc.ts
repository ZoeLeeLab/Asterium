import type { ProjectFileDeletionService } from '../project/ProjectFileDeletionService';
import type { ProjectFilesSnapshot } from '../../shared/projectWorkspace';
import { shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ProjectFileStore } from '../project/ProjectFileStore';
import type { ArtifactDeliveryService } from '../project/ArtifactDeliveryService';
import type { ProjectBrowserService } from '../project/ProjectBrowserService';

export function registerProjectFileOpenIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectFiles: Pick<ProjectFileStore, 'resolve'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectOpenFile, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.fileId !== 'string') throw new Error('INVALID_PROJECT_FILE_REQUEST');
    const error = await shell.openPath(await projectFiles.resolve(value.projectId, value.fileId));
    if (error) throw new Error(error);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerProjectFileQueryIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectBrowser: ProjectBrowserService,
  artifactDelivery: ArtifactDeliveryService,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectBrowse, async (event, request) => {
    requireSender(event);
    return projectBrowser.query(request);
  });
  ipcMain.handle(AGENT_IPC.projectListFiles, async (event, projectId: unknown) => {
    requireSender(event);
    if (typeof projectId !== 'string') throw new Error('INVALID_PROJECT_ID');
    return artifactDelivery.listProjectFiles(projectId);
  });
}

export function registerProjectFileDeletionIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { projectFileDeletions, publishProjectFiles }: {
    projectFileDeletions: Pick<ProjectFileDeletionService, 'inspect' | 'delete'>;
    publishProjectFiles: (snapshot: ProjectFilesSnapshot) => void;
  },
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.projectInspectFileDeletion, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.fileId !== 'string') throw new Error('INVALID_PROJECT_FILE_REQUEST');
    return projectFileDeletions.inspect({ kind: 'project_file', projectId: value.projectId, fileId: value.fileId });
  });
  ipcMain.handle(AGENT_IPC.projectDeleteFile, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.projectId !== 'string' || typeof value.fileId !== 'string') throw new Error('INVALID_PROJECT_FILE_REQUEST');
    const result = await projectFileDeletions.delete({ kind: 'project_file', projectId: value.projectId, fileId: value.fileId });
    for (const snapshot of result.projectSnapshots) publishProjectFiles(snapshot);
    return result;
  });
}
