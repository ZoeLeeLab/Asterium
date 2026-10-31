import type { PartnerEvent, SendMessageCommand } from '../../shared/agentProtocol';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';

/** Records only an accepted startup snapshot. Never reads current profile files on resume. */
export class SessionBootstrapRecorder {
  private readonly bindingsByCommand = new WeakMap<SendMessageCommand, string>();
  constructor(private readonly bindings: Pick<NativeThreadBindingStore, 'getForScope' | 'registerSingle' | 'markPersonaVersion'>) {}
  async onBound(event: Extract<PartnerEvent, { type: 'session.bound' }>, command: SendMessageCommand) {
    if (command.connectionSource === 'existing_thread') return;
    try {
    const route = command.route;
    const binding = !route || route.scope === 'single'
      ? await this.bindings.registerSingle({ partnerId: command.partnerId, source: command.connectionSource, conversationId: command.conversationId, nativeThreadId: event.sessionId })
      : await this.bindings.getForScope(command.partnerId, route.scope, route.scope === 'group' ? route.roomId : route.scope === 'workspace' ? route.projectId : route.generationId);
    if (route?.scope === 'group' && (binding?.generation !== route.bindingGeneration
      || binding.conversationId !== command.conversationId || binding.nativeThreadId !== event.sessionId)) return;
    if (binding && command.sessionBootstrap && (!command.sessionId || !binding.bootstrap)) this.bindingsByCommand.set(command, binding.bindingId);
    } catch {
      // Native acceptance has already happened. Keep that run alive; absent
      // durable bookkeeping the applied profile remains unknown on recovery.
    }
  }
  async onEvent(event: PartnerEvent, command: SendMessageCommand) {
    const id = this.bindingsByCommand.get(command);
    if (event.type !== 'message.accepted' || !id || !command.sessionBootstrap) return;
    try {
      await this.bindings.markPersonaVersion(id, command.sessionBootstrap.personaVersion ?? 'disabled', command.sessionBootstrap.version, command.sessionBootstrap);
      this.bindingsByCommand.delete(command);
    } catch {
      // An index write failure cannot turn an accepted native task into a
      // retryable send failure, which could duplicate the original task.
    }
  }
}
