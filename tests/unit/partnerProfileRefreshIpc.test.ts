// @vitest-environment node
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { PartnerDiaryScheduler } from '../../src/main/diary/PartnerDiaryScheduler';
import { MemoryFallbackInventory } from '../../src/main/memory/fallback/MemoryFallbackInventory';
import { StudioRuntimeCatalog } from '../../src/main/studio/StudioRuntimeCatalog';
import type { PartnerProfileSeed, PartnerProfilesSyncResult } from '../../src/shared/agentProtocol';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: {},
  shell: {},
}));

const refresh = 'asterium:agent:refresh-partner-profiles';
const changed = 'asterium:agent:partner-profiles-changed';

it('reads external profile edits, preserves unchanged file revisions and keeps existing refresh notifications', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-profile-refresh-ipc-'));
  electron.userData = root;
  const sender = { send: vi.fn<(channel: string, payload: unknown) => void>() };
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
  const invoke = async <T,>(channel: string, request?: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return await handler({ sender: caller }, request) as T;
  };
  const changes = () => sender.send.mock.calls.filter(([channel]) => channel === changed);
  try {
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      const profileRoot = path.join(root, 'AsteriumData');
      const userPath = path.join(profileRoot, 'user', 'user-profile.md');
      await expect(invoke(refresh, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(refresh)).rejects.toThrow('PARTNER_PROFILES_NOT_INITIALIZED');
      await expect(stat(userPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(changes()).toEqual([]);

      const seed: PartnerProfileSeed = {
        partnerId: 'fixture-partner', sourceMode: 'local_cli',
        publicIdentity: { displayName: '合成伙伴', introduction: '原伙伴介绍', expertise: '', mentionName: '合成伙伴' },
        management: { memoryMode: 'self_managed', personality: true, userProfile: true },
        connectionSettings: { adapterType: 'claude_code' },
      };
      const initial = await invoke<PartnerProfilesSyncResult>(DESKTOP_IPC.syncPartnerProfiles, {
        user: { displayName: '合成用户', introduction: '原用户介绍', updatedAt: '' }, partners: [seed],
      });
      const partnerPath = path.join(profileRoot, 'partners', initial.partners[0].directoryName, 'profile.md');
      const readSnapshot = (file: string) => Promise.all([readFile(file, 'utf8'), stat(file, { bigint: true }).then(value => value.mtimeNs)]);
      const original = await Promise.all([readSnapshot(userPath), readSnapshot(partnerPath)]);
      const applyProfiles = vi.spyOn(StudioRuntimeCatalog.prototype, 'applyProfiles');
      const diaryChanged = vi.spyOn(PartnerDiaryScheduler.prototype, 'changed');
      const refreshInventory = vi.spyOn(MemoryFallbackInventory.prototype, 'refresh');
      sender.send.mockClear();

      await expect(invoke(refresh)).resolves.toEqual(initial);
      await expect(Promise.all([readSnapshot(userPath), readSnapshot(partnerPath)])).resolves.toEqual(original);

      const userMarkdown = (await readFile(userPath, 'utf8')).replace('原用户介绍', '外部修改的合成用户介绍');
      const partnerMarkdown = (await readFile(partnerPath, 'utf8')).replace('原伙伴介绍', '外部修改的合成伙伴介绍');
      await Promise.all([writeFile(userPath, userMarkdown), writeFile(partnerPath, partnerMarkdown)]);
      const updated = await invoke<PartnerProfilesSyncResult>(refresh);
      expect(updated.user.introduction).toBe('外部修改的合成用户介绍');
      expect(updated.partners[0].publicIdentity.introduction).toBe('外部修改的合成伙伴介绍');
      expect(updated.user.revision).not.toBe(initial.user.revision);
      expect(updated.partners[0].revision).not.toBe(initial.partners[0].revision);
      await expect(readFile(userPath, 'utf8')).resolves.toBe(userMarkdown);
      await expect(readFile(partnerPath, 'utf8')).resolves.toBe(partnerMarkdown);

      expect(applyProfiles.mock.calls).toEqual([[initial], [updated]]);
      expect(diaryChanged).toHaveBeenCalledTimes(2);
      expect(refreshInventory).toHaveBeenCalledTimes(2);
      expect(changes()).toEqual([[changed, initial], [changed, updated]]);
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await testRm(root, { recursive: true, force: true });
  }
});
