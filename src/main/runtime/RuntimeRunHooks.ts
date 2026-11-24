import type { PartnerEvent, SendMessageCommand } from '../../shared/agentProtocol';
import { automationRunExpired } from '../../shared/automationTime';
import type { AutomationRun } from '../../shared/automations';
import type { AutomationRuntime } from '../automation/AutomationRuntime';
import type { SingleChatHistoryStore } from '../conversation/SingleChatHistoryStore';
import type { SingleChatMessageStore } from '../conversation/SingleChatMessageStore';
import type { ProjectRunChangeRecorder } from '../project/ProjectRunChangeRecorder';
import type { ProjectTaskRuntime } from '../project/ProjectTaskRuntime';
import type { ProjectWorkflowGenerationRuntime } from '../project/ProjectWorkflowGenerationRuntime';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import type { StudioOrchestrator } from '../studio/StudioOrchestrator';
import type { StudioRoomStore } from '../studio/StudioRoomStore';
import type { DelegationResultDelivery } from './DelegationResultDelivery';
import type { PartnerDelegation } from './PartnerDelegation';
import type { RunCoordinatorHooks } from './RunCoordinator';
import { streamFailureEvent } from './RunCoordinator';
import type { SessionBootstrapRecorder } from './SessionBootstrapRecorder';
import type { SessionBootstrapService } from './SessionBootstrapService';
interface Dependencies {
  automationHandles: { runtime?: AutomationRuntime };
  checkAutomation: (run: AutomationRun, leaseOwner?: string) => Promise<{ available: boolean; reason?: string }>;
  delegation: PartnerDelegation;
  delegationHandles: { delivery?: DelegationResultDelivery };
  delivery: RunCoordinatorHooks['deliver'];
  hydrateManagedRuntimeProfile: SessionBootstrapService['prepare'];
  nativeBindings: NativeThreadBindingStore;
  notifyHandoffDelivered: (event: PartnerEvent, command: SendMessageCommand) => void;
  projectChanges: ProjectRunChangeRecorder;
  projectTaskRuntimeRef: { current?: ProjectTaskRuntime };
  sendEvent: RunCoordinatorHooks['emit'];
  sessionBootstrapRecorder: SessionBootstrapRecorder;
  singleChatHistory: SingleChatHistoryStore;
  singleChatMessages: SingleChatMessageStore;
  studioOrchestration: { orchestrator?: StudioOrchestrator };
  studioRooms: StudioRoomStore;
  transformRuntimeEvent: NonNullable<RunCoordinatorHooks['transformEvent']>;
  workflowGenerationRuntimeRef: { current?: ProjectWorkflowGenerationRuntime };
}

