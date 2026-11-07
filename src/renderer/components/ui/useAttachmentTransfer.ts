import { useState, type ClipboardEvent, type DragEvent } from 'react';
import type { PendingMessageAttachment } from '../../../shared/agentProtocol';

type AddAttachments = (load: (remaining: number) => Promise<PendingMessageAttachment[]>, fallbackError: string) => unknown;

export function useAttachmentTransfer(enabled: boolean, addAttachments: AddAttachments, maxImageBytes: number, showError: (message: string) => void, allowLocalReferences?: true) {
  const referenceOption: [true?] = allowLocalReferences ? [true] : [];
  const [draggingFiles, setDraggingFiles] = useState(false);
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!enabled) return;
    const api = window.asteriumAttachments;
    if (!api) return;
    const files = Array.from(event.clipboardData.files ?? []);
    const trustedPaste = event.nativeEvent.isTrusted;
    if (files.length) {
      const screenshot = files.length === 1 && files[0].type === 'image/png' ? files[0] : undefined;
      if (!api.stageFiles && !(screenshot && api.stageClipboardImage)) return;
      event.preventDefault();
      if (screenshot && screenshot.size > maxImageBytes) {
        showError(`截图大小不能超过 ${maxImageBytes / (1024 * 1024)} MiB。`);
        return;
      }
      void addAttachments(async (remaining) => {
        if (api.stageFiles) {
          try {
            return await api.stageFiles(files, remaining, ...referenceOption);
          } catch (error) {
            if (trustedPaste && api.pasteFiles && String(error).includes('ATTACHMENT_NOT_FILE')) {
              const staged = await api.pasteFiles(remaining, ...referenceOption);
              if (staged.length) return staged;
            }
            throw error;
          }
        }
        return [await api.stageClipboardImage!(new Uint8Array(await screenshot!.arrayBuffer()))];
      }, '未能粘贴附件，请重试。');
      return;
    }
    // Explorer can expose its file list only to Electron's main clipboard API.
    // A normal text or HTML paste stays with the textarea.
    const types = Array.from(event.clipboardData.types ?? []);
    if (api.pasteFiles && trustedPaste && (!types.length || types.includes('Files'))) {
      event.preventDefault();
      void addAttachments((remaining) => api.pasteFiles!(remaining, ...referenceOption), '未能粘贴附件，请重试。');
    }
  };
  const onDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    const available = enabled && Boolean(window.asteriumAttachments?.stageFiles);
    event.dataTransfer.dropEffect = available ? 'copy' : 'none';
    setDraggingFiles(available);
  };
  const onDragLeave = (event: DragEvent<HTMLFormElement>) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDraggingFiles(false);
  };
  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    const files = Array.from(event.dataTransfer.files);
    setDraggingFiles(false);
    if (!files.length) return;
    event.preventDefault();
    const stage = window.asteriumAttachments?.stageFiles;
    if (enabled && stage) void addAttachments((remaining) => stage(files, remaining, ...referenceOption), '未能添加拖入的附件，请重试。');
  };
  return { draggingFiles: enabled && draggingFiles, onPaste, onDragOver, onDragLeave, onDrop };
}
