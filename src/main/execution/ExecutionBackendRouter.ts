import type { GeneralSettings } from '../../shared/generalSettings';
import { NativeExtensionLaunchBackend, type CommandLaunchRequest, type ExecutionTransport, type ExtensionLaunchBackend, type LaunchedSkillScript, type McpLaunchRequest, type SkillScriptLaunchRequest } from '../api/extensions/ExtensionLaunchBackend';
import type { ExecutionContext } from './ExecutionContext';
import path from 'node:path';
import { consumeNativeCommandApproval } from './NativeCommandApproval';

export type SandboxSettings = Pick<GeneralSettings, 'sandboxEnabled' | 'sandboxAllowNetwork'>;
export type LocalExecutionKind = 'command' | 'skill' | 'mcp_stdio';
export function selectExecutionBackend(settings: SandboxSettings, context?: ExecutionContext) {
  if (context?.kind === 'partner_runtime' && context.policy?.permissionMode === 'full') return 'native';
  return settings.sandboxEnabled ? 'sandbox' : 'native';
}
class UnavailableSandboxBackend implements ExtensionLaunchBackend {
  readonly id = 'sandbox' as const;
  readonly sandboxed = true;
  createMcpTransport(): never { throw new Error('SANDBOX_BACKEND_UNAVAILABLE'); }
  launchSkillScript(): Promise<LaunchedSkillScript> { return Promise.reject(new Error('SANDBOX_BACKEND_UNAVAILABLE')); }
  runCommand(): Promise<string> { return Promise.reject(new Error('SANDBOX_BACKEND_UNAVAILABLE')); }
}

/** Main-owned routing. A selected backend error can never select a second backend. */
export class ExecutionBackendRouter implements ExtensionLaunchBackend {
  // A router is not evidence that a process is sandboxed. Results carry selection metadata.
  readonly id = 'native' as const;
  readonly sandboxed = false;
  private epoch = 0;
  private draining = false;
  private readonly active = new Set<{ sandboxed: boolean; full: boolean; abort: AbortController; done: Promise<void>; cleanupFailed?: boolean; context?: ExecutionContext }>();
  private readonly scopeVersions = new Map<string, number>();
  private readonly blockedScopes = new Map<string, number>();
  constructor(private readonly settings: () => Promise<SandboxSettings>,
    private readonly sandbox: ExtensionLaunchBackend = new UnavailableSandboxBackend(),
    private readonly native: ExtensionLaunchBackend = new NativeExtensionLaunchBackend()) {}

  async beginSettingsChange(before: SandboxSettings, after: SandboxSettings, closeConnections: (networkOnly: boolean) => Promise<void>) {
    if (!before.sandboxEnabled && !after.sandboxEnabled) return () => undefined;
    this.draining = true; this.epoch++;
    const networkOnly = before.sandboxEnabled === after.sandboxEnabled;
    const affected = [...this.active].filter(item => !item.full && (!networkOnly || item.sandboxed));
    for (const item of affected) item.abort.abort(new Error('EXECUTION_SETTINGS_CHANGED'));
    try {
      await Promise.all([closeConnections(networkOnly), ...affected.map(item => item.done)]);
      if (affected.some(item => item.cleanupFailed)) throw new Error('SANDBOX_CLEANUP_FAILED');
    }
    catch { this.draining = false; throw new Error('EXECUTION_SETTINGS_CLEANUP_FAILED'); }
    return () => { this.draining = false; };
  }

