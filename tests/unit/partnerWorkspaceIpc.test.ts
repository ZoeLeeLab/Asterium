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

const getChannel = 'asterium:agent:get-partner-workspace';
const syncChannel = 'asterium:agent:sync-partner-workspace';
const changedChannel = 'asterium:agent:partner-workspace-changed';

async function withWorkspaceIpc(run: (fixture: {
  root: string;
  userData: string;
  invoke: (channel: string, value: unknown, caller?: object) => Promise<unknown>;
  setWindowAvailable: (available: boolean) => void;
  workspaceChanges: () => unknown[][];
}) => Promise<void>) {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-partner-workspace-ipc-'));
  const userData = path.join(root, 'profile');
  electron.userData = userData;
  const sender = { send: vi.fn<(channel: string, payload: unknown) => void>() };
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
  const invoke = (channel: string, value: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return handler({ sender: caller }, value);
  };

  try {
    await mkdir(userData);
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: userData,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await run({
        root, userData, invoke,
        setWindowAvailable: available => { window = available ? mainWindow : null; },
        workspaceChanges: () => sender.send.mock.calls.filter(([name]) => name === changedChannel),
      });
    } finally {
      await dispose();
    }
    expect(handlers.has(getChannel)).toBe(false);
    expect(handlers.has(syncChannel)).toBe(false);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
}

function workspaceFiles(userData: string) {
  const grantFile = path.join(userData, 'workspace-grants.v1.json');
  const workspaceFile = path.join(userData, 'conversation-workspaces.v1.json');
  const grants = new WorkspaceGrantStore(grantFile);
  const store = new PartnerWorkspaceStore(workspaceFile, grants);
  const snapshot = () => Promise.all([grantFile, workspaceFile].map(async file => ({
    bytes: await readFile(file),
    mtime: (await stat(file, { bigint: true })).mtimeNs,
  })));
  return { grants, store, snapshot };
}

it('reads saved partner workspaces through the existing sender-checked IPC and leaves the grants intact', async () => {
  await withWorkspaceIpc(async ({ root, userData, invoke, setWindowAvailable }) => {
    const cwd = path.join(root, 'working-directory');
    const manual = path.join(root, 'manual-directory');
    const unavailable = path.join(root, 'unavailable-directory');
    await Promise.all([cwd, manual, unavailable].map(directory => mkdir(directory)));
    const { grants, store, snapshot } = workspaceFiles(userData);
    const [cwdGrant, manualGrant, unavailableGrant] = await Promise.all([cwd, manual, unavailable].map(directory => grants.add(directory)));
    const partnerId = 'fixture-partner';
    await store.ensure(partnerId, cwdGrant.grantId, [manualGrant.grantId, unavailableGrant.grantId]);
    await rename(unavailable, path.join(root, 'moved-directory'));
    const expected = {
      partnerId,
      cwd: { grantId: cwdGrant.grantId, displayPath: cwd },
      workspaces: [{ grantId: manualGrant.grantId, displayPath: manual, source: 'manual' }],
      version: 1,
      unavailableGrantIds: [unavailableGrant.grantId],
    };
    const before = await snapshot();

    await expect(invoke(getChannel, '', {})).rejects.toThrow('INVALID_IPC_SENDER');
    setWindowAvailable(false);
    try {
      await expect(invoke(getChannel, partnerId)).rejects.toThrow('INVALID_IPC_SENDER');
    } finally {
      setWindowAvailable(true);
    }
    for (const invalid of [undefined, '', 1, { partnerId }]) {
      await expect(invoke(getChannel, invalid)).rejects.toThrow('INVALID_PARTNER_ID');
    }
    for (const unconfigured of ['unconfigured-fixture', ' ']) {
      await expect(invoke(getChannel, unconfigured)).resolves.toEqual({
        partnerId: unconfigured, workspaces: [], version: 0, unavailableGrantIds: [],
      });
    }
    await expect(invoke(getChannel, partnerId)).resolves.toEqual(expected);
    expect(await snapshot()).toEqual(before);
  });
});

it('syncs manual grants with version checks, retains project grants and publishes the saved workspace', async () => {
  await withWorkspaceIpc(async ({ root, userData, invoke, workspaceChanges }) => {
    const cwd = path.join(root, 'working-directory');
    const manual = path.join(root, 'manual-directory');
    const project = path.join(root, 'project-directory');
    const protectedDirectory = path.join(userData, 'AsteriumData');
    await Promise.all([cwd, manual, project].map(directory => mkdir(directory)));
    await mkdir(protectedDirectory, { recursive: true });
    const { grants, store, snapshot } = workspaceFiles(userData);
    const [cwdGrant, manualGrant, protectedGrant] = await Promise.all([cwd, manual, protectedDirectory].map(directory => grants.add(directory)));
    const partnerId = 'fixture-partner';
    const projectId = 'fixture-project';
    await store.ensure(partnerId, cwdGrant.grantId, []);
    const [initial] = await store.reconcileProjects([{ projectId, rootPath: project, partnerIds: [partnerId] }]);
    const before = await snapshot();
    const request = {
      partnerId,
      cwdGrantId: cwdGrant.grantId,
      workspaceGrantIds: [manualGrant.grantId, cwdGrant.grantId, manualGrant.grantId],
    };

    await expect(invoke(syncChannel, request, {})).rejects.toThrow('INVALID_IPC_SENDER');
    for (const invalid of [null, { ...request, partnerId: '' }, { ...request, cwdGrantId: 1 },
      { ...request, workspaceGrantIds: undefined }, { ...request, workspaceGrantIds: [false] }, { ...request, expectedVersion: 1.5 }]) {
      await expect(invoke(syncChannel, invalid)).rejects.toThrow('INVALID_PARTNER_WORKSPACE_SYNC');
    }
    await expect(invoke(syncChannel, { ...request, cwdGrantId: protectedGrant.grantId })).rejects.toThrow('PROFILE_DATA_ACCESS_DENIED');
    await expect(invoke(syncChannel, { ...request, expectedVersion: initial.version - 1 })).rejects.toThrow('PARTNER_WORKSPACE_VERSION_CONFLICT');
    expect(await snapshot()).toEqual(before);
    expect(workspaceChanges()).toEqual([]);

    const updated = {
      ...initial,
      workspaces: [{ grantId: manualGrant.grantId, displayPath: manual, source: 'manual' }, ...initial.workspaces],
      version: initial.version + 1,
    };
    await expect(invoke(syncChannel, { ...request, expectedVersion: initial.version })).resolves.toEqual(updated);
    expect(workspaceChanges()).toEqual([[changedChannel, updated]]);
    await expect(invoke(getChannel, partnerId)).resolves.toEqual(updated);

    const cleared = {
      partnerId, workspaces: initial.workspaces, version: updated.version + 1, unavailableGrantIds: [],
    };
    await expect(invoke(syncChannel, { partnerId, workspaceGrantIds: [] })).resolves.toEqual(cleared);
    await expect(invoke(getChannel, partnerId)).resolves.toEqual(cleared);
    expect(workspaceChanges()).toEqual([[changedChannel, updated], [changedChannel, cleared]]);
    expect((await snapshot())[0]).toEqual(before[0]);
  });
});
