import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { mcpDisconnectSchema } from '../../shared/apiExtensions';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ApiExtensionStore } from '../api/ApiExtensionStore';
import type { McpConnectionManager } from '../api/extensions/McpConnectionManager';

export function registerExtensionsIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  apiExtensions: ApiExtensionStore,
  mcpConnections: McpConnectionManager,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.extensionsGet, (event) => {
    requireSender(event); return apiExtensions.get();
  });
  ipcMain.handle(AGENT_IPC.extensionsUpsert, (event, value: unknown) => {
    requireSender(event); return apiExtensions.upsert(value);
  });
  ipcMain.handle(AGENT_IPC.extensionsRemove, (event, value: unknown) => {
    requireSender(event); return apiExtensions.remove(value);
  });
  ipcMain.handle(AGENT_IPC.extensionsSetBinding, (event, value: unknown) => {
    requireSender(event); return apiExtensions.setBinding(value);
  });
  ipcMain.handle(AGENT_IPC.extensionsSetTrust, (event, value: unknown) => {
    requireSender(event); return apiExtensions.setTrust(value);
  });
  ipcMain.handle(AGENT_IPC.extensionsConnectMcp, (event, value: unknown) => {
    requireSender(event); return mcpConnections.connectManagement(value);
  });
  ipcMain.handle(AGENT_IPC.extensionsDisconnectMcp, (event, value: unknown) => {
    requireSender(event); return mcpConnections.disconnectManagement(mcpDisconnectSchema.parse(value).id);
  });
  ipcMain.handle(AGENT_IPC.extensionsMcpStatus, (event) => {
    requireSender(event); return mcpConnections.managementStatus();
  });
}
