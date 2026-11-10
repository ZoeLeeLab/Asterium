// @vitest-environment node
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { SingleChatHistoryStore } from '../../src/main/conversation/SingleChatHistoryStore';
import type { Conversation, Message } from '../../src/renderer/types/domain';
import { SINGLE_CHAT_PAGE_SIZE } from '../../src/shared/singleChatHistory';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';
import { prepareSingleChatProfile } from '../../src/renderer/app/persistence';
import { createTestState } from '../fixtures/applicationState';
import { autoTestOutput } from '../helpers/autoTest.mjs';

const first = 'fixture-chat';
const second = 'fixture-other-chat';
const at = '2026-01-01T00:00:00.000Z';

function message(id: string, content: string): Message {
  return { id, authorId: 'fixture-partner', content, createdAt: '00:00', occurredAt: at };
}

function chat(id: string, messages: Message[]): Conversation {
  return { id, partnerId: 'fixture-partner', title: '分页示例', updatedAt: at, messages };
}

async function setup() {
  const profile = autoTestOutput();
  const store = new SingleChatHistoryStore(profile);
  const messages = Array.from({ length: 300 }, (_, i) => ({
    ...message('message-' + i, i === 7 ? '长聊天里的 **中文** 输入法和 "标点" 核验' : '示例内容 ' + i),
    ...(i % 2 === 0 ? { authorId: ASTERIUM_USER_ID } : {}),
  }));
  const manifest = await store.initialize(async () => ({
    profile: { ...prepareSingleChatProfile(createTestState()), activeConversationId: first },
    conversations: [chat(first, messages), chat(second, [message('other', '另一个会话 专用旧词')])],
    deletedConversationIds: [],
  }));
  return { store, profile, manifest, messages };
}

it('opens only the selected tail, pages by message ID, and searches Chinese before the rendered window', async () => {
  const { store, messages } = await setup();
  const snapshot = await store.openRecent();
  expect(snapshot?.conversations.map(item => item.messages.length)).toEqual([SINGLE_CHAT_PAGE_SIZE, 0]);
  expect(snapshot?.recentPages?.[first]).toEqual({ hasOlder: true, hasNewer: false, turnOffset: 110 });
  const latest = snapshot!.conversations[0].messages;
  expect(latest).toEqual(messages.slice(-SINGLE_CHAT_PAGE_SIZE));
  const prior = await store.readPage({ conversationId: first, before: latest[0].id });
  expect(prior?.messages.map(item => item.id)).toEqual(messages.slice(-160, -80).map(item => item.id));
  expect(prior).toMatchObject({ hasOlder: true, hasNewer: true, turnOffset: 70 });
  const around = await store.readPage({ conversationId: first, around: 'message-7' });
  expect(around?.messages.some(item => item.id === 'message-7')).toBe(true);
  expect(around).toMatchObject({ hasOlder: false, hasNewer: true });
  expect((await store.readPage({ conversationId: first, after: 'message-80' }))?.messages[0].id).toBe('message-81');
  for (const query of ['中文 输入法', '输入法', '入法', '法', '"标点"']) {
    expect(await store.search({ conversationId: first, query })).toMatchObject({ messageIds: ['message-7'], hasMore: false });
  }
  expect(await store.search({ query: '专用旧词' })).toMatchObject({ conversationIds: [second] });
  const batch = await store.search({ conversationId: first, query: '示例内容' });
  expect(batch).toMatchObject({ hasMore: true });
  expect(batch.messageIds).toHaveLength(100);
  const next = await store.search({ conversationId: first, query: '示例内容', after: batch.messageIds.at(-1) });
  expect(next.messageIds).toHaveLength(100);
  expect(next.messageIds.some(id => batch.messageIds.includes(id))).toBe(false);
});

it('updates existing rows without duplicate hits, then rebuilds a corrupt or lagging index from JSONL', async () => {
  const { store, profile, manifest } = await setup();
  await store.openRecent();
  const source = path.join(profile, 'single-chat-history.v2');
  const log = path.join(source, 'conversations', createHash('sha256').update(first).digest('hex'), 'events.jsonl');
  await store.write({ generation: manifest.generation, changes: [{
    conversationId: first, upsert: [message('message-7', '更新后的唯一片段'), message('new', '新增的搜索词')], remove: ['message-9'],
  }] });
  expect((await store.search({ query: '输入法' })).conversationIds).toEqual([]);
  expect((await store.search({ query: '更新后的唯一片段', conversationId: first })).messageIds).toEqual(['message-7']);

  const index = path.join(source, 'history-index.v1.sqlite');
  const before = await readFile(log);
  await writeFile(index, 'invalid derived database');
  const restarted = new SingleChatHistoryStore(profile);
  expect((await restarted.search({ query: '新增的搜索词', conversationId: first })).messageIds).toEqual(['new']);
  expect((await readdir(source)).some(name => name.startsWith('history-index.v1.sqlite.invalid-'))).toBe(true);
  expect(await readFile(log)).toEqual(before);

  await appendFile(log, JSON.stringify({ type: 'checkpoint', upsert: [message('durable', '日志已写索引未写')], remove: [] }) + '\n');
  await appendFile(log, '{"type":"checkpoint"');
  expect((await restarted.readPage({ conversationId: first }))?.messages.at(-1)?.id).toBe('durable');
  expect((await restarted.search({ query: '日志已写索引未写', conversationId: first })).messageIds).toEqual(['durable']);
  await restarted.write({ generation: manifest.generation, changes: [{
    conversationId: first, upsert: [message('after-repair', '尾部隔离后追加')], remove: [],
  }] });
  expect((await restarted.readPage({ conversationId: first }))?.messages.at(-1)?.id).toBe('after-repair');
  const damaged = (await readdir(path.dirname(log))).find(name => name.startsWith('events.jsonl.incomplete-'));
  expect(await readFile(path.join(path.dirname(log), damaged!), 'utf8')).toBe('{"type":"checkpoint"');
  await restarted.deleteConversation(second);
  expect((await restarted.search({ query: '专用旧词' })).conversationIds).toEqual([]);

  await rename(index, index + '.paused');
  await mkdir(index);
  await restarted.write({ generation: manifest.generation, changes: [{
    conversationId: first, upsert: [message('index-offline', '索引离线仍可保存')], remove: [],
  }] });
  await rmdir(index);
  await rename(index + '.paused', index);
  expect((await restarted.search({ query: '索引离线仍可保存', conversationId: first })).messageIds).toEqual(['index-offline']);
});

it('limits page payloads without dropping the requested anchor or skipping rows', async () => {
  const store = new SingleChatHistoryStore(autoTestOutput());
  const detail = '合成工具日志'.repeat(58_000);
  const messages = Array.from({ length: 8 }, (_, index) => ({
    ...message('large-' + index, '短正文 ' + index),
    timeline: [{ id: 'tool-' + index, kind: 'tool' as const, sequence: 1, toolCallId: 'call-' + index, summary: '示例', state: 'success' as const, detail }],
  }));
  await store.initialize(async () => ({ conversations: [chat(first, messages)], deletedConversationIds: [] }));
  const tail = await store.readPage({ conversationId: first });
  expect(tail?.hasOlder).toBe(true);
  expect(tail?.messages.at(-1)?.id).toBe('large-7');
  const earlier = await store.readPage({ conversationId: first, before: tail?.messages[0].id });
  expect([...(earlier?.messages ?? []), ...(tail?.messages ?? [])].map(item => item.id)).toEqual(messages.map(item => item.id));
  expect((await store.readPage({ conversationId: first, around: 'large-4' }))?.messages.some(item => item.id === 'large-4')).toBe(true);
});
