// @vitest-environment node
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { SingleChatHistoryStore } from '../../src/main/conversation/SingleChatHistoryStore';
import { SingleChatMessageStore } from '../../src/main/conversation/SingleChatMessageStore';
import { ConversationDeletionService } from '../../src/main/conversation/ConversationDeletionService';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';
import { WriterLeaseCoordinator } from '../../src/main/runtime/WriterLeaseCoordinator';
import { PartnerDelegation } from '../../src/main/runtime/PartnerDelegation';
import { PartnerDiarySettingsStore } from '../../src/main/diary/PartnerDiarySettingsStore';
import { PartnerDiaryScheduler } from '../../src/main/diary/PartnerDiaryScheduler';
import { MemoryFallbackInventory } from '../../src/main/memory/fallback/MemoryFallbackInventory';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { SingleChatHistorySnapshot, SingleChatHistoryWrite } from '../../src/shared/singleChatHistory';
import type { Conversation } from '../../src/renderer/types/domain';
import { createTestState } from '../fixtures/applicationState';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ profile: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.profile, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, safeStorage: {}, shell: {}, clipboard: {}, dialog: {},
}));
const keys = ['conversationDelete', 'conversationListDeleted', 'conversationOpenHistory', 'conversationPreviewSnapshotCleanup',
  'conversationClearSnapshots', 'conversationMigrateHistory', 'conversationReadHistoryPage', 'conversationReadToolOutput',
  'conversationSearchHistory', 'conversationWriteHistory', 'conversationSyncMessages'] as const;
type Handler = (event: { sender: object }, ...values: unknown[]) => unknown;
const handlers = new Map<string, Handler>(), removed: string[] = [], sender = { send: vi.fn() };
const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
const chat = 'fixture-history-chat', partner = 'fixture-history-partner', stamp = '2026-01-18T00:00:00.000Z';
const request = { conversationId: chat, partnerId: partner, source: 'api_partner' as const };
const message = { id: 'fixture-message', authorId: 'fixture-user', content: '合成消息', createdAt: stamp };
const conversation = (id = chat): Conversation => ({ id, partnerId: partner, title: '合成历史', updatedAt: stamp, messages: [message] });
const profile = () => { const { conversations, ...value } = createTestState(); void conversations; return value; };
const snapshot = (conversations = [conversation()]): SingleChatHistorySnapshot => ({ generation: 'fixture-generation', profile: profile(), conversations });
const write = (changes: SingleChatHistoryWrite['changes']): SingleChatHistoryWrite => ({ generation: 'fixture-generation', changes });
const change = (extra: Partial<SingleChatHistoryWrite['changes'][number]> = {}) => ({ conversationId: chat, upsert: [message], remove: [], ...extra });
const invoke = async <T = unknown>(key: keyof typeof DESKTOP_IPC, ...values: unknown[]) => await handlers.get(DESKTOP_IPC[key])!({ sender }, ...values) as T;
let root: string, dispose: (() => Promise<void>) | undefined;

beforeEach(async () => {
  vi.resetAllMocks(); handlers.clear(); removed.length = 0;
  root = await mkdtemp(path.join(os.tmpdir(), 'asterium-history-ipc-'));
  electron.profile = path.join(root, 'profile'); await mkdir(electron.profile);
  dispose = registerAgentIpc({
    handle: (channel: string, handler: Handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); },
  } as unknown as IpcMain, () => window, { environment: {
    profile: 'autotest', label: 'Fixture', userDataDirectory: electron.profile, projectsDirectory: path.join(root, 'projects'),
    temporaryDirectory: root, appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
    restoreBackgroundServices: false, mcpPort: 0,
  } });
  await invoke('studioMcpStatus');
});
afterEach(async () => {
  try { vi.restoreAllMocks(); await dispose?.(); expect(handlers.size).toBe(0); expect(removed).toHaveLength(230);
    for (const key of keys) expect(removed.filter(channel => channel === DESKTOP_IPC[key])).toHaveLength(1);
  } finally { dispose = undefined; await testRm(root, { recursive: true, force: true }); }
});
function refreshes(trace: string[] = []) {
  return {
    diary: vi.spyOn(PartnerDiarySettingsStore.prototype, 'reconcileSources').mockImplementation(async () => { trace.push('diary'); }),
    schedule: vi.spyOn(PartnerDiaryScheduler.prototype, 'changed').mockImplementation(async () => { trace.push('schedule'); }),
    memory: vi.spyOn(MemoryFallbackInventory.prototype, 'refresh').mockImplementation(async () => { trace.push('memory'); }),
  };
}

