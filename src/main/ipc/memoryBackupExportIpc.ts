import { app, dialog, type BrowserWindow, type FileFilter, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { MEMORY_BACKUP_EXTENSION } from '../../shared/memoryBackup';
import { writeMemoryBackup } from '../memory/MemoryBackupFile';
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
