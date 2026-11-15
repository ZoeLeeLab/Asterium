import { writeFile } from 'node:fs/promises';
import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { diaryTarget } from '../../shared/partnerDiary';
import type { PartnerDiaryService } from '../diary/PartnerDiaryService';

export function registerPartnerDiaryIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  diaries: Pick<PartnerDiaryService, 'store'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
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
