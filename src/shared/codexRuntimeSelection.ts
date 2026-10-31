import type { CodexRuntimeInfo } from './agentProtocol';

export function resolveCodexRuntime(
  runtimes: CodexRuntimeInfo[],
  runtimeId?: string,
  preferredEnvironment?: CodexRuntimeInfo['environment'],
) {
  const exact = runtimeId ? runtimes.find((runtime) => runtime.runtimeId === runtimeId) : undefined;
  if (exact) return exact;
  if (!preferredEnvironment) return undefined;
  return runtimes.find((runtime) => runtime.environment === preferredEnvironment && runtime.loggedIn)
    ?? runtimes.find((runtime) => runtime.environment === preferredEnvironment);
}
