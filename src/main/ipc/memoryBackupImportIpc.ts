import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { dialog, type BrowserWindow, type FileFilter, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { MemoryBackupData } from '../../shared/memoryBackup';
import { readMemoryBackup } from '../memory/MemoryBackupFile';
import type { PartnerMemoryService } from '../memory/PartnerMemoryService';
import { assertMemoryPartnerId } from './memoryArchiveIpc';

interface MemoryBackupImportIpcDependencies {
  partnerMemories: Pick<PartnerMemoryService, 'importBackup'>;
  memoryBackupFilters: FileFilter[];
}

export function registerMemoryBackupImportIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { partnerMemories, memoryBackupFilters }: MemoryBackupImportIpcDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  let memoryBackupDraft: { id: string; partnerId: string; backup: MemoryBackupData } | undefined;
  let choosingMemoryBackup = false;
  ipcMain.handle(AGENT_IPC.memoryBackupChoose, async (event, value: unknown) => {
    const window = requireSender(event);
    const partnerId = assertMemoryPartnerId(value);
    if (choosingMemoryBackup) throw new Error('MEMORY_BACKUP_BUSY');
    choosingMemoryBackup = true;
    memoryBackupDraft = undefined;
    try {
      const result = await dialog.showOpenDialog(window, { title: '选择伙伴记忆备份', filters: memoryBackupFilters, properties: ['openFile'] });
      if (result.canceled || !result.filePaths[0]) return null;
      const filePath = result.filePaths[0];
      const backup = await readMemoryBackup(filePath);
      const id = randomUUID();
      memoryBackupDraft = { id, partnerId, backup };
      return { id, fileName: path.basename(filePath), total: backup.records.length, archived: backup.records.filter(record => record.deletedAt).length };
    } finally { choosingMemoryBackup = false; }
  });
  ipcMain.handle(AGENT_IPC.memoryBackupImport, async (event, value: unknown, id: unknown) => {
    requireSender(event);
    const partnerId = assertMemoryPartnerId(value);
    const draft = memoryBackupDraft;
    if (!draft || draft.id !== id || draft.partnerId !== partnerId) throw new Error('MEMORY_BACKUP_PREVIEW_EXPIRED');
    const receipt = await partnerMemories.importBackup(partnerId, draft.backup);
    if (memoryBackupDraft === draft) memoryBackupDraft = undefined;
    return receipt;
  });
  ipcMain.handle(AGENT_IPC.memoryBackupCancel, (event, value: unknown, id: unknown) => {
    requireSender(event);
    if (memoryBackupDraft && memoryBackupDraft.id === id && memoryBackupDraft.partnerId === value) memoryBackupDraft = undefined;
  });

  return () => { memoryBackupDraft = undefined; };
}
