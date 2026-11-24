import type { StudioPrepareTurnRequest, StudioRoomMetadata } from '../../shared/studioRuntime';
import { getCodexThreadLastTurnId, getCodexThreadLifecycles } from '../adapters/CodexCliAdapter';
import { createLocalRuntimeResolver } from '../runtime/LocalRuntimeResolver';
import { NativeThreadBindingStore } from './NativeThreadBindingStore';
import { StudioAttachments } from './StudioAttachments';
import { StudioRoomStore } from './StudioRoomStore';

interface Dependencies {
  nativeBindings: NativeThreadBindingStore;
  resolveCodexLifecycleRuntime: ReturnType<typeof createLocalRuntimeResolver>['resolveCodexLifecycleRuntime'];
  studioAttachments: StudioAttachments;
  studioRooms: StudioRoomStore;
}

export function createStudioTurnRuntime(dependencies: Dependencies) {
  const { nativeBindings, resolveCodexLifecycleRuntime, studioAttachments, studioRooms } = dependencies;
  async function prepareStudioTurn(value: StudioPrepareTurnRequest) {
    if (value.source === 'existing_thread') throw new Error('STUDIO_EXISTING_THREAD_NOT_SUPPORTED');
    // v3 group bindings rebuild once from the canonical ledger so runtimes
    // receive their own registered replies (including the public seq) instead
    // of relying on native-thread history that cannot know the later seq.
    const conversationBase = `group:v3:${value.roomId}:${value.partnerId}`;
    let binding = await nativeBindings.reserve({
      partnerId: value.partnerId,
      source: value.source,
      scope: 'group',
      conversationId: conversationBase, generationScopedConversation: true,
      roomId: value.roomId,
    });
    if (binding.conversationId !== conversationBase && !binding.conversationId.startsWith(conversationBase + ':generation:')) {
      await nativeBindings.invalidate(binding.bindingId);
      binding = await nativeBindings.reserve({ partnerId: value.partnerId, source: value.source, scope: 'group', conversationId: conversationBase, generationScopedConversation: true, roomId: value.roomId });
    }
    if (binding.state === 'active' && binding.nativeThreadId && value.adapterType === 'codex_cli') {
      const { runtime, workingDirectory } = await resolveCodexLifecycleRuntime(value);
      const [lifecycle] = await getCodexThreadLifecycles(runtime.executablePath, workingDirectory, [binding.nativeThreadId]);
      const lastTurnId = lifecycle?.state === 'active'
        ? await getCodexThreadLastTurnId(runtime.executablePath, workingDirectory, binding.nativeThreadId).catch(() => undefined)
        : undefined;
      if (lifecycle?.state !== 'active' || !binding.lastCompletedRunId || lastTurnId !== binding.lastCompletedRunId) {
        await nativeBindings.invalidate(binding.bindingId);
        binding = await nativeBindings.reserve({
          partnerId: value.partnerId,
          source: value.source,
          scope: 'group',
          conversationId: conversationBase, generationScopedConversation: true,
          roomId: value.roomId,
        });
      }
    }
    const prepared = await studioRooms.prepareTurn(value.roomId, value.roundId, value.partnerId, binding.generation, binding.conversationId, binding.nativeThreadId, binding.studioSpeakingMode);
    const snapshot = await studioRooms.getRoom(value.roomId);
    return studioAttachments.prepareTurn(prepared, snapshot?.messages ?? []);
  }
  return prepareStudioTurn;
}

export function isStudioRoomMetadata(value: unknown): value is StudioRoomMetadata {
  return isRecord(value)
    && typeof value.roomId === 'string' && Boolean(value.roomId)
    && typeof value.projectId === 'string' && Boolean(value.projectId)
    && typeof value.name === 'string' && Boolean(value.name.trim())
    && (value.archived === undefined || typeof value.archived === 'boolean')
    && Array.isArray(value.memberIds) && value.memberIds.every((id) => typeof id === 'string' && Boolean(id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
