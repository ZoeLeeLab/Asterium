import type { CommandLaunchRequest } from '../api/extensions/ExtensionLaunchBackend';

/** Main-only, non-serializable and single-use. Never accepted from model or IPC arguments. */
export interface NativeCommandApproval { readonly __nativeCommandApproval: unique symbol; }
const pending = new WeakMap<NativeCommandApproval, string>();
type Binding = Pick<CommandLaunchRequest, 'command' | 'cwd' | 'context'>;
const fingerprint = (request: Binding) => JSON.stringify([request.command, request.cwd, request.context]);

/** These failures are established before a command process can run. Unknown
 * failures must never be advertised as safe to replay through Native. */
export const isConfirmedPreStartSandboxFailure = (code: string) => [
  'SANDBOX_ELEVATED_HOST_REFUSED', 'SANDBOX_HOST_IDENTITY_REFUSED', 'SANDBOX_BACKEND_UNAVAILABLE',
].includes(code);

export function issueNativeCommandApproval(request: Binding): NativeCommandApproval {
  const approval = Object.freeze({}) as NativeCommandApproval;
  pending.set(approval, fingerprint(request));
  return approval;
}

export function consumeNativeCommandApproval(request: Binding & { nativeApproval?: NativeCommandApproval }) {
  if (!request.nativeApproval) return false;
  const expected = pending.get(request.nativeApproval);
  pending.delete(request.nativeApproval);
  if (!expected || expected !== fingerprint(request)) throw new Error('NATIVE_COMMAND_APPROVAL_INVALID');
  return true;
}
