import { app, dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { RuntimeEnvironment } from '../../shared/runtimeEnvironment';
import type { GeneralSettingsStore } from '../settings/GeneralSettingsStore';
import { validateProjectDirectory } from '../settings/projectDirectory';
import { inspectDailyDataDirectory, saveDailyDataDirectory } from '../settings/runtimeEnvironment';
import { assertCanonicalPathOutsideProtectedRoots } from '../security/ProtectedPathPolicy';

export function registerStorageIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  generalSettings: Pick<GeneralSettingsStore, 'get' | 'update'>,
  options: { environment?: RuntimeEnvironment },
  protectedRoots: readonly string[],
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  const storageLocations = async (): Promise<import('../../shared/generalSettings').StorageLocations> => {
    const custom = (await generalSettings.get()).settings.defaultProjectRoot;
    return { userDataDirectory: app.getPath('userData'), canChooseUserDataDirectory: options.environment?.profile === 'daily',
      defaultProjectRoot: custom ?? options.environment?.projectsDirectory ?? path.join(app.getPath('documents'), 'Asterium Projects'), customized: Boolean(custom) };
  };
  ipcMain.handle(AGENT_IPC.storageGet, event => { requireSender(event); return storageLocations(); });
  ipcMain.handle(AGENT_IPC.storageChooseUserDataDirectory, async event => {
    const window = requireSender(event);
    if (options.environment?.profile !== 'daily') throw new Error('仅日常版可更改应用资料目录。');
    const choice = await dialog.showOpenDialog(window, {
      title: '选择应用资料目录', defaultPath: app.getPath('userData'), properties: ['openDirectory', 'createDirectory'],
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const appData = app.getPath('appData');
    const selected = inspectDailyDataDirectory(appData, choice.filePaths[0]);
    const confirmation = await dialog.showMessageBox(window, {
      type: 'question',
      message: selected.existing ? '重启后使用此目录中的已有资料？' : '重启后在空目录中创建一套新资料？',
      detail: `${selected.directory}\n当前目录中的资料会保留。星丛不会搬移或合并资料。`,
      buttons: ['取消', '使用此目录'], cancelId: 0, defaultId: 0, noLink: true,
    });
    if (confirmation.response !== 1) return null;
    saveDailyDataDirectory(appData, selected);
    return selected.directory;
  });
  ipcMain.handle(AGENT_IPC.storageChooseProjectRoot, async event => {
    const window = requireSender(event);
    const choice = await dialog.showOpenDialog(window, { title: '选择默认项目保存位置', properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    await assertCanonicalPathOutsideProtectedRoots(choice.filePaths[0], protectedRoots);
    await generalSettings.update({ defaultProjectRoot: choice.filePaths[0] });
    return storageLocations();
  });
  ipcMain.handle(AGENT_IPC.storageResetProjectRoot, async event => { requireSender(event); await generalSettings.update({ defaultProjectRoot: null }); return storageLocations(); });
  ipcMain.handle(AGENT_IPC.storageOpenProjectRoot, async event => {
    requireSender(event);
    const directory = await validateProjectDirectory((await storageLocations()).defaultProjectRoot);
    const error = await shell.openPath(directory); if (error) throw new Error(error);
  });
}
