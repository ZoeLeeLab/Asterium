import { realpath } from 'node:fs/promises';
import { app, dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { McpConnectionManager } from '../api/extensions/McpConnectionManager';
import type { ExecutionBackendRouter } from '../execution/ExecutionBackendRouter';
import { assertCanonicalPathOutsideProtectedRoots } from '../security/ProtectedPathPolicy';
import type { WorkspaceGrantStore } from '../security/WorkspaceGrantStore';

interface WorkspaceGrantSelectionDependencies {
  workspaceGrants: Pick<WorkspaceGrantStore, 'add'>;
  grants: Pick<Map<string, string>, 'set'>;
  protectedRoots: readonly string[];
}

interface WorkspaceGrantRevocationDependencies {
  workspaceGrants: Pick<WorkspaceGrantStore, 'get' | 'deleteMany'>;
  grants: Pick<Map<string, string>, 'delete'>;
  extensionLaunchBackend: Pick<ExecutionBackendRouter, 'invalidateWorkspaceRoots'>;
  mcpConnections: Pick<McpConnectionManager, 'invalidateWorkspaceRoots' | 'revalidateManagementWorkspaces'>;
}

export function registerWorkspaceGrantSelectionIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { workspaceGrants, grants, protectedRoots }: WorkspaceGrantSelectionDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.selectWorkspace, async (event, purpose: unknown) => {
    const window = requireSender(event);
    if (purpose !== undefined && purpose !== 'partner_root' && purpose !== 'workspace' && purpose !== 'mcp_workspace') throw new Error('INVALID_DIRECTORY_SELECTION_PURPOSE');
    const result = await dialog.showOpenDialog(window, {
      title: purpose === 'partner_root' ? '选择伙伴配置来源（原 CLI 项目根目录）' : purpose === 'mcp_workspace' ? '授权此 MCP 的测试工作区' : '授权伙伴额外工作区',
      buttonLabel: '授权此目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const displayPath = result.filePaths[0];
    await assertCanonicalPathOutsideProtectedRoots(displayPath, purpose === 'mcp_workspace' ? [...protectedRoots, app.getPath('userData')] : protectedRoots);
    const grant = await workspaceGrants.add(displayPath);
    grants.set(grant.grantId, displayPath);
    return grant;
  });
}

export function registerWorkspaceGrantRevocationIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { workspaceGrants, grants, extensionLaunchBackend, mcpConnections }: WorkspaceGrantRevocationDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.revokeWorkspaceGrants, async (event, value: unknown) => {
    requireSender(event);
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error('INVALID_WORKSPACE_GRANT_REVOKE');
    const paths = (await Promise.all(value.map(grantId => workspaceGrants.get(grantId)))).filter((folder): folder is string => Boolean(folder));
    const revokedPaths = [...paths, ...(await Promise.all(paths.map(folder => realpath(folder).catch(() => folder))))];
    for (const grantId of value) grants.delete(grantId);
    await workspaceGrants.deleteMany(value);
    await Promise.all([extensionLaunchBackend.invalidateWorkspaceRoots(revokedPaths), mcpConnections.invalidateWorkspaceRoots(revokedPaths)]);
    await mcpConnections.revalidateManagementWorkspaces();
  });
}
