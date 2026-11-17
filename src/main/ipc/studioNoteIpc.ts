import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { SaveStudioNoteRequest, StudioNoteStatus } from '../../shared/studioNotes';
import type { StudioNoteStore } from '../studio/StudioNoteStore';

export function registerStudioNoteIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  studioNotes: StudioNoteStore,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.studioNoteList, async (event, projectId: unknown) => {
    requireSender(event);
    if (projectId !== undefined && typeof projectId !== 'string') throw new Error('INVALID_STUDIO_NOTE_PROJECT');
    return studioNotes.list(projectId as string | undefined);
  });

  ipcMain.handle(AGENT_IPC.studioNoteSave, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || (value.id !== undefined && typeof value.id !== 'string') || typeof value.projectId !== 'string' || typeof value.content !== 'string') throw new Error('INVALID_STUDIO_NOTE');
    return studioNotes.save(value as unknown as SaveStudioNoteRequest);
  });

  ipcMain.handle(AGENT_IPC.studioNoteSetStatus, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.id !== 'string' || !['open', 'completed', 'archived'].includes(String(value.status))) throw new Error('INVALID_STUDIO_NOTE_STATUS');
    return studioNotes.setStatus(value.id, value.status as StudioNoteStatus);
  });

  ipcMain.handle(AGENT_IPC.studioNoteDelete, async (event, id: unknown) => {
    requireSender(event);
    if (typeof id !== 'string' || !id) throw new Error('INVALID_STUDIO_NOTE_ID');
    await studioNotes.remove(id);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
