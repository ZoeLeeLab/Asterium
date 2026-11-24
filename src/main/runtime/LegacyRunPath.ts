import { randomUUID } from 'node:crypto';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent, type SendMessageCommand } from '../../shared/agentProtocol';
import { isPartnerEvent } from '../../shared/agentProtocolValidation';
import { codexThreadInUseFailure } from '../../shared/codexThreadInUse';
import type { AdapterHost } from '../AdapterHost';
import type { PartnerAdapter } from '../adapters/PartnerAdapter';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import type { StudioOrchestrator } from '../studio/StudioOrchestrator';
import type { StudioRoomStore } from '../studio/StudioRoomStore';
import type { RunCoordinatorHooks } from './RunCoordinator';
import { sameEventRoute, withCommandRoute } from './RunCoordinator';
import type { SessionBootstrapRecorder } from './SessionBootstrapRecorder';
import type { SessionBootstrapService } from './SessionBootstrapService';
import type { WriterLeaseCoordinator } from './WriterLeaseCoordinator';
interface Dependencies {
  captureGuidanceSource: (event: PartnerEvent, command: SendMessageCommand) => Promise<void>;
  delivery: RunCoordinatorHooks['deliver'];
  host: AdapterHost;
  hydrateManagedRuntimeProfile: SessionBootstrapService['prepare'];
  markAcceptedStudioSpeakingMode: (event: PartnerEvent, command: SendMessageCommand) => Promise<void>;
  nativeBindings: NativeThreadBindingStore;
  notifyHandoffDelivered: (event: PartnerEvent, command: SendMessageCommand) => void;
  persistFirstSingleChatBinding: NonNullable<RunCoordinatorHooks['onBound']>;
  sendEvent: RunCoordinatorHooks['emit'];
  sessionBootstrapRecorder: SessionBootstrapRecorder;
  studioOrchestration: { orchestrator?: StudioOrchestrator };
  studioRooms: StudioRoomStore;
  transformRuntimeEvent: NonNullable<RunCoordinatorHooks['transformEvent']>;
  writerLeases: WriterLeaseCoordinator;
}

