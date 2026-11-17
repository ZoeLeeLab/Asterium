import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { ResolveUserInputCommand, SendGuidanceCommand, SendGuidanceResult } from '../../shared/agentProtocol';
import { assertAgentCommand } from '../../shared/agentProtocolValidation';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { RunCoordinator } from '../runtime/RunCoordinator';

export function registerRunGuidanceIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  runCoordinator: Pick<RunCoordinator, 'sendGuidance'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.sendGuidance, async (event, value: unknown): Promise<SendGuidanceResult> => {
    requireSender(event);
    assertAgentCommand(value);
    if (value.type !== 'guidance.send') throw new Error('INVALID_GUIDANCE_COMMAND');
    return runCoordinator.sendGuidance(value as SendGuidanceCommand);
  });
}

export function registerRunUserInputIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  runCoordinator: Pick<RunCoordinator, 'resolveUserInput'>,
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.resolveUserInput, async (event, value: unknown) => {
    requireSender(event);
    assertAgentCommand(value);
    if (value.type !== 'user_input.resolve') throw new Error('INVALID_USER_INPUT_COMMAND');
    await runCoordinator.resolveUserInput(value as ResolveUserInputCommand);
  });
}
