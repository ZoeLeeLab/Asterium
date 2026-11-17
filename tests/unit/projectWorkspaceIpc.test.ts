// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { ProjectWorkspaceStore } from '../../src/main/project/ProjectWorkspaceStore';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({
  root: '',
  openPath: vi.fn<(directory: string) => Promise<string>>().mockResolvedValue(''),
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.root,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    whenReady: async () => undefined,
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: {},
  shell: { openPath: electron.openPath },
}));

it('reads the registered workspace and opens its stored path through IPC', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-workspace-ipc-'));
  electron.root = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, projectId: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const get = 'asterium:project:get-workspace';
  const open = 'asterium:project:open-workspace';
  const invoke = async (channel: string, projectId: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return handler({ sender: caller }, projectId);
  };

  try {
    const projectsDirectory = path.join(root, 'projects');
    const workspaces = new ProjectWorkspaceStore(path.join(root, 'project-workspaces.v1.json'), () => projectsDirectory);
    const workspace = await workspaces.create({ projectId: 'fixture-project', name: 'Fixture project' });
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory, temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      for (const channel of [get, open]) {
        await expect(invoke(channel, workspace.projectId, {})).rejects.toThrow('INVALID_IPC_SENDER');
        await expect(invoke(channel, { projectId: workspace.projectId })).rejects.toThrow('INVALID_PROJECT_ID');
      }
      await expect(invoke(get, workspace.projectId)).resolves.toEqual(workspace);
      await expect(invoke(get, 'missing-fixture-project')).resolves.toBeNull();
      await expect(invoke(open, 'missing-fixture-project')).rejects.toThrow('PROJECT_WORKSPACE_NOT_READY');
      expect(electron.openPath).not.toHaveBeenCalled();

      await expect(invoke(open, workspace.projectId)).resolves.toBeUndefined();
      expect(electron.openPath.mock.calls).toEqual([[workspace.rootPath]]);

      electron.openPath.mockResolvedValueOnce('Fixture shell error');
      await expect(invoke(open, workspace.projectId)).rejects.toMatchObject({ message: 'Fixture shell error' });
      expect(electron.openPath.mock.calls).toEqual([[workspace.rootPath], [workspace.rootPath]]);
    } finally {
      await dispose();
    }
    expect(handlers.has(get)).toBe(false);
    expect(handlers.has(open)).toBe(false);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
});
