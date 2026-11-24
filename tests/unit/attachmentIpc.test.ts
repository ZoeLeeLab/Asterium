// @vitest-environment node
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow, IpcMain } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { registerAttachmentMaintenanceIpc } from '../../src/main/ipc/attachmentIpc';
import { ConversationAttachmentStore, MAX_MESSAGE_ATTACHMENTS } from '../../src/main/security/ConversationAttachmentStore';
import { ArtifactRegistry } from '../../src/main/security/ArtifactRegistry';
import { ProjectFileDeliveryCoordinator } from '../../src/main/project/ProjectFileDeliveryCoordinator';
import { PartnerDelegation } from '../../src/main/runtime/PartnerDelegation';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import { CYBERBOSS_CHAT_IMAGE_EXTENSIONS } from '../../src/shared/cyberBossChatAttachments';
import type { ConversationAttachmentInfo, MessageAttachment, PendingMessageAttachment } from '../../src/shared/agentProtocol';
import type { SnapshotCleanupPreview, SnapshotCleanupResult } from '../../src/shared/snapshotCleanup';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({
  profile: '', choose: vi.fn(), save: vi.fn(), readClipboard: vi.fn(), writeText: vi.fn(),
  open: vi.fn(), reveal: vi.fn(), thumbnail: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => electron.profile, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, safeStorage: {},
  clipboard: { read: electron.readClipboard, writeText: electron.writeText },
  dialog: { showOpenDialog: electron.choose, showSaveDialog: electron.save },
  shell: { openPath: electron.open, showItemInFolder: electron.reveal },
}));
vi.mock('../../src/main/security/attachmentThumbnail', () => ({ createAttachmentThumbnail: electron.thumbnail }));

const keys = [
  'attachmentChoose', 'attachmentStageFiles', 'attachmentPasteFiles', 'attachmentStageClipboardImage',
  'attachmentDiscard', 'attachmentCommit', 'attachmentList', 'attachmentInspect', 'attachmentRead',
  'attachmentOpen', 'attachmentReveal', 'attachmentCopyPath', 'attachmentExportAs', 'attachmentSaveToProject',
  'attachmentThumbnail', 'attachmentDeleteConversation', 'attachmentPreviewSnapshotCleanup', 'attachmentClearSnapshots',
] as const;
type Handler = (event: { sender: object }, value?: unknown) => unknown;
const handlers = new Map<string, Handler>(), removed: string[] = [];
const sender = { send: vi.fn() }, window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
const conversationId = 'fixture-attachment-chat', content = '# 合成附件\r\n';
let root: string, source: string, dispose: (() => Promise<void>) | undefined;
const invoke = async <T = unknown>(key: keyof typeof DESKTOP_IPC, value?: unknown, caller: object = sender) =>
  await handlers.get(DESKTOP_IPC[key])!({ sender: caller }, value) as T;

beforeEach(async () => {
  vi.resetAllMocks(); handlers.clear(); removed.length = 0;
  root = await mkdtemp(path.join(os.tmpdir(), 'asterium-attachment-ipc-'));
  electron.profile = path.join(root, 'profile'); await mkdir(electron.profile);
  source = path.join(root, 'fixture.md'); await writeFile(source, content);
  electron.choose.mockResolvedValue({ canceled: false, filePaths: [source] });
  electron.save.mockResolvedValue({ canceled: true });
  electron.open.mockResolvedValue(''); electron.readClipboard.mockResolvedValue([]);
  electron.thumbnail.mockResolvedValue('data:image/png;base64,Zml4dHVyZQ==');
  const ipc = {
    handle: (channel: string, handler: Handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); },
  } as unknown as IpcMain;
  dispose = registerAgentIpc(ipc, () => window, { environment: {
    profile: 'autotest', label: 'Fixture', userDataDirectory: electron.profile,
    projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root, appUserModelId: 'Asterium.Test',
    allowStartup: false, allowUpdates: false, restoreBackgroundServices: false, mcpPort: 0,
  } });
  await invoke('studioMcpStatus');
});
afterEach(async () => {
  try {
    await dispose?.(); expect(handlers.size).toBe(0); expect(removed).toHaveLength(230);
    for (const key of keys) expect(removed.filter(channel => channel === DESKTOP_IPC[key])).toHaveLength(1);
  } finally { dispose = undefined; vi.restoreAllMocks(); await testRm(root, { recursive: true, force: true }); }
});

