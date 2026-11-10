// @vitest-environment node
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { autoTestOutput } from '../helpers/autoTest.mjs';
import { SingleChatHistoryStore } from '../../src/main/conversation/SingleChatHistoryStore';
import type { Conversation, Message } from '../../src/renderer/types/domain';

const time = '2026-01-01T00:00:00.000Z';
function message(id: string, content = id): Message {
  return { id, content, authorId: 'fixture-partner', createdAt: '00:00', occurredAt: time };
}

function chat(id: string, messages: Message[] = [message('first')]): Conversation {
  return { id, title: '合成单聊', partnerId: 'fixture-partner', updatedAt: time, sessionId: 'native-fixture-thread', messages };
}

function logPath(profile: string, id: string) {
  return path.join(profile, 'single-chat-history.v2', 'conversations', createHash('sha256').update(id).digest('hex'), 'events.jsonl');
}

describe('single chat migration activation', () => {
  it('retains identities and ignores stale legacy imports after activation, including after restart', async () => {
    const profile = path.join(autoTestOutput(), 'activation');
    const store = new SingleChatHistoryStore(profile);
    const conversations = [chat('one'), chat('deleted')];
    const manifest = await store.initialize(async () => ({ conversations, deletedConversationIds: ['deleted'] }));
    expect(await store.readConversation('deleted')).toBeUndefined();
    expect((await store.readConversation('one'))?.conversation).toEqual(conversations[0]);
    const saved = await store.checkpoint({ generation: manifest.generation, conversationId: 'one', expectedRevision: 2, upsert: [message('first', 'new content')] });
    const staleLegacy = vi.fn(async () => ({ conversations, deletedConversationIds: [] }));
    const reopened = new SingleChatHistoryStore(profile);
    expect(await reopened.initialize(staleLegacy)).toEqual(manifest);
    expect(staleLegacy).not.toHaveBeenCalled();
    await expect(reopened.checkpoint({ generation: 'stale', conversationId: 'one', expectedRevision: saved, upsert: conversations[0].messages })).rejects.toThrow('STALE_GENERATION');
    await expect(reopened.checkpoint({ generation: manifest.generation, conversationId: 'one', expectedRevision: 2, upsert: conversations[0].messages })).rejects.toThrow('STALE_REVISION');
    expect((await reopened.readConversation('one'))?.conversation.messages[0].content).toBe('new content');
  });

  it('retries interrupted staging, but does not reimport when an activated manifest is missing', async () => {
    const profile = path.join(autoTestOutput(), 'staging');
    await mkdir(path.join(profile, 'single-chat-history.stage-abandoned'), { recursive: true });
    const store = new SingleChatHistoryStore(profile);
    await expect(store.initialize(async () => ({ conversations: [chat('one', [message('repeat'), message('repeat')])], deletedConversationIds: [] }))).rejects.toThrow('INVALID_EVENT');
    expect(await store.readConversation('one')).toBeUndefined();
    await store.initialize(async () => ({ conversations: [chat('one')], deletedConversationIds: [] }));
    const active = path.join(profile, 'single-chat-history.v2', 'manifest.json');
    await rename(active, active + '.unavailable');
    const legacy = vi.fn(async () => ({ conversations: [], deletedConversationIds: [] }));
    await expect(store.initialize(legacy)).rejects.toThrow('ENOENT');
    expect(legacy).not.toHaveBeenCalled();
  });

  it('keeps every committed record across a process kill and saves the torn tail before appending', async () => {
    const profile = path.join(autoTestOutput(), 'forced-exit');
    const store = new SingleChatHistoryStore(profile);
    const conversations = Array.from({ length: 3 }, (_, thread) => chat('chat-' + thread,
      Array.from({ length: 1600 }, (_, index) => message('message-' + index, '合成历史 ' + '文本。'.repeat(25)))));
    const manifest = await store.initialize(async () => ({ conversations, deletedConversationIds: [] }));
    const target = logPath(profile, 'chat-1');
    const fixture = path.join(profile, 'abrupt-worker.cjs');
    const modulePath = fileURLToPath(new URL('../../src/main/conversation/SingleChatHistoryStore.ts', import.meta.url));
    await writeFile(fixture, [
      'const { appendFileSync } = require("node:fs");',
      'const { pathToFileURL } = require("node:url");',
      '(async () => {',
      '  const { SingleChatHistoryStore } = await import(pathToFileURL(process.argv[2]).href);',
      '  const store = new SingleChatHistoryStore(process.argv[3]);',
      '  await store.checkpoint({ generation: process.argv[4], conversationId: "chat-1", expectedRevision: 1601,',
      '    upsert: [{ id: "tool-done", content: "工具结果已保存", authorId: "fixture-partner", createdAt: "00:00" }] });',
      '  appendFileSync(process.argv[5], \'{"type":"checkpoint","upsert":[\');',
      '  process.send("ready");',
      '  setInterval(() => {}, 1000);',
      '})().catch(() => process.exit(1));',
    ].join('\n'));
    const child = fork(fixture, [modulePath, profile, manifest.generation, target], { execArgv: ['--experimental-transform-types'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exit = once(child, 'exit');
    try {
      const status = await Promise.race([once(child, 'message').then(([value]) => value), exit.then(() => 'exited')]);
      expect(status).toBe('ready');
    } finally {
      child.kill('SIGKILL');
      await exit;
    }

    const reopened = new SingleChatHistoryStore(profile);
    const restored = await reopened.readConversation('chat-1');
    expect(restored?.incompleteTail).toBe(true);
    expect(restored?.conversation.messages).toHaveLength(1601);
    expect(restored?.conversation.messages.at(-1)?.id).toBe('tool-done');
    expect((await reopened.readConversation('chat-2'))?.conversation.messages).toHaveLength(1600);
    await reopened.checkpoint({ generation: manifest.generation, conversationId: 'chat-1', expectedRevision: 1602, upsert: [message('last')] });
    const damaged = (await readdir(path.dirname(target))).find(name => name.startsWith('events.jsonl.incomplete-'));
    expect(await readFile(path.join(path.dirname(target), damaged!), 'utf8')).toBe('{"type":"checkpoint","upsert":[');
    expect((await reopened.readConversation('chat-1'))?.conversation.messages.at(-1)?.id).toBe('last');
    expect((await reopened.readConversation('chat-1'))?.incompleteTail).toBe(false);
  }, 15_000);
});
