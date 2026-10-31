import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SingleChatMessageStore } from '../../src/main/conversation/SingleChatMessageStore';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-single-chat-messages-'));
  temporary.push(directory);
  const filePath = path.join(directory, 'messages.json');
  return { filePath, store: new SingleChatMessageStore(filePath) };
}

const snapshot = {
  conversationId: 'conversation-1',
  partnerId: 'partner-1',
  messages: [
    { messageId: 'message-1', authorType: 'user' as const, authorId: 'user', content: '一', createdAt: '10:00' },
    { messageId: 'message-2', authorType: 'partner' as const, authorId: 'partner-1', content: '二', createdAt: '10:01' },
    { messageId: 'message-3', authorType: 'user' as const, authorId: 'user', content: '三', createdAt: '10:02' },
    { messageId: 'message-4', authorType: 'partner' as const, authorId: 'partner-1', content: '四', createdAt: '10:03' },
  ],
};

describe('SingleChatMessageStore', () => {
  it('persists stable visible message IDs and resolves a bounded context window after restart', async () => {
    const value = await setup();
    await value.store.sync([snapshot]);
    const restarted = new SingleChatMessageStore(value.filePath);
    await expect(restarted.getMessage('conversation-1', 'message-3')).resolves.toMatchObject({ content: '三' });
    await expect(restarted.getWindow('conversation-1', 'message-3', 1)).resolves.toMatchObject({
      partnerId: 'partner-1',
      targetIndex: 2,
      messages: [{ messageId: 'message-2' }, { messageId: 'message-3' }, { messageId: 'message-4' }],
    });
  });

  it('replaces edited/truncated snapshots and removes deleted conversations', async () => {
    const value = await setup();
    await value.store.sync([snapshot]);
    await value.store.sync([{ ...snapshot, messages: [{ ...snapshot.messages[0], content: '编辑后' }] }]);
    await expect(value.store.getMessage('conversation-1', 'message-1')).resolves.toMatchObject({ content: '编辑后' });
    await expect(value.store.getMessage('conversation-1', 'message-2')).resolves.toBeUndefined();
    await value.store.deleteConversation('conversation-1');
    await expect(value.store.getConversation('conversation-1')).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(value.filePath, 'utf8')).conversations).toEqual({});
  });

  it('upserts the current visible user message before an asynchronous renderer snapshot arrives', async () => {
    const value = await setup();
    await value.store.upsertMessage('conversation-1', 'partner-1', snapshot.messages[0]);
    await value.store.upsertMessage('conversation-1', 'partner-1', { ...snapshot.messages[0], content: '重新生成后的正文' });
    await expect(value.store.getConversation('conversation-1')).resolves.toMatchObject({
      messages: [{ messageId: 'message-1', content: '重新生成后的正文' }],
    });
  });

  it('rejects duplicate message IDs instead of producing ambiguous anchors', async () => {
    const value = await setup();
    await expect(value.store.sync([{ ...snapshot, messages: [snapshot.messages[0], snapshot.messages[0]] }]))
      .rejects.toThrow('SINGLE_CHAT_MESSAGE_INDEX_INVALID');
  });
});
