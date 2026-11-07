import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { ConversationAttachmentStore } from '../../src/main/security/ConversationAttachmentStore';
import { ProjectWorkspaceStore } from '../../src/main/project/ProjectWorkspaceStore';
import { StudioAttachments } from '../../src/main/studio/StudioAttachments';
import { StudioRoomStore } from '../../src/main/studio/StudioRoomStore';
import { studioAttachmentConversationId } from '../../src/shared/studioRuntime';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-attachments-')); temporary.push(root);
  const input = path.join(root, 'test-document.txt'); await writeFile(input, 'generic group attachment');
  const store = new ConversationAttachmentStore({ rootDirectory: path.join(root, 'attachments') });
  const rooms = new StudioRoomStore(path.join(root, 'rooms.json'));
  const workspaces = new ProjectWorkspaceStore(path.join(root, 'projects.json'), () => path.join(root, 'projects'));
  const service = new StudioAttachments(store, { workspaces, rooms });
  const room = { roomId: 'room-one', projectId: 'project-one', name: '测试讨论组', memberIds: ['partner-one', 'partner-two'] };
  const [pending] = await store.stage([input]);
  const request = { room, messageId: 'message-one', authorId: 'user', content: '', speakerQueue: ['partner-one'], attachmentSelectionIds: [pending.selectionId] };
  return { root, input, store, service, rooms, workspaces, room, pending, request };
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
it('archives only after publication, using the snapshot and keeping a different same-name file', async () => {
  const { service, rooms, workspaces, room, request, input } = await setup();
  const workspace = await workspaces.create({ projectId: room.projectId, name: '测试项目' });
  const other = await workspaces.create({ projectId: 'project-other', name: '另一个测试项目' });
  const uploads = path.join(workspace.rootPath, 'uploads');
  const message = await service.prepareMessage(request);
  expect(await readdir(workspace.rootPath)).not.toContain('uploads');
  await mkdir(uploads);
  await writeFile(path.join(uploads, 'test-document.txt'), 'existing different file');
  await writeFile(input, 'source changed');
  const published = await rooms.startRound(message);
  await service.published(request);
  const completed = await service.archivePublished(published);
  expect(completed.messages[0].projectUploadPending).toBeUndefined();
  expect(await readFile(path.join(uploads, 'test-document.txt'), 'utf8')).toBe('existing different file');
  expect(await readFile(path.join(uploads, 'test-document (2).txt'), 'utf8')).toBe('generic group attachment');
  expect(await readdir(other.rootPath)).not.toContain('uploads');
  await service.archivePublished(published);
  expect(await readdir(uploads)).toHaveLength(2);
});

it('retains the posted message when archiving fails and retries only the file copy after reload', async () => {
  const { root, service, rooms, workspaces, room, request } = await setup();
  const workspace = await workspaces.create({ projectId: room.projectId, name: '测试项目' });
  const uploads = path.join(workspace.rootPath, 'uploads');
  await writeFile(uploads, 'blocks folder creation');
  const published = await rooms.startRound(await service.prepareMessage(request));
  await service.published(request);
  expect((await service.archivePublished(published)).messages[0].projectUploadPending).toBe(true);
  const restored = new StudioRoomStore(path.join(root, 'rooms.json'));
  const pending = (await restored.getRoom(room.roomId))!;
  expect(pending.messages[0].projectUploadPending).toBe(true);
  await rm(uploads);
  const completed = await service.archivePublished(pending);
  expect(completed.messages.filter((message) => message.authorType === 'user')).toHaveLength(1);
  expect(completed.messages[0].projectUploadPending).toBeUndefined();
  expect(await readFile(path.join(uploads, 'test-document.txt'), 'utf8')).toBe('generic group attachment');
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