it('registers all 11 channels in the existing slot and rejects foreign callers before validation or services', async () => {
  const all = [...handlers.keys()], expected = keys.map(key => DESKTOP_IPC[key]), start = all.indexOf(expected[0]);
  expect(all.slice(start, start + 11)).toEqual(expected); expect(all[start - 1]).toBe(DESKTOP_IPC.attachmentClearSnapshots);
  const open = vi.spyOn(SingleChatHistoryStore.prototype, 'open'), deletion = vi.spyOn(ConversationDeletionService.prototype, 'delete');
  for (const key of keys) await expect(handlers.get(DESKTOP_IPC[key])!({ sender: {} }, null)).rejects.toThrow('INVALID_IPC_SENDER');
  expect(open).not.toHaveBeenCalled(); expect(deletion).not.toHaveBeenCalled();
});

it('preserves delete validation and forwards accepted values without trimming or introducing safe-ID checks', async () => {
  const deletion = vi.spyOn(ConversationDeletionService.prototype, 'delete').mockResolvedValue({ conversationId: chat, cleanupPending: false }); refreshes();
  for (const value of [null, {}, { ...request, partnerId: 1 }, { ...request, source: 'other' }]) await expect(invoke('conversationDelete', value)).rejects.toThrow('INVALID_CONVERSATION_DELETE');
  expect(deletion).not.toHaveBeenCalled();
  const accepted = { ...request, partnerId: ' ', conversationId: '' };
  await invoke('conversationDelete', accepted); expect(deletion).toHaveBeenCalledExactlyOnceWith(accepted);
});

it('rejects busy deletion before cleanup and releases the lease before ordered diary and memory refresh', async () => {
  const trace: string[] = [], refresh = refreshes(trace), deletion = vi.spyOn(ConversationDeletionService.prototype, 'delete');
  const acquire = vi.spyOn(WriterLeaseCoordinator.prototype, 'tryAcquire').mockReturnValueOnce(undefined);
  await expect(invoke('conversationDelete', request)).rejects.toThrow('COMPACT_CONVERSATION_BUSY'); expect(deletion).not.toHaveBeenCalled(); expect(refresh.diary).not.toHaveBeenCalled();
  const release = vi.fn(() => { trace.push('release'); });
  acquire.mockReturnValue({ scope: { kind: 'conversation', partnerId: partner, conversationId: chat }, ownerId: 'fixture', release });
  const receipt = { conversationId: chat, cleanupPending: true };
  deletion.mockImplementation(async () => { trace.push('delete'); return receipt; });
  const remove = vi.spyOn(PartnerDelegation.prototype, 'remove').mockImplementation(async () => { trace.push('delegation'); });
  await expect(invoke('conversationDelete', request)).resolves.toBe(receipt);
  expect(trace).toEqual(['delete', 'delegation', 'release', 'diary', 'schedule', 'memory']);
  expect(remove).toHaveBeenCalledExactlyOnceWith(chat); expect(release).toHaveBeenCalledTimes(1);
  expect(acquire).toHaveBeenLastCalledWith({ kind: 'conversation', partnerId: partner, conversationId: chat }, 'delete:' + chat);
});

it.each(['delete', 'delegation', 'diary', 'schedule', 'memory'] as const)('preserves deletion failure at %s and lease release semantics', async stage => {
  const trace: string[] = [], release = vi.fn(() => { trace.push('release'); }), failure = new Error('SYNTHETIC_DELETE_FAILURE');
  vi.spyOn(WriterLeaseCoordinator.prototype, 'tryAcquire').mockReturnValue({ scope: { kind: 'conversation', partnerId: partner, conversationId: chat }, ownerId: 'fixture', release });
  const deletion = vi.spyOn(ConversationDeletionService.prototype, 'delete').mockImplementation(async () => { trace.push('delete'); if (stage === 'delete') throw failure; return { conversationId: chat, cleanupPending: false }; });
  vi.spyOn(PartnerDelegation.prototype, 'remove').mockImplementation(async () => { trace.push('delegation'); if (stage === 'delegation') throw failure; });
  const hooks = refreshes(trace); if (stage === 'diary') hooks.diary.mockRejectedValueOnce(failure); if (stage === 'schedule') hooks.schedule.mockRejectedValueOnce(failure); if (stage === 'memory') hooks.memory.mockRejectedValueOnce(failure);
  await expect(invoke('conversationDelete', request)).rejects.toBe(failure); expect(deletion).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
  if (stage === 'delete') { expect(trace).toEqual(['delete', 'release']); expect(hooks.diary).not.toHaveBeenCalled(); }
  if (stage === 'delegation') { expect(trace).toEqual(['delete', 'delegation', 'release']); expect(hooks.diary).not.toHaveBeenCalled(); }
  if (stage === 'diary') expect(hooks.schedule).not.toHaveBeenCalled(); if (stage === 'schedule') expect(hooks.memory).not.toHaveBeenCalled();
});

