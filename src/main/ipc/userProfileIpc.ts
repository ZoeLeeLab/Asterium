import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { PartnerProfileStore } from '../partner/PartnerProfileStore';
import type { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';

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
