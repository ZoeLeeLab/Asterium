import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, dialog, type BrowserWindow, type FileFilter, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { MEMORY_BACKUP_EXTENSION, type MemoryBackupData } from '../../shared/memoryBackup';
import { readMemoryBackup, writeMemoryBackup } from '../memory/MemoryBackupFile';
import type { PartnerMemoryService } from '../memory/PartnerMemoryService';
import type { PartnerProfileStore } from '../partner/PartnerProfileStore';
import { assertCanonicalPathOutsideProtectedRoots } from '../security/ProtectedPathPolicy';
import { assertMemoryPartnerId } from './memoryArchiveIpc';

interface MemoryBackupExportIpcDependencies {
  partnerProfiles: Pick<PartnerProfileStore, 'runtimeProfile'>;
  partnerMemories: Pick<PartnerMemoryService, 'exportBackup'>;
  protectedRoots: readonly string[];
  memoryBackupFilters: FileFilter[];
}

export function registerMemoryBackupExportIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { partnerProfiles, partnerMemories, protectedRoots, memoryBackupFilters }: MemoryBackupExportIpcDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.memoryBackupExport, async (event, value: unknown) => {
    const window = requireSender(event);
    const partnerId = assertMemoryPartnerId(value);
    const profile = await partnerProfiles.runtimeProfile(partnerId);
    if (profile?.management.memoryMode !== 'asterium') throw new Error('PARTNER_MEMORY_NOT_MANAGED');
    const filename = profile.publicIdentity.displayName.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);
    const result = await dialog.showSaveDialog(window, {
      title: '导出伙伴记忆', defaultPath: `星丛记忆-${filename}-${new Date().toISOString().slice(0, 10)}.${MEMORY_BACKUP_EXTENSION}`, filters: memoryBackupFilters,
    });
    if (result.canceled || !result.filePath) return null;
    const target = result.filePath;
    await assertCanonicalPathOutsideProtectedRoots(target, [...protectedRoots, app.getPath('userData')]);
    const backup = await partnerMemories.exportBackup(partnerId);
    await writeMemoryBackup(target, backup);
    return backup.records.length;
  });
}

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
