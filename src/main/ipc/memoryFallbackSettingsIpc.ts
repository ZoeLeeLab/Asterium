import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { MemoryFallbackInventory } from '../memory/fallback/MemoryFallbackInventory';
import type { MemoryFallbackScheduler } from '../memory/fallback/MemoryFallbackScheduler';
import type { MemoryFallbackSettingsStore } from '../memory/fallback/MemoryFallbackSettingsStore';

interface MemoryFallbackSettingsIpcDependencies {
  prepareMemoryStorage: () => Promise<unknown>;
  memoryFallbackSettings: Pick<MemoryFallbackSettingsStore, 'configure' | 'setPartner'>;
  memoryFallbackScheduler: Pick<MemoryFallbackScheduler, 'snapshot' | 'cancelCurrent' | 'reconfigure'>;
  memoryFallbackInventory: Pick<MemoryFallbackInventory, 'refresh'>;
}

export function registerMemoryFallbackSettingsIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { prepareMemoryStorage, memoryFallbackSettings, memoryFallbackScheduler, memoryFallbackInventory }: MemoryFallbackSettingsIpcDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.memoryFallbackGet, async (event) => {
    requireSender(event);
    await prepareMemoryStorage();
    return memoryFallbackScheduler.snapshot();
  });

  ipcMain.handle(AGENT_IPC.memoryFallbackConfigure, async (event, value: unknown) => {
    requireSender(event);
    await prepareMemoryStorage();
    await memoryFallbackSettings.configure(value);
    memoryFallbackScheduler.cancelCurrent();
    await memoryFallbackScheduler.reconfigure();
    return memoryFallbackScheduler.snapshot();
  });

  ipcMain.handle(AGENT_IPC.memoryFallbackSetPartner, async (event, value: unknown) => {
    requireSender(event);
    await prepareMemoryStorage();
    await memoryFallbackSettings.setPartner(value);
    memoryFallbackScheduler.cancelCurrent();
    await memoryFallbackInventory.refresh();
    return memoryFallbackScheduler.snapshot();
  });
}
