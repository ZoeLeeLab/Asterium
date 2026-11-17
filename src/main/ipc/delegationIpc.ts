import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { PartnerDelegation } from '../runtime/PartnerDelegation';

export function registerDelegationIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  delegation: Pick<PartnerDelegation, 'list' | 'resumeReviews' | 'interruptWait' | 'control'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.delegationList, async (event, conversationId: unknown) => {
    requireSender(event);
    if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 200) throw new Error('DELEGATION_SOURCE_INVALID');
    const batches = await delegation.list(conversationId);
    if (batches.some(batch => batch.tasks.some(task => task.status === 'uncertain'))) {
      void delegation.resumeReviews(conversationId).catch(() => console.error('Delegation review lookup could not be scheduled.'));
    }
    return batches;
  });
  ipcMain.handle(AGENT_IPC.delegationInterruptWait, (event, conversationId: unknown) => {
    requireSender(event);
    return typeof conversationId === 'string' && delegation.interruptWait(conversationId);
  });
  ipcMain.handle(AGENT_IPC.delegationControl, (event, conversationId: unknown, taskId: unknown, action: unknown) => {
    requireSender(event);
    if (typeof conversationId !== 'string' || typeof taskId !== 'string' || (action !== 'cancel' && action !== 'retry')) throw new Error('DELEGATION_CONTROL_INVALID');
    return delegation.control(conversationId, taskId, action);
  });
}
