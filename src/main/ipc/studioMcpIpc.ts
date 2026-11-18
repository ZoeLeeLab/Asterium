import { clipboard, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { isStudioMcpCredentialToken, type StudioMcpConfiguration } from '../../shared/studioMcp';
import type { ProjectMutationCoordinator } from '../project/ProjectMutationCoordinator';
import type { StudioMcpAccessStore } from '../studio/StudioMcpAccessStore';
import type { StudioMcpHost } from '../studio/StudioMcpHost';
import type { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';

interface StudioMcpHostIpcDependencies {
  studioMcpHost: Pick<StudioMcpHost, 'status' | 'configure'>;
  studioMcpStartup: Promise<void>;
  wakeReadinessChanged: () => void;
}

export function registerStudioMcpHostIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { studioMcpHost, studioMcpStartup, wakeReadinessChanged }: StudioMcpHostIpcDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.studioMcpStatus, async (event) => {
    requireSender(event);
    await studioMcpStartup;
    return studioMcpHost.status();
  });
  ipcMain.handle(AGENT_IPC.studioMcpConfigure, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value)) throw new Error('STUDIO_MCP_CONFIGURATION_INVALID');
    const status = await studioMcpHost.configure(value as unknown as StudioMcpConfiguration);
    wakeReadinessChanged(); return status;
  });
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
