// @vitest-environment node
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { ProjectFileStore } from '../../src/main/project/ProjectFileStore';
import { ProjectWorkspaceStore } from '../../src/main/project/ProjectWorkspaceStore';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '' }));
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
  shell: {},
}));

it('keeps project browsing and indexed file listing on their existing IPC channels', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-file-query-ipc-'));
  electron.root = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: typeof sender }, value: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const browse = 'asterium:project:browse';
  const list = 'asterium:project:list-files';
  const invoke = async (channel: string, value: unknown, caller = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return handler({ sender: caller }, value);
  };

  let dispose: (() => Promise<void>) | undefined;
  try {
    const projectsDirectory = path.join(root, 'projects');
    const projectId = 'fixture-project';
    const workspaces = new ProjectWorkspaceStore(path.join(root, 'project-workspaces.v1.json'), () => projectsDirectory);
    const workspace = await workspaces.create({ projectId, name: 'Fixture project' });
    const files = new ProjectFileStore(path.join(root, 'project-files.v1.json'), workspaces);
    const indexedPath = path.join(workspace.rootPath, 'indexed.ts');
    await writeFile(indexedPath, 'const indexed = true;\n');
    await writeFile(path.join(workspace.rootPath, 'unregistered.ts'), 'const unregistered = true;\n');
    await files.initializeProject(workspace, [{ artifactId: 'fixture-artifact', relativePath: 'indexed.ts', originalPath: indexedPath }]);
    const expectedFiles = await files.list(projectId);
    const indexed = expectedFiles.find((file) => file.relativePath === 'indexed.ts');
    expect(indexed).toBeDefined();

    dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory, temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    const foreign = { send: vi.fn() };
    await expect(invoke(browse, null, foreign)).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(list, null, foreign)).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(browse, { projectId, action: 'history', offset: -1 })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(invoke(list, null)).rejects.toThrow('INVALID_PROJECT_ID');
    await expect(invoke(browse, { projectId, action: 'file', path: '../outside.ts' })).rejects.toThrow('PROJECT_FILE_PATH_REJECTED');
    await expect(invoke(browse, { projectId, action: 'directory' })).resolves.toMatchObject({
      entries: expect.arrayContaining([{ name: 'unregistered.ts', path: 'unregistered.ts', directory: false }]),
    });
    await expect(invoke(browse, { projectId, action: 'file', fileId: indexed!.fileId })).resolves.toMatchObject({
      content: { path: 'indexed.ts', text: 'const indexed = true;\n' },
    });
    expect(expectedFiles.map((file) => file.relativePath)).not.toContain('unregistered.ts');
    await expect(invoke(list, projectId)).resolves.toEqual(expectedFiles);
  } finally {
    try {
      if (dispose) {
        await dispose();
        expect(handlers.has(browse)).toBe(false);
        expect(handlers.has(list)).toBe(false);
      }
    } finally {
      await testRm(root, { recursive: true, force: true });
    }
  }
});
