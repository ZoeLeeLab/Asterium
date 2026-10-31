import { z } from 'zod';
import { diaryConfigure, type PartnerDiaryConfig } from '../../shared/partnerDiary';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';

const configSchema = z.object({ partnerId: z.string().min(1), enabled: z.boolean(), conversationId: z.string().min(1), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  revision: z.number().int().positive(), upstreamThreadId: z.string().min(1).optional(), disabledReason: z.literal('source_deleted').optional() });
const schema = z.object({ version: z.literal(1), partners: z.record(z.string(), configSchema) });
export interface DiaryPartnerIdentity { sourceMode: 'api_partner' | 'local_cli' | 'existing_thread'; available: boolean; threadId?: string; }
export class PartnerDiarySettingsStore {
  private readonly storage: AtomicJsonStore<z.infer<typeof schema>>;
  constructor(filePath: AtomicJsonStorePath, private readonly source: (conversationId: string) => Promise<{ partnerId: string; sessionId?: string } | undefined>,
    private readonly partner: (id: string) => DiaryPartnerIdentity | undefined) {
    this.storage = new AtomicJsonStore({ filePath, empty: () => ({ version: 1, partners: {} }), decode: (value) => schema.parse(value) });
  }
  async list(): Promise<PartnerDiaryConfig[]> { return Object.values((await this.storage.read()).partners); }
  async configure(input: unknown): Promise<PartnerDiaryConfig> {
    const update = diaryConfigure.parse(input);
    const owner = this.partner(update.partnerId);
    const source = await this.source(update.conversationId);
    if (update.enabled && (!owner || !owner.available || !source || source.partnerId !== update.partnerId)) throw new Error('DIARY_SOURCE_NOT_AVAILABLE');
    if (update.enabled && owner?.sourceMode === 'existing_thread') {
      if (!update.acknowledgeUpstreamHistory) throw new Error('DIARY_UPSTREAM_HISTORY_ACK_REQUIRED');
      if (!owner.threadId || source?.sessionId !== owner.threadId) throw new Error('DIARY_UPSTREAM_THREAD_MISMATCH');
    }
    return this.storage.runExclusive(async () => {
      const data = await this.storage.readNow();
      const previous = data.partners[update.partnerId];
      const config: PartnerDiaryConfig = { partnerId: update.partnerId, enabled: update.enabled, conversationId: update.conversationId, time: update.time,
        revision: (previous?.revision ?? 0) + 1,
        ...(update.enabled && owner?.sourceMode === 'existing_thread' ? { upstreamThreadId: owner.threadId } : {}),
      };
      data.partners[update.partnerId] = config;
      await this.storage.writeNow(data); return config;
    });
  }
  async reconcileSources() {
    await this.storage.runExclusive(async () => {
      const data = await this.storage.readNow(); let changed = false;
      for (const config of Object.values(data.partners)) {
        if (config.enabled && !await this.source(config.conversationId)) { config.enabled = false; config.disabledReason = 'source_deleted'; config.revision++; changed = true; }
      }
      if (changed) await this.storage.writeNow(data);
    });
  }
}
