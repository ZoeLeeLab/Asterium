// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { StudioRuntimeCatalog } from '../../src/main/studio/StudioRuntimeCatalog';
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

const channel = 'asterium:agent:save-user-profile';
const fixtureProfile = { displayName: '  Fixture user  ', introduction: '  Synthetic introduction  ', updatedAt: '' };

async function withUserProfile(run: (fixture: {
  profilePath: string;
  invoke: (value: unknown, caller?: object) => Promise<unknown>;
}) => Promise<void>) {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-user-profile-ipc-'));
  const userData = path.join(root, 'profile');
  const profilePath = path.join(userData, 'AsteriumData', 'user', 'user-profile.md');
  electron.userData = userData;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (name: string, handler: Handler) => {
      if (handlers.has(name)) throw new Error(`Duplicate IPC channel: ${name}`);
      handlers.set(name, handler);
    },
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as IpcMain;
  const invoke = (value: unknown, caller: object = sender) => {
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
      await run({ profilePath, invoke });
    } finally {
      await dispose();
    }
    expect(handlers.has(channel)).toBe(false);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
}

it('rejects untrusted senders and invalid user profiles before writing or updating the catalog', async () => {
  await withUserProfile(async ({ profilePath, invoke }) => {
    const updateUser = vi.spyOn(StudioRuntimeCatalog.prototype, 'updateUser');
    try {
      await expect(invoke(fixtureProfile, {})).rejects.toThrow('INVALID_IPC_SENDER');
      for (const invalid of [null, { ...fixtureProfile, displayName: 'x'.repeat(81) },
        { ...fixtureProfile, introduction: 'x'.repeat(20_001) }, { ...fixtureProfile, updatedAt: 0 },
        { ...fixtureProfile, revision: 'A'.repeat(64) }]) {
        await expect(invoke(invalid)).rejects.toThrow('INVALID_USER_PROFILE');
      }
      await expect(invoke({ ...fixtureProfile, displayName: ' ' })).rejects.toThrow('USER_PROFILE_INVALID');
      await expect(stat(profilePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(updateUser).not.toHaveBeenCalled();
    } finally {
      updateUser.mockRestore();
    }
  });
});

it('saves with or without a revision, updates the catalog after writing, and leaves both intact on conflict', async () => {
  await withUserProfile(async ({ profilePath, invoke }) => {
    const updateCatalog = StudioRuntimeCatalog.prototype.updateUser;
    const diskAtUpdate: string[] = [];
    const updateUser = vi.spyOn(StudioRuntimeCatalog.prototype, 'updateUser').mockImplementation(function (this: StudioRuntimeCatalog, user) {
      diskAtUpdate.push(readFileSync(profilePath, 'utf8'));
      updateCatalog.call(this, user);
    });
    try {
      const first = await invoke(fixtureProfile);
      const firstMarkdown = await readFile(profilePath, 'utf8');
      expect(firstMarkdown).toContain('## 名字\n\nFixture user\n');
      expect(firstMarkdown).toContain('## 介绍\n\nSynthetic introduction\n');
      const revision = createHash('sha256').update(firstMarkdown).digest('hex');
      expect(first).toEqual({
        displayName: 'Fixture user', introduction: 'Synthetic introduction',
        updatedAt: (await stat(profilePath)).mtime.toISOString(), revision,
      });
      expect(updateUser).toHaveBeenCalledExactlyOnceWith(first);
      expect(diskAtUpdate).toEqual([firstMarkdown]);
      const catalog = updateUser.mock.contexts[0] as StudioRuntimeCatalog;
      expect(catalog.user()).toEqual(first);

      const second = await invoke({ ...fixtureProfile, introduction: 'Fixture edit', revision });
      const savedMarkdown = await readFile(profilePath, 'utf8');
      expect(savedMarkdown).toContain('## 介绍\n\nFixture edit\n');
      const savedStat = await stat(profilePath, { bigint: true });
      expect(second).toEqual({
        displayName: 'Fixture user', introduction: 'Fixture edit', updatedAt: (await stat(profilePath)).mtime.toISOString(),
        revision: createHash('sha256').update(savedMarkdown).digest('hex'),
      });
      expect(updateUser).toHaveBeenCalledTimes(2);
      expect(updateUser).toHaveBeenLastCalledWith(second);
      expect(diskAtUpdate).toEqual([firstMarkdown, savedMarkdown]);
      expect(catalog.user()).toEqual(second);

      await expect(invoke({ ...fixtureProfile, displayName: 'Stale fixture edit', revision })).rejects.toThrow('PROFILE_VERSION_CONFLICT');
      await expect(readFile(profilePath, 'utf8')).resolves.toBe(savedMarkdown);
      expect((await stat(profilePath, { bigint: true })).mtimeNs).toBe(savedStat.mtimeNs);
      expect(updateUser).toHaveBeenCalledTimes(2);
      expect(catalog.user()).toEqual(second);
    } finally {
      updateUser.mockRestore();
    }
  });
});
