// @vitest-environment node
import { mkdir, mkdtemp, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain, OpenDialogReturnValue } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { McpConnectionManager } from '../../src/main/api/extensions/McpConnectionManager';
import { ExecutionBackendRouter } from '../../src/main/execution/ExecutionBackendRouter';
import { WorkspaceGrantStore } from '../../src/main/security/WorkspaceGrantStore';
import type { WorkspaceGrant } from '../../src/shared/agentProtocol';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ userData: '', showOpenDialog: vi.fn<() => Promise<OpenDialogReturnValue>>() }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {},
  clipboard: {},
  dialog: { showOpenDialog: electron.showOpenDialog },
  safeStorage: {},
  shell: {},
}));

const select = 'asterium:agent:select-workspace';
const revoke = 'asterium:agent:revoke-workspace-grants';

async function withGrants(run: (fixture: {
  root: string;
  userData: string;
  grantFile: string;
  window: BrowserWindow;
  invoke: <T = unknown>(channel: string, value: unknown, caller?: object) => Promise<T>;
  restart: () => Promise<void>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-workspace-grant-ipc-'));
  const userData = path.join(root, 'profile');
  electron.userData = userData;
  electron.showOpenDialog.mockReset();
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const invoke = async <T,>(channel: string, value: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return await handler({ sender: caller }, value) as T;
  };
  const start = () => registerAgentIpc(ipcMain, () => window, { environment: {
    profile: 'autotest', label: 'Fixture', userDataDirectory: userData,
    projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
    appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
    restoreBackgroundServices: false, mcpPort: 0,
  } });
  try {
    await mkdir(path.join(userData, 'AsteriumData'), { recursive: true });
    let dispose = start();
    try {
      await run({
        root, userData, window, invoke, grantFile: path.join(userData, 'workspace-grants.v1.json'),
        restart: async () => {
          await dispose();
          expect(handlers.size).toBe(0);
          dispose = start();
        },
      });
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await testRm(root, { recursive: true, force: true });
  }
}

it('preserves the directory dialog, cancellation and protected paths for each purpose', async () => {
  await withGrants(async ({ root, userData, grantFile, window, invoke }) => {
    const directory = path.join(root, 'selected');
    await mkdir(directory);
    await expect(invoke(select, 'workspace', {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(select, 'unsupported')).rejects.toThrow('INVALID_DIRECTORY_SELECTION_PURPOSE');
    expect(electron.showOpenDialog).not.toHaveBeenCalled();

    const options = { buttonLabel: '授权此目录', properties: ['openDirectory', 'createDirectory'] };
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [directory] });
    await expect(invoke(select, undefined)).resolves.toBeNull();
    expect(electron.showOpenDialog).toHaveBeenLastCalledWith(window, { ...options, title: '授权伙伴额外工作区' });
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    await expect(invoke(select, 'workspace')).resolves.toBeNull();
    await expect(stat(grantFile)).rejects.toMatchObject({ code: 'ENOENT' });

    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path.join(userData, 'AsteriumData')] });
    await expect(invoke(select, 'partner_root')).rejects.toThrow('PROFILE_DATA_ACCESS_DENIED');
    expect(electron.showOpenDialog).toHaveBeenLastCalledWith(window, { ...options, title: '选择伙伴配置来源（原 CLI 项目根目录）' });

    const profileFolder = path.join(userData, 'fixture-folder');
    await mkdir(profileFolder);
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [profileFolder] });
    await expect(invoke(select, 'mcp_workspace')).rejects.toThrow('PROFILE_DATA_ACCESS_DENIED');
    expect(electron.showOpenDialog).toHaveBeenLastCalledWith(window, { ...options, title: '授权此 MCP 的测试工作区' });
    await expect(stat(grantFile)).rejects.toMatchObject({ code: 'ENOENT' });

    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [directory] });
    const grant = await invoke<WorkspaceGrant>(select, 'mcp_workspace');
    expect(grant).toEqual({ displayPath: directory, grantId: expect.stringMatching(/^workspace-/) });
    await expect(new WorkspaceGrantStore(grantFile).get(grant.grantId)).resolves.toBe(directory);
  });
});

it('restores saved grants across IPC restarts and revokes only the selected grant before invalidating dependents', async () => {
  await withGrants(async ({ root, grantFile, invoke, restart }) => {
    const selected = path.join(root, 'selected');
    const kept = path.join(root, 'kept');
    await Promise.all([mkdir(selected), mkdir(kept)]);
    electron.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [selected] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [kept] });
    const grant = await invoke<WorkspaceGrant>(select, 'workspace');
    const other = await invoke<WorkspaceGrant>(select, 'workspace');
    const partnerId = 'fixture-partner';
    await invoke(DESKTOP_IPC.syncPartnerWorkspace, { partnerId, workspaceGrantIds: [grant.grantId, other.grantId] });
    await restart();
    await expect(invoke(DESKTOP_IPC.getPartnerWorkspace, partnerId)).resolves.toMatchObject({
      workspaces: [{ ...grant, source: 'manual' }, { ...other, source: 'manual' }], unavailableGrantIds: [],
    });

    const deleteMany = vi.spyOn(WorkspaceGrantStore.prototype, 'deleteMany');
    const extensions = vi.spyOn(ExecutionBackendRouter.prototype, 'invalidateWorkspaceRoots');
    const mcp = vi.spyOn(McpConnectionManager.prototype, 'invalidateWorkspaceRoots');
    const revalidate = vi.spyOn(McpConnectionManager.prototype, 'revalidateManagementWorkspaces');
    await expect(invoke(revoke, [], {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(revoke, [grant.grantId, 1])).rejects.toThrow('INVALID_WORKSPACE_GRANT_REVOKE');
    expect(deleteMany).not.toHaveBeenCalled();
    expect(extensions).not.toHaveBeenCalled();
    expect(mcp).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();

    const ids = [grant.grantId, 'fixture-missing-grant'];
    await expect(invoke(revoke, ids)).resolves.toBeUndefined();
    const paths = [selected, await realpath(selected)];
    expect(deleteMany).toHaveBeenCalledExactlyOnceWith(ids);
    expect(extensions).toHaveBeenCalledExactlyOnceWith(paths);
    expect(mcp).toHaveBeenCalledExactlyOnceWith(paths);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledBefore(extensions);
    expect(deleteMany).toHaveBeenCalledBefore(mcp);
    expect(extensions).toHaveBeenCalledBefore(revalidate);
    expect(mcp).toHaveBeenCalledBefore(revalidate);
    const restored = new WorkspaceGrantStore(grantFile);
    await expect(restored.get(grant.grantId)).resolves.toBeUndefined();
    await expect(restored.get(other.grantId)).resolves.toBe(kept);
    await expect(invoke(DESKTOP_IPC.getPartnerWorkspace, partnerId)).resolves.toMatchObject({
      workspaces: [{ ...other, source: 'manual' }], unavailableGrantIds: [grant.grantId],
    });
    expect((await stat(selected)).isDirectory()).toBe(true);
  });
});
