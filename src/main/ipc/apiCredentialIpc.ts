import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ApiConnectionStore } from '../api/ApiConnectionStore';
import type { CredentialStore } from '../security/CredentialStore';

export function registerApiCredentialIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  credentials: Pick<CredentialStore, 'save' | 'has' | 'delete'>,
  apiConnections: Pick<ApiConnectionStore, 'assertCredentialUnreferenced'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.saveApiCredential, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.secret !== 'string' || !value.secret || (value.credentialRef !== undefined && typeof value.credentialRef !== 'string')) throw new Error('INVALID_CREDENTIAL_REQUEST');
    const credentialRef = await credentials.save(value.secret, value.credentialRef);
    return { credentialRef, configured: true, masked: '••••••••' };
  });

  ipcMain.handle(AGENT_IPC.apiCredentialStatus, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.credentialRef !== 'string' || !value.credentialRef) throw new Error('INVALID_CREDENTIAL_REQUEST');
    const configured = await credentials.has(value.credentialRef);
    return { credentialRef: value.credentialRef, configured, masked: configured ? '••••••••' : '' };
  });

  ipcMain.handle(AGENT_IPC.deleteApiCredential, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.credentialRef !== 'string' || !value.credentialRef) throw new Error('INVALID_CREDENTIAL_REQUEST');
    await apiConnections.assertCredentialUnreferenced(value.credentialRef);
    await credentials.delete(value.credentialRef);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