async function attach(file = source, chat = conversationId, message = 'fixture-message') {
  const [pending] = await invoke<PendingMessageAttachment[]>('attachmentStageFiles', [file]);
  const [attachment] = await invoke<MessageAttachment[]>('attachmentCommit', { conversationId: chat, messageId: message, selectionIds: [pending.selectionId] });
  return { pending, attachment, context: { attachmentId: attachment.id, conversationId: chat } };
}
const info: ConversationAttachmentInfo = {
  id: 'fixture-attachment', name: 'fixture.txt', mediaType: 'text/plain', sizeBytes: 7,
  createdAt: '2026-01-01T00:00:00.000Z', sentAt: '2026-01-01T00:00:00.000Z', sourceId: 'fixture-source',
  sourceAvailability: 'available', availability: 'available', sends: [],
};

it('registers all 18 channels once in the original slot and rejects every foreign caller before any work', async () => {
  const channels = [...handlers.keys()], expected = keys.map(key => DESKTOP_IPC[key]);
  expect(channels.slice(channels.indexOf(expected[0]), channels.indexOf(expected[0]) + 18)).toEqual(expected);
  expect(channels[channels.indexOf(expected[0]) - 1]).toBe(DESKTOP_IPC.artifactClearCache);
  expect(channels[channels.indexOf(expected.at(-1)!) + 1]).toBe(DESKTOP_IPC.conversationDelete);
  for (const key of keys) await expect(invoke(key, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
  expect(electron.choose).not.toHaveBeenCalled(); expect(electron.readClipboard).not.toHaveBeenCalled();
  expect(electron.save).not.toHaveBeenCalled(); expect(electron.thumbnail).not.toHaveBeenCalled();
});

it('keeps choose defaults, image filters, local-reference opt-in, cancellation and remaining-count validation', async () => {
  const stage = vi.spyOn(ConversationAttachmentStore.prototype, 'stage').mockResolvedValue([]);
  await invoke('attachmentChoose', { filter: 'cyberboss_images', remaining: 2, allowLocalReferences: true });
  expect(electron.choose).toHaveBeenLastCalledWith(window, { title: '选择图片', buttonLabel: '添加',
    properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: CYBERBOSS_CHAT_IMAGE_EXTENSIONS }] });
  expect(stage).toHaveBeenLastCalledWith([source], true);
  await invoke('attachmentChoose', { remaining: 1.5, allowLocalReferences: 'true' });
  expect(electron.choose).toHaveBeenLastCalledWith(window, { title: '选择图片或文件', buttonLabel: '添加', properties: ['openFile', 'multiSelections'] });
  expect(stage).toHaveBeenLastCalledWith([source], false);
  for (const remaining of [0, -1, MAX_MESSAGE_ATTACHMENTS + 1]) await expect(invoke('attachmentChoose', { remaining })).rejects.toThrow('ATTACHMENT_COUNT_LIMIT');
  electron.choose.mockResolvedValueOnce({ canceled: true, filePaths: [source] });
  const calls = stage.mock.calls.length; await expect(invoke('attachmentChoose')).resolves.toEqual([]); expect(stage).toHaveBeenCalledTimes(calls);
  electron.choose.mockResolvedValueOnce({ canceled: false, filePaths: [source, source] });
  await expect(invoke('attachmentChoose', { remaining: 1 })).rejects.toThrow('ATTACHMENT_COUNT_LIMIT'); expect(stage).toHaveBeenCalledTimes(calls);
  const failure = new Error('SYNTHETIC_PICKER_FAILURE'); electron.choose.mockRejectedValueOnce(failure);
  await expect(invoke('attachmentChoose')).rejects.toBe(failure);
});

