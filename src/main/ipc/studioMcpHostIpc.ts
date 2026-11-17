import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { StudioMcpConfiguration } from '../../shared/studioMcp';
import type { StudioMcpHost } from '../studio/StudioMcpHost';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
