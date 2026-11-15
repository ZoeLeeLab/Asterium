import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { apiConfigurationMutationSchema } from '../../shared/apiConnections';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ApiConnectionStore } from '../api/ApiConnectionStore';
import type { CredentialStore } from '../security/CredentialStore';

export function registerApiConnectionsIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  apiConnections: Pick<ApiConnectionStore, 'snapshot' | 'mutate'>,
  credentials: Pick<CredentialStore, 'has'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.apiConnectionsGet, async (event) => {
    requireSender(event); return apiConnections.snapshot();
  });
  ipcMain.handle(AGENT_IPC.apiConnectionsMutate, async (event, value: unknown) => {
    requireSender(event);
    const request = apiConfigurationMutationSchema.parse(value);
    if (request.action === 'service' && request.value.settings?.auth !== 'none' && !await credentials.has(request.value.credentialRef)) throw new Error('API_CREDENTIAL_REQUIRED');
    if (request.action === 'service') for (const header of request.value.settings?.headers ?? []) if (!await credentials.has(header.credentialRef)) throw new Error('API_HEADER_CREDENTIAL_REQUIRED');
    return apiConnections.mutate(request);
  });
}
