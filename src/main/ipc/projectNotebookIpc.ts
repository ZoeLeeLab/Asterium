import { writeFile } from 'node:fs/promises';
import { BrowserWindow, dialog, type IpcMain } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ProjectNotebookTarget, ProjectNotebookUserReplaceRequest } from '../../shared/projectNotebook';
import type { PartnerProjectNotebookService } from '../notebook/PartnerProjectNotebookService';

export function registerProjectNotebookIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  projectNotebooks: PartnerProjectNotebookService,
  archivedMarkdownFileName: (name: string, suffix: string) => string,
) {
  ipcMain.handle(AGENT_IPC.projectNotebookGet, async (event, value: unknown) => {
    void event;
    const target = assertProjectNotebookTarget(value);
    await projectNotebooks.assertActiveMembership(target.partnerId, target.projectId);
    return (await projectNotebooks.notebookStore(target.partnerId)).get(target.projectId);
  });

  ipcMain.handle(AGENT_IPC.projectNotebookReplace, async (event, value: unknown) => {
    void event;
    const request = assertProjectNotebookReplaceRequest(value);
    const project = await projectNotebooks.assertActiveMembership(request.partnerId, request.projectId);
    return (await projectNotebooks.notebookStore(request.partnerId)).replace({
      projectId: request.projectId,
      projectName: project.name,
      content: request.content,
      expectedRevision: request.expectedRevision,
    });
  });

  ipcMain.handle(AGENT_IPC.projectNotebookListArchived, async (event) => {
    void event;
    return projectNotebooks.listArchived();
  });

  ipcMain.handle(AGENT_IPC.projectNotebookExport, async (event, value: unknown) => {
    const target = assertProjectNotebookTarget(value);
    const notebook = await projectNotebooks.getArchived(target.partnerId, target.projectId);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('PROJECT_NOTEBOOK_EXPORT_WINDOW_UNAVAILABLE');
    const result = await dialog.showSaveDialog(window, {
      title: '导出项目工作笔记',
      defaultPath: archivedMarkdownFileName(notebook.projectName, '工作笔记'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, notebook.content, 'utf8');
    return true;
  });

  ipcMain.handle(AGENT_IPC.projectNotebookPurge, async (event, value: unknown) => {
    void event;
    const target = assertProjectNotebookTarget(value);
    return projectNotebooks.purgeArchived(target.partnerId, target.projectId);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertProjectNotebookTarget(value: unknown): ProjectNotebookTarget {
  if (!isRecord(value) || typeof value.partnerId !== 'string' || !value.partnerId.trim()
    || typeof value.projectId !== 'string' || !value.projectId.trim()) throw new Error('INVALID_PROJECT_NOTEBOOK_TARGET');
  return { partnerId: value.partnerId, projectId: value.projectId };
}

function assertProjectNotebookReplaceRequest(value: unknown): ProjectNotebookUserReplaceRequest {
  const target = assertProjectNotebookTarget(value);
  if (!isRecord(value) || typeof value.content !== 'string'
    || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) throw new Error('INVALID_PROJECT_NOTEBOOK_REPLACE');
  return { ...target, content: value.content, expectedRevision: Number(value.expectedRevision) };
}
