import { NativeExtensionLaunchBackend, type CommandLaunchRequest, type ExtensionLaunchBackend, type McpLaunchRequest, type SkillScriptLaunchRequest } from '../api/extensions/ExtensionLaunchBackend';
import type { ExecutionContext } from './ExecutionContext';

/** Main's single launch entry. The selected backend remains the only executor.
 * No policy, retry, fallback, environment or lifecycle changes belong in this facade.
 */
export class ExecutionGateway implements ExtensionLaunchBackend {
  constructor(private readonly backend: ExtensionLaunchBackend) {}
  get id() { return this.backend.id; }
  get sandboxed() { return this.backend.sandboxed; }
  createMcpTransport(request: McpLaunchRequest) { return this.backend.createMcpTransport(request); }
  launchSkillScript(request: SkillScriptLaunchRequest) { return this.backend.launchSkillScript(request); }
  runCommand(request: CommandLaunchRequest): Promise<string> {
    if (!this.backend.runCommand) return Promise.reject(new Error('EXECUTION_COMMAND_BACKEND_UNAVAILABLE'));
    return this.backend.runCommand(request);
  }
  /** RPC remains owned by its authorized connection; no retry or alternate transport. */
  dispatchMcp<T>(request: { context: Extract<ExecutionContext, { kind: 'partner_runtime' }>; dispatch: () => Promise<T> }): Promise<T> {
    return request.dispatch();
  }
}

/** Default composition, also used by standalone tools. Never selected after a backend failure. */
export const nativeExecutionGateway = new ExecutionGateway(new NativeExtensionLaunchBackend());

export function executionGatewayFor(backend: ExtensionLaunchBackend) {
  return backend instanceof ExecutionGateway ? backend : new ExecutionGateway(backend);
}
