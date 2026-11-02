import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationAttachmentStore, MAX_MESSAGE_ATTACHMENT_BYTES } from '../../src/main/security/ConversationAttachmentStore';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-attachments-'));
  temporaryDirectories.push(root);
  const source = path.join(root, '用户文件.txt');
  const storeRoot = path.join(root, 'user-data', 'conversation-attachments', 'v2');
  const legacyIndexPath = path.join(root, 'user-data', 'message-attachments.v1.json');
  await writeFile(source, 'hello attachment', 'utf8');
  const options = { rootDirectory: storeRoot, legacyIndexPath };
  return { root, source, storeRoot, legacyIndexPath, options, store: new ConversationAttachmentStore(options) };
}

describe('ConversationAttachmentStore', () => {
  it('keeps an immutable conversation copy while source paths remain main-process-only metadata', async () => {
    const { source, storeRoot, store } = await fixture();
    const [pending] = await store.stage([source]);
    const [attachment] = await store.commit('conversation-a', [pending.selectionId], 'message-one');
    const savedPath = await store.pathFor(attachment.id, 'conversation-a');

    expect(attachment).toEqual({ id: expect.stringMatching(/^attachment-/), name: '用户文件.txt', mediaType: 'text/plain', sizeBytes: 16 });
    expect(savedPath).toContain(path.join('conversation-attachments', 'v2', 'conversation-a', attachment.id, 'content'));
    expect(await store.sourcePathFor(attachment.id, 'conversation-a')).toBe(source);
    await writeFile(source, 'changed at source', 'utf8');
    await rm(source);
    expect(await readFile(savedPath, 'utf8')).toBe('hello attachment');
    const listed = await store.list('conversation-a');
    expect(listed[0]).toMatchObject({ availability: 'available', sourceAvailability: 'missing', sends: [{ messageId: 'message-one' }] });
    expect(JSON.stringify(listed)).not.toContain(source);
    await expect(store.sourcePathFor(attachment.id, 'conversation-a')).rejects.toThrow('ATTACHMENT_SOURCE_MISSING');

    const indexText = await readFile(path.join(storeRoot, 'conversation-a', 'index.json'), 'utf8');
    const privateIndex = JSON.parse(indexText) as { attachments: Record<string, { sourcePath: string; snapshotPath: string }> };
    expect(privateIndex.attachments[attachment.id].sourcePath).toBe(source);
    expect(privateIndex.attachments[attachment.id].snapshotPath).toBe(savedPath);
    expect(indexText).not.toContain('attachmentRef');
  });

  it('canonicalizes renderer metadata and isolates attachment ids by conversation', async () => {
    const { source, store } = await fixture();
    const [pending] = await store.stage([source]);
    const [attachment] = await store.commit('conversation-a', [pending.selectionId], 'message-one');

    expect(await store.canonicalize('conversation-a', [{ ...attachment, name: '伪造.exe', mediaType: 'image/png', sizeBytes: 1 }])).toEqual([attachment]);
    await expect(store.pathFor(attachment.id, 'conversation-b')).rejects.toThrow('ATTACHMENT_REFERENCE_INVALID');
  });

  it('reuses an unchanged snapshot, creates a new version after edits, and restores indexes after restart', async () => {
    const { source, options, store } = await fixture();
    const firstPending = await store.stage([source]);
    const [first] = await store.commit('conversation-a', firstPending.map((item) => item.selectionId), 'message-one');
    const secondPending = await store.stage([source]);
    const [second] = await store.commit('conversation-a', secondPending.map((item) => item.selectionId), 'message-two');
    expect(second.id).toBe(first.id);
    await writeFile(source, 'version two', 'utf8');
    const thirdPending = await store.stage([source]);
    const [third] = await store.commit('conversation-a', thirdPending.map((item) => item.selectionId), 'message-three');
    expect(third.id).not.toBe(first.id);

    const restarted = new ConversationAttachmentStore(options);
    const listed = await restarted.list('conversation-a');
    expect(listed.map((item) => item.id)).toEqual([first.id, third.id]);
    expect(listed[0].sourceId).toBe(listed[1].sourceId);
    expect(listed[0].sends.map((item) => item.messageId)).toEqual(['message-one', 'message-two']);
  });

  it('cleans pending copies and rejects the actual copied byte count above 20 MB', async () => {
    const { root, source, storeRoot, store } = await fixture();
    const [pending] = await store.stage([source]);
    const pendingPath = await store.pendingPath(pending.selectionId);
    await store.discard([pending.selectionId]);
    await expect(stat(pendingPath)).rejects.toThrow();

    const oversized = path.join(root, 'large.bin');
    await writeFile(oversized, Buffer.alloc(MAX_MESSAGE_ATTACHMENT_BYTES + 1));
    await expect(store.stage([oversized])).rejects.toThrow('ATTACHMENT_TOO_LARGE');
    expect(await stat(path.join(storeRoot, '.pending'))).toBeTruthy();

    const [selected] = await store.stage([source]);
    await writeFile(source, Buffer.alloc(MAX_MESSAGE_ATTACHMENT_BYTES + 1));
    await expect(store.commit('conversation-a', [selected.selectionId], 'message-too-large')).rejects.toThrow('ATTACHMENT_TOO_LARGE');
    expect(await store.list('conversation-a')).toEqual([]);
  });

  it('keeps archived data untouched until explicit permanent deletion', async () => {
    const { source, store } = await fixture();
    const [pending] = await store.stage([source]);
    const [attachment] = await store.commit('conversation-a', [pending.selectionId], 'message-one');
    expect((await store.list('conversation-a'))[0].availability).toBe('available');
    await store.deleteConversation('conversation-a');
    await expect(store.pathFor(attachment.id, 'conversation-a')).rejects.toThrow('ATTACHMENT_REFERENCE_INVALID');
    expect(await readFile(source, 'utf8')).toBe('hello attachment');
  });

  it('migrates v1 records, preserves ids, and never treats a missing original as a usable snapshot', async () => {
    const { source, legacyIndexPath, options } = await fixture();
    await mkdir(path.dirname(legacyIndexPath), { recursive: true });
    await writeFile(legacyIndexPath, JSON.stringify({ version: 1, attachments: {
      present: { id: 'attachment-00000000-0000-0000-0000-000000000001', name: '旧文件.txt', mediaType: 'TEXT/PLAIN', sizeBytes: 16, attachmentRef: 'message-attachment:attachment-00000000-0000-0000-0000-000000000001', conversationId: 'conversation-a', sourcePath: source, createdAt: '2026-01-01T00:00:00.000Z' },
      missing: { id: 'attachment-00000000-0000-0000-0000-000000000002', name: '丢失.txt', mediaType: 'text/plain', sizeBytes: 7, attachmentRef: 'message-attachment:attachment-00000000-0000-0000-0000-000000000002', conversationId: 'conversation-a', sourcePath: `${source}.missing`, createdAt: '2026-01-01T00:00:01.000Z' },
    } }), 'utf8');
    const store = new ConversationAttachmentStore(options);
    const listed = await store.list('conversation-a');
    expect(listed.map((item) => [item.id, item.availability, item.sourceAvailability])).toEqual([
      ['attachment-00000000-0000-0000-0000-000000000001', 'available', 'available'],
      ['attachment-00000000-0000-0000-0000-000000000002', 'missing', 'missing'],
    ]);
    expect(await readFile(`${legacyIndexPath}.migrated`, 'utf8')).toContain('attachments');
  });
});