it('returns deletion IDs and preserves list failures', async () => {
  const ids = [chat], list = vi.spyOn(ConversationDeletionService.prototype, 'listDeletedIds').mockResolvedValue(ids);
  await expect(invoke('conversationListDeleted')).resolves.toBe(ids);
  const failure = new Error('SYNTHETIC_LIST_FAILURE'); list.mockRejectedValueOnce(failure); await expect(invoke('conversationListDeleted')).rejects.toBe(failure);
});

it('keeps open argument validation, recent selection and missing-history short circuit', async () => {
  const open = vi.spyOn(SingleChatHistoryStore.prototype, 'open').mockResolvedValue(undefined), recent = vi.spyOn(SingleChatHistoryStore.prototype, 'openRecent').mockResolvedValue(undefined);
  const deleted = vi.spyOn(ConversationDeletionService.prototype, 'listDeletedIds'), pending = vi.spyOn(NativeThreadBindingStore.prototype, 'pendingCodexImports');
  for (const value of [null, 0, '', {}]) await expect(invoke('conversationOpenHistory', value)).rejects.toThrow('SINGLE_CHAT_HISTORY_INVALID_OPEN');
  expect(open).not.toHaveBeenCalled(); await expect(invoke('conversationOpenHistory')).resolves.toBeUndefined(); await invoke('conversationOpenHistory', false); await invoke('conversationOpenHistory', true);
  expect(open).toHaveBeenCalledTimes(2); expect(recent).toHaveBeenCalledTimes(1); expect(deleted).not.toHaveBeenCalled(); expect(pending).not.toHaveBeenCalled();
});

it('filters tombstones before activating only exactly matched committed Codex imports in order', async () => {
  const imported = { ...conversation(), importedCodexThread: true, sessionId: 'fixture-thread' }, deletedChat = conversation('fixture-deleted'), plain = conversation('fixture-plain');
  const history = snapshot([imported, deletedChat, plain]); vi.spyOn(SingleChatHistoryStore.prototype, 'open').mockResolvedValue(history);
  vi.spyOn(ConversationDeletionService.prototype, 'listDeletedIds').mockResolvedValue([deletedChat.id]);
  const pending = (bindingId: string, conversationId: string, partnerId = partner, nativeThreadId: string | undefined = 'fixture-thread') => ({ bindingId, conversationId, partnerId, nativeThreadId });
  vi.spyOn(NativeThreadBindingStore.prototype, 'pendingCodexImports').mockResolvedValue([
    pending('fixture-match', chat), pending('fixture-deleted', deletedChat.id), pending('fixture-plain', plain.id), pending('fixture-partner', chat, 'fixture-other'), pending('fixture-thread', chat, partner, 'fixture-other-thread'), pending('fixture-empty', chat, partner, ''),
  ] as never);
  const activate = vi.spyOn(NativeThreadBindingStore.prototype, 'activate').mockResolvedValue(undefined as never);
  await expect(invoke('conversationOpenHistory')).resolves.toEqual({ ...history, conversations: [imported, plain] });
  expect(activate).toHaveBeenCalledExactlyOnceWith('fixture-match', 'fixture-thread');
  const failure = new Error('SYNTHETIC_ACTIVATION_FAILURE'); activate.mockRejectedValueOnce(failure); await expect(invoke('conversationOpenHistory')).rejects.toBe(failure);
});

