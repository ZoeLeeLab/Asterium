import { writeFile } from 'node:fs/promises';
import { BrowserWindow, dialog, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { StudioRoomStore } from '../studio/StudioRoomStore';

export function registerStudioRoomIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  studioRooms: Pick<StudioRoomStore, 'getRoom' | 'setMuted' | 'setSettings'>,
  archivedMarkdownFileName: (name: string, suffix: string) => string,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.studioGetRoom, async (event, roomId: unknown) => {
    requireSender(event);
    if (typeof roomId !== 'string' || !roomId) throw new Error('INVALID_STUDIO_ROOM_ID');
    return studioRooms.getRoom(roomId);
  });

  ipcMain.handle(AGENT_IPC.studioExportMarkdown, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roomId !== 'string' || !value.roomId.trim()
      || typeof value.content !== 'string' || Buffer.byteLength(value.content, 'utf8') > 10_000_000) {
      throw new Error('INVALID_STUDIO_MARKDOWN_EXPORT');
    }
    const room = await studioRooms.getRoom(value.roomId);
    if (!room) throw new Error('STUDIO_ROOM_NOT_FOUND');
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('STUDIO_EXPORT_WINDOW_UNAVAILABLE');
    const result = await dialog.showSaveDialog(window, {
      title: '导出群聊记录',
      defaultPath: archivedMarkdownFileName(room.metadata.name, '群聊记录'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, value.content, 'utf8');
    return true;
  });

  ipcMain.handle(AGENT_IPC.studioSetMuted, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roomId !== 'string' || !Array.isArray(value.partnerIds) || !value.partnerIds.every((id) => typeof id === 'string')) throw new Error('INVALID_STUDIO_MUTE_REQUEST');
    return studioRooms.setMuted(value.roomId, value.partnerIds);
  });

  ipcMain.handle(AGENT_IPC.studioSetSettings, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roomId !== 'string' || !isRecord(value.settings)
      || !['free_discussion', 'selected_partners', 'round_robin'].includes(String(value.settings.speakingMode))
      || !Array.isArray(value.settings.selectedPartnerIds) || !value.settings.selectedPartnerIds.every((id) => typeof id === 'string')
      || typeof value.settings.discussionProtectionEnabled !== 'boolean') throw new Error('INVALID_STUDIO_SETTINGS_REQUEST');
    return studioRooms.setSettings(value.roomId, {
      speakingMode: value.settings.speakingMode as 'free_discussion' | 'selected_partners' | 'round_robin',
      selectedPartnerIds: value.settings.selectedPartnerIds as string[],
      discussionProtectionEnabled: value.settings.discussionProtectionEnabled,
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