export function createLegacyRunPath(dependencies: Dependencies) {
  const { captureGuidanceSource, delivery, host, hydrateManagedRuntimeProfile, markAcceptedStudioSpeakingMode, nativeBindings, notifyHandoffDelivered, persistFirstSingleChatBinding, sendEvent, sessionBootstrapRecorder, studioOrchestration, studioRooms, transformRuntimeEvent, writerLeases } = dependencies;
  async function startAdapterRun(adapter: PartnerAdapter, command: SendMessageCommand, disposeAfter = false, artifactBaseDirectory?: string, validateBeforeStart?: () => Promise<void>) {
    if (/^(compact|reload):/.test(writerLeases.ownerFor({ kind: 'conversation', partnerId: command.partnerId, conversationId: command.conversationId }) ?? '')) throw new Error('COMPACT_CONVERSATION_BUSY');
    const lease = await writerLeases.acquire({ kind: 'conversation', partnerId: command.partnerId, conversationId: command.conversationId }, `legacy:${command.commandId}`);
    const release = async () => {
      try {
        if (disposeAfter) await adapter.dispose?.();
      } finally {
        lease.release();
      }
    };
    let iterator: AsyncIterator<PartnerEvent> | undefined;
    try {
      await validateBeforeStart?.();
      if (command.sessionId) await hydrateManagedRuntimeProfile(command);
      delivery(command, 'awaiting_confirmation');
      const stream = adapter.sendMessage(command)[Symbol.asyncIterator]();
      iterator = stream;
      const first = await stream.next();
      if (first.done || !isPartnerEvent(first.value) || first.value.type !== 'session.bound') throw new Error('ADAPTER_SESSION_NOT_BOUND');
      const firstEvent = withCommandRoute(first.value, command);
      if (!sameEventRoute(firstEvent, command)) throw new Error('ADAPTER_EVENT_ROUTE_MISMATCH');
      if (command.route?.scope === 'group') {
        const binding = await nativeBindings.getForScope(command.partnerId, 'group', command.route.roomId);
        if (!binding || binding.conversationId !== command.conversationId || binding.generation !== command.route.bindingGeneration) throw new Error('NATIVE_BINDING_ROUTE_MISMATCH');
        if (binding.state === 'pending') await nativeBindings.activate(binding.bindingId, firstEvent.sessionId);
        else if (binding.nativeThreadId !== firstEvent.sessionId) throw new Error('NATIVE_THREAD_ROUTE_MISMATCH');
      }
      await studioRooms.observeEvent(firstEvent);
      sendEvent(firstEvent);
      const receipt = { runId: firstEvent.runId, sessionId: firstEvent.sessionId };
      host.bindRun(receipt.runId, adapter);
      host.bindSession(command.partnerId, command.conversationId, receipt.sessionId, adapter);
      if (command.route?.scope === 'group') await studioRooms.bindRun(command.route.roomId, command.route.roundId, command.partnerId, receipt.runId, receipt.sessionId);
      const bound = firstEvent as Extract<PartnerEvent, { type: 'session.bound' }>;
      await persistFirstSingleChatBinding(bound, command);
      await sessionBootstrapRecorder.onBound(bound, command);
      void (async () => {
        let lastSequence = firstEvent.sequence;
        try {
          for (;;) {
            const next = await stream.next();
            if (next.done) break;
            if (!isPartnerEvent(next.value)) continue;
            const routedEvent = withCommandRoute(next.value, command);
            if (!sameEventRoute(routedEvent, command) || routedEvent.sessionId !== receipt.sessionId || routedEvent.runId !== receipt.runId) throw new Error('ADAPTER_EVENT_ROUTE_MISMATCH');
            lastSequence = routedEvent.sequence;
            await studioRooms.observeEvent(routedEvent);
            if (command.route?.scope === 'group' && routedEvent.type === 'run.completed') {
              const binding = await nativeBindings.getForScope(command.partnerId, 'group', command.route.roomId);
              if (binding?.generation === command.route.bindingGeneration) await nativeBindings.markCompleted(binding.bindingId, routedEvent.runId).catch(() => undefined);
            }
            await captureGuidanceSource(routedEvent, command);
            await sessionBootstrapRecorder.onEvent(routedEvent, command);
            await markAcceptedStudioSpeakingMode(routedEvent, command);
            notifyHandoffDelivered(routedEvent, command);
            if (routedEvent.type === 'message.accepted') delivery(command, 'delivered');
            if (routedEvent.type === 'run.failed') delivery(command, 'failed', routedEvent.error);
            const outgoing = await transformRuntimeEvent(routedEvent, artifactBaseDirectory);
            if (outgoing) sendEvent(outgoing);
          }
        } catch (error) {
          if (command.route?.scope === 'group') {
            await nativeBindings.invalidateGroupTurn(command).catch(() => undefined);
            const failed: PartnerEvent = {
              protocolVersion: AGENT_PROTOCOL_VERSION,
              type: 'run.failed',
              eventId: randomUUID(),
              partnerId: command.partnerId,
              conversationId: command.conversationId,
              connectionSource: command.connectionSource,
              clientMessageId: command.clientMessageId,
              sessionId: receipt.sessionId,
              runId: receipt.runId,
              sequence: lastSequence + 1,
              occurredAt: new Date().toISOString(),
              route: command.route,
              error: { code: 'ADAPTER_STREAM_FAILED', message: '伙伴的事件流意外中断。', stage: 'transport', retryable: true },
            };
            await studioRooms.observeEvent(failed).catch(() => undefined);
            sendEvent(failed);
          }
          delivery(command, 'failed', {
            code: 'ADAPTER_STREAM_FAILED',
            message: '伙伴的事件流意外中断。',
            stage: 'transport',
            retryable: true,
            technicalDetail: error instanceof Error ? error.message.slice(0, 500) : undefined,
          });
        } finally {
          host.releaseRun(receipt.runId);
          await stream.return?.().catch(() => undefined);
          await release().catch(() => undefined);
          if (command.route?.scope === 'group' && studioRooms.hasPendingPassRetry(receipt.runId)) {
            studioOrchestration.orchestrator?.markPassCorrection(command.route.roomId, command.route.roundId, command.partnerId);
            await studioRooms.retryPassAfterRelease(receipt.runId).catch(() => undefined);
          }
        }
      })();
      return receipt;
    } catch (error) {
      await iterator?.return?.().catch(() => undefined);
      await release().catch(() => undefined);
      if (command.route?.scope === 'group') {
        await nativeBindings.invalidateGroupTurn(command).catch(() => undefined);
        await studioRooms.failPreparedTurn(command.route.roomId, command.route.roundId, command.partnerId).catch(() => undefined);
      }
      delivery(command, 'failed', codexThreadInUseFailure(error) ?? {
        code: 'ADAPTER_START_FAILED',
        message: '无法启动伙伴会话。',
        stage: 'adapter',
        retryable: true,
        technicalDetail: error instanceof Error ? error.message.slice(0, 500) : undefined,
      });
      throw error;
    }
  }
  return { startAdapterRun };
}