it('forwards snapshot preview and accepts only the original 36-character plan guard', async () => {
  const plan = { planId: 'x'.repeat(36), count: 1, bytes: 7, skippedCount: 0 }, result = { clearedCount: 1, freedBytes: 7, skippedCount: 0 };
  vi.spyOn(SingleChatHistoryStore.prototype, 'previewSnapshotCleanup').mockResolvedValue(plan);
  const clear = vi.spyOn(SingleChatHistoryStore.prototype, 'clearSnapshots').mockResolvedValue(result);
  await expect(invoke('conversationPreviewSnapshotCleanup')).resolves.toBe(plan);
  for (const value of [null, 1, '', 'x'.repeat(35)]) await expect(invoke('conversationClearSnapshots', value)).rejects.toThrow('SNAPSHOT_PLAN_EXPIRED');
  expect(clear).not.toHaveBeenCalled(); await expect(invoke('conversationClearSnapshots', plan.planId)).resolves.toBe(result); expect(clear).toHaveBeenCalledExactlyOnceWith(plan.planId);
});

it('validates migration inside the legacy loader, preserves projection merge and forwards tombstones', async () => {
  const legacy = { conversationId: chat, partnerId: partner, messages: [{ messageId: 'fixture-projected', authorType: 'user' as const, authorId: 'fixture-user', content: '合成补全', createdAt: stamp }] };
  vi.spyOn(SingleChatMessageStore.prototype, 'listLegacy').mockResolvedValue([legacy]); vi.spyOn(ConversationDeletionService.prototype, 'listDeletedIds').mockResolvedValue(['fixture-deleted']);
  const input = { profile: profile(), conversations: [conversation()] }; let loaded: unknown;
  const initialize = vi.spyOn(SingleChatHistoryStore.prototype, 'initialize').mockImplementation(async load => { loaded = await load(); return {} as never; });
  vi.spyOn(SingleChatHistoryStore.prototype, 'openRecent').mockResolvedValue(snapshot()); vi.spyOn(NativeThreadBindingStore.prototype, 'pendingCodexImports').mockResolvedValue([]);
  await expect(invoke('conversationMigrateHistory', input, true)).resolves.toMatchObject({ generation: 'fixture-generation' });
  expect(loaded).toMatchObject({ profile: input.profile, deletedConversationIds: ['fixture-deleted'], conversations: [{ id: chat, messages: [message, { id: 'fixture-projected', content: '合成补全' }] }] });
  initialize.mockClear(); await expect(invoke('conversationMigrateHistory', input, null)).rejects.toThrow('SINGLE_CHAT_HISTORY_INVALID_OPEN'); expect(initialize).not.toHaveBeenCalled();
  await expect(invoke('conversationMigrateHistory', null)).rejects.toThrow('SINGLE_CHAT_HISTORY_INVALID_IMPORT');
  initialize.mockResolvedValue({} as never); vi.spyOn(SingleChatHistoryStore.prototype, 'open').mockResolvedValue(snapshot());
  await expect(invoke('conversationMigrateHistory', null)).resolves.toMatchObject({ generation: 'fixture-generation' });
  vi.mocked(SingleChatHistoryStore.prototype.open).mockResolvedValue(undefined); await expect(invoke('conversationMigrateHistory', null)).rejects.toThrow('SINGLE_CHAT_HISTORY_ACTIVATION_MISSING');
});

it('validates page and output requests before deletion checks and never reads tombstoned chats', async () => {
  const deleted = vi.spyOn(ConversationDeletionService.prototype, 'isDeleted').mockResolvedValue(true);
  const read = vi.spyOn(SingleChatHistoryStore.prototype, 'readPage').mockResolvedValue({ messages: [], hasOlder: false, hasNewer: false });
  const output = vi.spyOn(SingleChatHistoryStore.prototype, 'readToolOutput').mockResolvedValue({ text: '合成工具输出', nextOffset: undefined });
  await expect(invoke('conversationReadHistoryPage', { conversationId: chat, before: 'a', after: 'b' })).rejects.toThrow('SINGLE_CHAT_HISTORY_INVALID_PAGE');
  await expect(invoke('conversationReadToolOutput', { conversationId: chat, outputId: 'bad' })).rejects.toThrow('SINGLE_CHAT_TOOL_OUTPUT_INVALID_REQUEST'); expect(deleted).not.toHaveBeenCalled();
  const page = { conversationId: chat, around: 'fixture-message' }, tool = { conversationId: chat, outputId: 'a'.repeat(64), offset: 3 };
  await expect(invoke('conversationReadHistoryPage', page)).resolves.toBeUndefined(); await expect(invoke('conversationReadToolOutput', tool)).resolves.toBeUndefined(); expect(read).not.toHaveBeenCalled(); expect(output).not.toHaveBeenCalled();
  deleted.mockResolvedValue(false); await expect(invoke('conversationReadHistoryPage', page)).resolves.toEqual({ messages: [], hasOlder: false, hasNewer: false }); await expect(invoke('conversationReadToolOutput', tool)).resolves.toEqual({ text: '合成工具输出' }); expect(read).toHaveBeenCalledExactlyOnceWith(page); expect(output).toHaveBeenCalledExactlyOnceWith(tool);
});

