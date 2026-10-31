import type { PartnerAdapter } from '../adapters/PartnerAdapter';
import type { SessionBootstrapDocument } from '../../shared/agentProtocol';
import { profileReloadPrompt, type ProfileKind } from './AppliedSessionProfiles';

export class NativeProfileReloadError extends Error {
  constructor(cause: unknown, readonly recoveryRequired: boolean) {
    super(recoveryRequired ? 'PROFILE_RELOAD_RECOVERY_REQUIRED' : cause instanceof Error ? cause.message : 'PROFILE_RELOAD_FAILED', { cause });
  }
}

/** Compensation has its own bounded signal: cancellation cannot skip restoration. */
export async function confirmNativeProfileReload(adapter: PartnerAdapter, sessionId: string, kind: ProfileKind,
  previous: SessionBootstrapDocument, next: SessionBootstrapDocument, signal: AbortSignal, recoverFirst = false) {
  if (!adapter.reloadProfiles || !adapter.restoreProfileSnapshot) throw new NativeProfileReloadError(new Error('SESSION_COMMAND_UNAVAILABLE'), true);
  const restore = () => adapter.restoreProfileSnapshot!(sessionId, previous);
  if (recoverFirst) {
    try { await restore(); } catch (error) { throw new NativeProfileReloadError(error, true); }
  }
  try {
    const message = await adapter.reloadProfiles(sessionId, profileReloadPrompt(kind, next), next, signal);
    return { message, rollback: restore };
  } catch (error) {
    try { await restore(); }
    catch (rollbackError) { throw new NativeProfileReloadError(new AggregateError([error, rollbackError]), true); }
    throw new NativeProfileReloadError(error, false);
  }
}