  async invalidatePartner(partnerId: string, closeConnections: () => Promise<void>) {
    this.scopeVersions.set(partnerId, (this.scopeVersions.get(partnerId) ?? 0) + 1);
    this.blockedScopes.set(partnerId, (this.blockedScopes.get(partnerId) ?? 0) + 1);
    const affected = [...this.active].filter(item => !item.full && item.context?.kind === 'partner_runtime' && item.context.partnerId === partnerId);
    for (const item of affected) item.abort.abort(new Error('EXECUTION_WORKSPACE_CHANGED'));
    try {
      await Promise.all([closeConnections(), ...affected.map(item => item.done)]);
      if (affected.some(item => item.cleanupFailed)) throw new Error();
    } catch { throw new Error('SANDBOX_WORKSPACE_CLEANUP_FAILED'); }
    const blocked = (this.blockedScopes.get(partnerId) ?? 1) - 1;
    if (blocked) this.blockedScopes.set(partnerId, blocked); else this.blockedScopes.delete(partnerId);
  }
  async invalidateWorkspaceRoots(roots: readonly string[]) {
    const partners = new Set([...this.active].flatMap(item => item.context?.kind === 'partner_runtime' && !item.full
      && item.context.workspace?.workspaceFolders.some(folder => roots.some(root => path.resolve(folder).toLowerCase() === path.resolve(root).toLowerCase())) ? [item.context.partnerId] : []));
    await Promise.all([...partners].map(partner => this.invalidatePartner(partner, async () => undefined)));
  }

  private async choose(context?: ExecutionContext, nativeCommandApproved = false) {
    if (context?.kind === 'partner_runtime' && context.policy?.planMode === 'plan') throw new Error('ASTERIUM_PLAN_READ_ONLY');
    const full = context?.kind === 'partner_runtime' && context.policy?.permissionMode === 'full';
    if (full) return { backend: this.native, settings: { sandboxEnabled: false, sandboxAllowNetwork: false }, full, policyKey: 'full-native', epoch: this.epoch };
    const epoch = this.epoch;
    const partnerId = context?.kind === 'partner_runtime' ? context.partnerId : undefined;
    const scopeVersion = partnerId ? this.scopeVersions.get(partnerId) ?? 0 : 0;
    if (partnerId && this.blockedScopes.has(partnerId)) throw new Error('SANDBOX_WORKSPACE_CHANGING');
    if (this.draining) throw new Error('EXECUTION_SETTINGS_CHANGING');
    const settings = await this.settings();
    if (this.draining || epoch !== this.epoch) throw new Error('EXECUTION_SETTINGS_CHANGED');
    if (partnerId && (this.blockedScopes.has(partnerId) || scopeVersion !== (this.scopeVersions.get(partnerId) ?? 0))) throw new Error('SANDBOX_WORKSPACE_CHANGED');
    if (context?.kind === 'partner_runtime' && (context.policy?.permissionMode === 'read_only' || context.policy?.planMode === 'plan')) throw new Error('ASTERIUM_READ_ONLY');
    const selected = nativeCommandApproved ? 'native' : selectExecutionBackend(settings, context);
    if (selected === 'sandbox' && (!context || (context.kind === 'partner_runtime' && !context.policy))) throw new Error('SANDBOX_CONTEXT_REQUIRED');
    return { backend: selected === 'sandbox' ? this.sandbox : this.native, settings, full, policyKey: JSON.stringify([selected, settings.sandboxAllowNetwork, epoch, scopeVersion]), epoch };
  }

