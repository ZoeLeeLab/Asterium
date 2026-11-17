import { clipboard, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { isStudioMcpCredentialToken } from '../../shared/studioMcp';
import type { ProjectMutationCoordinator } from '../project/ProjectMutationCoordinator';
import type { StudioMcpAccessStore } from '../studio/StudioMcpAccessStore';
import type { StudioMcpHost } from '../studio/StudioMcpHost';
import type { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';

interface StudioMcpCredentialIpcDependencies {
  projectCoordinator: Pick<ProjectMutationCoordinator, 'run'>;
  studioRuntimeCatalog: Pick<StudioRuntimeCatalog, 'partner'>;
  studioMcpAccess: Pick<StudioMcpAccessStore, 'issue' | 'revoke'>;
  studioMcpHost: Pick<StudioMcpHost, 'status'>;
  wakeReadinessChanged: () => void;
}

export function registerStudioMcpCredentialIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { projectCoordinator, studioRuntimeCatalog, studioMcpAccess, studioMcpHost, wakeReadinessChanged }: StudioMcpCredentialIpcDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.studioMcpIssueCredential, async (event, partnerId: unknown) => {
    requireSender(event);
    if (typeof partnerId !== 'string') throw new Error('STUDIO_MCP_PARTNER_REQUIRED');
    const issued = await projectCoordinator.run(async () => {
      if (studioRuntimeCatalog.partner(partnerId)?.sourceMode !== 'existing_thread') throw new Error('STUDIO_MCP_PARTNER_REQUIRED');
      return studioMcpAccess.issue(partnerId);
    });
    wakeReadinessChanged(); return issued;
  });
  ipcMain.handle(AGENT_IPC.studioMcpCopyCredential, (event, token: unknown) => {
    requireSender(event);
    if (!isStudioMcpCredentialToken(token)) throw new Error('STUDIO_MCP_CREDENTIAL_INVALID');
    return clipboard.writeText(token);
  });
  ipcMain.handle(AGENT_IPC.studioMcpRevokeCredential, async (event, credentialId: unknown) => {
    requireSender(event);
    if (typeof credentialId !== 'string') throw new Error('STUDIO_MCP_CREDENTIAL_NOT_FOUND');
    await projectCoordinator.run(() => studioMcpAccess.revoke(credentialId));
    return studioMcpHost.status();
  });
}
