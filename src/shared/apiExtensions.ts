import { z } from 'zod';

const text = z.string().trim().min(1).max(2_048).refine((value) => !value.includes('\0'));
const absolutePath = text.refine((value) => /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value), 'Absolute Windows path required');
const secretName = z.string().min(1).max(256).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
export const extensionSecretsSchema = z.record(secretName, z.string().max(65_536)).refine((values) => Object.keys(values).length <= 128);
export const extensionConfigurationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mcp_stdio'), command: text, args: z.array(z.string().max(8_192).refine((v) => !v.includes('\0'))).max(128), cwd: absolutePath.optional(), workspaceGrantId: z.string().regex(/^workspace-[0-9a-f-]{36}$/).optional() }).strict(),
  z.object({ type: z.literal('mcp_http'), url: text.refine((value) => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash; } catch { return false; }
  }, 'HTTP(S) URL without embedded credentials or fragment required') }).strict(),
  z.object({ type: z.literal('skill'), directory: absolutePath }).strict(),
]);
export type ExtensionConfiguration = z.infer<typeof extensionConfigurationSchema>;
export type ExtensionKind = 'mcp' | 'skill';
export type ExtensionTrustState = 'untrusted' | 'pending' | 'trusted';
export interface ApiExtensionSummary {
  id: string;
  kind: ExtensionKind;
  name: string;
  enabled: boolean;
  configuration: ExtensionConfiguration;
  secretNames: string[];
  hasSecrets: boolean;
  generation: number;
  inventoryKnown: boolean;
  trust: ExtensionTrustState;
}
export interface ApiExtensionsSnapshot {
  version: number;
  extensions: ApiExtensionSummary[];
  bindings: { partnerId: string; extensionIds: string[] }[];
}
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const extensionIdSchema = z.string().regex(/^extension-[0-9a-f-]{36}$/);
export const extensionUpsertSchema = z.object({
  expectedVersion: version,
  id: extensionIdSchema.optional(),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  configuration: extensionConfigurationSchema,
  // Omitted preserves existing values for the same transport; null clears them.
  // stdio values become environment variables, HTTP values become headers.
  secrets: extensionSecretsSchema.nullable().optional(),
}).strict().superRefine((input, context) => {
  if (input.configuration.type === 'skill' && input.secrets && Object.keys(input.secrets).length) context.addIssue({ code: 'custom', message: 'Skills do not accept connection secrets' });
  if (input.configuration.type === 'mcp_http' && input.secrets) {
    const names = Object.keys(input.secrets).map((name) => name.toLowerCase());
    if (new Set(names).size !== names.length || names.some((name) => ['mcp-session-id', 'mcp-protocol-version'].includes(name)) || Object.values(input.secrets).some((value) => /[\r\n\0]/.test(value))) context.addIssue({ code: 'custom', message: 'Invalid HTTP headers (MCP session/version headers are transport-owned)' });
  }
});
export const extensionTargetSchema = z.object({ expectedVersion: version, id: extensionIdSchema }).strict();
export const extensionTrustSchema = extensionTargetSchema.extend({ action: z.enum(['request', 'revoke']) }).strict();
export const extensionBindingSchema = z.object({
  expectedVersion: version,
  partnerId: z.string().trim().min(1).max(200),
  extensionIds: z.array(extensionIdSchema).max(256).refine((ids) => new Set(ids).size === ids.length),
}).strict();
export type ExtensionUpsertRequest = z.infer<typeof extensionUpsertSchema>;
/** Model installation has no credential, trust, enabled-state or partner-selection fields. */
export const mcpInstallSchema = z.object({
  name: extensionUpsertSchema.shape.name,
  configuration: z.discriminatedUnion('type', [extensionConfigurationSchema.options[0].omit({ workspaceGrantId: true }), extensionConfigurationSchema.options[1]]),
}).strict();
export type McpInstallRequest = z.infer<typeof mcpInstallSchema>;
export type ExtensionTargetRequest = z.infer<typeof extensionTargetSchema>;
export type ExtensionTrustRequest = z.infer<typeof extensionTrustSchema>;
export type ExtensionBindingRequest = z.infer<typeof extensionBindingSchema>;
export const mcpConnectSchema = z.object({ id: extensionIdSchema, expectedGeneration: version }).strict();
export const mcpDisconnectSchema = z.object({ id: extensionIdSchema }).strict();
export interface McpConnectionStatus {
  extensionId: string;
  generation: number;
  state: 'connecting' | 'ready' | 'refreshing' | 'closed' | 'failed';
  backend: 'native' | 'sandbox';
  sandboxed: boolean;
  toolCount: number;
  errorCode?: string;
}

/** Management bridge only. Runtime/catalog/approval operations remain Main-only. */
export interface AsteriumExtensionsApi {
  get(): Promise<ApiExtensionsSnapshot>;
  upsert(input: ExtensionUpsertRequest): Promise<ApiExtensionsSnapshot>;
  remove(input: ExtensionTargetRequest): Promise<ApiExtensionsSnapshot>;
  setBinding(input: ExtensionBindingRequest): Promise<ApiExtensionsSnapshot>;
  setTrust(input: ExtensionTrustRequest): Promise<ApiExtensionsSnapshot>;
  connectMcp(input: z.infer<typeof mcpConnectSchema>): Promise<McpConnectionStatus>;
  disconnectMcp(input: z.infer<typeof mcpDisconnectSchema>): Promise<void>;
  mcpStatus(): Promise<McpConnectionStatus[]>;
}