it('keeps scoped and unscoped search tombstone filtering and hasMore behavior', async () => {
  const search = vi.spyOn(SingleChatHistoryStore.prototype, 'search').mockResolvedValue({ conversationIds: [chat, 'fixture-deleted'], messageIds: ['fixture-live', 'fixture-old'], hasMore: true });
  vi.spyOn(ConversationDeletionService.prototype, 'listDeletedIds').mockResolvedValue(['fixture-deleted']);
  await expect(invoke('conversationSearchHistory', { query: 'x'.repeat(513) })).rejects.toThrow('SINGLE_CHAT_HISTORY_INVALID_SEARCH'); expect(search).not.toHaveBeenCalled();
  await expect(invoke('conversationSearchHistory', { query: '' })).resolves.toEqual({ conversationIds: [chat], messageIds: ['fixture-live', 'fixture-old'], hasMore: true });
  const scoped = { query: '合成', conversationId: 'fixture-deleted' }; await expect(invoke('conversationSearchHistory', scoped)).resolves.toEqual({ conversationIds: [chat], messageIds: [], hasMore: false }); expect(search).toHaveBeenLastCalledWith(scoped);
});

it('rejects sending into deleted chats atomically and filters other tombstoned writes without changing the live objects', async () => {
  const save = vi.spyOn(SingleChatHistoryStore.prototype, 'write').mockResolvedValue(undefined); vi.spyOn(ConversationDeletionService.prototype, 'listDeletedIds').mockResolvedValue(['fixture-deleted']); refreshes();
  await expect(invoke('conversationWriteHistory', write([change(), change({ conversationId: 'fixture-deleted', upsert: [{ ...message, status: 'sending' }] })]))).rejects.toThrow('SINGLE_CHAT_HISTORY_CONVERSATION_DELETED'); expect(save).not.toHaveBeenCalled();
  const live = change(), value = write([live, change({ conversationId: 'fixture-deleted' })]); await expect(invoke('conversationWriteHistory', value)).resolves.toBeUndefined();
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...value, changes: [live] }); expect(save.mock.calls[0][0].changes[0]).toBe(live); expect(value.changes).toHaveLength(2);
});

it.each([
  { name: 'busy', value: change({ busy: true }), memory: 0, diary: 0 },
  { name: 'unspecified busy', value: change(), memory: 0, diary: 0 },
  { name: 'completed message', value: change({ busy: false }), memory: 1, diary: 1 },
  { name: 'remove only', value: change({ busy: false, upsert: [], remove: ['fixture-message'] }), memory: 1, diary: 0 },
  { name: 'archived metadata', value: change({ busy: false, upsert: [], metadata: { id: chat, partnerId: partner, title: '合成', updatedAt: stamp, isArchived: true } }), memory: 0, diary: 1 },
  { name: 'empty', value: change({ busy: false, upsert: [] }), memory: 0, diary: 0 },
])('keeps fire-and-forget refresh predicates for $name and never refreshes before saving', async ({ value, memory, diary }) => {
  const trace: string[] = [], hooks = refreshes(trace), save = vi.spyOn(SingleChatHistoryStore.prototype, 'write').mockImplementation(async () => { trace.push('write'); }); vi.spyOn(ConversationDeletionService.prototype, 'listDeletedIds').mockResolvedValue([]);
  await invoke('conversationWriteHistory', write([value])); await Promise.resolve();
  expect(trace[0]).toBe('write'); expect(hooks.memory).toHaveBeenCalledTimes(memory); expect(hooks.diary).toHaveBeenCalledTimes(diary); expect(hooks.schedule).toHaveBeenCalledTimes(diary);
  const failure = new Error('SYNTHETIC_WRITE_FAILURE'); save.mockRejectedValueOnce(failure); const calls = trace.length;
  await expect(invoke('conversationWriteHistory', write([value]))).rejects.toBe(failure); expect(trace).toHaveLength(calls);
});

