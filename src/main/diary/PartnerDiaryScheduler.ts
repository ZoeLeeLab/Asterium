import type { PartnerDiaryConfig, PartnerDiaryEntry } from '../../shared/partnerDiary';
import { diaryLogicalDate } from '../../shared/partnerDiary';
import type { SingleChatConversationSnapshot } from '../../shared/singleChatMessages';
import type { PartnerDiarySettingsStore } from './PartnerDiarySettingsStore';
import type { PartnerDiaryStore } from './PartnerDiaryStore';
import { diaryPrompt, diarySourceMessages } from './DiaryPrompt';
import type { WriterLeaseCoordinator } from '../runtime/WriterLeaseCoordinator';

export interface DiaryGeneration { config: PartnerDiaryConfig; entry: PartnerDiaryEntry; source: string; signal: AbortSignal; }
interface Dependencies {
  settings: Pick<PartnerDiarySettingsStore, 'list'>;
  store: (partnerId: string) => Promise<PartnerDiaryStore>;
  source: (conversationId: string) => Promise<SingleChatConversationSnapshot | undefined>;
  identity: (partnerId: string) => { available: boolean; threadId?: string } | undefined;
  generate: (input: DiaryGeneration) => Promise<string>;
  leases: Pick<WriterLeaseCoordinator, 'tryAcquire'>;
  now?: () => Date;
}
export class PartnerDiaryScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private disposed = false;
  private running?: Promise<void>;
  private epoch = 0;
  private signature = '';
  private active?: { config: PartnerDiaryConfig; controller: AbortController };
  constructor(private readonly options: Dependencies) {}
  private now() { return this.options.now?.() ?? new Date(); }
  async start() { if (this.started || this.disposed) return; this.started = true; await this.reschedule(); }
  async changed() {
    const active = this.active;
    if (active && !await this.allowed(active.config)) active.controller.abort();
    if (this.started) {
      const configs = await this.options.settings.list();
      if (this.configSignature(configs) !== this.signature) await this.reschedule();
    }
  }
  async dispose() {
    this.disposed = true; this.epoch++; if (this.timer) clearTimeout(this.timer); this.active?.controller.abort(); await this.running;
  }
  private async allowed(config: PartnerDiaryConfig) {
    if (this.disposed || !this.options.identity(config.partnerId)?.available) return false;
    const current = (await this.options.settings.list()).find((item) => item.partnerId === config.partnerId);
    const source = await this.options.source(config.conversationId);
    return Boolean(!this.disposed && current?.enabled && current.revision === config.revision && source?.partnerId === config.partnerId
      && (!config.upstreamThreadId || (source.sessionId === config.upstreamThreadId && this.options.identity(config.partnerId)?.threadId === config.upstreamThreadId)));
  }
  private async reschedule() {
    const epoch = ++this.epoch; if (this.timer) clearTimeout(this.timer);
    const configs = await this.options.settings.list(); if (epoch !== this.epoch || this.disposed) return;
    this.signature = this.configSignature(configs);
    const now = this.now();
    const future = configs.filter((config) => config.enabled && this.options.identity(config.partnerId)?.available).map((config) => {
      const [hour, minute] = config.time.split(':').map(Number); const due = new Date(now); due.setHours(hour, minute, 0, 0);
      if (due <= now) due.setDate(due.getDate() + 1); return { config, due };
    });
    if (!future.length) return;
    const next = Math.min(...future.map((item) => item.due.valueOf()));
    const selected = future.filter((item) => item.due.valueOf() === next);
    this.timer = setTimeout(() => {
      if (epoch !== this.epoch || this.disposed) return;
      // A late wakeup never replays missed daily schedules. Existing work never queues another round.
      if (this.running) { void this.reschedule(); return; }
      const missed = this.now().valueOf() - next >= 60_000 || diaryLogicalDate(this.now()) !== diaryLogicalDate(new Date(next));
      const work = this.run(selected.map((item) => item.config), diaryLogicalDate(new Date(next)), missed).catch(() => console.error('Diary schedule could not be completed; no retry will be started.')).finally(() => {
        this.running = undefined; if (!this.disposed) void this.reschedule();
      });
      this.running = work;
    }, Math.max(1, next - now.valueOf()));
    this.timer.unref?.();
  }
  private configSignature(configs: PartnerDiaryConfig[]) {
    return JSON.stringify(configs.map((config) => [config.partnerId, config.revision, this.options.identity(config.partnerId)?.available ?? false]));
  }
  private async run(configs: PartnerDiaryConfig[], date: string, missed: boolean) {
    for (const config of configs) {
      if (this.disposed || !await this.allowed(config)) continue;
      const store = await this.options.store(config.partnerId); const entry = await store.claim(date, config.conversationId); if (!entry) continue;
      let lease: ReturnType<Dependencies['leases']['tryAcquire']>;
      const finish = (state: 'skipped' | 'failed', reason: string) => store.finish(date, entry.generationId, { state, reason });
      try {
        if (missed) { await finish('skipped', 'missed_time'); continue; }
        const source = await this.options.source(config.conversationId);
        if (!source || source.partnerId !== config.partnerId) { await finish('skipped', 'source_deleted'); continue; }
        if (source.busy) { await finish('skipped', 'source_busy'); continue; }
        lease = this.options.leases.tryAcquire({ kind: 'conversation', partnerId: config.partnerId, conversationId: config.conversationId }, `diary:${entry.generationId}`);
        if (!lease) { await finish('skipped', 'source_busy'); continue; }
        const messages = diarySourceMessages(source, date, this.now());
        if (!messages.length) { await finish('skipped', 'no_messages'); continue; }
        const prompt = diaryPrompt(date, messages); const controller = new AbortController(); this.active = { config, controller };
        const timer = setTimeout(() => controller.abort(new Error('DIARY_TIMEOUT')), 120_000);
        try {
          const content = await abortable(this.options.generate({ config, entry, source: prompt, signal: controller.signal }), controller.signal);
          if (!await this.allowed(config) || diaryLogicalDate(this.now()) !== date) { await finish('skipped', 'configuration_changed'); continue; }
          await store.finish(date, entry.generationId, { state: 'completed', content: `# ${date}\n\n${content.replace(/^\s*#\s+\d{4}-\d{2}-\d{2}[^\r\n]*(?:\r?\n)*/u, '').trim()}\n` });
        } finally { clearTimeout(timer); this.active = undefined; }
      } catch (error) {
        const code = error instanceof Error && /^DIARY_[A-Z_]+$/u.test(error.message) ? error.message : 'DIARY_GENERATION_FAILED';
        await finish('failed', code).catch(() => undefined);
      } finally { lease?.release(); }
    }
  }
}
function abortable<T>(work: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('DIARY_CANCELLED')); signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)); if (signal.aborted) abort();
  });
}
