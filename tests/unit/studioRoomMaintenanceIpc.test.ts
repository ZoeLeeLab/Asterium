// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { ProjectService } from '../../src/main/project/ProjectService';
import { ProjectMutationCoordinator } from '../../src/main/project/ProjectMutationCoordinator';
import { ProjectWorkspaceStore } from '../../src/main/project/ProjectWorkspaceStore';
import { StudioRoomStore } from '../../src/main/studio/StudioRoomStore';
import { StudioAttachments } from '../../src/main/studio/StudioAttachments';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';
import { MemoryFallbackInventory } from '../../src/main/memory/fallback/MemoryFallbackInventory';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import { studioAttachmentConversationId, type StudioRoomSnapshot } from '../../src/shared/studioRuntime';
import type { MessageAttachment, PendingMessageAttachment } from '../../src/shared/agentProtocol';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ profile: '' }));
vi.mock('electron', () => ({ app: { getPath: () => electron.profile, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined }, BrowserWindow: class {}, safeStorage: {}, clipboard: {}, dialog: {}, shell: {} }));
type Handler = (event: { sender: object }, value?: unknown) => unknown;
const keys = ['studioRetryProjectUploads', 'studioRemoveRoom'] as const;
const metadata = { roomId: 'fixture-maintenance-room', projectId: 'fixture-maintenance-project', name: '合成房间', memberIds: ['fixture-partner'] };
const handlers = new Map<string, Handler>(), removed: string[] = [], sender = { send: vi.fn() }, window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
let root: string, room: StudioRoomSnapshot, dispose: (() => Promise<void>) | undefined;
const invoke = async <T = unknown>(key: keyof typeof DESKTOP_IPC, value?: unknown) => await handlers.get(DESKTOP_IPC[key])!({ sender }, value) as T;
beforeEach(async () => {
  vi.resetAllMocks(); handlers.clear(); removed.length = 0;
  root = await mkdtemp(path.join(os.tmpdir(), 'asterium-room-maintenance-ipc-')); electron.profile = path.join(root, 'profile'); await mkdir(electron.profile);
  dispose = registerAgentIpc({ handle: (channel: string, handler: Handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); }, removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); } } as unknown as IpcMain, () => window,
    { environment: { profile: 'autotest', label: 'Fixture', userDataDirectory: electron.profile, projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root, appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false, restoreBackgroundServices: false, mcpPort: 0 } });
  await invoke('studioMcpStatus'); room = await invoke<StudioRoomSnapshot>('studioSyncRoom', metadata); sender.send.mockClear();
});
afterEach(async () => {
  try { vi.restoreAllMocks(); await dispose?.(); expect(handlers.size).toBe(0); expect(removed).toHaveLength(230); for (const key of keys) expect(removed.filter(channel => channel === DESKTOP_IPC[key])).toHaveLength(1); }
  finally { dispose = undefined; await testRm(root, { recursive: true, force: true }); }
});

it('keeps both handlers in their original position and rejects foreign senders before validation', async () => {
  const all = [...handlers.keys()], index = all.indexOf(DESKTOP_IPC.studioRetryProjectUploads);
  expect(all.slice(index - 1, index + 3)).toEqual([DESKTOP_IPC.studioResolveDiscussion, ...keys.map(key => DESKTOP_IPC[key]), DESKTOP_IPC.studioCancelRound]);
  const get = vi.spyOn(StudioRoomStore.prototype, 'getRoom'), remove = vi.spyOn(ProjectService.prototype, 'removeRoom');
  for (const key of keys) await expect(handlers.get(DESKTOP_IPC[key])!({ sender: {} }, null)).rejects.toThrow('INVALID_IPC_SENDER');
  expect(get).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});
