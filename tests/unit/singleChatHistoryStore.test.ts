// @vitest-environment node
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
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

  it('persists a newly bound native session without letting a second session replace it', async () => {
    const profile = path.join(autoTestOutput(), 'native-binding');
    const store = new SingleChatHistoryStore(profile);
    const conversation = { ...chat('one'), sessionId: undefined };
    await store.initialize(async () => ({ conversations: [conversation], deletedConversationIds: [] }));
    expect(await store.bindInitialSession('one', 'fixture-partner', 'first-thread')).toBe(true);
    expect(await store.bindInitialSession('one', 'fixture-partner', 'other-thread')).toBe(false);
    const reopened = new SingleChatHistoryStore(profile);
    expect((await reopened.readConversation('one'))?.conversation.sessionId).toBe('first-thread');
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
    await expect(store.initialize(legacy)).rejects.toThrow('SINGLE_CHAT_HISTORY_MANIFEST_MISSING');
    expect(legacy).not.toHaveBeenCalled();
  });

  it('stores oversized details once per chat, reads Unicode pages after restart and deletes only that chat', async () => {
    const profile = path.join(autoTestOutput(), 'tool-output');
    const store = new SingleChatHistoryStore(profile);
    const detail = 'a'.repeat(65535) + '星😀'.repeat(20000) + '最后';
    const withOutput = (id: string): Message => ({
      ...message(id), timeline: [{ id: 'tool', sequence: 1, kind: 'tool', toolCallId: 'tool', summary: '文件读取', state: 'success', detail }],
    });
    const manifest = await store.initialize(async () => ({ conversations: [chat('one', [withOutput('first')]), chat('two')], deletedConversationIds: [] }));
    await store.checkpoint({ generation: manifest.generation, conversationId: 'one', expectedRevision: 2, upsert: [withOutput('again')] });
    const target = logPath(profile, 'one');
    const reopened = new SingleChatHistoryStore(profile);
    const saved = await reopened.readPage({ conversationId: 'one' });
    const ref = expect.objectContaining({ sizeBytes: Buffer.byteLength(detail) });
    expect(saved?.messages.map(message => message.timeline?.[0])).toEqual([
      expect.objectContaining({ detailRef: ref }), expect.objectContaining({ detailRef: ref }),
    ]);
    const outputId = createHash('sha256').update(detail).digest('hex');
    const outputs = path.join(path.dirname(target), 'outputs');
    expect(await readdir(outputs)).toEqual([outputId + '.txt']);
    expect((await readFile(target, 'utf8')).length).toBeLessThan(8000);
    const query = { conversationId: 'one', outputId };
    const first = await reopened.readToolOutput(query);
    expect(first?.nextOffset).toBe(65535);
    expect(first?.text).toBe(detail.slice(0, 65535));
    let all = first!.text;
    let next = first!.nextOffset;
    while (next !== undefined) {
      const page = await reopened.readToolOutput({ ...query, offset: next });
      all += page!.text;
      next = page!.nextOffset;
    }
    expect(all).toBe(detail);
    await expect(reopened.readToolOutput({ ...query, offset: 65536 })).rejects.toThrow('INVALID_PAGE');
    await expect(reopened.readToolOutput({ ...query, outputId: '../manifest' })).rejects.toThrow('INVALID_ID');
    await expect(reopened.readToolOutput({ ...query, conversationId: 'two' })).rejects.toThrow();
    await reopened.deleteConversation('one');
    expect(await reopened.readToolOutput(query)).toBeUndefined();
    expect(await readdir(outputs)).toEqual([]);
    expect(await reopened.readConversation('two')).toBeDefined();
  });

  it('leaves the checkpoint revision retryable when tool detail cannot be saved', async () => {
    const profile = path.join(autoTestOutput(), 'tool-output-retry');
    const store = new SingleChatHistoryStore(profile);
    const manifest = await store.initialize(async () => ({ conversations: [chat('one')], deletedConversationIds: [] }));
    const outputPath = path.join(path.dirname(logPath(profile, 'one')), 'outputs');
    await writeFile(outputPath, 'synthetic file blocks directory');
    const request = {
      generation: manifest.generation, conversationId: 'one', expectedRevision: 2,
      upsert: [{ ...message('tool-result'), timeline: [
        { id: 'tool', sequence: 1, kind: 'tool' as const, toolCallId: 'tool', summary: '合成工具', state: 'success' as const, detail: '中'.repeat(12000) },
      ] }],
    };
    await expect(store.checkpoint(request)).rejects.toThrow();
    expect((await store.readConversation('one'))?.revision).toBe(2);
    await unlink(outputPath);
    await expect(store.checkpoint(request)).resolves.toBe(3);
  });

  it('keeps every committed record across a process kill and saves the torn tail before appending', async () => {
    const profile = path.join(autoTestOutput(), 'forced-exit');
    const store = new SingleChatHistoryStore(profile);
    const conversations = Array.from({ length: 3 }, (_, thread) => chat('chat-' + thread,
      Array.from({ length: 1600 }, (_, index) => message('message-' + index, '合成历史 ' + '文本。'.repeat(25)))));
    const manifest = await store.initialize(async () => ({ conversations, deletedConversationIds: [] }));
    const target = logPath(profile, 'chat-1');
    const fixture = path.join(profile, 'abrupt-worker.cjs');
    const entry = fileURLToPath(new URL('../../src/main/conversation/SingleChatHistoryStore.ts', import.meta.url));
    const bundle = path.join(profile, 'bundle');
    await build({
      configFile: false, logLevel: 'silent',
      build: { outDir: bundle, lib: { entry, formats: ['cjs'], fileName: () => 'store.cjs' }, rollupOptions: { external: [/^node:/] } },
    });
    const modulePath = path.join(bundle, 'store.cjs');
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
    const child = fork(fixture, [modulePath, profile, manifest.generation, target], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
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
