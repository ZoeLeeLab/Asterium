// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { SingleChatMessageStore } from '../../src/main/conversation/SingleChatMessageStore';
import { PartnerMemoryService } from '../../src/main/memory/PartnerMemoryService';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import type { PartnerProfileSeed } from '../../src/shared/agentProtocol';
import type { MemoryArchiveBriefing, MemoryRecord } from '../../src/shared/memoryArchive';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.root, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: {},
  shell: {},
}));

const seed: PartnerProfileSeed = {
  partnerId: 'fixture-partner', sourceMode: 'local_cli',
  publicIdentity: { displayName: '合成伙伴', introduction: '', expertise: '', mentionName: '合成伙伴' },
  management: { memoryMode: 'asterium', personality: false, userProfile: false }, connectionSettings: {},
};
const { partnerId } = seed;
const timestamp = '2026-01-18T10:00:00.000Z';
const query = 'asterium:memory-archive:query';
const readSource = 'asterium:memory-archive:read-source';
const briefing = 'asterium:memory-archive:briefing';
const changed = 'asterium:memory-archive:changed';
const record: MemoryRecord = {
  schemaVersion: 1, partnerId, memoryId: 'fixture-memory', type: 'stable_fact', status: 'active',
  body: '合成记忆正文', tags: ['样例'], weight: 4, createdAt: timestamp, updatedAt: timestamp, comments: [], sources: [],
};

async function withArchive(run: (fixture: {
  invoke: <T = unknown>(channel: string, value: unknown, caller?: object) => Promise<T>;
  store: PartnerMemoryService;
  chats: SingleChatMessageStore;
  changes: () => unknown[][];
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-memory-archive-ipc-'));
  electron.root = root;
  const profiles = new PartnerProfileStore(path.join(root, 'AsteriumData'));
  const store = new PartnerMemoryService(profiles);
  const chats = new SingleChatMessageStore(path.join(root, 'single-chat-messages.v1.json'));
  const sender = { send: vi.fn<(channel: string, data: unknown) => void>() };
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
  const invoke = async <T,>(channel: string, value: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return await handler({ sender: caller }, value) as T;
  };

  try {
    await profiles.savePartner(seed);
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await invoke(query, { partnerId });
      await run({ invoke, store, chats, changes: () => sender.send.mock.calls.filter(([channel]) => channel === changed) });
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
  } finally {
    profiles.dispose();
    await testRm(root, { recursive: true, force: true });
  }
}

it('queries saved records with existing filters and limits and reads sources within the same partner', async () => {
  await withArchive(async ({ invoke, store, chats, changes }) => {
    const messageId = 'fixture-message';
    const message = { messageId, authorType: 'partner' as const, authorId: partnerId, content: '合成来源正文', createdAt: timestamp };
    await chats.sync([
      { conversationId: 'fixture-chat', partnerId, messages: [message] },
      { conversationId: 'fixture-other-chat', partnerId: 'fixture-other-partner', messages: [{ ...message, content: '另一伙伴的合成正文' }] },
    ]);
    const sources = ['fixture-chat', 'fixture-other-chat'].map(conversationId => ({ kind: 'single_chat' as const, conversationId, messageId }));
    const active = { ...record, sources };
    const second = { ...record, memoryId: 'fixture-other-memory', body: '无关合成正文', tags: ['其他'], weight: 2 as const };
    const archived = { ...record, memoryId: 'fixture-archived-memory', body: '合成归档正文', deletedAt: timestamp };
    await store.importBackup(partnerId, { format: 'asterium.partner-memory', version: 1, partnerId, records: [active, second, archived], fallbackMemoryIds: [] });
    const read = { partnerId, memoryId: active.memoryId };

    await expect(invoke(query, { partnerId }, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(readSource, read, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(query, { partnerId, tags: [1] })).rejects.toThrow('INVALID_MEMORY_ARCHIVE_QUERY');
    await expect(invoke(query, { partnerId: ' ' })).rejects.toThrow('INVALID_MEMORY_PARTNER_ID');
    await expect(invoke(readSource, { ...read, sourceIndex: -1 })).rejects.toThrow('INVALID_MEMORY_ARCHIVE_SOURCE_READ');
    await expect(invoke(readSource, { ...read, sourceIndex: 2 })).rejects.toThrow('MEMORY_SOURCE_INDEX_INVALID');
    await expect(invoke(query, { partnerId, types: ['stable_fact'], tags: ['样例'], limit: 1 })).resolves.toMatchObject({
      partnerId, archiveVersion: expect.any(String), records: [active], fallbackMemoryIds: [],
    });
    await expect(invoke(query, { partnerId, archivedOnly: true })).resolves.toMatchObject({ records: [archived] });
    await expect(invoke(readSource, { ...read, sourceIndex: 0 })).resolves.toMatchObject([
      { index: 0, result: { state: 'live', messages: [{ ...message, offset: 0 }] } },
    ]);
    await expect(invoke(readSource, read)).resolves.toMatchObject([
      { index: 0, result: { state: 'live' } },
      { index: 1, result: { state: 'unavailable', messages: [], reason: 'source_access_denied' } },
    ]);
    expect(changes()).toEqual([]);
  });
});

it('caches a briefing per archive version and date without publishing an archive change', async () => {
  await withArchive(async ({ invoke, store, changes }) => {
    await store.create(partnerId, record);
    const cached = vi.spyOn(PartnerMemoryService.prototype, 'cacheBriefing');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 18, 12));
    try {
      await expect(invoke(briefing, partnerId, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(briefing, ' ')).rejects.toThrow('INVALID_MEMORY_PARTNER_ID');
      expect(cached).not.toHaveBeenCalled();

      const first = await invoke<MemoryArchiveBriefing>(briefing, partnerId);
      expect(first).toMatchObject({ partnerId, logicalDate: '2026-01-18', content: expect.stringContaining(record.body) });
      await expect(store.cachedBriefing(partnerId)).resolves.toEqual(first);
      await expect(invoke(briefing, partnerId)).resolves.toEqual(first);
      expect(cached).toHaveBeenCalledExactlyOnceWith(partnerId, first);

      const additional = { ...record, memoryId: 'fixture-extra-memory', body: '后来增加的合成正文' };
      await store.create(partnerId, additional);
      const updated = await invoke<MemoryArchiveBriefing>(briefing, partnerId);
      expect(updated.archiveVersion).not.toBe(first.archiveVersion);
      expect(updated.content).toContain(additional.body);
      expect(cached).toHaveBeenCalledTimes(2);

      vi.setSystemTime(new Date(2026, 0, 19, 12));
      const nextDay = await invoke<MemoryArchiveBriefing>(briefing, partnerId);
      expect(nextDay).toMatchObject({ archiveVersion: updated.archiveVersion, logicalDate: '2026-01-19' });
      expect(cached).toHaveBeenLastCalledWith(partnerId, nextDay);
      expect(cached).toHaveBeenCalledTimes(3);
      expect(changes()).toEqual([]);
    } finally {
      vi.useRealTimers();
      cached.mockRestore();
    }
  });
});
