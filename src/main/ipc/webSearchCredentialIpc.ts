import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { CredentialStore } from '../security/CredentialStore';

export function registerWebSearchCredentialIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  credentials: Pick<CredentialStore, 'save' | 'has' | 'delete'>,
  credentialRef: string,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.saveWebSearchCredential, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.secret !== 'string' || !value.secret.trim()) throw new Error('INVALID_WEB_SEARCH_CREDENTIAL_REQUEST');
    await credentials.save(value.secret.trim(), credentialRef);
    return { configured: true, masked: '••••••••' };
  });

  ipcMain.handle(AGENT_IPC.webSearchCredentialStatus, async (event) => {
    requireSender(event);
    const configured = await credentials.has(credentialRef);
    return { configured, masked: configured ? '••••••••' : '' };
  });

  ipcMain.handle(AGENT_IPC.deleteWebSearchCredential, async (event) => {
    requireSender(event);
    await credentials.delete(credentialRef);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
