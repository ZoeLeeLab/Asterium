// @vitest-environment node
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { autoTestOutput } from '../helpers/autoTest.mjs';
import { createTestState } from '../fixtures/applicationState';
import { SingleChatHistoryStore } from '../../src/main/conversation/SingleChatHistoryStore';
import { SingleChatMessageStore } from '../../src/main/conversation/SingleChatMessageStore';
import { createAutomationTargetPolicy } from '../../src/main/automation/AutomationTargetPolicy';

afterEach(() => vi.restoreAllMocks());

function forbidRichProjectionOnMain() {
  const prepare = DatabaseSync.prototype.prepare;
  return vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.includes('json_remove')) throw Error('RICH_MESSAGES_READ_ON_MAIN');
    return prepare.call(this, sql);
  });
}

async function fixture() {
  const directory = autoTestOutput();
  const state = createTestState();
  const selected = { ...state.conversations[0], sessionId: 'fixture-native', partnerRootGrantId: 'fixture-root', messages: state.conversations[0].messages.map(message => ({ ...message,
    timeline: [{ id: 'fixture-tool', kind: 'tool' as const, sequence: 1, toolCallId: 'fixture-call', summary: '合成工具', state: 'success' as const, detail: 'x'.repeat(16_384) }],
  })) };
  const conversations = [selected, { ...state.conversations[1], partnerId: 'fixture-local-b', isArchived: true }];
  const { conversations: _conversations, ...profile } = state;
  void _conversations;
  const history = new SingleChatHistoryStore(directory);
  const manifest = await history.initialize(async () => ({ profile, conversations, deletedConversationIds: [] }));
  await history.openRecent();
  const singles = new SingleChatMessageStore(path.join(directory, 'legacy.json'), history);
  return { directory, history, singles, selected, generation: manifest.generation };
}

it('reads metadata with the same lifecycle fields without decoding rich messages', async () => {
  const { history, selected } = await fixture();
  forbidRichProjectionOnMain();
  const snapshot = await history.readProjection(undefined, undefined, { metadataOnly: true });
  expect(snapshot?.conversations[0]).toMatchObject({ id: selected.id, sessionId: 'fixture-native', partnerRootGrantId: 'fixture-root', messages: [] });
  expect(snapshot?.conversations[1].isArchived).toBe(true);
});

it('builds automation targets without the full-message listing', async () => {
  const { singles, selected } = await fixture();
  const listing = vi.spyOn(singles, 'list').mockRejectedValue(Error('FULL_HISTORY_READ_FOR_TARGETS'));
  const policy = createAutomationTargetPolicy({
    automationHandles: {},
    conversationDeletions: { isDeleted: async () => false },
    nativeBindings: { getForScope: async () => ({ state: 'active', nativeThreadId: 'fixture-native', generation: 1 }) },
    partnerWorkspaces: { grantIds: async () => ({ cwdGrantId: 'fixture-root' }) },
    projectWorkspaces: {}, singleChatMessages: singles, studioRooms: { listAll: async () => [] },
    studioRuntimeCatalog: { partner: () => ({ sourceMode: 'local_cli', available: true, publicIdentity: { displayName: '示例伙伴' } }) },
    useLegacyRunPath: false, writerLeases: {},
  } as unknown as Parameters<typeof createAutomationTargetPolicy>[0]);
  expect(await policy.targets()).toEqual([expect.objectContaining({ target: expect.objectContaining({ conversationId: selected.id, nativeThreadId: 'fixture-native' }), available: true })]);
  expect(listing).not.toHaveBeenCalled();
});

it('reads full projections off the main SQLite projection path and preserves content and order', async () => {
  const { history, selected } = await fixture();
  forbidRichProjectionOnMain();
  const snapshot = await history.readProjection(selected.id);
  expect(snapshot?.conversations).toHaveLength(1);
  expect(snapshot?.conversations[0].messages.map(message => [message.id, message.content])).toEqual(selected.messages.map(message => [message.id, message.content]));
  expect(snapshot?.conversations[0].messages.every(message => !Object.hasOwn(message, 'timeline'))).toBe(true);
});

it('preserves partner filtering and never returns a deleted conversation through the worker', async () => {
  const { history, selected } = await fixture();
  expect((await history.readProjection(undefined, id => id === selected.partnerId))?.conversations.map(chat => chat.id)).toEqual([selected.id]);
  await history.deleteConversation(selected.id);
  expect((await history.readProjection(selected.id))?.conversations).toEqual([]);
});

it('retains busy and updated lifecycle metadata in the lightweight path', async () => {
  const { history, singles, selected, generation } = await fixture();
  const { messages, ...metadata } = selected;
  void messages;
  await history.write({ generation, changes: [{ conversationId: selected.id, metadata: { ...metadata, title: '更新后的合成标题', isDisabled: true }, upsert: [], remove: [], busy: true }] });
  forbidRichProjectionOnMain();
  expect((await singles.listMetadata())[0]).toMatchObject({ conversationId: selected.id, title: '更新后的合成标题', busy: true, isDisabled: true, messages: [] });
});

it('leaves a valid index byte-identical after worker projection', async () => {
  const { directory, history } = await fixture();
  const file = path.join(directory, 'single-chat-history.v2', 'history-index.v1.sqlite');
  const before = await readFile(file);
  await history.readProjection();
  expect(await readFile(file)).toEqual(before);
});

it('closes the worker connection and rebuilds a corrupt derived index from the authoritative log', async () => {
  const { directory, history, selected } = await fixture();
  const db = new DatabaseSync(path.join(directory, 'single-chat-history.v2', 'history-index.v1.sqlite'));
  try { db.prepare('UPDATE messages SET payload = ? WHERE chat_id = ?').run('{invalid', selected.id); }
  finally { db.close(); }
  expect((await history.readProjection(selected.id))?.conversations[0].messages.map(message => message.id)).toEqual(selected.messages.map(message => message.id));
  expect((await history.readConversation(selected.id))?.conversation.messages).toEqual(selected.messages);
});

it('keeps the legacy metadata path available without requiring a migrated history', async () => {
  const singles = new SingleChatMessageStore(path.join(autoTestOutput(), 'legacy.json'));
  await singles.sync([{ conversationId: 'fixture-legacy', partnerId: 'fixture-partner', title: '旧存储合成标题', sessionId: 'fixture-native', messages: [{ messageId: 'fixture-message', authorId: 'fixture-partner', authorType: 'partner', content: '合成旧消息', createdAt: '00:00' }] }]);
  expect(await singles.listMetadata()).toEqual([{ conversationId: 'fixture-legacy', partnerId: 'fixture-partner', title: '旧存储合成标题', sessionId: 'fixture-native', messages: [] }]);
  expect((await singles.list())[0].messages).toHaveLength(1);
});
