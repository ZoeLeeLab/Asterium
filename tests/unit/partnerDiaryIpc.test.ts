// @vitest-environment node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { SingleChatMessageStore } from '../../src/main/conversation/SingleChatMessageStore';
import { PartnerDiaryCatalog } from '../../src/main/diary/PartnerDiaryCatalog';
import { PartnerDiaryScheduler } from '../../src/main/diary/PartnerDiaryScheduler';
import { PartnerDiaryStore } from '../../src/main/diary/PartnerDiaryStore';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import type { PartnerDiaryConfig } from '../../src/shared/partnerDiary';
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

const get = 'asterium:diary:get';
const configure = 'asterium:diary:configure';
const read = 'asterium:diary:read';
const exportMarkdown = 'asterium:diary:export';

async function withDiaryIpc(run: (fixture: {
  root: string;
  window: BrowserWindow;
  profiles: PartnerProfileStore;
  invoke: (channel: string, request?: unknown, caller?: object) => Promise<unknown>;
}) => Promise<void>) {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-partner-diary-ipc-'));
  electron.root = root;
  electron.showSaveDialog.mockReset();
  const profiles = new PartnerProfileStore(path.join(root, 'AsteriumData'));
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
  const invoke = async (channel: string, request?: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return handler({ sender: caller }, request);
  };

  try {
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await run({ root, window, profiles, invoke });
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

it('reads stored diary states and only exports verified Markdown without changing its bytes', async () => {
  await withDiaryIpc(async ({ root, window, profiles, invoke }) => {
    const partnerId = 'fixture-diary-partner';
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
  });
});

it('lists saved diary configurations, entries and notices for unavailable or changed sources', async () => {
  await withDiaryIpc(async ({ root, profiles, invoke }) => {
    const settingsFile = path.join(root, 'partner-diary-settings.v1.json');
    const chats = new SingleChatMessageStore(path.join(root, 'single-chat-messages.v1.json'));
    const partnerId = 'fixture-ready';
    await profiles.savePartner({
      partnerId, sourceMode: 'local_cli',
      publicIdentity: { displayName: '合成伙伴', mentionName: '合成伙伴', introduction: '', expertise: '' },
      management: { memoryMode: 'self_managed', personality: false, userProfile: false },
      connectionSettings: {},
    });
    const diaries = new PartnerDiaryStore(await profiles.diaryDirectory(partnerId), partnerId);
    const entry = await diaries.claim('2026-01-18', 'fixture-chat-ready');
    expect(entry).toBeDefined();

    const configs: PartnerDiaryConfig[] = [
      { partnerId, conversationId: 'fixture-chat-ready', enabled: true, time: '09:00', revision: 1 },
      { partnerId: 'fixture-unavailable', conversationId: 'fixture-chat-unavailable', enabled: true, time: '09:00', revision: 1 },
      { partnerId: 'fixture-missing', conversationId: 'fixture-chat-missing', enabled: true, time: '09:00', revision: 1 },
      { partnerId: 'fixture-disabled', conversationId: 'fixture-chat-disabled', enabled: false, time: '09:00', revision: 2, disabledReason: 'source_deleted' },
      { partnerId: 'fixture-changed', conversationId: 'fixture-chat-changed', enabled: true, time: '09:00', revision: 1, upstreamThreadId: 'fixture-thread-before' },
    ];
    await chats.sync([configs[0], configs[3], configs[4]].map(({ partnerId, conversationId, upstreamThreadId }) => ({
      partnerId, conversationId, messages: [], sessionId: upstreamThreadId,
    })));
    const saved = JSON.stringify({ version: 1, partners: Object.fromEntries(configs.map(config => [config.partnerId, config])) });
    await writeFile(settingsFile, saved, 'utf8');
    const identity = vi.spyOn(PartnerDiaryCatalog.prototype, 'identity').mockImplementation(id => id === 'fixture-unavailable' ? undefined : {
      available: true, sourceMode: id === 'fixture-changed' ? 'existing_thread' : 'local_cli',
      threadId: id === 'fixture-changed' ? 'fixture-thread-after' : undefined,
    });

    await expect(invoke(get, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
    expect(identity).not.toHaveBeenCalled();
    await expect(invoke(get)).resolves.toEqual({
      configs, entries: [entry], notices: {
        'fixture-unavailable': '伙伴已移除或运行时不可用，日记不会自动执行。',
        'fixture-missing': '来源会话已永久删除，日记已停用，请重新选择来源后保存。',
        'fixture-disabled': '来源会话已永久删除，日记已停用，请重新选择来源后保存。',
        'fixture-changed': '上游线程已变化，日记将跳过，请重新选择来源并确认后保存。',
      },
    });
    await expect(readFile(settingsFile, 'utf8')).resolves.toBe(saved);
  });
});

it('validates diary updates and waits for the scheduler notification after saving', async () => {
  await withDiaryIpc(async ({ root, invoke }) => {
    const settingsFile = path.join(root, 'partner-diary-settings.v1.json');
    const chats = new SingleChatMessageStore(path.join(root, 'single-chat-messages.v1.json'));
    const request = { partnerId: 'fixture-partner', conversationId: 'fixture-chat', enabled: true, time: '09:00' };
    const threadId = 'fixture-thread';
    await chats.sync([{ partnerId: request.partnerId, conversationId: request.conversationId, sessionId: threadId, messages: [] }]);
    const identity = vi.spyOn(PartnerDiaryCatalog.prototype, 'identity').mockReturnValue({ available: true, sourceMode: 'existing_thread', threadId });
    const changed = vi.spyOn(PartnerDiaryScheduler.prototype, 'changed');

    await expect(invoke(configure, request, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(configure, { ...request, time: '25:00' })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(invoke(configure, request)).rejects.toThrow('DIARY_UPSTREAM_HISTORY_ACK_REQUIRED');
    const confirmed = { ...request, acknowledgeUpstreamHistory: true };
    identity.mockReturnValueOnce({ available: true, sourceMode: 'existing_thread', threadId: 'fixture-other-thread' });
    await expect(invoke(configure, confirmed)).rejects.toThrow('DIARY_UPSTREAM_THREAD_MISMATCH');
    await expect(invoke(configure, { ...confirmed, conversationId: 'fixture-missing-chat' })).rejects.toThrow('DIARY_SOURCE_NOT_AVAILABLE');
    expect(changed).not.toHaveBeenCalled();
    await expect(readFile(settingsFile)).rejects.toMatchObject({ code: 'ENOENT' });

    const saved = { ...request, revision: 1, upstreamThreadId: threadId };
    await expect(invoke(configure, confirmed)).resolves.toEqual(saved);
    expect(changed).toHaveBeenCalledTimes(1);

    const update = { ...saved, time: '10:00', revision: 2 };
    changed.mockImplementationOnce(async () => {
      expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({ version: 1, partners: { [request.partnerId]: update } });
      throw new Error('fixture-scheduler-notification-failure');
    });
    await expect(invoke(configure, { ...confirmed, time: update.time })).rejects.toThrow('fixture-scheduler-notification-failure');
    expect(changed).toHaveBeenCalledTimes(2);
    await expect(invoke(get)).resolves.toEqual({ configs: [update], entries: [], notices: {} });
  });
});
