// @vitest-environment node
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { ProjectBrowserService } from '../../src/main/project/ProjectBrowserService';
import { ProjectFileStore } from '../../src/main/project/ProjectFileStore';
import { ProjectRunChangeRecorder } from '../../src/main/project/ProjectRunChangeRecorder';
import { ProjectWorkspaceStore } from '../../src/main/project/ProjectWorkspaceStore';
import type { SendMessageCommand } from '../../src/shared/agentProtocol';
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

it('lists and reads saved project run changes through the original IPC contract', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-run-changes-ipc-'));
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
  const list = 'asterium:project:run-changes-list';
  const read = 'asterium:project:run-changes-read';
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
    const files = new ProjectFileStore(() => path.join(root, 'project-files.v1.json'), workspaces);
    const recorder = new ProjectRunChangeRecorder(() => path.join(root, 'project-run-changes'), new ProjectBrowserService(workspaces, files), async () => undefined, () => undefined);
    const command = {
      clientMessageId: 'fixture-message', partnerId: 'fixture-partner', route: { scope: 'workspace', projectId },
    } as SendMessageCommand;
    const file = 'fixture.ts';
    const absoluteFile = path.join(workspace.rootPath, file);
    await writeFile(absoluteFile, 'before\n');
    await recorder.begin(command);
    recorder.report(command, [file]);
    await writeFile(absoluteFile, 'saved snapshot\n');
    await recorder.finish(command, 'completed');
    const records = await recorder.list(projectId);
    expect(records).toHaveLength(1);
    const request = { projectId, id: records[0].id, path: file };
    const snapshot = await recorder.read(request);
    // A subsequent edit lets the test distinguish the saved copy from the working file.
    await writeFile(absoluteFile, 'later edit\n');

    dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory, temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    expect([...handlers.keys()].filter((channel) => channel.startsWith('asterium:project:run-changes-')).sort()).toEqual([list, read]);
    const foreign = { send: vi.fn() };
    await expect(invoke(list, null, foreign)).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(read, null, foreign)).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(list, null)).rejects.toThrow('INVALID_PROJECT_ID');
    for (const invalid of [null, [], { ...request, projectId: 1 }, { ...request, id: 1 }, { ...request, path: 1 }]) {
      await expect(invoke(read, invalid)).rejects.toThrow('INVALID_PROJECT_CHANGE_REQUEST');
    }
    await expect(invoke(list, projectId)).resolves.toEqual(records);
    expect(snapshot).toMatchObject({ text: 'saved snapshot\n', diff: expect.stringContaining('-before\n+saved snapshot') });
    await expect(invoke(read, { ...request, extra: true })).resolves.toEqual(snapshot);
    await expect(invoke(list, 'missing-project')).rejects.toThrow('PROJECT_WORKSPACE_NOT_READY');
    await expect(invoke(read, { ...request, path: 'missing.ts' })).rejects.toThrow('PROJECT_CHANGE_FILE_NOT_FOUND');
  } finally {
    try {
      if (dispose) {
        await dispose();
        expect(handlers.has(list)).toBe(false);
        expect(handlers.has(read)).toBe(false);
      }
    } finally {
      await testRm(root, { recursive: true, force: true });
    }
  }
});
