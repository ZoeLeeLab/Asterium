// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain, OpenDialogReturnValue } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { WorkspaceGrantStore } from '../../src/main/security/WorkspaceGrantStore';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';
import type { ClaudeSessionImport } from '../../src/shared/agentProtocol';
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

const channel = 'asterium:agent:import-claude-session';

it('checks the file picker, preserves existing bindings and only grants a valid unbound session directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-claude-session-import-ipc-'));
  const userData = path.join(root, 'profile');
  const projects = path.join(root, '.claude', 'projects');
  const project = path.join(projects, 'fixture-project');
  const workspace = path.join(root, 'workspace');
  const grantFile = path.join(userData, 'workspace-grants.v1.json');
  const bindingsFile = path.join(userData, 'native-thread-bindings.v1.json');
  electron.userData = userData;
  const home = vi.spyOn(os, 'homedir').mockReturnValue(root);
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (name: string, handler: Handler) => {
      if (handlers.has(name)) throw new Error(`Duplicate IPC channel: ${name}`);
      handlers.set(name, handler);
    },
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as IpcMain;
  const invoke = async (caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return await handler({ sender: caller }) as ClaudeSessionImport | null;
  };

  try {
    await Promise.all([mkdir(userData), mkdir(project, { recursive: true }), mkdir(workspace)]);
    const sessionId = '00000001-0000-4000-8000-000000000001';
    const sessionFile = path.join(project, `${sessionId}.jsonl`);
    const outside = path.join(root, `${sessionId}.jsonl`);
    const payload = JSON.stringify({ type: 'user', sessionId, cwd: workspace });
    await Promise.all([writeFile(sessionFile, payload), writeFile(outside, payload)]);
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: userData,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await expect(invoke({})).rejects.toThrow('INVALID_IPC_SENDER');
      expect(electron.showOpenDialog).not.toHaveBeenCalled();
      electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [sessionFile] });
      await expect(invoke()).resolves.toBeNull();
      expect(electron.showOpenDialog).toHaveBeenLastCalledWith(window, {
        title: '选择要导入的 Claude Code 会话文件', buttonLabel: '导入此会话',
        defaultPath: projects, properties: ['openFile'], filters: [{ name: 'Claude Code session', extensions: ['jsonl'] }],
      });
      electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
      await expect(invoke()).resolves.toBeNull();
      electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [outside] });
      await expect(invoke()).rejects.toThrow('INVALID_CLAUDE_SESSION_FILE');
      await expect(stat(grantFile)).rejects.toMatchObject({ code: 'ENOENT' });

      electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [sessionFile] });
      const imported = await invoke();
      if (!imported) throw new Error('Expected a fixture session import');
      const workingDirectory = await realpath(workspace);
      expect(imported).toEqual({
        sessionId, sessionFilePath: await realpath(sessionFile),
        workspaceGrant: { grantId: expect.stringMatching(/^workspace-/), displayPath: workingDirectory },
      });
      await expect(new WorkspaceGrantStore(grantFile).get(imported.workspaceGrant.grantId)).resolves.toBe(workingDirectory);
      const bindings = new NativeThreadBindingStore(bindingsFile);
      await expect(bindings.isBoundNativeThread(sessionId)).resolves.toBe(false);
      await bindings.registerSingle({ partnerId: 'fixture-partner', source: 'local_cli', conversationId: 'fixture-chat', nativeThreadId: sessionId });
      const storedGrant = await readFile(grantFile);
      const storedBinding = await readFile(bindingsFile);
      await expect(invoke()).rejects.toThrow('NATIVE_THREAD_ALREADY_BOUND');
      await expect(readFile(grantFile)).resolves.toEqual(storedGrant);
      await expect(readFile(bindingsFile)).resolves.toEqual(storedBinding);
      await expect(readFile(sessionFile, 'utf8')).resolves.toBe(payload);
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
  } finally {
    home.mockRestore();
    await testRm(root, { recursive: true, force: true });
  }
});
