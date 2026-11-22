import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipboard, dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { CYBERBOSS_CHAT_IMAGE_EXTENSIONS } from '../../shared/cyberBossChatAttachments';
import { MAX_MESSAGE_ATTACHMENTS, type ConversationAttachmentStore } from '../security/ConversationAttachmentStore';
import type { ArtifactRegistry } from '../security/ArtifactRegistry';
import { createAttachmentThumbnail } from '../security/attachmentThumbnail';
import type { ProjectFileDeliveryCoordinator } from '../project/ProjectFileDeliveryCoordinator';
import type { PartnerDelegation } from '../runtime/PartnerDelegation';

export function registerAttachmentSelectionIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  messageAttachments: Pick<ConversationAttachmentStore, 'stage' | 'stageClipboardImage' | 'discard' | 'commit'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.attachmentChoose, async (event, value: unknown) => {
    const window = requireSender(event);
    const remaining = isRecord(value) && Number.isSafeInteger(value.remaining) ? Number(value.remaining) : MAX_MESSAGE_ATTACHMENTS;
    if (remaining < 1 || remaining > MAX_MESSAGE_ATTACHMENTS) throw new Error('ATTACHMENT_COUNT_LIMIT');
    const imagesOnly = isRecord(value) && value.filter === 'cyberboss_images';
    const result = await dialog.showOpenDialog(window, {
      title: imagesOnly ? '选择图片' : '选择图片或文件',
      buttonLabel: '添加', properties: ['openFile', 'multiSelections'],
      ...(imagesOnly ? { filters: [{ name: '图片', extensions: CYBERBOSS_CHAT_IMAGE_EXTENSIONS }] } : {}),
    });
    if (result.canceled) return [];
    if (result.filePaths.length > remaining) throw new Error('ATTACHMENT_COUNT_LIMIT');
    return messageAttachments.stage(result.filePaths, isRecord(value) && value.allowLocalReferences === true);
  });
  ipcMain.handle(AGENT_IPC.attachmentStageFiles, async (event, value: unknown) => {
    requireSender(event);
    const files = isRecord(value) ? value.paths : value;
    if (!Array.isArray(files) || !files.every((file) => typeof file === 'string' && path.isAbsolute(file))) throw new Error('ATTACHMENT_NOT_FILE');
    return messageAttachments.stage(files, isRecord(value) && value.allowLocalReferences === true);
  });
  ipcMain.handle(AGENT_IPC.attachmentPasteFiles, async (event, value: unknown) => {
    requireSender(event);
    const remaining = isRecord(value) ? value.remaining : value;
    if (typeof remaining !== 'number' || !Number.isSafeInteger(remaining) || remaining < 1 || remaining > MAX_MESSAGE_ATTACHMENTS) throw new Error('ATTACHMENT_COUNT_LIMIT');
    const mimeType = 'text/uri-list';
    const item = (await clipboard.read()).find((entry) => entry.types.includes(mimeType));
    const payload = await item?.getType(mimeType);
    if (!(payload instanceof Blob)) return [];
    const urls = (await payload.text()).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('file://'));
    if (urls.length > remaining) throw new Error('ATTACHMENT_COUNT_LIMIT');
    return urls.length ? messageAttachments.stage(urls.map((url) => fileURLToPath(url)), isRecord(value) && value.allowLocalReferences === true) : [];
  });
  ipcMain.handle(AGENT_IPC.attachmentStageClipboardImage, async (event, value: unknown) => {
    requireSender(event);
    if (!(value instanceof Uint8Array)) throw new Error('ATTACHMENT_CLIPBOARD_IMAGE_INVALID');
    return messageAttachments.stageClipboardImage(value);
  });
  ipcMain.handle(AGENT_IPC.attachmentDiscard, async (event, value: unknown) => {
    requireSender(event);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('INVALID_ATTACHMENT_SELECTIONS');
    await messageAttachments.discard(value);
  });
  ipcMain.handle(AGENT_IPC.attachmentCommit, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.conversationId !== 'string' || typeof value.messageId !== 'string' || !Array.isArray(value.selectionIds)
      || value.selectionIds.some((item) => typeof item !== 'string')) throw new Error('INVALID_ATTACHMENT_COMMIT');
    return messageAttachments.commit(value.conversationId, value.selectionIds as string[], value.messageId, true);
  });
}