it('passes absolute path arrays and records to staging unchanged and leaves service failures intact', async () => {
  const result: PendingMessageAttachment[] = [{ selectionId: 'pending-attachment-fixture', name: 'fixture', mediaType: 'text/plain', sizeBytes: 1 }];
  const stage = vi.spyOn(ConversationAttachmentStore.prototype, 'stage').mockResolvedValue(result);
  const paths = [source]; await expect(invoke('attachmentStageFiles', paths)).resolves.toBe(result); expect(stage.mock.calls[0][0]).toBe(paths);
  expect(stage).toHaveBeenLastCalledWith(paths, false);
  await invoke('attachmentStageFiles', { paths, allowLocalReferences: true }); expect(stage).toHaveBeenLastCalledWith(paths, true);
  await invoke('attachmentStageFiles', []); expect(stage).toHaveBeenLastCalledWith([], false);
  for (const value of [null, {}, 'bad', ['relative.md'], [1], { paths: [source, false] }]) await expect(invoke('attachmentStageFiles', value)).rejects.toThrow('ATTACHMENT_NOT_FILE');
  const failure = new Error('SYNTHETIC_STAGE_FAILURE'); stage.mockRejectedValueOnce(failure);
  await expect(invoke('attachmentStageFiles', paths)).rejects.toBe(failure);
});

it('reads only the first URI-list clipboard item, keeps file URL order and validates count before reading', async () => {
  const stage = vi.spyOn(ConversationAttachmentStore.prototype, 'stage').mockResolvedValue([]);
  for (const value of [undefined, null, '1', 0, 1.5, MAX_MESSAGE_ATTACHMENTS + 1]) await expect(invoke('attachmentPasteFiles', value)).rejects.toThrow('ATTACHMENT_COUNT_LIMIT');
  expect(electron.readClipboard).not.toHaveBeenCalled();
  await expect(invoke('attachmentPasteFiles', 1)).resolves.toEqual([]); expect(stage).not.toHaveBeenCalled();
  electron.readClipboard.mockResolvedValueOnce([{ types: ['text/uri-list'], getType: async () => 'not a Blob' }]);
  await expect(invoke('attachmentPasteFiles', 1)).resolves.toEqual([]);
  const urls = ' # comment\r\nhttps://example.test/ignored\r\n ' + pathToFileURL(source).href + ' \r\n' + pathToFileURL(source).href;
  const getType = vi.fn(async () => new Blob([urls]));
  electron.readClipboard.mockResolvedValue([{ types: ['text/plain'], getType: vi.fn() }, { types: ['text/uri-list'], getType },
    { types: ['text/uri-list'], getType: vi.fn(() => { throw new Error('WRONG_CLIPBOARD_ITEM'); }) }]);
  await invoke('attachmentPasteFiles', { remaining: 2, allowLocalReferences: true });
  expect(getType).toHaveBeenCalledExactlyOnceWith('text/uri-list'); expect(stage).toHaveBeenLastCalledWith([source, source], true);
  const calls = stage.mock.calls.length;
  await expect(invoke('attachmentPasteFiles', 1)).rejects.toThrow('ATTACHMENT_COUNT_LIMIT'); expect(stage).toHaveBeenCalledTimes(calls);
  electron.readClipboard.mockResolvedValueOnce([{ types: ['text/uri-list'], getType: async () => new Blob(['https://example.test/only']) }]);
  await expect(invoke('attachmentPasteFiles', 1)).resolves.toEqual([]); expect(stage).toHaveBeenCalledTimes(calls);
});

it('keeps Uint8Array identity for clipboard images and preserves image-service errors', async () => {
  const bytes = new Uint8Array([1, 2, 3]), result = { selectionId: 'pending-attachment-fixture' } as PendingMessageAttachment;
  const stage = vi.spyOn(ConversationAttachmentStore.prototype, 'stageClipboardImage').mockResolvedValue(result);
  for (const value of [undefined, [1], new ArrayBuffer(3)]) await expect(invoke('attachmentStageClipboardImage', value)).rejects.toThrow('ATTACHMENT_CLIPBOARD_IMAGE_INVALID');
  await expect(invoke('attachmentStageClipboardImage', bytes)).resolves.toBe(result); expect(stage.mock.calls[0][0]).toBe(bytes);
  const failure = new Error('SYNTHETIC_IMAGE_FAILURE'); stage.mockRejectedValueOnce(failure);
  await expect(invoke('attachmentStageClipboardImage', bytes)).rejects.toBe(failure);
});

