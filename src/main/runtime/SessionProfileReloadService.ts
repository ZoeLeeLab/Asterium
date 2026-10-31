import type { SessionBootstrapDocument } from '../../shared/agentProtocol';
import type { SessionCommandRequest, SessionCommandResult } from '../../shared/sessionCommands';
import type { PartnerProfileStore } from '../partner/PartnerProfileStore';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import { appliedProfiles, profileVersion, replaceProfile, type ProfileKind } from './AppliedSessionProfiles';
import { conversationWriterScope, type WriterLeaseCoordinator } from './WriterLeaseCoordinator';
import { NativeProfileReloadError } from './NativeProfileReload';

export { profileReloadPrompt } from './AppliedSessionProfiles';

export class SessionProfileReloadService {
  private readonly requests = new Map<string, { fingerprint: string; result: Promise<SessionCommandResult> }>();
  private readonly controllers = new Set<AbortController>();
  constructor(private readonly deps: {
    leases: WriterLeaseCoordinator;
    profiles: Pick<PartnerProfileStore, 'runtimeProfile' | 'runtimeUserProfile' | 'managedPersonaState'>;
    bindings: Pick<NativeThreadBindingStore, 'getForScope' | 'markPersonaVersion' | 'setProfileRecoveryRequired'>;
    legacyBootstrap?: (request: SessionCommandRequest) => Promise<SessionBootstrapDocument | undefined>;
    validate: (request: SessionCommandRequest) => Promise<void>;
    confirm: (request: SessionCommandRequest, kind: ProfileKind, previous: SessionBootstrapDocument, next: SessionBootstrapDocument, signal: AbortSignal, recoverFirst: boolean) => Promise<{ message: string; commit?: () => Promise<void>; rollback?: () => Promise<void> }>;
  }, private readonly timeoutMs = 180_000) {}

  execute(request: SessionCommandRequest): Promise<SessionCommandResult> {
    const fingerprint = JSON.stringify([request.command, request.partnerId, request.conversationId, request.sessionId, request.source]);
    const prior = this.requests.get(request.commandId);
    if (prior) return prior.fingerprint === fingerprint ? prior.result : Promise.reject(new Error('IDEMPOTENCY_CONFLICT'));
    const lease = this.deps.leases.tryAcquire(conversationWriterScope(request), `reload:${request.commandId}`);
    if (!lease) return Promise.reject(new Error('SESSION_COMMAND_BUSY'));
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('PROFILE_RELOAD_TIMEOUT')), this.timeoutMs);
    const result = this.run(request, controller.signal).finally(() => { clearTimeout(timer); this.controllers.delete(controller); lease.release(); });
    this.requests.set(request.commandId, { fingerprint, result });
    void result.then(() => { if (this.requests.size > 128) this.requests.delete(request.commandId); }, () => this.requests.delete(request.commandId));
    return result;
  }

  private async run(request: SessionCommandRequest, signal: AbortSignal): Promise<SessionCommandResult> {
    await this.deps.validate(request);
    const binding = await this.deps.bindings.getForScope(request.partnerId, 'single', request.conversationId);
    if (!binding || binding.state !== 'active' || binding.nativeThreadId !== request.sessionId || binding.source !== request.source) throw new Error('SESSION_COMMAND_THREAD_MISMATCH');
    const kind: ProfileKind = request.command === 'reload-user' ? 'user' : 'persona';
    const profile = await this.deps.profiles.runtimeProfile(request.partnerId);
    if (!profile) throw new Error('PARTNER_PROFILE_NOT_FOUND');
    const previous = binding.bootstrap ?? await this.deps.legacyBootstrap?.(request) ?? { version: 1, content: '', createdAt: binding.createdAt, timeZone: '', appliedProfiles: {} };
    const profiles = appliedProfiles(previous);
    if (kind === 'user') {
      const user = profile.management.userProfile ? await this.deps.profiles.runtimeUserProfile() : undefined;
      profiles.user = user ? { enabled: true, displayName: user.displayName, introduction: user.introduction, version: profileVersion({ displayName: user.displayName, introduction: user.introduction }) } : { enabled: false, version: 'disabled' };
    } else {
      const persona = await this.deps.profiles.managedPersonaState(request.partnerId);
      profiles.persona = persona.enabled ? { enabled: true, personality: persona.personality, systemPrompt: persona.systemPrompt, version: persona.version } : { enabled: false, version: 'disabled' };
    }
    const next = replaceProfile(previous, kind, profiles);
    signal.throwIfAborted();
    const native = request.source === 'local_cli';
    const recoverFirst = Boolean(binding.profileRecoveryRequired);
    // Persist before touching the native thread so a crash cannot silently
    // resume a conversation whose profile confirmation was never committed.
    if (native) await this.deps.bindings.setProfileRecoveryRequired(binding.bindingId, true);
    let confirmed;
    try { confirmed = await this.deps.confirm(request, kind, previous, next, signal, recoverFirst); }
    catch (error) {
      if (!native) throw error;
      if (error instanceof NativeProfileReloadError && !error.recoveryRequired) {
        try { await this.deps.bindings.setProfileRecoveryRequired(binding.bindingId, false); }
        catch (writeError) { throw new NativeProfileReloadError(new AggregateError([error, writeError]), true); }
        throw error;
      }
      throw new NativeProfileReloadError(error, true);
    }
    try {
      signal.throwIfAborted();
      const current = await this.deps.bindings.getForScope(request.partnerId, 'single', request.conversationId);
      if (!current || current.bindingId !== binding.bindingId || current.nativeThreadId !== request.sessionId || current.state !== 'active') throw new Error('SESSION_COMMAND_THREAD_MISMATCH');
      await confirmed.commit?.();
      await this.deps.bindings.markPersonaVersion(binding.bindingId, next.personaVersion ?? 'unknown', next.version, next, { clearProfileRecovery: native });
    } catch (error) {
      try {
        await confirmed.rollback?.();
        if (native) await this.deps.bindings.setProfileRecoveryRequired(binding.bindingId, false);
      } catch (rollbackError) {
        if (native) throw new NativeProfileReloadError(new AggregateError([error, rollbackError]), true);
        throw rollbackError;
      }
      throw error;
    }
    return { status: 'success', message: `${kind === 'user' ? '用户资料' : '伙伴人设'}已重读：${confirmed.message}` };
  }
  dispose() { for (const controller of this.controllers) controller.abort(new Error('PROFILE_RELOAD_INTERRUPTED')); }
}
