// @vitest-environment node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { PartnerDiaryStore } from '../../src/main/diary/PartnerDiaryStore';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '', showSaveDialog: vi.fn() }));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.root,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    whenReady: async () => undefined,
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: { showSaveDialog: electron.showSaveDialog },
  safeStorage: {},
  shell: {},
}));

it('reads stored diary states and only exports verified Markdown without changing its bytes', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-partner-diary-ipc-'));
  electron.root = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, request: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const read = 'asterium:diary:read';
  const exportMarkdown = 'asterium:diary:export';
  const invoke = async (channel: string, request: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return handler({ sender: caller }, request);
  };

  try {
    const partnerId = 'fixture-diary-partner';
    const profiles = new PartnerProfileStore(path.join(root, 'AsteriumData'));
    await profiles.savePartner({
      partnerId, sourceMode: 'local_cli',
      publicIdentity: { displayName: 'Fixture partner', mentionName: 'fixture', introduction: '', expertise: '' },
      management: { memoryMode: 'self_managed', personality: false, userProfile: false },
      connectionSettings: {},
    });
    const diaryDirectory = await profiles.diaryDirectory(partnerId);
    const diaries = new PartnerDiaryStore(diaryDirectory, partnerId);
    const conversationId = 'fixture-diary-conversation';
    const date = '2026-10-21';
    const content = '# 合成日记\r\n\r\n保留中文和换行。 🌱\r\n';
    const claimed = await diaries.claim(date, conversationId);
    if (!claimed) throw new Error('Could not claim fixture diary');
    const completed = await diaries.finish(date, claimed.generationId, { state: 'completed', content });

    const incomplete = [];
    for (const [entryDate, state] of [['2026-10-22', 'running'], ['2026-10-23', 'skipped'], ['2026-10-24', 'failed']] as const) {
      const entry = await diaries.claim(entryDate, conversationId);
      if (!entry) throw new Error('Could not claim fixture diary');
      incomplete.push(state === 'running' ? entry : await diaries.finish(entryDate, entry.generationId, { state, reason: 'fixture-reason' }));
    }

    const target = { partnerId, date };
    const source = path.join(diaryDirectory, `${date}.md`);
    const destination = path.join(root, 'fixture-export.md');
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      for (const channel of [read, exportMarkdown]) {
        await expect(invoke(channel, target, {})).rejects.toThrow('INVALID_IPC_SENDER');
        await expect(invoke(channel, { ...target, date: '2026-02-30' })).rejects.toMatchObject({ name: 'ZodError' });
      }
      const missing = { partnerId, date: '2026-10-25' };
      await expect(invoke(read, missing)).resolves.toBeUndefined();
      await expect(invoke(exportMarkdown, missing)).rejects.toThrow('DIARY_NOT_COMPLETED');
      for (const entry of incomplete) {
        const request = { partnerId, date: entry.date };
        await expect(invoke(read, request)).resolves.toEqual({ entry });
        await expect(invoke(exportMarkdown, request)).rejects.toThrow('DIARY_NOT_COMPLETED');
      }
      await expect(invoke(read, target)).resolves.toEqual({ entry: completed, content });
      await writeFile(source, 'Modified fixture diary.', 'utf8');
      await expect(invoke(read, target)).rejects.toThrow('DIARY_CONTENT_CHANGED');
      await expect(invoke(exportMarkdown, target)).rejects.toThrow('DIARY_CONTENT_CHANGED');
      expect(electron.showSaveDialog).not.toHaveBeenCalled();
      await writeFile(source, content, 'utf8');

      electron.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: destination });
      await expect(invoke(exportMarkdown, target)).resolves.toBe(false);
      expect(electron.showSaveDialog).toHaveBeenLastCalledWith(window, {
        title: '导出伙伴日记', defaultPath: `${date}-伙伴日记.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
      await expect(invoke(exportMarkdown, target)).resolves.toBe(true);
      await expect(readFile(destination)).resolves.toEqual(Buffer.from(content, 'utf8'));
      await expect(diaries.read(date)).resolves.toEqual({ entry: completed, content });
    } finally {
      await dispose();
    }
    expect(handlers.has(read)).toBe(false);
    expect(handlers.has(exportMarkdown)).toBe(false);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
});