it('keeps the existing nonempty-string validation and does not trim room IDs', async () => {
  const get = vi.spyOn(StudioRoomStore.prototype, 'getRoom').mockResolvedValue(undefined), remove = vi.spyOn(ProjectService.prototype, 'removeRoom').mockResolvedValue(undefined), refresh = vi.spyOn(MemoryFallbackInventory.prototype, 'refresh').mockResolvedValue(undefined);
  for (const key of keys) for (const value of [null, undefined, '', 1, {}]) await expect(invoke(key, value)).rejects.toThrow('INVALID_STUDIO_ROOM_ID');
  expect(get).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  for (const key of keys) await expect(invoke(key, ' ')).resolves.toBeUndefined(); expect(get).toHaveBeenCalledExactlyOnceWith(' '); expect(remove).toHaveBeenCalledExactlyOnceWith(' '); expect(refresh).toHaveBeenCalledTimes(1);
});
it.each(['missing', 'archived'] as const)('does no archiving or active-project check for a %s room', async state => {
  vi.spyOn(StudioRoomStore.prototype, 'getRoom').mockResolvedValue(state === 'missing' ? undefined : { ...room, metadata: { ...metadata, archived: true } });
  const active = vi.spyOn(ProjectMutationCoordinator.prototype, 'assertProjectActive'), archive = vi.spyOn(StudioAttachments.prototype, 'archivePublished');
  await expect(invoke('studioRetryProjectUploads', metadata.roomId)).resolves.toBeUndefined(); expect(active).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled();
});
it('holds the existing project coordinator through the entire read, project check and archive operation', async () => {
  const trace: string[] = []; let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), pending = new Promise<void>(resolve => { finish = resolve; });
  const get = vi.spyOn(StudioRoomStore.prototype, 'getRoom').mockImplementation(async () => { trace.push('read'); return room; });
  vi.spyOn(ProjectMutationCoordinator.prototype, 'assertProjectActive').mockImplementation(projectId => { expect(projectId).toBe(metadata.projectId); trace.push('active'); });
  let first = true; vi.spyOn(StudioAttachments.prototype, 'archivePublished').mockImplementation(async snapshot => { expect(snapshot).toBe(room); trace.push('archive'); if (first) { first = false; entered(); await pending; } return snapshot; });
  const left = invoke('studioRetryProjectUploads', metadata.roomId), right = invoke('studioRetryProjectUploads', metadata.roomId);
  try { await started; expect(get).toHaveBeenCalledTimes(1); expect(trace).toEqual(['read', 'active', 'archive']); } finally { finish(); }
  await expect(left).resolves.toBeUndefined(); await expect(right).resolves.toBeUndefined(); expect(trace).toEqual(['read', 'active', 'archive', 'read', 'active', 'archive']);
});
it.each(['read', 'active', 'archive'] as const)('preserves retry failure at %s and permits a later retry through the same coordinator', async stage => {
  const failure = new Error('SYNTHETIC_UPLOAD_RETRY_FAILURE'), get = vi.spyOn(StudioRoomStore.prototype, 'getRoom').mockResolvedValue(room), active = vi.spyOn(ProjectMutationCoordinator.prototype, 'assertProjectActive'), archive = vi.spyOn(StudioAttachments.prototype, 'archivePublished').mockResolvedValue(room);
  if (stage === 'read') get.mockRejectedValueOnce(failure); if (stage === 'active') active.mockImplementationOnce(() => { throw failure; }); if (stage === 'archive') archive.mockRejectedValueOnce(failure);
  await expect(invoke('studioRetryProjectUploads', metadata.roomId)).rejects.toBe(failure); if (stage !== 'archive') expect(archive).not.toHaveBeenCalled();
  await expect(invoke('studioRetryProjectUploads', metadata.roomId)).resolves.toBeUndefined(); expect(archive).toHaveBeenLastCalledWith(room);
});
it('awaits room removal before memory refresh and retains failures from either operation', async () => {
  let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
  const remove = vi.spyOn(ProjectService.prototype, 'removeRoom').mockReturnValueOnce(pending), refresh = vi.spyOn(MemoryFallbackInventory.prototype, 'refresh').mockResolvedValue(undefined);
  const removed = invoke('studioRemoveRoom', metadata.roomId); expect(remove).toHaveBeenCalledExactlyOnceWith(metadata.roomId); expect(refresh).not.toHaveBeenCalled(); finish(); await expect(removed).resolves.toBeUndefined(); expect(refresh).toHaveBeenCalledTimes(1);
  const failure = new Error('SYNTHETIC_ROOM_REMOVE_FAILURE'); remove.mockRejectedValueOnce(failure); refresh.mockClear(); await expect(invoke('studioRemoveRoom', metadata.roomId)).rejects.toBe(failure); expect(refresh).not.toHaveBeenCalled();
  remove.mockResolvedValue(undefined); refresh.mockRejectedValueOnce(failure); await expect(invoke('studioRemoveRoom', metadata.roomId)).rejects.toBe(failure);
});
it('retains the existing room and bindings rollback if binding removal fails', async () => {
  const failure = new Error('SYNTHETIC_BINDING_REMOVE_FAILURE'), refresh = vi.spyOn(MemoryFallbackInventory.prototype, 'refresh'), restore = vi.spyOn(NativeThreadBindingStore.prototype, 'restore');
  vi.spyOn(NativeThreadBindingStore.prototype, 'removeRooms').mockRejectedValueOnce(failure);
  await expect(invoke('studioRemoveRoom', metadata.roomId)).rejects.toBe(failure); expect(restore).toHaveBeenCalledTimes(1); expect(refresh).not.toHaveBeenCalled();
  await expect(invoke('studioGetRoom', metadata.roomId)).resolves.toEqual(room);
});
it('rejects room removal while a round is active before changing bindings or refreshing memory', async () => {
  vi.spyOn(StudioRoomStore.prototype, 'getRoom').mockResolvedValue({ ...room, activeRound: { state: 'running' } } as StudioRoomSnapshot);
  const remove = vi.spyOn(StudioRoomStore.prototype, 'removeRoom'), bindings = vi.spyOn(NativeThreadBindingStore.prototype, 'removeRooms'), refresh = vi.spyOn(MemoryFallbackInventory.prototype, 'refresh');
  await expect(invoke('studioRemoveRoom', metadata.roomId)).rejects.toThrow('STUDIO_ROUND_ALREADY_ACTIVE'); expect(remove).not.toHaveBeenCalled(); expect(bindings).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
});
it('retries only a failed owned upload without duplicating its message and preserves source, snapshot and project bytes after room removal', async () => {
  const workspaces = new ProjectWorkspaceStore(path.join(electron.profile, 'project-workspaces.v1.json'), () => path.join(root, 'projects')), workspace = await workspaces.create({ projectId: metadata.projectId, name: '合成上传项目' });
  const input = path.join(root, 'fixture-upload.md'), uploads = path.join(workspace.rootPath, 'uploads'); await writeFile(input, '合成已发送的版本'); await writeFile(uploads, '合成阻塞文件夹');
  const [pending] = await invoke<PendingMessageAttachment[]>('attachmentStageFiles', [input]);
  const context = studioAttachmentConversationId(metadata.roomId), attachments = await invoke<MessageAttachment[]>('attachmentCommit', { conversationId: context, selectionIds: [pending.selectionId], messageId: 'fixture-upload-message' });
  const roomRead = vi.spyOn(StudioRoomStore.prototype, 'getRoom');
  await invoke('studioGetRoom', metadata.roomId);
  const rooms = roomRead.mock.contexts[0] as StudioRoomStore; roomRead.mockRestore();
  await rooms.publishUserMessage({ room: metadata, messageId: 'fixture-upload-message', authorId: 'fixture-user', content: '', speakerQueue: [], attachments }, 'manual', metadata.memberIds); await writeFile(input, '合成源文件后来改了');
  await expect(invoke('studioRetryProjectUploads', metadata.roomId)).resolves.toBeUndefined();
  expect((await invoke<StudioRoomSnapshot>('studioGetRoom', metadata.roomId)).messages[0].projectUploadPending).toBe(true);
  await unlink(uploads); await invoke('studioRetryProjectUploads', metadata.roomId); await invoke('studioRetryProjectUploads', metadata.roomId);
  const saved = await invoke<StudioRoomSnapshot>('studioGetRoom', metadata.roomId); expect(saved.messages).toHaveLength(1); expect(saved.messages[0].projectUploadPending).toBeUndefined(); expect(await readdir(uploads)).toEqual(['fixture-upload.md']); expect(await readFile(path.join(uploads, 'fixture-upload.md'), 'utf8')).toBe('合成已发送的版本');
  const other = { ...metadata, roomId: 'fixture-other-room', name: '合成保留房间' }; await invoke('studioSyncRoom', other);
  await expect(invoke('studioRemoveRoom', metadata.roomId)).resolves.toBeUndefined(); await expect(invoke('studioGetRoom', metadata.roomId)).resolves.toBeUndefined(); await expect(invoke('studioGetRoom', other.roomId)).resolves.toMatchObject({ metadata: other });
  expect(await readFile(input, 'utf8')).toBe('合成源文件后来改了'); expect(await readFile(path.join(uploads, 'fixture-upload.md'), 'utf8')).toBe('合成已发送的版本'); await expect(invoke('attachmentRead', { attachmentId: attachments[0].id, conversationId: context })).resolves.toMatchObject({ text: '合成已发送的版本' });
});