  async runCommand(request: CommandLaunchRequest) {
    // A caller retaining the original object cannot swap the approved command,
    // identity or workspace while settings/revalidation awaits are in flight.
    if (request.nativeApproval) request = { ...request, context: structuredClone(request.context) };
    const nativeCommandApproved = consumeNativeCommandApproval(request);
    if (nativeCommandApproved && (request.context?.kind !== 'partner_runtime' || !request.context.policy)) throw new Error('NATIVE_COMMAND_CONTEXT_REQUIRED');
    const selection = await this.choose(request.context, nativeCommandApproved);
    if (!selection.backend.runCommand) throw new Error('EXECUTION_COMMAND_BACKEND_UNAVAILABLE');
    return this.track(selection, request.signal, async signal => {
      const beforeStart = this.revalidate(selection.epoch, request.beforeStart, request.context);
      // Native has no suspended helper handshake. Revalidate the approved intent
      // immediately before its single dispatch; ordinary Native/Full is unchanged.
      if (nativeCommandApproved) { await beforeStart(); signal.throwIfAborted(); }
      return selection.backend.runCommand!({ ...request, signal, beforeStart, sandboxPolicy: { allowNetwork: selection.settings.sandboxAllowNetwork, policyKey: selection.policyKey } });
    }, request.context);
  }
  async launchSkillScript(request: SkillScriptLaunchRequest) {
    const selection = await this.choose(request.context);
    let launched: LaunchedSkillScript | undefined;
    // Keep the operation registered until the actual process closes, not just until spawn.
    let finish!: () => void, failLifetime!: (error: unknown) => void;
    const lifetime = new Promise<void>((resolve, reject) => { finish = resolve; failLifetime = reject; });
    let publish!: (value: LaunchedSkillScript) => void, fail!: (error: unknown) => void;
    const initialized = new Promise<LaunchedSkillScript>((resolve, reject) => { publish = resolve; fail = reject; });
    const launch = this.track(selection, request.signal, async signal => {
      launched = await selection.backend.launchSkillScript({ ...request, signal, beforeStart: this.revalidate(selection.epoch, request.beforeStart, request.context), sandboxPolicy: { allowNetwork: selection.settings.sandboxAllowNetwork, policyKey: selection.policyKey } });
      const completed = () => { void launched!.close().then(finish, failLifetime); };
      launched.process.once('close', completed);
      if (launched.process.exitCode !== null || launched.process.signalCode !== null) completed();
      publish(launched);
      return lifetime;
    }, request.context);
    void launch.catch(fail);
    const original = await initialized;
    return { ...original, execution: { backend: selection.backend.id, sandboxed: selection.backend.sandboxed }, close: async () => { try { await original.close(); } finally { await launch; } } };
  }
  async createMcpTransport(request: McpLaunchRequest): Promise<ExecutionTransport> {
    // HTTP is explicitly outside local sandbox routing, including availability checks.
    if (request.configuration.type === 'mcp_http') return this.native.createMcpTransport(request);
    const selection = await this.choose(request.context);
    const transport = await selection.backend.createMcpTransport({ ...request, beforeStart: this.revalidate(selection.epoch, request.beforeStart, request.context), sandboxPolicy: { allowNetwork: selection.settings.sandboxAllowNetwork, policyKey: selection.policyKey } }) as ExecutionTransport;
    transport.execution ??= { backend: selection.backend.id, sandboxed: false, policyKey: selection.policyKey };
    return transport;
  }
  private revalidate(epoch: number, check?: () => Promise<void>, context?: ExecutionContext) {
    const partnerId = context?.kind === 'partner_runtime' ? context.partnerId : undefined;
    const scopeVersion = partnerId ? this.scopeVersions.get(partnerId) ?? 0 : 0;
    return async () => {
      if (!check) throw new Error('SANDBOX_REVALIDATION_REQUIRED');
      if (this.draining || epoch !== this.epoch) throw new Error('SANDBOX_EXECUTION_SETTINGS_CHANGED');
      await check();
      if (this.draining || epoch !== this.epoch) throw new Error('SANDBOX_EXECUTION_SETTINGS_CHANGED');
      if (partnerId && (this.blockedScopes.has(partnerId) || scopeVersion !== (this.scopeVersions.get(partnerId) ?? 0))) throw new Error('SANDBOX_WORKSPACE_CHANGED');
    };
  }
  private async track<T>(selection: { backend: ExtensionLaunchBackend; full: boolean }, signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>, context?: ExecutionContext) {
    signal.throwIfAborted();
    const abort = new AbortController();
    let finish!: () => void;
    const item = { sandboxed: selection.backend.sandboxed, full: selection.full, abort, done: new Promise<void>(resolve => { finish = resolve; }), cleanupFailed: false, context };
    this.active.add(item);
    try { return await action(AbortSignal.any([signal, abort.signal])); }
    catch (error) { item.cleanupFailed = error instanceof Error && error.message.startsWith('SANDBOX_CLEANUP_FAILED'); throw error; }
    finally { this.active.delete(item); finish(); }
  }
}
