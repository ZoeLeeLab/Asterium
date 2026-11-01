import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { ConversationAttachmentStore } from '../../src/main/security/ConversationAttachmentStore';
import { StudioAttachments } from '../../src/main/studio/StudioAttachments';
import { StudioRoomStore } from '../../src/main/studio/StudioRoomStore';
import { studioAttachmentConversationId } from '../../src/shared/studioRuntime';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-attachments-')); temporary.push(root);
  const input = path.join(root, 'test-document.txt'); await writeFile(input, 'generic group attachment');
  const store = new ConversationAttachmentStore({ rootDirectory: path.join(root, 'attachments') });
  const service = new StudioAttachments(store), rooms = new StudioRoomStore(path.join(root, 'rooms.json'));
  const room = { roomId: 'room-one', projectId: 'project-one', name: '测试讨论组', memberIds: ['partner-one', 'partner-two'] };
  const [pending] = await store.stage([input]);
  const request = { room, messageId: 'message-one', authorId: 'user', content: '', speakerQueue: ['partner-one'], attachmentSelectionIds: [pending.selectionId] };
  return { root, input, store, service, rooms, room, pending, request };
}
it('publishes attachment-only group messages with stable snapshots, persists them and retries safely before publication', async () => {
  const { store, service, rooms, room, input, request } = await setup();
  const first = await service.prepareMessage(request);
  const retry = await service.prepareMessage(request);
  expect(retry.attachments).toEqual(first.attachments);
  const snapshot = await rooms.startRound(retry);
  await service.published(request);
  expect(snapshot.messages[0].attachments).toEqual(first.attachments);
  expect((await rooms.getRoom(room.roomId))!.messages[0].attachments).toEqual(first.attachments);
  const id = first.attachments![0].id, context = studioAttachmentConversationId(room.roomId);
  await writeFile(input, 'source changed'); await rm(input);
  expect(await readFile(await store.pathFor(id, context), 'utf8')).toBe('generic group attachment');
  await expect(service.prepareMessage(request)).rejects.toThrow('ATTACHMENT_SELECTION_EXPIRED');
});
it('binds attachment reads to an authoritative group conversation and published sequence boundary', async () => {
  const { store, service, rooms, room, request } = await setup();
  const message = await service.prepareMessage(request);
  const snapshot = await rooms.startRound(message);
  const conversationId = `group:v3:${room.roomId}:partner-one:generation:1`;
  const prepared = await rooms.prepareTurn(room.roomId, snapshot.activeRound!.roundId, 'partner-one', 1, conversationId);
  const attachment = message.attachments![0];
  await expect(store.pathFor(attachment.id, conversationId)).rejects.toThrow('ATTACHMENT_SCOPE_NOT_REGISTERED');
  const attached = service.prepareTurn(prepared, snapshot.messages);
  expect(attached.attachments).toEqual([attachment]);
  expect(await store.canonicalize(conversationId, [attachment])).toEqual([attachment]);
  expect(await store.read(attachment.id, conversationId)).toEqual(Buffer.from('generic group attachment'));
  expect((await store.list(conversationId)).map(item => item.id)).toEqual([attachment.id]);
  await expect(store.inspect(attachment.id, 'single-conversation')).rejects.toThrow();
  await expect(store.pathFor(attachment.id, 'group:v3:other-room:partner-one:generation:1')).rejects.toThrow('ATTACHMENT_SCOPE_NOT_REGISTERED');
  service.prepareTurn({ ...prepared, inputThroughSeq: 0 }, snapshot.messages);
  await expect(store.read(attachment.id, conversationId)).rejects.toThrow('ATTACHMENT_SCOPE_NOT_REGISTERED');
  service.prepareTurn(prepared, snapshot.messages);
  await store.deleteConversation(conversationId);
  await expect(store.read(attachment.id, conversationId)).rejects.toThrow('ATTACHMENT_SCOPE_NOT_REGISTERED');
  expect(await store.read(attachment.id, studioAttachmentConversationId(room.roomId))).toEqual(Buffer.from('generic group attachment'));
});
it('rejects fake bindings, traversal identifiers and attachment changes on an existing message id', async () => {
  const { store, service, rooms, request, room } = await setup();
  expect(() => studioAttachmentConversationId('../other')).toThrow('INVALID_STUDIO_ATTACHMENT_ROOM');
  expect(() => store.authorizeGroup('single-conversation', room.roomId, [])).toThrow('ATTACHMENT_GROUP_BINDING_INVALID');
  expect(() => store.authorizeGroup('group:v3:other-room:partner-one', room.roomId, [])).toThrow('ATTACHMENT_GROUP_BINDING_INVALID');
  const message = await service.prepareMessage(request); await rooms.startRound(message);
  await expect(rooms.startRound({ ...message, attachments: [{ ...message.attachments![0], name: 'changed' }] })).rejects.toThrow('STUDIO_MESSAGE_ID_CONFLICT');
  await expect(rooms.startRound({ ...request, attachmentSelectionIds: [] })).rejects.toThrow('STUDIO_MESSAGE_CONTENT_INVALID');
});