it('passes discard and commit arrays without normalization, retains pending selections and returns the original service result', async () => {
  const discard = vi.spyOn(ConversationAttachmentStore.prototype, 'discard').mockResolvedValue(undefined);
  const commit = vi.spyOn(ConversationAttachmentStore.prototype, 'commit').mockResolvedValue([]);
  for (const value of [undefined, {}, [1]]) await expect(invoke('attachmentDiscard', value)).rejects.toThrow('INVALID_ATTACHMENT_SELECTIONS');
  const selections = ['', 'pending-attachment-fixture', 'pending-attachment-fixture'];
  await expect(invoke('attachmentDiscard', selections)).resolves.toBeUndefined(); expect(discard.mock.calls[0][0]).toBe(selections);
  for (const value of [null, {}, { conversationId, messageId: 1, selectionIds: [] }, { conversationId, messageId: '', selectionIds: [1] }])
    await expect(invoke('attachmentCommit', value)).rejects.toThrow('INVALID_ATTACHMENT_COMMIT');
  await invoke('attachmentCommit', { conversationId: '', messageId: '', selectionIds: selections }); expect(commit).toHaveBeenCalledExactlyOnceWith('', selections, '', true);
  const failure = new Error('SYNTHETIC_COMMIT_FAILURE'); commit.mockRejectedValueOnce(failure);
  await expect(invoke('attachmentCommit', { conversationId, messageId: '', selectionIds: [] })).rejects.toBe(failure);
  discard.mockRejectedValueOnce(failure); await expect(invoke('attachmentDiscard', [])).rejects.toBe(failure);
});

it('preserves context guards, including empty-string forwarding, and the list query guard', async () => {
  for (const key of ['attachmentInspect', 'attachmentRead', 'attachmentOpen', 'attachmentReveal', 'attachmentCopyPath', 'attachmentExportAs', 'attachmentSaveToProject'] as const)
    for (const value of [null, {}, { attachmentId: 1, conversationId }, { attachmentId: '', conversationId: 1 }])
      await expect(invoke(key, value)).rejects.toThrow('INVALID_ATTACHMENT_CONTEXT');
  await expect(invoke('attachmentList', 1)).rejects.toThrow('INVALID_CONVERSATION_ID');
  const list = vi.spyOn(ConversationAttachmentStore.prototype, 'list').mockResolvedValue([]); await invoke('attachmentList', ''); expect(list).toHaveBeenCalledExactlyOnceWith('');
  const inspect = vi.spyOn(ConversationAttachmentStore.prototype, 'inspect').mockResolvedValue(info);
  await expect(invoke('attachmentInspect', { attachmentId: '', conversationId: '' })).resolves.toBe(info); expect(inspect).toHaveBeenCalledExactlyOnceWith('', '');
});

it('returns exact UTF-8 or base64 data with the established preview-kind precedence after inspect then read', async () => {
  const calls: string[] = [], bytes = Buffer.from('合成\r\n');
  const inspect = vi.spyOn(ConversationAttachmentStore.prototype, 'inspect').mockImplementation(async () => { calls.push('inspect'); return info; });
  const read = vi.spyOn(ConversationAttachmentStore.prototype, 'read').mockImplementation(async () => { calls.push('read'); return bytes; });
  const cases = [
    ['fixture.png', 'image/png', 'image', false], ['fixture.docx', 'application/pdf', 'pdf', false],
    ['fixture.md', 'application/octet-stream', 'markdown', false], ['fixture.html', 'text/plain', 'html', true],
    ['fixture.htm', 'application/octet-stream', 'html', false], ['fixture.doc', 'application/msword', 'word', false],
    ['fixture.docx', 'text/plain', 'word', true], ['fixture.xlsx', 'application/octet-stream', 'sheet', false],
    ['fixture.xls', 'application/octet-stream', 'sheet', false], ['fixture.ppt', 'application/octet-stream', 'slides', false],
    ['fixture.pptx', 'application/octet-stream', 'slides', false], ['fixture.json', 'application/json', 'text', true],
    ['fixture.xml', 'application/xml', 'text', true], ['fixture.js', 'application/javascript', 'text', true],
    ['fixture.zip', 'application/octet-stream', 'unsupported', false],
  ] as const;
  for (const [name, mediaType, previewKind, text] of cases) {
    calls.length = 0; const metadata = { ...info, name, mediaType }; inspect.mockImplementation(async () => { calls.push('inspect'); return metadata; });
    await expect(invoke('attachmentRead', { attachmentId: info.id, conversationId })).resolves.toEqual({
      info: { ...metadata, previewKind }, ...(text ? { text: bytes.toString('utf8') } : { dataUrl: 'data:' + mediaType + ';base64,' + bytes.toString('base64') }),
    });
    expect(calls).toEqual(['inspect', 'read']); expect(read).toHaveBeenLastCalledWith(info.id, conversationId);
  }
  const failure = new Error('SYNTHETIC_INSPECT_FAILURE'); inspect.mockRejectedValueOnce(failure); const count = read.mock.calls.length;
  await expect(invoke('attachmentRead', { attachmentId: info.id, conversationId })).rejects.toBe(failure); expect(read).toHaveBeenCalledTimes(count);
  read.mockRejectedValueOnce(failure); await expect(invoke('attachmentRead', { attachmentId: info.id, conversationId })).rejects.toBe(failure);
});

