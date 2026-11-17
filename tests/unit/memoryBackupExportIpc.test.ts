// @vitest-environment node
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain, SaveDialogReturnValue } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { readMemoryBackup } from '../../src/main/memory/MemoryBackupFile';
import { PartnerMemoryService } from '../../src/main/memory/PartnerMemoryService';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import type { PartnerProfileSeed } from '../../src/shared/agentProtocol';
import type { MemoryRecord } from '../../src/shared/memoryArchive';
import type { MemoryBackupData } from '../../src/shared/memoryBackup';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ userData: '', showSaveDialog: vi.fn<() => Promise<SaveDialogReturnValue>>() }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {},
  clipboard: {},
  dialog: { showSaveDialog: electron.showSaveDialog },
  safeStorage: {},
  shell: {},
}));

const channel = 'asterium:memory-backup:export';
const seed: PartnerProfileSeed = {
  partnerId: 'fixture-partner', sourceMode: 'local_cli',
  publicIdentity: { displayName: '合成/伙伴:样例', introduction: '', expertise: '', mentionName: '合成伙伴' },
  management: { memoryMode: 'asterium', personality: false, userProfile: false }, connectionSettings: {},
};
const { partnerId } = seed;
const timestamp = '2026-01-18T10:00:00.000Z';
const active: MemoryRecord = {
  schemaVersion: 1, partnerId, memoryId: 'fixture-active', type: 'stable_fact', status: 'active',
  body: '合成记忆正文', tags: ['样例'], weight: 4, createdAt: timestamp, updatedAt: timestamp, comments: [], sources: [],
};
const archived = { ...active, memoryId: 'fixture-archived', body: '合成归档正文', deletedAt: timestamp };

async function withExport(run: (fixture: {
  root: string;
  userData: string;
  window: BrowserWindow;
  memories: PartnerMemoryService;
  invoke: (value: unknown, caller?: object) => Promise<unknown>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-memory-backup-export-ipc-'));
  const userData = path.join(root, 'profile');
  electron.userData = userData;
  electron.showSaveDialog.mockReset();
  const profiles = new PartnerProfileStore(path.join(userData, 'AsteriumData'));
  const memories = new PartnerMemoryService(profiles);
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
  const invoke = async (value: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return await handler({ sender: caller }, value);
  };

  try {
    await profiles.savePartner(seed);
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: userData, projectsDirectory: path.join(root, 'projects'),
      temporaryDirectory: root, appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await run({ root, userData, window, memories, invoke });
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
    profiles.dispose();
    await testRm(root, { recursive: true, force: true });
  }
}

it('keeps caller, partner, dialog cancellation and protected destination checks before export', async () => {
  await withExport(async ({ root, userData, window, invoke }) => {
    const exportBackup = vi.spyOn(PartnerMemoryService.prototype, 'exportBackup');
    await expect(invoke(partnerId, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(' ')).rejects.toThrow('INVALID_MEMORY_PARTNER_ID');
    await expect(invoke('fixture-missing-partner')).rejects.toThrow('PARTNER_MEMORY_NOT_MANAGED');
    expect(electron.showSaveDialog).not.toHaveBeenCalled();

    const canceledTarget = path.join(root, 'canceled.asterium-memory.gz');
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: canceledTarget });
    await expect(invoke(partnerId)).resolves.toBeNull();
    expect(electron.showSaveDialog).toHaveBeenCalledExactlyOnceWith(window, {
      title: '导出伙伴记忆', defaultPath: expect.stringMatching(/^星丛记忆-合成_伙伴_样例-\d{4}-\d{2}-\d{2}\.asterium-memory\.gz$/u),
      filters: [{ name: '星丛伙伴记忆备份', extensions: ['gz'] }],
    });
    await expect(stat(canceledTarget)).rejects.toMatchObject({ code: 'ENOENT' });

    const protectedTarget = path.join(userData, 'protected.asterium-memory.gz');
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: protectedTarget });
    await expect(invoke(partnerId)).rejects.toThrow('PROFILE_DATA_ACCESS_DENIED');
    await expect(stat(protectedTarget)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(exportBackup).not.toHaveBeenCalled();
  });
});

it('writes a readable gzip with active and archived records and returns the record count', async () => {
  await withExport(async ({ root, memories, invoke }) => {
    const target = path.join(root, 'export.asterium-memory.gz');
    electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
    await expect(invoke(partnerId)).resolves.toBe(0);

    const data: MemoryBackupData = {
      format: 'asterium.partner-memory', version: 1, partnerId,
      records: [active, archived], fallbackMemoryIds: [],
    };
    await memories.importBackup(partnerId, data);
    await expect(invoke(partnerId)).resolves.toBe(2);
    await expect(readMemoryBackup(target)).resolves.toEqual({ ...data, records: expect.arrayContaining([active, archived]) });
  });
});
