import { z } from 'zod';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../../storage/AtomicJsonStore';
import type { CredentialStore } from '../../security/CredentialStore';
import { normalizeDeepSeekChatEndpoint } from '../../adapters/deepSeekModels';
import { fallbackModelsRequest, fallbackPartnerUpdate, fallbackSettingsUpdate, type MemoryFallbackSettings } from '../../../shared/memoryFallback';
import type { ApiModelSummary } from '../../../shared/agentProtocol';

const schema = z.object({ version: z.literal(1), provider: z.literal('deepseek'), endpoint: z.string(), model: z.string(),
  intervalMinutes: z.union([z.literal(15), z.literal(20), z.literal(30)]),
  partners: z.record(z.string(), z.object({ enabled: z.boolean(), enabledAt: z.string().datetime(), history: z.enum(['from_now', 'unprocessed']) })),
});
const CREDENTIAL = 'asterium-memory-fallback-api';
export class MemoryFallbackSettingsStore {
  private readonly storage: AtomicJsonStore<z.infer<typeof schema>>;
  constructor(filePath: AtomicJsonStorePath, private readonly credentials: Pick<CredentialStore, 'save' | 'get' | 'has' | 'delete'>,
    private readonly eligible: (partnerId: string) => boolean | Promise<boolean>, private readonly now = () => new Date().toISOString()) {
    this.storage = new AtomicJsonStore({ filePath, empty: () => ({ version: 1, provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', intervalMinutes: 20, partners: {} }), decode: (value) => schema.parse(value) });
  }
  async get(): Promise<MemoryFallbackSettings> {
    const value = await this.storage.read();
    return { provider: value.provider, endpoint: value.endpoint, model: value.model, intervalMinutes: value.intervalMinutes,
      partners: structuredClone(value.partners), credentialConfigured: await this.credentials.has(CREDENTIAL).catch(() => false) };
  }
  async secret() { return this.credentials.get(CREDENTIAL); }
  async listModels(input: unknown, read: (endpoint: string, apiKey: string) => Promise<ApiModelSummary[]>) {
    const request = fallbackModelsRequest.parse(input);
    const endpoint = normalizeDeepSeekChatEndpoint(request.endpoint);
    const apiKey = request.apiKey ?? await this.secret();
    if (!apiKey) throw new Error('MEMORY_FALLBACK_CREDENTIAL_REQUIRED');
    return read(endpoint, apiKey);
  }
  async configure(input: unknown) {
    const update = fallbackSettingsUpdate.parse(input);
    const endpoint = normalizeDeepSeekChatEndpoint(update.endpoint);
    if (update.clearCredential && update.apiKey) throw new Error('MEMORY_FALLBACK_CREDENTIAL_CONFLICT');
    await this.storage.runExclusive(async () => {
      const value = await this.storage.readNow();
      if (update.apiKey) await this.credentials.save(update.apiKey, CREDENTIAL);
      if (update.clearCredential) await this.credentials.delete(CREDENTIAL);
      await this.storage.writeNow({ ...value, provider: update.provider, endpoint, model: update.model, intervalMinutes: update.intervalMinutes });
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
