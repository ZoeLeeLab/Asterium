import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { MemoryImportService } from '../memory/MemoryImportService';

export function registerMemoryImportIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  memoryImport: Pick<MemoryImportService, 'preview' | 'confirm' | 'cancel' | 'undo'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.memoryImportPreview, (event, value: unknown) => {
    requireSender(event);
    return memoryImport.preview(value);
  });
  ipcMain.handle(AGENT_IPC.memoryImportConfirm, (event, value: unknown) => {
    requireSender(event);
    return memoryImport.confirm(value);
  });
  ipcMain.handle(AGENT_IPC.memoryImportCancel, (event, value: unknown) => {
    requireSender(event);
    memoryImport.cancel(value);
  });
  ipcMain.handle(AGENT_IPC.memoryImportUndo, (event, value: unknown) => {
    requireSender(event);
    return memoryImport.undo(value);
  });
}
