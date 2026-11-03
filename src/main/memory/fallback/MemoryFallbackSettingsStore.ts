import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../../storage/AtomicJsonStore';
import type { CredentialStore } from '../../security/CredentialStore';
import { createDefaultApiProviderRegistry } from '../../api/ApiProviderRegistry';
import { memoryFallbackProvider, fallbackModelsRequest, fallbackPartnerUpdate, fallbackSettingsUpdate, type MemoryFallbackProvider, type MemoryFallbackSettings } from '../../../shared/memoryFallback';
import type { ApiModelSummary } from '../../../shared/agentProtocol';

const providers = createDefaultApiProviderRegistry();
const schema = z.object({ version: z.literal(1), provider: memoryFallbackProvider, endpoint: z.string(), model: z.string(),
  credentialRef: z.string().regex(/^asterium-memory-fallback-api(?:-[a-f0-9-]{36})?$/).optional(),
  intervalMinutes: z.union([z.literal(15), z.literal(20), z.literal(30)]),
  partners: z.record(z.string(), z.object({ enabled: z.boolean(), enabledAt: z.string().datetime(), history: z.enum(['from_now', 'unprocessed']) })),
});
const CREDENTIAL = 'asterium-memory-fallback-api';
export class MemoryFallbackSettingsStore {
  private readonly storage: AtomicJsonStore<z.infer<typeof schema>>;
  constructor(filePath: AtomicJsonStorePath, private readonly credentials: Pick<CredentialStore, 'save' | 'get' | 'has' | 'delete'>,
    private readonly eligible: (partnerId: string) => boolean | Promise<boolean>, private readonly now = () => new Date().toISOString()) {
    this.storage = new AtomicJsonStore<z.infer<typeof schema>>({ filePath, empty: () => ({ version: 1, provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', intervalMinutes: 20, partners: {} }), decode: (value) => schema.parse(value) });
  }
  async get(): Promise<MemoryFallbackSettings> {
    return this.storage.runExclusive(async () => {
      const value = await this.storage.readNow();
      return { provider: value.provider, endpoint: value.endpoint, model: value.model, intervalMinutes: value.intervalMinutes,
        partners: structuredClone(value.partners), credentialConfigured: await this.credentials.has(value.credentialRef ?? CREDENTIAL).catch(() => false) };
    });
  }
  async secret(expected?: MemoryFallbackSettings) {
    return this.storage.runExclusive(async () => {
      const value = await this.storage.readNow();
      if (expected && (value.provider !== expected.provider || value.endpoint !== expected.endpoint || value.model !== expected.model)) throw new Error('MEMORY_FALLBACK_CANCELLED');
      return this.credentials.get(value.credentialRef ?? CREDENTIAL);
    });
  }
  async listModels(input: unknown, read: (provider: MemoryFallbackProvider, endpoint: string, apiKey: string) => Promise<ApiModelSummary[]>) {
    const request = fallbackModelsRequest.parse(input);
    const endpoint = providers.require(request.provider).normalizeEndpoint(request.endpoint);
    const apiKey = await this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      if (!request.apiKey && (request.provider !== current.provider || endpoint !== current.endpoint)) throw new Error('MEMORY_FALLBACK_NEW_CREDENTIAL_REQUIRED');
      return request.apiKey ?? await this.credentials.get(current.credentialRef ?? CREDENTIAL);
    });
    if (!apiKey) throw new Error('MEMORY_FALLBACK_CREDENTIAL_REQUIRED');
    return read(request.provider, endpoint, apiKey);
  }
  async configure(input: unknown) {
    const update = fallbackSettingsUpdate.parse(input);
    const endpoint = providers.require(update.provider).normalizeEndpoint(update.endpoint);
    if (update.clearCredential && update.apiKey) throw new Error('MEMORY_FALLBACK_CREDENTIAL_CONFLICT');
    await this.storage.runExclusive(async () => {
      const value = await this.storage.readNow();
      const previousRef = value.credentialRef ?? CREDENTIAL;
      if (!update.apiKey && !update.clearCredential && (update.provider !== value.provider || endpoint !== value.endpoint) && await this.credentials.has(previousRef)) throw new Error('MEMORY_FALLBACK_NEW_CREDENTIAL_REQUIRED');
      // A failed config write must not pair a new service's key with the old endpoint.
      const credentialRef = update.apiKey || update.clearCredential ? `${CREDENTIAL}-${randomUUID()}` : previousRef;
      if (update.apiKey) await this.credentials.save(update.apiKey, credentialRef);
      try {
        await this.storage.writeNow({ ...value, credentialRef, provider: update.provider, endpoint, model: update.model, intervalMinutes: update.intervalMinutes });
      } catch (error) {
        if (update.apiKey) await this.credentials.delete(credentialRef).catch(() => undefined);
        throw error;
      }
      if (credentialRef !== previousRef) await this.credentials.delete(previousRef).catch(() => console.error('Unused memory fallback credential could not be removed.'));
    });
    return this.get();
  }
  async setPartner(input: unknown) {
    const update = fallbackPartnerUpdate.parse(input);
    if (update.enabled && !await this.eligible(update.partnerId)) throw new Error('MEMORY_FALLBACK_PARTNER_NOT_ELIGIBLE');
    await this.storage.runExclusive(async () => {
      const value = await this.storage.readNow();
      const previous = value.partners[update.partnerId];
      if (update.enabled && !previous?.enabled && !update.history) throw new Error('MEMORY_FALLBACK_HISTORY_CHOICE_REQUIRED');
      value.partners[update.partnerId] = { enabled: update.enabled, enabledAt: update.enabled && !previous?.enabled ? this.now() : previous?.enabledAt ?? this.now(), history: update.history ?? previous?.history ?? 'from_now' };
      await this.storage.writeNow(value);
    });
    return this.get();
  }
}