it('swallows background refresh failures after successful writes and does not await unresolved refreshes', async () => {
  vi.spyOn(SingleChatHistoryStore.prototype, 'write').mockResolvedValue(undefined); vi.spyOn(ConversationDeletionService.prototype, 'listDeletedIds').mockResolvedValue([]);
  const hooks = refreshes(), failure = new Error('SYNTHETIC_REFRESH_FAILURE'); hooks.memory.mockRejectedValueOnce(failure); hooks.diary.mockRejectedValueOnce(failure);
  await expect(invoke('conversationWriteHistory', write([change({ busy: false })]))).resolves.toBeUndefined(); await Promise.resolve(); expect(hooks.schedule).not.toHaveBeenCalled();
  let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; }); hooks.memory.mockImplementationOnce(async () => { await pending; }); hooks.diary.mockReturnValueOnce(pending);
  try { await expect(invoke('conversationWriteHistory', write([change({ busy: false })]))).resolves.toBeUndefined(); } finally { finish(); await Promise.resolve(); }
});

it('skips all legacy sync validation after activation and retains ordered refreshes before activation', async () => {
  const active = vi.spyOn(SingleChatHistoryStore.prototype, 'isActive').mockResolvedValue(true), sync = vi.spyOn(SingleChatMessageStore.prototype, 'sync').mockResolvedValue(undefined), trace: string[] = [], hooks = refreshes(trace);
  await expect(invoke('conversationSyncMessages', null)).resolves.toBeUndefined(); expect(sync).not.toHaveBeenCalled(); expect(hooks.diary).not.toHaveBeenCalled();
  active.mockResolvedValue(false); await expect(invoke('conversationSyncMessages', null)).rejects.toThrow('SINGLE_CHAT_MESSAGE_INDEX_INVALID');
  sync.mockImplementation(async () => { trace.push('sync'); }); const value = [{ conversationId: chat, partnerId: partner, messages: [] }]; await expect(invoke('conversationSyncMessages', value)).resolves.toBeUndefined(); expect(sync).toHaveBeenCalledExactlyOnceWith(value); expect(trace).toEqual(['sync', 'diary', 'schedule', 'memory']);
  const failure = new Error('SYNTHETIC_SYNC_FAILURE'); sync.mockRejectedValueOnce(failure); hooks.diary.mockClear(); await expect(invoke('conversationSyncMessages', value)).rejects.toBe(failure); expect(hooks.diary).not.toHaveBeenCalled();
});

it('uses real isolated history migration, writes, index search, tool-output reads and tombstone filtering', async () => {
  refreshes(); const migrated = await invoke<SingleChatHistorySnapshot>('conversationMigrateHistory', { profile: profile(), conversations: [conversation()] });
  expect(migrated.conversations[0].messages).toEqual([message]);
  const next = { ...message, id: 'fixture-next-message', content: '合成唯一搜索词' };
  await invoke('conversationWriteHistory', { generation: migrated.generation, changes: [change({ upsert: [next], busy: false })] });
  await expect(invoke('conversationSearchHistory', { query: '合成唯一搜索词', conversationId: chat })).resolves.toMatchObject({ conversationIds: [chat], messageIds: [next.id] });
  await expect(invoke('conversationReadHistoryPage', { conversationId: chat })).resolves.toMatchObject({ messages: [message, next] });
  const detail = '合成完整工具输出\n'.repeat(2000), store = new SingleChatHistoryStore(electron.profile), output = await store.recordToolOutput(chat, detail);
  expect(output).toBeDefined();
  const toolPage = await invoke<{ text: string }>('conversationReadToolOutput', { conversationId: chat, outputId: output!.detailRef.id });
  expect(detail.startsWith(toolPage.text)).toBe(true); expect(toolPage.text).not.toBe('');
  await expect(invoke('conversationDelete', request)).resolves.toEqual({ conversationId: chat, cleanupPending: false });
  await expect(invoke('conversationListDeleted')).resolves.toEqual([chat]); await expect(invoke('conversationReadHistoryPage', { conversationId: chat })).resolves.toBeUndefined();
  expect((await invoke<SingleChatHistorySnapshot>('conversationOpenHistory')).conversations).toEqual([]);
});
