import type { PartnerProfileStore } from '../partner/PartnerProfileStore';
import { PartnerDiaryStore } from './PartnerDiaryStore';

export class PartnerDiaryService {
  private readonly stores = new Map<string, { directory: string; store: PartnerDiaryStore }>();
  private readonly initialized = new Set<string>();
  constructor(private readonly profiles: Pick<PartnerProfileStore, 'diaryDirectory' | 'partnerIds'>) {}
  async store(partnerId: string) {
    const directory = await this.profiles.diaryDirectory(partnerId);
    let cached = this.stores.get(partnerId);
    if (!cached || cached.directory !== directory) { cached = { directory, store: new PartnerDiaryStore(directory, partnerId) }; this.stores.set(partnerId, cached); }
    return cached.store;
  }
  async recover() {
    for (const partnerId of await this.profiles.partnerIds()) {
      if (this.initialized.has(partnerId)) continue;
      await (await this.store(partnerId)).recover(); this.initialized.add(partnerId);
    }
  }
  async list() {
    const entries = [];
    for (const partnerId of await this.profiles.partnerIds()) entries.push(...await (await this.store(partnerId)).list());
    return entries.sort((a, b) => b.date.localeCompare(a.date) || a.partnerId.localeCompare(b.partnerId));
  }
}
