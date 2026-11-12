import type { SingleChatMessageStore } from '../../conversation/SingleChatMessageStore';
import type { StudioRoomStore } from '../../studio/StudioRoomStore';
import type { MemoryFallbackSettingsStore } from './MemoryFallbackSettingsStore';
import { singleChatFallbackInputs, studioFallbackInputs } from './MemoryFallbackInputs';
import type { MemoryFallbackJobStore } from './MemoryFallbackJobStore';

/** One serialized authoritative inventory, including when fallback is switched off. */
export class MemoryFallbackInventory {
  private pending?: Promise<void>;
  private refreshRequested = false;
  private ready = false;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly singles: Pick<SingleChatMessageStore, 'list'>, private readonly studio: Pick<StudioRoomStore, 'listAll'>,
    private readonly jobs: MemoryFallbackJobStore, private readonly settings: MemoryFallbackSettingsStore, private readonly eligible: (id: string) => boolean) {}
  activate() { this.ready = true; return this.refresh(); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  refresh() {
    if (!this.ready) return Promise.resolve();
    this.refreshRequested = true;
    if (this.pending) return this.pending;
    const work = Promise.resolve().then(async () => {
      while (this.refreshRequested) {
        this.refreshRequested = false;
        const [singles, rooms, settings] = await Promise.all([this.singles.list(this.eligible), this.studio.listAll(), this.settings.get()]);
        await this.jobs.sync([...singleChatFallbackInputs(singles), ...studioFallbackInputs(rooms)].filter((input) => this.eligible(input.partnerId)));
        for (const [id, config] of Object.entries(settings.partners)) if (config.enabled) await this.jobs.applyEnablement(id, config.enabledAt, config.history);
        for (const listener of this.listeners) listener();
      }
    }).finally(() => {
      if (this.pending === work) this.pending = undefined;
    });
    this.pending = work;
    return work;
  }
}