export function createRuntimeRunHooks(dependencies: Dependencies) {
  const { automationHandles, checkAutomation, delegation, delegationHandles, delivery, hydrateManagedRuntimeProfile, nativeBindings, notifyHandoffDelivered, projectChanges, projectTaskRuntimeRef, sendEvent, sessionBootstrapRecorder, singleChatHistory, singleChatMessages, studioOrchestration, studioRooms, transformRuntimeEvent, workflowGenerationRuntimeRef } = dependencies;
  async function persistFirstSingleChatBinding(event: Extract<PartnerEvent, { type: 'session.bound' }>, command: SendMessageCommand) {
    if ((command.route && command.route.scope !== 'single') || command.connectionSource === 'existing_thread') return;
    if (await singleChatHistory.bindInitialSession(command.conversationId, command.partnerId, event.sessionId)) {
      await nativeBindings.registerSingle({
        conversationId: command.conversationId, partnerId: command.partnerId,
        source: command.connectionSource, nativeThreadId: event.sessionId,
      });
    }
  }

  const captureGuidanceSource = async (event: PartnerEvent, command: SendMessageCommand) => {
    if (event.type !== 'guidance.applied' || !event.sourceMessage) return;
    await singleChatMessages.upsertMessage(command.conversationId, command.partnerId, event.sourceMessage);
    // Runtime tools capture sources lazily from this Main-owned command.
    command.messageId = event.sourceMessage.messageId;
  };

  async function markAcceptedStudioSpeakingMode(event: PartnerEvent, command: SendMessageCommand) {
    if (event.type !== 'message.accepted' || command.route?.scope !== 'group') return;
    const speakingMode = command.runtimeContext?.conversation?.studio?.speakingMode;
    if (!speakingMode) return;
    try {
      const binding = await nativeBindings.getForScope(command.partnerId, 'group', command.route.roomId);
      if (binding?.generation === command.route.bindingGeneration && binding.conversationId === command.conversationId
        && binding.nativeThreadId === event.sessionId && binding.studioSpeakingMode !== speakingMode) await nativeBindings.markStudioSpeakingMode(binding.bindingId, speakingMode);
    } catch {
      // This bookkeeping must not fail an accepted Studio turn. If it cannot
      // be persisted, the next turn safely repeats the mode notice once.
    }
  }

  const hooks: RunCoordinatorHooks = {
    prepare: async (command) => {
      await delegationHandles.delivery?.validateBeforeStart(command);
      const automatic = automationHandles.runtime?.runFor(command);
      if (automatic && (automationHandles.runtime?.isAborted(command) || !(await checkAutomation(automatic, `runtime:${command.commandId}`)).available || automationRunExpired(automatic, Date.now()))) throw new Error('AUTOMATION_REVALIDATION_FAILED');
      if (command.sessionId) await hydrateManagedRuntimeProfile(command);
      if (!delegationHandles.delivery?.owns(command)) await projectChanges.begin(command).catch((error) => { projectChanges.failedStart(command); console.error('Project change baseline unavailable', error); });
    },
    beforeEvent: async (event, command) => { await projectChanges.observe(event, command).catch((error) => console.error('Project change capture unavailable', error)); },
    deliver: delivery,
    emit: sendEvent,
    observe: (event) => studioRooms.observeEvent(event),
    validateFirstEvent: async (event, command) => {
      delegationHandles.delivery?.validateFirst(command, event);
      automationHandles.runtime?.validateFirst(command, event);
      await automationHandles.runtime?.observe(event);
      if (event.type !== 'session.bound') throw new Error('FIRST_EVENT_MUST_BIND_SESSION');
      await projectTaskRuntimeRef.current?.validateFirstEvent(event, command);
      await workflowGenerationRuntimeRef.current?.validateFirstEvent(event, command);
      if (command.route?.scope !== 'group') return;
      const binding = await nativeBindings.getForScope(command.partnerId, 'group', command.route.roomId);
      if (!binding || binding.conversationId !== command.conversationId || binding.generation !== command.route.bindingGeneration) throw new Error('NATIVE_BINDING_ROUTE_MISMATCH');
      if (binding.state === 'pending') await nativeBindings.activate(binding.bindingId, event.sessionId);
      else if (binding.nativeThreadId !== event.sessionId) throw new Error('NATIVE_THREAD_ROUTE_MISMATCH');
    },
    onBound: async (event, command) => {
      await delegationHandles.delivery?.observe(event);
      await persistFirstSingleChatBinding(event, command);
      await automationHandles.runtime?.bound(command, { runId: event.runId, sessionId: event.sessionId });
      if (command.route?.scope === 'group') await studioRooms.bindRun(command.route.roomId, command.route.roundId, command.partnerId, event.runId, event.sessionId);
      await sessionBootstrapRecorder.onBound(event, command);
    },
    onEvent: async (event, command) => {
      await delegationHandles.delivery?.observe(event);
      notifyHandoffDelivered(event, command);
      if (event.type === 'run.completed') await delegation.releaseTurn(command.clientMessageId, true);
      await automationHandles.runtime?.observe(event);
      await captureGuidanceSource(event, command);
      await projectTaskRuntimeRef.current?.onEvent(event, command);
      await workflowGenerationRuntimeRef.current?.onEvent(event, command);
      await sessionBootstrapRecorder.onEvent(event, command);
      await markAcceptedStudioSpeakingMode(event, command);
      if (event.type === 'run.completed') await workflowGenerationRuntimeRef.current?.markCompleted(command, event.runId);
      if (command.route?.scope !== 'group' || event.type !== 'run.completed') return;
      const binding = await nativeBindings.getForScope(command.partnerId, 'group', command.route.roomId);
      if (binding?.generation === command.route.bindingGeneration) await nativeBindings.markCompleted(binding.bindingId, event.runId).catch(() => undefined);
    },
    transformEvent: transformRuntimeEvent,
    onStreamFailure: async (_error, context) => {
      await automationHandles.runtime?.fail(context.command);
      await projectChanges.finish(context.command, 'failed').catch(() => undefined);
      await projectTaskRuntimeRef.current?.invalidatePending(context.command);
      projectTaskRuntimeRef.current?.fail(context.command, _error);
      await workflowGenerationRuntimeRef.current?.failCommand(context.command, _error);
      if (context.command.route?.scope !== 'group') return;
      await nativeBindings.invalidateGroupTurn(context.command).catch(() => undefined);
      const failed = streamFailureEvent(context);
      await studioRooms.observeEvent(failed).catch(() => undefined);
      sendEvent(failed);
    },
    onStartFailure: async (_error, command) => {
      await automationHandles.runtime?.fail(command);
      await projectChanges.finish(command, 'failed').catch(() => undefined);
      projectChanges.failedStart(command);
      await projectTaskRuntimeRef.current?.invalidatePending(command);
      projectTaskRuntimeRef.current?.fail(command, _error);
      await workflowGenerationRuntimeRef.current?.failCommand(command, _error);
      if (command.route?.scope !== 'group') return;
      await nativeBindings.invalidateGroupTurn(command).catch(() => undefined);
      await studioRooms.failPreparedTurn(command.route.roomId, command.route.roundId, command.partnerId).catch(() => undefined);
    },
    onReleased: async ({ command, receipt }) => {
      await delegationHandles.delivery?.released(command);
      await delegation.releaseTurn(command.clientMessageId, false);
      await automationHandles.runtime?.fail(command);
      await projectChanges.finish(command, 'failed').catch(() => undefined);
      projectChanges.failedStart(command);
      projectTaskRuntimeRef.current?.released(command);
      if (command.route?.scope !== 'group' || !studioRooms.hasPendingPassRetry(receipt.runId)) return;
      studioOrchestration.orchestrator?.markPassCorrection(command.route.roomId, command.route.roundId, command.partnerId);
      await studioRooms.retryPassAfterRelease(receipt.runId).catch(() => undefined);
    },
  };
  return { hooks, persistFirstSingleChatBinding, captureGuidanceSource, markAcceptedStudioSpeakingMode };
}