export function registerAttachmentAccessIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { messageAttachments, artifacts, saveArtifactToProject }: {
    messageAttachments: Pick<ConversationAttachmentStore, 'list' | 'inspect' | 'read' | 'pathFor' | 'sourcePathFor' | 'pendingPath'>;
    artifacts: Pick<ArtifactRegistry, 'register'>;
    saveArtifactToProject: (artifactId: string, projectId: string, source: 'user') => ReturnType<ProjectFileDeliveryCoordinator['deliver']>;
  },
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.attachmentList, async (event, conversationId: unknown) => {
    requireSender(event);
    if (typeof conversationId !== 'string') throw new Error('INVALID_CONVERSATION_ID');
    return messageAttachments.list(conversationId);
  });
  ipcMain.handle(AGENT_IPC.attachmentInspect, async (event, value: unknown) => {
    requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    return messageAttachments.inspect(attachmentId, conversationId);
  });
  ipcMain.handle(AGENT_IPC.attachmentRead, async (event, value: unknown) => {
    requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    const info = await messageAttachments.inspect(attachmentId, conversationId);
    const buffer = await messageAttachments.read(attachmentId, conversationId);
    const publicInfo = { ...info, previewKind: attachmentPreviewKind(info.name, info.mediaType) };
    if (isTextMime(info.mediaType)) return { info: publicInfo, text: buffer.toString('utf8') };
    return { info: publicInfo, dataUrl: `data:${info.mediaType};base64,${buffer.toString('base64')}` };
  });
  ipcMain.handle(AGENT_IPC.attachmentOpen, async (event, value: unknown) => {
    requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    const error = await shell.openPath(await messageAttachments.pathFor(attachmentId, conversationId));
    if (error) throw new Error(error);
  });
  ipcMain.handle(AGENT_IPC.attachmentReveal, async (event, value: unknown) => {
    requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    shell.showItemInFolder(await messageAttachments.sourcePathFor(attachmentId, conversationId));
  });
  ipcMain.handle(AGENT_IPC.attachmentCopyPath, async (event, value: unknown) => {
    requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    clipboard.writeText(await messageAttachments.sourcePathFor(attachmentId, conversationId));
  });
  ipcMain.handle(AGENT_IPC.attachmentExportAs, async (event, value: unknown) => {
    const window = requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    const info = await messageAttachments.inspect(attachmentId, conversationId);
    const result = await dialog.showSaveDialog(window, { defaultPath: info.name });
    if (result.canceled || !result.filePath) return false;
    await copyFile(await messageAttachments.pathFor(attachmentId, conversationId), result.filePath);
    return true;
  });
  ipcMain.handle(AGENT_IPC.attachmentSaveToProject, async (event, value: unknown) => {
    requireSender(event);
    const { attachmentId, conversationId } = assertAttachmentContext(value);
    if (!isRecord(value) || typeof value.projectId !== 'string' || !value.projectId.trim()) throw new Error('INVALID_PROJECT_ARTIFACT_REQUEST');
    const projectId = value.projectId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) throw new Error('ARTIFACT_PROJECT_ID_REJECTED');
    const info = await messageAttachments.inspect(attachmentId, conversationId);
    const registered = await artifacts.register(
      { kind: 'local_path', path: await messageAttachments.pathFor(attachmentId, conversationId) },
      { method: 'manual', conversationId, name: info.name, mediaType: info.mediaType },
    );
    return saveArtifactToProject(registered.id, projectId, 'user');
  });
  ipcMain.handle(AGENT_IPC.attachmentThumbnail, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.id !== 'string') throw new Error('INVALID_ATTACHMENT_REFERENCE');
    const sourcePath = value.id.startsWith('pending-attachment-')
      ? await messageAttachments.pendingPath(value.id)
      : typeof value.conversationId === 'string' ? await messageAttachments.pathFor(value.id, value.conversationId) : undefined;
    if (!sourcePath) throw new Error('ATTACHMENT_CONVERSATION_REQUIRED');
    return createAttachmentThumbnail(sourcePath);
  });
}

export function registerAttachmentMaintenanceIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { messageAttachments, summaryRuns, delegation }: {
    messageAttachments: Pick<ConversationAttachmentStore, 'deleteConversation' | 'previewSnapshotCleanup' | 'clearSnapshots'>;
    summaryRuns: Pick<ReadonlyMap<string, AbortController>, 'get'>;
    delegation: Pick<PartnerDelegation, 'remove'>;
  },
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.attachmentDeleteConversation, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string' || !value) throw new Error('INVALID_CONVERSATION_ID');
    await messageAttachments.deleteConversation(value);
    summaryRuns.get(value)?.abort();
    await delegation.remove(value);
  });
  ipcMain.handle(AGENT_IPC.attachmentPreviewSnapshotCleanup, async (event) => {
    requireSender(event);
    return messageAttachments.previewSnapshotCleanup();
  });
  ipcMain.handle(AGENT_IPC.attachmentClearSnapshots, async (event, value: unknown) => {
    requireSender(event);
    if (typeof value !== 'string' || value.length !== 36) throw new Error('SNAPSHOT_PLAN_EXPIRED');
    return messageAttachments.clearSnapshots(value);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAttachmentContext(value: unknown) {
  if (!isRecord(value) || typeof value.attachmentId !== 'string' || typeof value.conversationId !== 'string') throw new Error('INVALID_ATTACHMENT_CONTEXT');
  return { attachmentId: value.attachmentId, conversationId: value.conversationId };
}

function isTextMime(mediaType: string) {
  return mediaType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mediaType);
}

function attachmentPreviewKind(name: string, mediaType: string) {
  const extension = path.extname(name).toLocaleLowerCase();
  if (mediaType.startsWith('image/')) return 'image' as const;
  if (mediaType === 'application/pdf') return 'pdf' as const;
  if (extension === '.md' || mediaType === 'text/markdown') return 'markdown' as const;
  if (extension === '.html' || extension === '.htm' || mediaType === 'text/html') return 'html' as const;
  if (['.doc', '.docx'].includes(extension)) return 'word' as const;
  if (['.xls', '.xlsx'].includes(extension)) return 'sheet' as const;
  if (['.ppt', '.pptx'].includes(extension)) return 'slides' as const;
  if (isTextMime(mediaType)) return 'text' as const;
  return 'unsupported' as const;
}
