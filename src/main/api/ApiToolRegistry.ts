import { z } from 'zod';
import type { AuthorizationPurpose, PermissionMode, PlanMode } from '../../shared/agentProtocol';
import type { ApiToolDefinition } from './ApiProviderAdapter';
import type { ExecutionCapabilities } from '../execution/ExecutionPermissions';
export { assertApiToolAllowed, apiToolRequiresAuthorization } from '../execution/ExecutionPermissions';

export interface ApiToolResult {
  content: string;
  execution?: { backend: 'native' | 'sandbox'; sandboxed: boolean };
  isError?: boolean;
  artifact?: { path: string; name?: string; method: 'automatic' | 'deliver_tool'; changeKind?: 'create' | 'modify' };
}

export interface ToolAuthorizationDescriptor {
  /** External/file mutation; Main-owned memory and notebook writes retain their separate authorization. */
  mutates: boolean;
  action: 'read_file' | 'write_file' | 'delete_file' | 'run_command' | 'external_side_effect';
  risk: 'low' | 'medium' | 'high';
  summary: string;
  targets: string[];
  purpose?: AuthorizationPurpose;
  capabilities?: ExecutionCapabilities;
}

export interface ApiToolExecutionAuthorization {
  policy?: ApiToolExecutionPolicy;
  /** Main runtime only, after an explicit command_native allow_once. Not model arguments. */
  nativeCommandApproved?: boolean;
  externalWritePath?: string;
  /** Exact files created by an approved outside-workspace write in this run. */
  externalReadPaths?: ReadonlySet<string>;
}

export type ApiToolSource = 'workspace' | 'attachment' | 'asterium' | 'web' | 'mcp' | 'skill';
export interface ApiToolExecutionPolicy { permissionMode: PermissionMode; planMode: PlanMode; }
export interface ApiExtensionTrustControl {
  kind?: 'mcp' | 'skill';
  extensionId: string; name: string; generation: number;
  state(policy: ApiToolExecutionPolicy): Promise<'untrusted' | 'pending' | 'trusted'>;
  prepare(policy: ApiToolExecutionPolicy): Promise<string>;
  confirm(token: string, policy: ApiToolExecutionPolicy, signal: AbortSignal): Promise<void>;
  discard(token: string): void;
}

export interface ApiToolRegistration {
  definition: ApiToolDefinition;
  /** UI classification only; the model-facing definition and execution key stay unchanged. */
  presentationName?: string;
  source: ApiToolSource;
  /** Explicit opt-in; a new registration is unavailable in Plan by default. */
  allowInPlan?: boolean;
  /** Optional pure domain validation, before approval or execution. */
  validate?: (args: Record<string, unknown>) => void;
  argumentsValidator?: (args: Record<string, unknown>) => Record<string, unknown>;
  guard?: (args: Record<string, unknown>, policy: ApiToolExecutionPolicy) => Promise<void>;
  extensionTrust?: ApiExtensionTrustControl;
  describe: (args: Record<string, unknown>) => ToolAuthorizationDescriptor;
  execute: (args: Record<string, unknown>, signal: AbortSignal, authorization: ApiToolExecutionAuthorization) => Promise<ApiToolResult>;
}

export interface PreparedApiTool {
  readonly presentationName?: string;
  readonly source: ApiToolSource;
  readonly allowInPlan: boolean;
  readonly descriptor: ToolAuthorizationDescriptor;
  readonly extensionTrust?: ApiExtensionTrustControl;
  guard?(policy: ApiToolExecutionPolicy): Promise<void>;
  execute(signal: AbortSignal, authorization?: ApiToolExecutionAuthorization): Promise<ApiToolResult>;
}

/** Compile the current built-in schemas once, matching the definitions advertised to the provider. */
export function compileApiToolArguments(definition: ApiToolDefinition) {
  const validator = z.fromJSONSchema(definition.parameters);
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const result = validator.safeParse(args);
    if (!result.success) {
      const location = result.error.issues[0]?.path.join('.') || 'arguments';
      throw new Error(`TOOL_ARGUMENT_INVALID:${location}`);
    }
    if (typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) throw new Error('TOOL_ARGUMENTS_NOT_OBJECT');
    return result.data as Record<string, unknown>;
  };
}

/** A per-runtime catalog. Only registered, schema-valid calls can reach a handler. */
export class ApiToolRegistry {
  private readonly entries = new Map<string, { registration: ApiToolRegistration; validate: ReturnType<typeof compileApiToolArguments> }>();

  register(input: ApiToolRegistration) {
    if (this.entries.has(input.definition.name)) throw new Error('API_TOOL_ALREADY_REGISTERED');
    const registration = { ...input, definition: structuredClone(input.definition) };
    this.entries.set(registration.definition.name, { registration, validate: registration.argumentsValidator ?? compileApiToolArguments(registration.definition) });
  }

  has(name: string) { return this.entries.has(name); }

  get definitions(): ApiToolDefinition[] {
    return [...this.entries.values()].map(({ registration }) => structuredClone(registration.definition));
  }

  prepare(name: string, args: Record<string, unknown>): PreparedApiTool {
    const entry = this.entries.get(name);
    if (!entry) throw new Error('TOOL_NOT_AVAILABLE');
    const { registration } = entry;
    const validated = entry.validate(args);
    registration.validate?.(validated);
    return {
      presentationName: registration.presentationName,
      source: registration.source,
      allowInPlan: registration.allowInPlan === true,
      descriptor: registration.describe(validated),
      extensionTrust: registration.extensionTrust,
      guard: registration.guard ? (policy) => registration.guard!(validated, policy) : undefined,
      execute: async (signal, authorization = {}) => {
        if (signal.aborted) throw Object.assign(new Error('ABORTED'), { name: 'AbortError' });
        return registration.execute(validated, signal, authorization);
      },
    };
  }
}