it('opens the managed snapshot but reveals and copies the original source, and returns shell failures', async () => {
  const { context } = await attach(); const resolve = vi.spyOn(ConversationAttachmentStore.prototype, 'pathFor');
  await expect(invoke('attachmentOpen', context)).resolves.toBeUndefined();
  const snapshot = await resolve.mock.results[0].value; expect(snapshot).not.toBe(source); expect(await readFile(snapshot, 'utf8')).toBe(content);
  expect(electron.open).toHaveBeenLastCalledWith(snapshot);
  electron.open.mockResolvedValueOnce('SYNTHETIC_SHELL_FAILURE'); await expect(invoke('attachmentOpen', context)).rejects.toThrow('SYNTHETIC_SHELL_FAILURE');
  await expect(invoke('attachmentReveal', context)).resolves.toBeUndefined(); expect(electron.reveal).toHaveBeenCalledExactlyOnceWith(source);
  await expect(invoke('attachmentCopyPath', context)).resolves.toBeUndefined(); expect(electron.writeText).toHaveBeenCalledExactlyOnceWith(source);
});

it('leaves cancelled exports untouched and copies exact snapshot bytes only after confirmation', async () => {
  const { context } = await attach(), destination = path.join(root, 'fixture-export.md');
  electron.save.mockResolvedValueOnce({ canceled: true, filePath: destination }).mockResolvedValueOnce({ canceled: false }).mockResolvedValueOnce({ canceled: false, filePath: destination });
  await expect(invoke('attachmentExportAs', context)).resolves.toBe(false); await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(invoke('attachmentExportAs', context)).resolves.toBe(false); expect(electron.save).toHaveBeenLastCalledWith(window, { defaultPath: 'fixture.md' });
  await writeFile(source, '合成源文件的新内容');
  await expect(invoke('attachmentExportAs', context)).resolves.toBe(true); expect(await readFile(destination, 'utf8')).toBe(content);
  electron.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(root, 'missing', 'fixture.md') });
  await expect(invoke('attachmentExportAs', context)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('validates project IDs before inspection, registers the snapshot and delivers it as user without changing call order', async () => {
  const { context } = await attach(), calls: string[] = [], receipt = { fixture: 'delivered' } as never;
  const inspect = vi.spyOn(ConversationAttachmentStore.prototype, 'inspect');
  for (const projectId of [undefined, '', ' ', 1]) await expect(invoke('attachmentSaveToProject', { ...context, projectId })).rejects.toThrow('INVALID_PROJECT_ARTIFACT_REQUEST');
  for (const projectId of ['../bad', '_bad', 'x'.repeat(129)]) await expect(invoke('attachmentSaveToProject', { ...context, projectId })).rejects.toThrow('ARTIFACT_PROJECT_ID_REJECTED');
  expect(inspect).not.toHaveBeenCalled();
  const metadata = await invoke<ConversationAttachmentInfo>('attachmentInspect', context);
  inspect.mockImplementation(async () => { calls.push('inspect'); return metadata; });
  const pathFor = ConversationAttachmentStore.prototype.pathFor;
  const resolve = vi.spyOn(ConversationAttachmentStore.prototype, 'pathFor').mockImplementation(async function (this: ConversationAttachmentStore, ...args) {
    calls.push('path'); return pathFor.apply(this, args);
  });
  const register = vi.spyOn(ArtifactRegistry.prototype, 'register'), deliver = vi.spyOn(ProjectFileDeliveryCoordinator.prototype, 'deliver');
  register.mockImplementation(async () => { calls.push('register'); return { id: 'fixture-registered' } as never; });
  deliver.mockImplementation(async () => { calls.push('deliver'); return receipt; });
  await expect(invoke('attachmentSaveToProject', { ...context, projectId: ' fixture-project ' })).resolves.toBe(receipt);
  expect(calls).toEqual(['inspect', 'path', 'inspect', 'register', 'deliver']);
  expect(register).toHaveBeenCalledExactlyOnceWith({ kind: 'local_path', path: await resolve.mock.results[0].value },
    { method: 'manual', conversationId, name: metadata.name, mediaType: metadata.mediaType });
  expect(deliver).toHaveBeenCalledExactlyOnceWith({ artifactId: 'fixture-registered', projectId: 'fixture-project', source: 'user' });
  const failure = new Error('SYNTHETIC_REGISTER_FAILURE'); register.mockRejectedValueOnce(failure);
  await expect(invoke('attachmentSaveToProject', { ...context, projectId: 'fixture-project' })).rejects.toBe(failure); expect(deliver).toHaveBeenCalledTimes(1);
});

it('resolves pending and committed thumbnails through the store and keeps missing-context and decoder results', async () => {
  const { pending, attachment, context } = await attach(), pendingPath = vi.spyOn(ConversationAttachmentStore.prototype, 'pendingPath'),
    committedPath = vi.spyOn(ConversationAttachmentStore.prototype, 'pathFor');
  for (const value of [null, {}, { id: 1 }]) await expect(invoke('attachmentThumbnail', value)).rejects.toThrow('INVALID_ATTACHMENT_REFERENCE');
  await expect(invoke('attachmentThumbnail', { id: attachment.id })).rejects.toThrow('ATTACHMENT_CONVERSATION_REQUIRED');
  await expect(invoke('attachmentThumbnail', { id: pending.selectionId })).resolves.toBe('data:image/png;base64,Zml4dHVyZQ==');
  expect(electron.thumbnail).toHaveBeenLastCalledWith(await pendingPath.mock.results[0].value);
  electron.thumbnail.mockResolvedValueOnce(''); await expect(invoke('attachmentThumbnail', { id: attachment.id, conversationId })).resolves.toBe('');
  expect(electron.thumbnail).toHaveBeenLastCalledWith(await committedPath.mock.results[0].value);
  const failure = new Error('SYNTHETIC_THUMBNAIL_FAILURE'); electron.thumbnail.mockRejectedValueOnce(failure);
  await expect(invoke('attachmentThumbnail', { id: context.attachmentId, conversationId })).rejects.toBe(failure);
});

it('removes only one attachment conversation and calls delegation cleanup after store success, preserving failures', async () => {
  const first = await attach(), second = await attach(source, 'fixture-other-chat');
  const remove = vi.spyOn(PartnerDelegation.prototype, 'remove');
  for (const value of [undefined, '', 1]) await expect(invoke('attachmentDeleteConversation', value)).rejects.toThrow('INVALID_CONVERSATION_ID');
  await expect(invoke('attachmentDeleteConversation', conversationId)).resolves.toBeUndefined(); expect(remove).toHaveBeenCalledExactlyOnceWith(conversationId);
  await expect(invoke('attachmentList', conversationId)).resolves.toEqual([]);
  await expect(invoke('attachmentInspect', second.context)).resolves.toMatchObject({ id: second.attachment.id });
  expect(await readFile(source, 'utf8')).toBe(content);
  const store = vi.spyOn(ConversationAttachmentStore.prototype, 'deleteConversation'), failure = new Error('SYNTHETIC_DELETE_FAILURE');
  store.mockRejectedValueOnce(failure); await expect(invoke('attachmentDeleteConversation', 'fixture-other-chat')).rejects.toBe(failure); expect(remove).toHaveBeenCalledTimes(1);
  remove.mockRejectedValueOnce(failure); await expect(invoke('attachmentDeleteConversation', 'fixture-other-chat')).rejects.toBe(failure);
  expect(first.attachment.id).not.toBe(second.attachment.id);
});

it('previews and clears only the confirmed snapshot plan, preserving source files, attachment IDs and distinct versions', async () => {
  const first = await attach(), second = await attach(source, 'fixture-other-chat');
  await writeFile(source, '合成第二版本');
  const latest = await attach(source, conversationId, 'fixture-message-two');
  const before = await invoke<MessageAttachment[]>('attachmentList', conversationId);
  const plan = await invoke<SnapshotCleanupPreview>('attachmentPreviewSnapshotCleanup');
  expect(plan).toMatchObject({ count: 1, bytes: Buffer.byteLength(content), skippedCount: 0 });
  expect(await invoke('attachmentList', conversationId)).toEqual(before);
  for (const value of [undefined, 1, '', 'x'.repeat(35)]) await expect(invoke('attachmentClearSnapshots', value)).rejects.toThrow('SNAPSHOT_PLAN_EXPIRED');
  await expect(invoke('attachmentClearSnapshots', 'x'.repeat(36))).rejects.toThrow('SNAPSHOT_PLAN_EXPIRED');
  await expect(invoke<SnapshotCleanupResult>('attachmentClearSnapshots', plan.planId)).resolves.toEqual({ clearedCount: 1, freedBytes: Buffer.byteLength(content), skippedCount: 0 });
  expect(await invoke('attachmentList', conversationId)).toEqual(before);
  for (const context of [first.context, second.context]) await expect(invoke('attachmentRead', context)).resolves.toMatchObject({ text: content });
  await expect(invoke('attachmentRead', latest.context)).resolves.toMatchObject({ text: '合成第二版本' });
  expect(await readFile(source, 'utf8')).toBe('合成第二版本');
  await expect(invoke('attachmentClearSnapshots', plan.planId)).rejects.toThrow('SNAPSHOT_PLAN_EXPIRED');
});

it('awaits report cancellation between attachment removal and delegation removal, propagating failures', async () => {
  const calls: string[] = [], local = new Map<string, Handler>();
  const remove = vi.fn(async () => { calls.push('attachments'); });
  const cancelDelegation = vi.fn<(id: string) => Promise<boolean>>(async () => { calls.push('cancel'); return true; });
  const delegation = { remove: vi.fn(async () => { calls.push('delegation'); }) };
  registerAttachmentMaintenanceIpc({ handle: (channel: string, handler: Handler) => { expect(local.has(channel)).toBe(false); local.set(channel, handler); } } as unknown as IpcMain,
    { messageAttachments: { deleteConversation: remove, previewSnapshotCleanup: vi.fn(), clearSnapshots: vi.fn() }, cancelDelegation, delegation }, () => window);
  let finishCancel!: () => void;
  cancelDelegation.mockImplementationOnce(async () => { calls.push('cancel'); await new Promise<void>(resolve => { finishCancel = resolve; }); return true; });
  const deletion = local.get(DESKTOP_IPC.attachmentDeleteConversation)!({ sender }, conversationId);
  await vi.waitFor(() => expect(cancelDelegation).toHaveBeenCalledExactlyOnceWith(conversationId));
  expect(delegation.remove).not.toHaveBeenCalled(); finishCancel(); await deletion;
  expect(calls).toEqual(['attachments', 'cancel', 'delegation']);
  const failure = new Error('SYNTHETIC_REMOVAL_FAILURE'); remove.mockRejectedValueOnce(failure);
  await expect(local.get(DESKTOP_IPC.attachmentDeleteConversation)!({ sender }, 'fixture-other-chat')).rejects.toBe(failure);
  expect(cancelDelegation).toHaveBeenCalledTimes(1); expect(delegation.remove).toHaveBeenCalledTimes(1);
  cancelDelegation.mockRejectedValueOnce(failure);
  await expect(local.get(DESKTOP_IPC.attachmentDeleteConversation)!({ sender }, 'fixture-other-chat')).rejects.toBe(failure);
  expect(delegation.remove).toHaveBeenCalledTimes(1);
  delegation.remove.mockRejectedValueOnce(failure);
  await expect(local.get(DESKTOP_IPC.attachmentDeleteConversation)!({ sender }, 'fixture-other-chat')).rejects.toBe(failure);
  expect(cancelDelegation).toHaveBeenLastCalledWith('fixture-other-chat');
});
