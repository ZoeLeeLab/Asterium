import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ClaudeInstallation } from '../adapters/ClaudeCodeAdapter';
import type { CodexInstallation } from '../adapters/CodexCliAdapter';

export function registerLocalRuntimeDetectionIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  refreshClaude: () => Promise<ClaudeInstallation>,
  refreshCodex: () => Promise<CodexInstallation>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.detectClaude, async (event) => {
    requireSender(event);
    return publicClaudeInstallation(await refreshClaude());
  });

  ipcMain.handle(AGENT_IPC.detectCodex, async (event) => {
    requireSender(event);
    return refreshCodex();
  });
}

function publicClaudeInstallation(installation: ClaudeInstallation) {
  return {
    installed: installation.installed,
    loggedIn: installation.loggedIn,
    version: installation.version,
    authMethod: installation.authMethod,
    executableLabel: installation.executableLabel,
    error: installation.error,
  };
}
