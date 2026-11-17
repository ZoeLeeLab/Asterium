import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { automationConfirmationReplySchema } from '../../shared/automations';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { AutomationConfirmations } from '../automation/AutomationConfirmations';
import type { AutomationService } from '../automation/AutomationService';

export function registerAutomationIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  automationService: Pick<AutomationService, 'get' | 'mutate'>,
  automationConfirmations: Pick<AutomationConfirmations, 'list' | 'resolve'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.automationsGet, async event => { requireSender(event); return automationService.get(); });
  ipcMain.handle(AGENT_IPC.automationsConfirmationsGet, async event => { requireSender(event); return automationConfirmations.list(); });
  ipcMain.handle(AGENT_IPC.automationsConfirmationsResolve, async (event, request: unknown) => { requireSender(event); const reply = automationConfirmationReplySchema.parse(request); automationConfirmations.resolve(reply.id, reply.approved); });
  ipcMain.handle(AGENT_IPC.automationsMutate, async (event, request: unknown) => { requireSender(event); return automationService.mutate(request); });
}
