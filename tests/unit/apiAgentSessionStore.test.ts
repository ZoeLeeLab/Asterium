import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiAgentSessionStore, type ApiAgentSession } from '../../src/main/api/ApiAgentSessionStore';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-api-session-'));
  temporaryDirectories.push(directory);
  return directory;
}

function session(turns: number): ApiAgentSession {
  return {
    version: 1,
    partnerId: 'partner-1',
    conversationId: 'conversation-1',
    provider: 'deepseek',
    bootstrapSystemPrompt: '新会话启动资料',
    legacyContext: '旧对话',
    updatedAt: new Date(0).toISOString(),
    turns: Array.from({ length: turns }, (_, index) => ({
      clientMessageId: `client-${index}`,
      userContent: `问题 ${index}`,
      messages: [{ role: 'assistant' as const, content: `回答 ${index}`, reasoningContent: `思考 ${index}` }],
      completedAt: new Date(index * 1_000).toISOString(),
    })),
  };
}

describe('ApiAgentSessionStore', () => {
  it('persists exact structured reasoning and tool messages', async () => {
    const directory = await tempDirectory();
    const store = new ApiAgentSessionStore(directory);
    const value = session(1);
    value.turns[0].messages = [
      { role: 'assistant', content: '', reasoningContent: '需要先读取文件', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
      { role: 'tool', toolCallId: 'call-1', content: '{"ok":true,"result":"hello"}' },
      { role: 'assistant', content: '文件内容是 hello', reasoningContent: '已经得到结果' },
    ];
    await store.remember(value);
    expect(await store.load('partner-1', 'conversation-1')).toEqual(expect.objectContaining({ bootstrapSystemPrompt: '新会话启动资料', turns: value.turns }));
    const files = await import('node:fs/promises').then(({ readdir }) => readdir(directory));
    const raw = await readFile(path.join(directory, files.find((file) => file.endsWith('.json') && file !== 'index.json')!), 'utf8');
    expect(raw).toContain('需要先读取文件');
    expect(raw).not.toContain('api-key');
  });

  it('normalizes legacy attachment records on a successful write without paths or attachment refs', async () => {
    const directory = await tempDirectory();
    const store = new ApiAgentSessionStore(directory);
    const value = session(1);
    value.turns[0].attachments = [{ id: 'attachment-1', name: 'notes.txt', mediaType: 'TEXT/PLAIN', sizeBytes: 12, attachmentRef: 'message-attachment:attachment-1', sourcePath: 'C:\\private\\notes.txt' } as never];
    await store.remember(value);
    const restored = await store.load('partner-1', 'conversation-1');
    expect(restored?.turns[0].attachments).toEqual([{ id: 'attachment-1', name: 'notes.txt', mediaType: 'text/plain', sizeBytes: 12 }]);
    const files = await import('node:fs/promises').then(({ readdir }) => readdir(directory));
    const raw = await readFile(path.join(directory, files.find((file) => file.endsWith('.json') && file !== 'index.json')!), 'utf8');
    expect(raw).not.toContain('attachmentRef');
    expect(raw).not.toContain('private');
  });

  it('evicts complete oldest turns by count and serialized size', async () => {
    const directory = await tempDirectory();
    const countStore = new ApiAgentSessionStore(directory, { maxTurns: 3, maxBytes: 1024 * 1024 });
    await countStore.remember(session(5));
    expect((await countStore.load('partner-1', 'conversation-1'))?.turns.map((turn) => turn.clientMessageId)).toEqual(['client-2', 'client-3', 'client-4']);

    const sizeDirectory = await tempDirectory();
    const sizeStore = new ApiAgentSessionStore(sizeDirectory, { maxTurns: 30, maxBytes: 900 });
    const large = session(4);
    for (const turn of large.turns) turn.messages = [{ role: 'assistant', content: 'x'.repeat(260), reasoningContent: 'r'.repeat(260) }];
    await sizeStore.remember(large);
    const restored = await sizeStore.load('partner-1', 'conversation-1');
    expect(restored?.turns.length).toBe(1);
    expect(restored?.turns[0].clientMessageId).toBe('client-3');
  });

  it('deletes one conversation or every indexed session for a partner', async () => {
    const directory = await tempDirectory();
    const store = new ApiAgentSessionStore(directory);
    await store.remember(session(1));
    await store.delete('partner-1', 'conversation-1');
    expect(await store.load('partner-1', 'conversation-1')).toBeUndefined();
    const another = { ...session(1), conversationId: 'conversation-2' };
    await store.remember(another);
    await store.deletePartner('partner-1');
    expect(await store.load('partner-1', 'conversation-2')).toBeUndefined();
  });
});
