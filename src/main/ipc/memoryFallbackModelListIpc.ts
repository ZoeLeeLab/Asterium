import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { ApiProviderRegistry } from '../api/ApiProviderRegistry';
import type { MemoryFallbackSettingsStore } from '../memory/fallback/MemoryFallbackSettingsStore';

export function registerMemoryFallbackModelListIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  memoryFallbackSettings: Pick<MemoryFallbackSettingsStore, 'listModels'>,
  apiProviders: Pick<ApiProviderRegistry, 'listModels'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.memoryFallbackListModels, async (event, value: unknown) => {
    requireSender(event);
    return memoryFallbackSettings.listModels(value, (provider, endpoint, apiKey) => apiProviders.listModels(provider, endpoint, apiKey));
  });
}
