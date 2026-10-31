import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  extensionBindingSchema, extensionConfigurationSchema, extensionIdSchema, extensionSecretsSchema,
  extensionTargetSchema, extensionTrustSchema, extensionUpsertSchema, mcpInstallSchema,
  type ApiExtensionsSnapshot, type ApiExtensionSummary,
} from '../../shared/apiExtensions';
import type { PermissionMode, PlanMode } from '../../shared/agentProtocol';
import { API_EXTENSION_CREDENTIAL_PREFIX, type CredentialStore } from '../security/CredentialStore';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';
import { executionPermissions } from '../execution/ExecutionPermissions';

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const recordSchema = z.object({
  id: extensionIdSchema, name: z.string().trim().min(1).max(120), enabled: z.boolean(),
  configuration: extensionConfigurationSchema,
  credentialRef: z.string().optional(), secretNames: z.array(z.string()).max(128),
  generation: counter, inventoryDigest: digest.optional(),
  trust: z.enum(['untrusted', 'pending', 'trusted']), trustedFingerprint: digest.optional(),
}).strict().superRefine((entry, context) => {
  if (entry.credentialRef && !ownsCredential(entry.id, entry.credentialRef)) context.addIssue({ code: 'custom', message: 'Foreign credential reference' });
  if (Boolean(entry.credentialRef) !== Boolean(entry.secretNames.length) || (entry.configuration.type === 'skill' && entry.credentialRef)) context.addIssue({ code: 'custom', message: 'Invalid secret metadata' });
  if ((entry.trust === 'trusted' && (!entry.inventoryDigest || entry.trustedFingerprint !== fingerprint(entry)))
    || (entry.trust !== 'trusted' && entry.trustedFingerprint)) context.addIssue({ code: 'custom', message: 'Invalid trust fingerprint' });
});
type ExtensionRecord = z.infer<typeof recordSchema>;
const fileSchema = z.object({
  format: z.literal(1), version: counter,
  extensions: z.array(recordSchema).max(256),
  bindings: z.array(z.object({ partnerId: z.string().min(1).max(200), extensionIds: z.array(extensionIdSchema).max(256),
    revisions: z.record(extensionIdSchema, counter).refine((value) => Object.keys(value).length <= 256).default({}),
  }).strict()).max(10_000),
}).strict().superRefine((file, context) => {
  const ids = new Set(file.extensions.map((entry) => entry.id));
  if (ids.size !== file.extensions.length || new Set(file.bindings.map((item) => item.partnerId)).size !== file.bindings.length
    || file.bindings.some((item) => new Set(item.extensionIds).size !== item.extensionIds.length || item.extensionIds.some((id) => !ids.has(id)) || Object.keys(item.revisions).some((id) => !ids.has(id)))) {
    context.addIssue({ code: 'custom', message: 'Invalid extension references' });
  }
});
type ExtensionFile = z.infer<typeof fileSchema>;
export interface ExtensionApprovalPolicy { permissionMode: PermissionMode; planMode: PlanMode }
interface PendingApproval { id: string; generation: number; fingerprint: string; partnerId?: string; bindingRevision?: number }
export interface ApiExtensionChange { snapshot: ApiExtensionsSnapshot; inventoryOrigin?: symbol }

/** One serialized authority for configuration, bindings and trust. No process launch or file loading. */
export class ApiExtensionStore {
  private readonly data: AtomicJsonStore<ExtensionFile>;
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(change: ApiExtensionChange) => void>();

  constructor(filePath: AtomicJsonStorePath,
    private readonly credentials: Pick<CredentialStore, 'save' | 'get' | 'delete'>,
    private readonly eligiblePartner: (partnerId: string) => boolean | Promise<boolean>,
    private readonly cleanupError: () => void = () => console.warn('API_EXTENSION_CREDENTIAL_CLEANUP_FAILED'),
  ) {
    this.data = new AtomicJsonStore({ filePath, empty: () => ({ format: 1, version: 0, extensions: [], bindings: [] }), decode: (value) => fileSchema.parse(value) });
  }

