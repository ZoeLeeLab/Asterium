import os from 'node:os';
import path from 'node:path';
import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { readClaudeSessionFile } from '../adapters/claudeSessionFile';
import type { WorkspaceGrantStore } from '../security/WorkspaceGrantStore';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';

interface ClaudeSessionImportIpcDependencies {
  nativeBindings: Pick<NativeThreadBindingStore, 'isBoundNativeThread'>;
  workspaceGrants: Pick<WorkspaceGrantStore, 'add'>;
  grants: Pick<Map<string, string>, 'set'>;
}

export function registerClaudeSessionImportIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { nativeBindings, workspaceGrants, grants }: ClaudeSessionImportIpcDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.importClaudeSession, async (event) => {
    const window = requireSender(event);
    const result = await dialog.showOpenDialog(window, {
      title: '选择要导入的 Claude Code 会话文件',
      buttonLabel: '导入此会话',
      defaultPath: path.join(os.homedir(), '.claude', 'projects'),
      properties: ['openFile'],
      filters: [{ name: 'Claude Code session', extensions: ['jsonl'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const imported = await readClaudeSessionFile(result.filePaths[0]);
    if (await nativeBindings.isBoundNativeThread(imported.sessionId)) throw new Error('NATIVE_THREAD_ALREADY_BOUND');
    const workspaceGrant = await workspaceGrants.add(imported.workingDirectory);
    grants.set(workspaceGrant.grantId, workspaceGrant.displayPath);
    return { sessionId: imported.sessionId, sessionFilePath: imported.sessionFilePath, workspaceGrant };
  });
}
