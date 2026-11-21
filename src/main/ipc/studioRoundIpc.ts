import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import type { StudioRoomMetadata, StudioStartRoundRequest, StudioPrepareTurnRequest, StudioPreparedTurn } from '../../shared/studioRuntime';
import type { StudioOrchestrator } from '../studio/StudioOrchestrator';
import type { StudioRoomStore } from '../studio/StudioRoomStore';
import type { ContextHandoffService } from '../runtime/ContextHandoffService';

interface StudioOrchestration {
  orchestrator?: Pick<StudioOrchestrator, 'startRound' | 'cancelRound'>;
}

export function registerStudioRoundCancellationIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { studioOrchestration, studioRooms }: { studioOrchestration: StudioOrchestration; studioRooms: Pick<StudioRoomStore, 'cancelRound'> },
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(AGENT_IPC.studioCancelRound, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roomId !== 'string' || !value.roomId) throw new Error('INVALID_STUDIO_CANCEL_REQUEST');
    return studioOrchestration.orchestrator ? studioOrchestration.orchestrator.cancelRound(value.roomId) : studioRooms.cancelRound(value.roomId);
  });
}

export function registerStudioRoundIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  { studioOrchestration, contextHandoff, prepareStudioTurn, studioRooms, isStudioRoomMetadata }: {
    studioOrchestration: StudioOrchestration;
    contextHandoff: Pick<ContextHandoffService, 'validate'>;
    prepareStudioTurn: (value: StudioPrepareTurnRequest) => Promise<StudioPreparedTurn>;
    studioRooms: Pick<StudioRoomStore, 'failPreparedTurn'>;
    isStudioRoomMetadata(value: unknown): value is StudioRoomMetadata;
  },
  requireSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  function isStudioStartRoundRequest(value: unknown): value is StudioStartRoundRequest {
    return isRecord(value) && isStudioRoomMetadata(value.room)
      && typeof value.messageId === 'string' && Boolean(value.messageId)
      && typeof value.content === 'string' && (Boolean(value.content.trim()) || (Array.isArray(value.attachmentSelectionIds) && value.attachmentSelectionIds.length > 0))
      && value.attachments === undefined
      && (value.attachmentSelectionIds === undefined || (Array.isArray(value.attachmentSelectionIds) && value.attachmentSelectionIds.length <= 10
        && new Set(value.attachmentSelectionIds).size === value.attachmentSelectionIds.length
        && value.attachmentSelectionIds.every(id => typeof id === 'string' && /^pending-attachment-[A-Za-z0-9-]+$/.test(id))))
      && typeof value.authorId === 'string' && Boolean(value.authorId)
      && Array.isArray(value.speakerQueue) && value.speakerQueue.length > 0
      && value.speakerQueue.every((id) => typeof id === 'string' && Boolean(id))
      && (value.mentions === undefined || (Array.isArray(value.mentions) && value.mentions.every((mention) => isRecord(mention)
        && typeof mention.partnerId === 'string' && Boolean(mention.partnerId)
        && typeof mention.label === 'string' && Boolean(mention.label.trim())
        && mention.source === 'user'
        && (mention.start === undefined || Number.isSafeInteger(mention.start))
        && (mention.end === undefined || Number.isSafeInteger(mention.end)))));
  }

  ipcMain.handle(AGENT_IPC.studioStartRound, async (event, value: unknown) => {
    requireSender(event);
    if (!isStudioStartRoundRequest(value)) throw new Error('INVALID_STUDIO_ROUND_REQUEST');
    if (!studioOrchestration.orchestrator) throw new Error('STUDIO_ORCHESTRATOR_NOT_READY');
    const draft = value.contextHandoff === undefined ? undefined
      : await contextHandoff.validate(value.contextHandoff, { kind: 'group', id: value.room.roomId });
    return studioOrchestration.orchestrator.startRound(value, draft);
  });

  ipcMain.handle(AGENT_IPC.studioPrepareTurn, async (event, value: unknown) => {
    requireSender(event);
    if (!isStudioPrepareTurnRequest(value)) throw new Error('INVALID_STUDIO_TURN_REQUEST');
    return prepareStudioTurn(value);
  });

  ipcMain.handle(AGENT_IPC.studioFailTurn, async (event, value: unknown) => {
    requireSender(event);
    if (!isRecord(value) || typeof value.roomId !== 'string' || typeof value.roundId !== 'string' || typeof value.partnerId !== 'string') throw new Error('INVALID_STUDIO_FAIL_REQUEST');
    return studioRooms.failPreparedTurn(value.roomId, value.roundId, value.partnerId);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}





function isStudioPrepareTurnRequest(value: unknown): value is StudioPrepareTurnRequest {
  return isRecord(value)
    && typeof value.roomId === 'string' && Boolean(value.roomId)
    && typeof value.roundId === 'string' && Boolean(value.roundId)
    && typeof value.partnerId === 'string' && Boolean(value.partnerId)
    && ['local_cli', 'api_partner', 'existing_thread'].includes(String(value.source))
    && (value.adapterType === undefined || ['codex_cli', 'claude_code'].includes(String(value.adapterType)))
    && (value.partnerRootGrantId === undefined || typeof value.partnerRootGrantId === 'string')
    && (value.codexRuntimeId === undefined || typeof value.codexRuntimeId === 'string')
    && (value.codexRuntimeEnvironment === undefined || ['global_cli', 'desktop_app', 'vscode_extension', 'path'].includes(String(value.codexRuntimeEnvironment)));
}
