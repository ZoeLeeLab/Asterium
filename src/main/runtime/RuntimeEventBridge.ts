import { type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  AGENT_PROTOCOL_VERSION,
  type ExistingThreadChangedEvent,
  type MessageDeliveryEvent,
  type PartnerEvent,
  type SendMessageCommand
} from '../../shared/agentProtocol';
import { DESKTOP_IPC as AGENT_IPC } from '../../shared/desktopIpc';
import { AutomationConfirmations } from '../automation/AutomationConfirmations';
import { AutomationRuntime } from '../automation/AutomationRuntime';
import { SingleChatHistoryStore } from '../conversation/SingleChatHistoryStore';
import { PartnerProfileStore } from '../partner/PartnerProfileStore';
import { ProjectFileDeliveryCoordinator } from '../project/ProjectFileDeliveryCoordinator';
import { ProjectTaskRuntime } from '../project/ProjectTaskRuntime';
import type { DesktopNotifications } from '../settings/DesktopNotifications';
import { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
import { SessionCommandService } from './SessionCommandService';

interface Dependencies {
  automationConfirmations: AutomationConfirmations;
  automationHandles: { runtime?: AutomationRuntime };
  getWindow: () => BrowserWindow | null;
  notifications: DesktopNotifications | undefined;
  partnerProfiles: PartnerProfileStore;
  projectFileDelivery: ProjectFileDeliveryCoordinator;
  projectTaskRuntimeRef: { current?: ProjectTaskRuntime };
  sessionCommands: SessionCommandService;
  singleChatHistory: SingleChatHistoryStore;
  studioRuntimeCatalog: StudioRuntimeCatalog;
}

export function createRuntimeEventBridge(dependencies: Dependencies) {
  const { automationConfirmations, automationHandles, getWindow, notifications, partnerProfiles, projectFileDelivery, projectTaskRuntimeRef, sessionCommands, singleChatHistory, studioRuntimeCatalog } = dependencies;
  const sendEvent = (event: PartnerEvent | MessageDeliveryEvent | ExistingThreadChangedEvent) => {
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') automationConfirmations.cancelOwner(event.clientMessageId);
    sessionCommands.observe(event as PartnerEvent);
    if (event.type === 'run.completed' || event.type === 'authorization.requested') notifications?.agent(event, automationHandles.runtime?.eventRunFor(event), studioRuntimeCatalog.partner(event.partnerId)?.publicIdentity.displayName);
    const observed = event.type === 'session.bound' && event.model
      ? { partnerId: event.partnerId, conversationId: event.conversationId, threadId: event.sessionId, observedAt: event.occurredAt, model: event.model, source: event.modelSource ?? 'runtime' }
      : event.type === 'extension.event' && event.namespace === 'asterium.runtime' && event.name === 'model_observed' && isRecord(event.payload) && typeof event.payload.model === 'string'
        ? { partnerId: event.partnerId, conversationId: event.conversationId, threadId: event.sessionId, observedAt: event.occurredAt, model: event.payload.model, source: event.payload.source === 'native_thread' ? 'native_thread' as const : 'runtime' as const }
        : undefined;
    if (observed) {
      studioRuntimeCatalog.observeModel(observed.partnerId, {
        model: observed.model,
        status: 'recent',
        observedAt: observed.observedAt,
        source: observed.source,
        conversationId: observed.conversationId,
        ...(observed.threadId ? { threadId: observed.threadId } : {}),
      });
      void partnerProfiles.observeModel({
        partnerId: observed.partnerId,
        conversationId: observed.conversationId,
        threadId: observed.threadId,
        model: observed.model,
        source: observed.source,
        observedAt: observed.observedAt,
      }).catch(() => undefined);
    }
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      const run = 'clientMessageId' in event ? automationHandles.runtime?.eventRunFor(event) : undefined;
      if (run && event.type !== 'message.delivery' && event.type !== 'existing_thread.changed') {
        automationHandles.runtime?.replaceEvent(event); window.webContents.send(AGENT_IPC.automationsEvent, { run, event });
        if (run.definition.target.roomId) window.webContents.send(AGENT_IPC.event, event); // Studio retains its approval/question interaction path.
      }
      else window.webContents.send(AGENT_IPC.event, event);
    }
  };

  const transformRuntimeEvent = async (event: PartnerEvent, artifactBaseDirectory?: string) => {
    if (event.type === 'tool.completed') {
      // The reference is main-owned. Adapters can only supply the detail itself.
      const clean = { ...event, detail: typeof event.detail === 'string' ? event.detail : undefined, detailRef: undefined };
      if (event.route && event.route.scope !== 'single') return clean;
      if (!clean.detail || clean.detail.length <= 4096) return clean;
      // On failure leave the detail in the event. The checkpoint retries it and surfaces a storage failure.
      const stored = await singleChatHistory.recordToolOutput(event.conversationId, clean.detail).catch(() => undefined);
      return stored ? { ...clean, ...stored } : clean;
    }
    if (event.type !== 'file.produced') return event;
    const registered = await projectFileDelivery.registerRuntimeFile(event, artifactBaseDirectory);
    if (!registered?.emitArtifactEvent) {
      // Invalid claims stay hidden; a same-run duplicate keeps its original renderer card.
      return undefined;
    }
    const { info } = registered;
    if (info.registrationMethod === 'deliver_tool' && registered.delivery) {
      projectTaskRuntimeRef.current?.recordProjectFile(event, {
        fileId: registered.delivery.fileId,
        relativePath: registered.delivery.relativePath,
        revision: registered.delivery.revision,
        contentHash: registered.delivery.contentHash,
        sizeBytes: registered.delivery.sizeBytes,
      });
    }
    return { ...event, source: undefined, artifactId: info.id, artifactRef: info.id, name: info.name, mediaType: info.mediaType, sizeBytes: info.sizeBytes, sourceKind: info.sourceKind, registrationMethod: info.registrationMethod, availability: info.availability, cached: info.cached, localSourceKey: info.localSourceKey };
  };

  const delivery = (command: SendMessageCommand, state: MessageDeliveryEvent['state'], error?: MessageDeliveryEvent['error']) => sendEvent({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type: 'message.delivery',
    eventId: randomUUID(),
    partnerId: command.partnerId,
    conversationId: command.conversationId,
    connectionSource: command.connectionSource,
    clientMessageId: command.clientMessageId,
    state,
    occurredAt: new Date().toISOString(),
    error,
  });

  const notifyHandoffDelivered = (event: PartnerEvent, command: SendMessageCommand) => {
    if (event.type !== 'message.accepted' || !command.contextHandoff) return;
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC.contextHandoffDelivered, command.contextHandoff.id);
  };
  return { sendEvent, transformRuntimeEvent, delivery, notifyHandoffDelivered };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
