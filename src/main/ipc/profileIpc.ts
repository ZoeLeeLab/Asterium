import type { PartnerProfileSeed } from '../../shared/agentProtocol';
import type { PartnerProfileService } from '../partner/PartnerProfileService';
import { type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, shell } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { PartnerProfileStore } from '../partner/PartnerProfileStore';
import type { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
import { mkdir } from 'node:fs/promises';

export function registerPartnerProfileRefreshIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  partnerProfiles: Pick<PartnerProfileStore, 'refresh'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.refreshPartnerProfiles, async (event) => {
    requireSender(event); return partnerProfiles.refresh();
  });
}

interface UserProfileDependencies {
  partnerProfiles: Pick<PartnerProfileStore, 'saveUser'>;
  studioRuntimeCatalog: Pick<StudioRuntimeCatalog, 'updateUser'>;
  isUserProfileSeed(value: unknown): value is Parameters<PartnerProfileStore['saveUser']>[0];
}

export function registerUserProfileIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { partnerProfiles, studioRuntimeCatalog, isUserProfileSeed }: UserProfileDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.saveUserProfile, async (event, value: unknown) => {
    requireSender(event);
    if (!isUserProfileSeed(value)) throw new Error('INVALID_USER_PROFILE');
    const saved = await partnerProfiles.saveUser(value);
    studioRuntimeCatalog.updateUser(saved);
    return saved;
  });
}

export function registerProfileDirectoryIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  profileDataRoot: string,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.openProfileDirectory, async (event) => {
    requireSender(event);
    await mkdir(profileDataRoot, { recursive: true });
    const error = await shell.openPath(profileDataRoot);
    if (error) throw new Error(error);
  });
}

interface PartnerProfileIpcDependencies {
  partnerProfileService: Pick<PartnerProfileService, 'sync' | 'save' | 'trash'>;
  isUserProfileSeed(value: unknown): value is Parameters<PartnerProfileService['sync']>[0]['user'];
  isPartnerProfileSeed(value: unknown): value is PartnerProfileSeed;
}

export function registerPartnerProfileIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { partnerProfileService, isUserProfileSeed, isPartnerProfileSeed }: PartnerProfileIpcDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.syncPartnerProfiles, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || !isUserProfileSeed(value.user) || !Array.isArray(value.partners) || !value.partners.every(isPartnerProfileSeed)) throw new Error('INVALID_PARTNER_PROFILE_SYNC');
    return partnerProfileService.sync(value as unknown as Parameters<PartnerProfileService['sync']>[0]);
  });

  ipcMain.handle(AGENT_IPC.savePartnerProfile, async (event, value: unknown) => {
    requireSender(event);
    if (!isPartnerProfileSeed(value)) throw new Error('INVALID_PARTNER_PROFILE');
    return partnerProfileService.save(value);
  });

  ipcMain.handle(AGENT_IPC.trashPartnerProfile, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.partnerId !== 'string' || !value.partnerId) throw new Error('INVALID_PARTNER_PROFILE_TRASH');
    return partnerProfileService.trash(value.partnerId);
  });

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