  async get(): Promise<ApiExtensionsSnapshot> { return snapshot(await this.data.read()); }
  subscribe(listener: (change: ApiExtensionChange) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  upsert(value: unknown) {
    const input = extensionUpsertSchema.parse(value);
    return this.data.runExclusive(async () => {
      const file = await this.data.readNow();
      assertVersion(file, input.expectedVersion);
      const existing = input.id ? find(file, input.id) : undefined;
      if (existing && kind(existing) !== (input.configuration.type === 'skill' ? 'skill' : 'mcp')) throw new Error('API_EXTENSION_KIND_IMMUTABLE');
      const id = existing?.id ?? `extension-${randomUUID()}`;
      const preserve = existing?.configuration.type === input.configuration.type && input.secrets === undefined;
      let credentialRef = preserve ? existing.credentialRef : undefined;
      let secretNames = preserve ? existing.secretNames : [];
      const newSecrets = input.secrets && Object.keys(input.secrets).length ? input.secrets : undefined;
      if (newSecrets) {
        credentialRef = await this.credentials.save(JSON.stringify(newSecrets), `${API_EXTENSION_CREDENTIAL_PREFIX}${id}-${randomUUID()}`);
        secretNames = Object.keys(newSecrets).sort();
      }
      const criticalChange = !existing || canonical(existing.configuration) !== canonical(input.configuration)
        || existing.credentialRef !== credentialRef || existing.enabled !== input.enabled;
      const entry: ExtensionRecord = {
        id, name: input.name, enabled: input.enabled, configuration: input.configuration, credentialRef, secretNames,
        generation: (existing?.generation ?? 0) + Number(criticalChange),
        inventoryDigest: criticalChange ? undefined : existing?.inventoryDigest,
        trust: existing?.trust === 'untrusted' || !existing ? 'untrusted' : criticalChange ? 'pending' : existing.trust,
        trustedFingerprint: criticalChange ? undefined : existing?.trustedFingerprint,
      };
      if (existing) file.extensions[file.extensions.indexOf(existing)] = entry;
      else file.extensions.push(entry);
      try { await this.commit(file); }
      catch (error) { if (newSecrets && credentialRef) await this.cleanup(credentialRef); throw error; }
      if (criticalChange) this.forgetApprovals(id);
      if (existing?.credentialRef && existing.credentialRef !== credentialRef) await this.cleanup(existing.credentialRef);
      return snapshot(file);
    });
  }

  remove(value: unknown) {
    const input = extensionTargetSchema.parse(value);
    return this.data.runExclusive(async () => {
      const file = await this.data.readNow(); assertVersion(file, input.expectedVersion);
      const entry = find(file, input.id);
      file.extensions = file.extensions.filter((item) => item !== entry);
      file.bindings = file.bindings.map((binding) => ({ ...binding, extensionIds: binding.extensionIds.filter((id) => id !== entry.id),
        revisions: Object.fromEntries(Object.entries(binding.revisions).filter(([id]) => id !== entry.id)),
      })).filter((binding) => binding.extensionIds.length || Object.keys(binding.revisions).length);
      await this.commit(file); this.forgetApprovals(entry.id);
      if (entry.credentialRef) await this.cleanup(entry.credentialRef);
      return snapshot(file);
    });
  }

  setBinding(value: unknown) {
    const input = extensionBindingSchema.parse(value);
    return this.data.runExclusive(async () => {
      const file = await this.data.readNow(); assertVersion(file, input.expectedVersion);
      if (!await this.eligiblePartner(input.partnerId)) throw new Error('API_EXTENSION_PARTNER_INELIGIBLE');
      for (const id of input.extensionIds) find(file, id);
      const previous = file.bindings.find((item) => item.partnerId === input.partnerId);
      const revisions = { ...previous?.revisions };
      for (const id of new Set([...(previous?.extensionIds ?? []), ...input.extensionIds])) {
        if (Boolean(previous?.extensionIds.includes(id)) !== input.extensionIds.includes(id)) revisions[id] = (revisions[id] ?? 0) + 1;
      }
      file.bindings = file.bindings.filter((item) => item.partnerId !== input.partnerId);
      // Keep tombstone revisions after unbinding, so rebind never revives an older prepared call.
      if (input.extensionIds.length || Object.keys(revisions).length) file.bindings.push({ partnerId: input.partnerId, extensionIds: input.extensionIds, revisions });
      await this.commit(file); return snapshot(file);
    });
  }

  setTrust(value: unknown) {
    const input = extensionTrustSchema.parse(value);
    return this.data.runExclusive(async () => {
      const file = await this.data.readNow(); assertVersion(file, input.expectedVersion);
      const entry = find(file, input.id);
      // Re-requesting cannot downgrade established trust; revocation is explicit.
      if (input.action === 'revoke' || entry.trust !== 'trusted') {
        entry.trust = input.action === 'request' ? 'pending' : 'untrusted';
        entry.trustedFingerprint = undefined; entry.generation++;
      }
      await this.commit(file); this.forgetApprovals(entry.id); return snapshot(file);
    });
  }

  /** Main-only: input is the actually discovered tool schemas or skill package manifest, never IPC hashes. */
  recordInventory(id: string, expectedGeneration: number, manifest: unknown, origin?: symbol) {
    const inventoryDigest = hash(canonical(manifest));
    return this.data.runExclusive(async () => {
      const file = await this.data.readNow(); const entry = find(file, id);
      if (entry.generation !== expectedGeneration) throw new Error('API_EXTENSION_STALE_GENERATION');
      if (entry.inventoryDigest !== inventoryDigest) {
        entry.inventoryDigest = inventoryDigest; invalidate(entry);
        await this.commit(file, origin); this.forgetApprovals(id);
      }
      return summary(entry);
    });
  }

  /** A server announced a changed catalog. Keep no usable old approval while rediscovery is pending. */
  invalidateInventory(id: string, expectedGeneration: number, origin: symbol) {
    return this.data.runExclusive(async () => {
      const file = await this.data.readNow(); const entry = find(file, id);
      if (entry.generation !== expectedGeneration) throw new Error('API_EXTENSION_STALE_GENERATION');
      if (!entry.inventoryDigest) return summary(entry);
      entry.inventoryDigest = undefined; invalidate(entry);
      await this.commit(file, origin); this.forgetApprovals(id);
      return summary(entry);
    });
  }

  /** Reserved for S4's Main-owned pending authorization. Tokens are ephemeral, single-use, never a management IPC. */
  prepareTrustApproval(id: string, policy: ExtensionApprovalPolicy, partnerId?: string) {
    executionPermissions.assertTrustApproval(policy);
    return this.data.runExclusive(async () => {
      const file = await this.data.readNow(), entry = find(file, id);
      if (!entry.enabled || entry.trust !== 'pending' || !entry.inventoryDigest) throw new Error('API_EXTENSION_TRUST_NOT_READY');
      const revision = partnerId ? bindingRevision(file, partnerId, id) : undefined;
      if (partnerId && (revision === undefined || !await this.eligiblePartner(partnerId))) throw new Error('API_EXTENSION_APPROVAL_EXPIRED');
      const token = randomUUID();
      this.approvals.set(token, { id, generation: entry.generation, fingerprint: fingerprint(entry), partnerId, bindingRevision: revision });
      return token;
    });
  }

  confirmTrustApproval(token: string, policy: ExtensionApprovalPolicy, partnerId?: string, checkContext?: () => Promise<void>) {
    const approval = this.approvals.get(token); this.approvals.delete(token);
    executionPermissions.assertTrustApproval(policy);
    return this.data.runExclusive(async () => {
      if (!approval) throw new Error('API_EXTENSION_APPROVAL_EXPIRED');
      const file = await this.data.readNow(); const entry = find(file, approval.id);
      if (approval.partnerId && (approval.partnerId !== partnerId || bindingRevision(file, approval.partnerId, entry.id) !== approval.bindingRevision)) throw new Error('API_EXTENSION_APPROVAL_EXPIRED');
      if (partnerId && (!await this.eligiblePartner(partnerId) || !file.bindings.some((binding) => binding.partnerId === partnerId && binding.extensionIds.includes(entry.id)))) throw new Error('API_EXTENSION_APPROVAL_EXPIRED');
      await checkContext?.();
      if (!entry.enabled || entry.trust !== 'pending' || entry.generation !== approval.generation || fingerprint(entry) !== approval.fingerprint) throw new Error('API_EXTENSION_APPROVAL_EXPIRED');
      entry.trust = 'trusted'; entry.trustedFingerprint = approval.fingerprint;
      await this.commit(file); this.forgetApprovals(entry.id); return snapshot(file);
    });
  }

  discardTrustApproval(token: string) { this.approvals.delete(token); }

  /** Future runtime must still enforce registry policy/scopes before consulting this metadata. */
  async enabledForPartner(partnerId: string) {
    if (!await this.eligiblePartner(partnerId)) return [];
    const file = await this.data.read(); const ids = new Set(file.bindings.find((item) => item.partnerId === partnerId)?.extensionIds ?? []);
    return file.extensions.filter((entry) => entry.enabled && ids.has(entry.id)).map(summary);
  }

  /** Main-only monotonic authority for one partner/extension binding; not a management capability. */
  async bindingRevision(partnerId: string, id: string) { return bindingRevision(await this.data.read(), partnerId, id); }

  /** Main-only metadata for this partner, including disabled entries. Never exposes other bindings or secret values. */
  async configuredForPartner(partnerId: string) {
    if (!await this.eligiblePartner(partnerId)) throw new Error('API_EXTENSION_PARTNER_INELIGIBLE');
    const file = await this.data.read(), ids = new Set(file.bindings.find((binding) => binding.partnerId === partnerId)?.extensionIds ?? []);
    return file.extensions.filter((entry) => ids.has(entry.id)).map(summary);
  }

  /** Atomic, approval-gated model installation. It can only add an untrusted MCP and bind the speaking API partner. */
  installMcpForPartner(partnerId: string, expectedVersion: number, value: unknown, checkContext: () => Promise<void>) {
    const input = mcpInstallSchema.parse(value);
    return this.data.runExclusive(async () => {
      const file = await this.data.readNow(); assertVersion(file, expectedVersion);
      if (!await this.eligiblePartner(partnerId)) throw new Error('API_EXTENSION_PARTNER_INELIGIBLE');
      await checkContext();
      const binding = file.bindings.find((item) => item.partnerId === partnerId);
      const existing = file.extensions.find((entry) => binding?.extensionIds.includes(entry.id) && entry.name === input.name);
      if (existing) {
        if (kind(existing) !== 'mcp' || canonical(existing.configuration) !== canonical(input.configuration)) throw new Error('API_MCP_NAME_CONFLICT');
        if (!existing.enabled) throw new Error('API_MCP_DISABLED_USE_SETTINGS');
        return { extension: summary(existing), reused: true };
      }
      const entry: ExtensionRecord = { id: `extension-${randomUUID()}`, name: input.name, configuration: input.configuration,
        enabled: true, generation: 1, secretNames: [], trust: 'untrusted' };
      file.extensions.push(entry);
      if (binding) { binding.extensionIds.push(entry.id); binding.revisions[entry.id] = 1; }
      else file.bindings.push({ partnerId, extensionIds: [entry.id], revisions: { [entry.id]: 1 } });
      await this.commit(file);
      return { extension: summary(entry), reused: false };
    });
  }

  /** Linearization point: validate authority under the mutation queue, start once, then release before I/O completes. */
  dispatchForPartner<T>(partnerId: string, id: string, generation: number, dispatch: () => Promise<T>, checkContext?: () => Promise<void>, expectedBindingRevision?: number) {
    return this.data.runExclusive(async () => {
      const file = await this.data.readNow(); const entry = find(file, id);
      if (!await this.eligiblePartner(partnerId) || !entry.enabled || entry.generation !== generation
        || !file.bindings.some((binding) => binding.partnerId === partnerId && binding.extensionIds.includes(id))) throw new Error('MCP_AUTHORITY_CHANGED');
      if (expectedBindingRevision !== undefined && bindingRevision(file, partnerId, id) !== expectedBindingRevision) throw new Error('API_EXTENSION_BINDING_CHANGED');
      await checkContext?.();
      return { pending: dispatch() };
    });
  }

  /** Main-only launch credential resolution; callers must bind id + generation to their connection. */
  async connectionSecrets(id: string, expectedGeneration: number) {
    return this.data.runExclusive(async () => {
      const entry = find(await this.data.readNow(), id);
      if (!entry.enabled || entry.generation !== expectedGeneration) throw new Error('API_EXTENSION_STALE_GENERATION');
      if (!entry.credentialRef) return {};
      const secret = await this.credentials.get(entry.credentialRef);
      if (!secret) throw new Error('API_EXTENSION_CREDENTIAL_MISSING');
      try { return extensionSecretsSchema.parse(JSON.parse(secret)); }
      catch { throw new Error('API_EXTENSION_CREDENTIAL_INVALID'); }
    });
  }

  private async commit(file: ExtensionFile, inventoryOrigin?: symbol) {
    file.version++; await this.data.writeNow(fileSchema.parse(file));
    for (const listener of this.listeners) {
      try { listener({ snapshot: snapshot(file), inventoryOrigin }); }
      catch { console.warn('API_EXTENSION_CHANGE_LISTENER_FAILED'); }
    }
  }
  private forgetApprovals(id: string) { for (const [token, approval] of this.approvals) if (approval.id === id) this.approvals.delete(token); }
  private async cleanup(ref: string) { try { await this.credentials.delete(ref); } catch { this.cleanupError(); } }
}

function assertVersion(file: ExtensionFile, expected: number) { if (file.version !== expected) throw new Error('API_EXTENSIONS_VERSION_CONFLICT'); }
function find(file: ExtensionFile, id: string) { const entry = file.extensions.find((item) => item.id === id); if (!entry) throw new Error('API_EXTENSION_NOT_FOUND'); return entry; }
function kind(entry: Pick<ExtensionRecord, 'configuration'>) { return entry.configuration.type === 'skill' ? 'skill' as const : 'mcp' as const; }
function invalidate(entry: ExtensionRecord) { entry.generation++; if (entry.trust !== 'untrusted') entry.trust = 'pending'; entry.trustedFingerprint = undefined; }
function ownsCredential(id: string, ref: string) { return new RegExp(`^${API_EXTENSION_CREDENTIAL_PREFIX}${id}-[0-9a-f-]{36}$`).test(ref); }
function fingerprint(entry: { configuration: unknown; credentialRef?: string; inventoryDigest?: string }) { return hash(canonical({ configuration: entry.configuration, credentialRef: entry.credentialRef ?? null, inventoryDigest: entry.inventoryDigest ?? null })); }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  throw new Error('API_EXTENSION_MANIFEST_INVALID');
}
function summary(entry: ExtensionRecord): ApiExtensionSummary {
  return { id: entry.id, kind: kind(entry), name: entry.name, enabled: entry.enabled, configuration: structuredClone(entry.configuration), secretNames: [...entry.secretNames], hasSecrets: Boolean(entry.credentialRef), generation: entry.generation, inventoryKnown: Boolean(entry.inventoryDigest), trust: entry.trust };
}
function snapshot(file: ExtensionFile): ApiExtensionsSnapshot { return { version: file.version, extensions: file.extensions.map(summary), bindings: file.bindings.filter((binding) => binding.extensionIds.length).map(({ partnerId, extensionIds }) => ({ partnerId, extensionIds: [...extensionIds] })) }; }
function bindingRevision(file: ExtensionFile, partnerId: string, id: string) {
  const binding = file.bindings.find((item) => item.partnerId === partnerId);
  return binding?.extensionIds.includes(id) ? binding.revisions[id] ?? 0 : undefined;
}
