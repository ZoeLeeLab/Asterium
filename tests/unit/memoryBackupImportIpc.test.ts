// @vitest-environment node
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain, OpenDialogReturnValue } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { writeMemoryBackup } from '../../src/main/memory/MemoryBackupFile';
import { PartnerMemoryService } from '../../src/main/memory/PartnerMemoryService';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import type { MemoryRecord } from '../../src/shared/memoryArchive';
import type { MemoryBackupPreview, MemoryBackupReceipt } from '../../src/shared/memoryBackup';
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

const choose = 'asterium:memory-backup:choose';
const confirm = 'asterium:memory-backup:import';
const cancel = 'asterium:memory-backup:cancel';
const changed = 'asterium:memory-archive:changed';
const partnerId = 'fixture-partner';
const sourcePartnerId = 'fixture-source-partner';
const timestamp = '2026-01-18T10:00:00.000Z';
const record: MemoryRecord = {
  schemaVersion: 1, partnerId: sourcePartnerId, memoryId: 'fixture-active', type: 'stable_fact', status: 'active',
  body: '合成记忆正文', tags: [], weight: 4, createdAt: timestamp, updatedAt: timestamp, comments: [], sources: [],
};
const archived = { ...record, memoryId: 'fixture-archived', deletedAt: timestamp };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function withBackupImport(run: (fixture: {
  root: string;
  window: BrowserWindow;
  backupFile: string;
  memories: PartnerMemoryService;
  changes: () => unknown[][];
  close: () => Promise<void>;
  invoke: <T = unknown>(channel: string, value: unknown, id?: unknown, caller?: object) => Promise<T>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-memory-backup-import-ipc-'));
  electron.userData = path.join(root, 'profile');
  electron.showOpenDialog.mockReset();
  const profiles = new PartnerProfileStore(path.join(electron.userData, 'AsteriumData'));
  const memories = new PartnerMemoryService(profiles);
  const sender = { send: vi.fn<(channel: string, data: unknown) => void>() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown, id: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const invoke = async <T,>(channel: string, value: unknown, id?: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return await handler({ sender: caller }, value, id) as T;
  };
  try {
    await profiles.savePartner({
      partnerId, sourceMode: 'local_cli',
      publicIdentity: { displayName: '合成伙伴', mentionName: '合成伙伴', introduction: '', expertise: '' },
      management: { memoryMode: 'asterium', personality: false, userProfile: false }, connectionSettings: {},
    });
    const backupFile = path.join(root, 'fixture-backup.asterium-memory.gz');
    await writeMemoryBackup(backupFile, {
      format: 'asterium.partner-memory', version: 1, partnerId: sourcePartnerId,
      records: [record, archived], fallbackMemoryIds: [],
    });
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: electron.userData,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= dispose();
    try {
      await run({
        root, window, backupFile, memories, invoke, close,
        changes: () => sender.send.mock.calls.filter(([channel]) => channel === changed),
      });
    } finally {
      await close();
    }
    expect(handlers.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
    profiles.dispose();
    await testRm(root, { recursive: true, force: true });
  }
}

it('previews without importing, then enforces partner and preview identity and consumes a successful draft', async () => {
  await withBackupImport(async ({ window, backupFile, memories, invoke, changes }) => {
    const importBackup = vi.spyOn(PartnerMemoryService.prototype, 'importBackup');
    for (const channel of [choose, confirm, cancel]) {
      await expect(invoke(channel, partnerId, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
    }
    await expect(invoke(choose, ' ')).rejects.toThrow('INVALID_MEMORY_PARTNER_ID');
    await expect(invoke(confirm, ' ')).rejects.toThrow('INVALID_MEMORY_PARTNER_ID');
    expect(electron.showOpenDialog).not.toHaveBeenCalled();

    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [backupFile] });
    const preview = await invoke<MemoryBackupPreview>(choose, partnerId);
    expect(preview).toEqual({ id: expect.any(String), fileName: path.basename(backupFile), total: 2, archived: 1 });
    expect(electron.showOpenDialog).toHaveBeenCalledExactlyOnceWith(window, {
      title: '选择伙伴记忆备份', filters: [{ name: '星丛伙伴记忆备份', extensions: ['gz'] }], properties: ['openFile'],
    });
    await expect(invoke(confirm, sourcePartnerId, preview.id)).rejects.toThrow('MEMORY_BACKUP_PREVIEW_EXPIRED');
    await expect(invoke(confirm, partnerId, 'fixture-other-preview')).rejects.toThrow('MEMORY_BACKUP_PREVIEW_EXPIRED');
    await expect(invoke(cancel, sourcePartnerId, preview.id)).resolves.toBeUndefined();
    expect(importBackup).not.toHaveBeenCalled();
    expect(changes()).toEqual([]);

    const transient = new Error('fixture-import-failed');
    importBackup.mockRejectedValueOnce(transient);
    await expect(invoke(confirm, partnerId, preview.id)).rejects.toBe(transient);
    await expect(invoke(confirm, partnerId, preview.id)).resolves.toEqual({ added: 2, skipped: 0 });
    await expect(invoke(confirm, partnerId, preview.id)).rejects.toThrow('MEMORY_BACKUP_PREVIEW_EXPIRED');
    for (const saved of [record, archived]) {
      await expect(memories.get(partnerId, saved.memoryId, { includeDeleted: true })).resolves.toEqual({ ...saved, partnerId });
    }
    const repeated = await invoke<MemoryBackupPreview>(choose, partnerId);
    await expect(invoke(confirm, partnerId, repeated.id)).resolves.toEqual({ added: 0, skipped: 2 });
    expect(changes()).toEqual([[changed, { partnerId }]]);
  });
});

it('blocks concurrent file selection and invalidates drafts on a new selection, cancel and exit', async () => {
  await withBackupImport(async ({ root, backupFile, invoke, close }) => {
    const file = { canceled: false, filePaths: [backupFile] };
    electron.showOpenDialog.mockResolvedValue(file);
    const initial = await invoke<MemoryBackupPreview>(choose, partnerId);
    const dialog = deferred<OpenDialogReturnValue>();
    electron.showOpenDialog.mockReturnValueOnce(dialog.promise);
    const pending = invoke(choose, partnerId);
    try {
      await expect(invoke(choose, partnerId)).rejects.toThrow('MEMORY_BACKUP_BUSY');
      await expect(invoke(confirm, partnerId, initial.id)).rejects.toThrow('MEMORY_BACKUP_PREVIEW_EXPIRED');
    } finally {
      dialog.resolve({ canceled: true, filePaths: [] });
    }
    await expect(pending).resolves.toBeNull();

    const invalidFile = path.join(root, 'fixture-invalid.gz');
    await writeFile(invalidFile, 'Invalid fixture backup.', 'utf8');
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [invalidFile] });
    await expect(invoke(choose, partnerId)).rejects.toThrow('MEMORY_BACKUP_INVALID');
    const next = await invoke<MemoryBackupPreview>(choose, partnerId);
    await expect(invoke(cancel, partnerId, next.id)).resolves.toBeUndefined();
    await expect(invoke(confirm, partnerId, next.id)).rejects.toThrow('MEMORY_BACKUP_PREVIEW_EXPIRED');

    const beforeExit = await invoke<MemoryBackupPreview>(choose, partnerId);
    const closing = close();
    await expect(invoke(confirm, partnerId, beforeExit.id)).rejects.toThrow('MEMORY_BACKUP_PREVIEW_EXPIRED');
    await closing;
  });
});

it('keeps a replacement draft when an earlier in-flight import finishes', async () => {
  await withBackupImport(async ({ backupFile, invoke }) => {
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [backupFile] });
    const receipt = { added: 2, skipped: 0 };
    const pending = deferred<MemoryBackupReceipt>();
    vi.spyOn(PartnerMemoryService.prototype, 'importBackup').mockResolvedValue(receipt).mockReturnValueOnce(pending.promise);
    const initial = await invoke<MemoryBackupPreview>(choose, partnerId);
    const earlier = invoke(confirm, partnerId, initial.id);
    const replacement = await invoke<MemoryBackupPreview>(choose, partnerId).finally(() => pending.resolve(receipt));
    await expect(earlier).resolves.toEqual(receipt);
    await expect(invoke(confirm, partnerId, replacement.id)).resolves.toEqual(receipt);
  });
});
