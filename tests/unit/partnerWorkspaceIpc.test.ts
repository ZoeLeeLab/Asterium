// @vitest-environment node
import { mkdir, mkdtemp, readFile, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { PartnerWorkspaceStore } from '../../src/main/security/PartnerWorkspaceStore';
import { WorkspaceGrantStore } from '../../src/main/security/WorkspaceGrantStore';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.userData,
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

it('reads saved partner workspaces through the existing sender-checked IPC and leaves the grants intact', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-partner-workspace-ipc-'));
  const userData = path.join(root, 'profile');
  electron.userData = userData;
  const sender = { send: vi.fn() };
  const mainWindow = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  let window: BrowserWindow | null = mainWindow;
  type Handler = (event: { sender: object }, value: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (name: string, handler: Handler) => {
      if (handlers.has(name)) throw new Error(`Duplicate IPC channel: ${name}`);
      handlers.set(name, handler);
    },
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as IpcMain;
  const channel = 'asterium:agent:get-partner-workspace';

  try {
    const cwd = path.join(root, 'working-directory');
    const manual = path.join(root, 'manual-directory');
    const unavailable = path.join(root, 'unavailable-directory');
    await Promise.all([userData, cwd, manual, unavailable].map(directory => mkdir(directory)));
    const grantFile = path.join(userData, 'workspace-grants.v1.json');
    const workspaceFile = path.join(userData, 'conversation-workspaces.v1.json');
    const grants = new WorkspaceGrantStore(grantFile);
    const [cwdGrant, manualGrant, unavailableGrant] = await Promise.all([cwd, manual, unavailable].map(directory => grants.add(directory)));
    const partnerId = 'fixture-partner';
    const store = new PartnerWorkspaceStore(workspaceFile, grants);
    await store.ensure(partnerId, cwdGrant.grantId, [manualGrant.grantId, unavailableGrant.grantId]);
    await rename(unavailable, path.join(root, 'moved-directory'));
    const expected = {
      partnerId,
      cwd: { grantId: cwdGrant.grantId, displayPath: cwd },
      workspaces: [{ grantId: manualGrant.grantId, displayPath: manual, source: 'manual' }],
      version: 1,
      unavailableGrantIds: [unavailableGrant.grantId],
    };
    const files = [grantFile, workspaceFile];
    const snapshot = () => Promise.all(files.map(async file => ({
      bytes: await readFile(file),
      mtime: (await stat(file, { bigint: true })).mtimeNs,
    })));
    const before = await snapshot();

    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: userData,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
      await expect(handler({ sender: {} }, '')).rejects.toThrow('INVALID_IPC_SENDER');
      window = null;
      try {
        await expect(handler({ sender }, partnerId)).rejects.toThrow('INVALID_IPC_SENDER');
      } finally {
        window = mainWindow;
      }
      for (const invalid of [undefined, '', 1, { partnerId }]) {
        await expect(handler({ sender }, invalid)).rejects.toThrow('INVALID_PARTNER_ID');
      }
      for (const unconfigured of ['unconfigured-fixture', ' ']) {
        await expect(handler({ sender }, unconfigured)).resolves.toEqual({
          partnerId: unconfigured, workspaces: [], version: 0, unavailableGrantIds: [],
        });
      }
      await expect(handler({ sender }, partnerId)).resolves.toEqual(expected);
      expect(await snapshot()).toEqual(before);
    } finally {
      await dispose();
    }
    expect(handlers.has(channel)).toBe(false);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
});
