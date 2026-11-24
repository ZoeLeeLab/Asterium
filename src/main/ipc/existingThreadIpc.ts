import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ExistingThreadConnection } from '../../shared/agentProtocol';
import { assertAgentCommand } from '../../shared/agentProtocolValidation';
import { normalizeCyberBossServiceUrl } from '../adapters/CyberBossBridgeClient';
import type { createExistingThreadService, ExistingThreadSendRequest, ExistingThreadWatchRequest } from '../runtime/ExistingThreadService';
import type { CredentialStore } from '../security/CredentialStore';

export function registerExistingThreadIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  credentials: Pick<CredentialStore, 'save' | 'has' | 'delete'>,
  threads: ReturnType<typeof createExistingThreadService>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.saveBridgeCredential, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.secret !== 'string' || !value.secret) throw new Error('INVALID_CREDENTIAL_REQUEST');
    const credentialRef = await credentials.save(value.secret);
    return { credentialRef, configured: true, masked: '••••••••' };
  });

  ipcMain.handle(AGENT_IPC.bridgeCredentialStatus, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.credentialRef !== 'string' || !value.credentialRef) throw new Error('INVALID_CREDENTIAL_REQUEST');
    const configured = await credentials.has(value.credentialRef);
    return { credentialRef: value.credentialRef, configured, masked: configured ? '••••••••' : '' };
  });

  ipcMain.handle(AGENT_IPC.deleteBridgeCredential, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.credentialRef !== 'string' || !value.credentialRef) throw new Error('INVALID_CREDENTIAL_REQUEST');
    await credentials.delete(value.credentialRef);
  });

  ipcMain.handle(AGENT_IPC.testExistingThread, async (event, value: unknown) => {
    requireSender(event);
    const connection = assertExistingThreadConnection(value, true);
    return threads.testConnection(connection);
  });

  ipcMain.handle(AGENT_IPC.watchExistingThread, async (event, value: unknown) => {
    requireSender(event);
    const request = assertExistingThreadWatchRequest(value);
    return threads.watch(request);
  });

  ipcMain.handle(AGENT_IPC.stopExistingThreadWatch, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.partnerId !== 'string' || !value.partnerId) throw new Error('INVALID_EXISTING_THREAD_WATCH_REQUEST');
    threads.stopWatch(value.partnerId);
  });

  ipcMain.handle(AGENT_IPC.getExistingThreadFileCapabilities, async (event, value: unknown) => {
    requireSender(event);
    const connection = assertExistingThreadConnection(value);
    return threads.fileCapabilities(connection);
  });

  ipcMain.handle(AGENT_IPC.sendExistingThreadMessage, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || !isRecord(value.connection) || !isRecord(value.command)) throw new Error('INVALID_EXISTING_THREAD_SEND_REQUEST');
    const request = value as unknown as ExistingThreadSendRequest;
    const connection = assertExistingThreadConnection(request.connection);
    assertAgentCommand(request.command);
    if (request.command.type !== 'message.send' || request.command.connectionSource !== 'existing_thread') throw new Error('INVALID_EXISTING_THREAD_SEND_COMMAND');
    return threads.send(request, connection);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExistingThreadConnection(value: unknown, allowEmptyThreadId = false): ExistingThreadConnection {
  if (!isRecord(value) || typeof value.serviceUrl !== 'string' || typeof value.threadId !== 'string' || typeof value.credentialRef !== 'string' || !value.credentialRef) throw new Error('INVALID_EXISTING_THREAD_CONNECTION');
  if (value.workspaceRoot !== undefined && typeof value.workspaceRoot !== 'string') throw new Error('INVALID_EXISTING_THREAD_CONNECTION');
  normalizeCyberBossServiceUrl(value.serviceUrl);
  const threadId = value.threadId.trim();
  if ((!threadId && !allowEmptyThreadId) || (threadId && !isSafeExistingThreadId(threadId))) throw new Error('INVALID_CYBERBOSS_THREAD_ID');
  return value as unknown as ExistingThreadConnection;
}

function assertExistingThreadWatchRequest(value: unknown): ExistingThreadWatchRequest {
  if (!isRecord(value) || typeof value.partnerId !== 'string' || !value.partnerId || !isRecord(value.connection)) throw new Error('INVALID_EXISTING_THREAD_WATCH_REQUEST');
  return { partnerId: value.partnerId, connection: assertExistingThreadConnection(value.connection) };
}

function isSafeExistingThreadId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value.trim());
}
