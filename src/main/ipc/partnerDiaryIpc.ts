import { writeFile } from 'node:fs/promises';
import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { diaryTarget } from '../../shared/partnerDiary';
import type { SingleChatMessageStore } from '../conversation/SingleChatMessageStore';
import type { PartnerDiaryCatalog } from '../diary/PartnerDiaryCatalog';
import type { PartnerDiaryScheduler } from '../diary/PartnerDiaryScheduler';
import type { PartnerDiaryService } from '../diary/PartnerDiaryService';
import type { PartnerDiarySettingsStore } from '../diary/PartnerDiarySettingsStore';

interface PartnerDiaryIpcDependencies {
  diaries: Pick<PartnerDiaryService, 'list' | 'store'>;
  diarySettings: Pick<PartnerDiarySettingsStore, 'list' | 'configure'>;
  diaryCatalog: Pick<PartnerDiaryCatalog, 'identity'>;
  diaryScheduler: Pick<PartnerDiaryScheduler, 'changed'>;
  singleChatMessages: Pick<SingleChatMessageStore, 'getConversation'>;
}

export function registerPartnerDiaryIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { diaries, diarySettings, diaryCatalog, diaryScheduler, singleChatMessages }: PartnerDiaryIpcDependencies,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.diaryGet, async (event) => {
    requireSender(event);
    const configs = await diarySettings.list(); const notices: Record<string, string> = {};
    for (const config of configs) {
      const source = await singleChatMessages.getConversation(config.conversationId); const owner = diaryCatalog.identity(config.partnerId);
      if (!owner?.available) notices[config.partnerId] = '伙伴已移除或运行时不可用，日记不会自动执行。';
      else if (!source || config.disabledReason === 'source_deleted') notices[config.partnerId] = '来源会话已永久删除，日记已停用，请重新选择来源后保存。';
      else if (config.upstreamThreadId && (owner.threadId !== config.upstreamThreadId || source.sessionId !== config.upstreamThreadId)) notices[config.partnerId] = '上游线程已变化，日记将跳过，请重新选择来源并确认后保存。';
    }
    return { configs, entries: await diaries.list(), notices };
  });
  ipcMain.handle(AGENT_IPC.diaryConfigure, async (event, value: unknown) => {
    requireSender(event); const config = await diarySettings.configure(value); await diaryScheduler.changed(); return config;
  });

  ipcMain.handle(AGENT_IPC.diaryRead, async (event, value: unknown) => {
    requireSender(event); const target = diaryTarget.parse(value); return (await diaries.store(target.partnerId)).read(target.date);
  });
  ipcMain.handle(AGENT_IPC.diaryExport, async (event, value: unknown) => {
    const window = requireSender(event); const target = diaryTarget.parse(value);
    const document = await (await diaries.store(target.partnerId)).read(target.date);
    if (document?.entry.state !== 'completed' || document.content === undefined) throw new Error('DIARY_NOT_COMPLETED');
    const result = await dialog.showSaveDialog(window, { title: '导出伙伴日记', defaultPath: `${target.date}-伙伴日记.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, document.content, 'utf8'); return true;
  });
}
