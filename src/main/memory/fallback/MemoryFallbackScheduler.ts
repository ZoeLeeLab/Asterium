import { randomUUID } from 'node:crypto';
import type { MemoryFallbackSettings, MemoryFallbackSnapshot, MemoryFallbackJobStatus } from '../../../shared/memoryFallback';
import type { ApiProviderAdapter } from '../../api/ApiProviderAdapter';
import type { MemoryFallbackSettingsStore } from './MemoryFallbackSettingsStore';
import type { MemoryFallbackInventory } from './MemoryFallbackInventory';
import type { FallbackJob, MemoryFallbackJobStore } from './MemoryFallbackJobStore';
import type { MemoryConsolidation } from './MemoryConsolidation';

const ATTEMPT_DEADLINE = 120_000;
export class MemoryFallbackScheduler {
  private interval?: ReturnType<typeof setInterval>;
  private intervalMs = 0;
  private nextPollAt = 0;
  private running?: Promise<void>;
  private disposed = false;
  private active?: { job: FallbackJob; config: MemoryFallbackSettings; controller: AbortController };
  private waitController?: AbortController;
  constructor(private readonly settings: Pick<MemoryFallbackSettingsStore, 'get'>, private readonly jobs: MemoryFallbackJobStore,
    private readonly inventory: Pick<MemoryFallbackInventory, 'refresh'>, private readonly consolidation: Pick<MemoryConsolidation, 'execute' | 'recover'>,
    private readonly createAdapter: (config: MemoryFallbackSettings) => Promise<ApiProviderAdapter>, private readonly eligible: (id: string) => boolean,
    private readonly now = () => Date.now()) {}

  async start() {
    if (this.disposed || this.interval) return;
    await this.reconfigure();
    void this.tick(); // Exactly one startup scan; persisted budgets and cooldowns remain authoritative.
  }
  async reconfigure() {
    const intervalMs = (await this.settings.get()).intervalMinutes * 60_000;
    if (this.disposed) return;
    if (this.intervalMs === intervalMs && this.interval) return;
    if (this.interval) clearInterval(this.interval);
    this.intervalMs = intervalMs; this.nextPollAt = this.now() + intervalMs;
    this.interval = setInterval(() => {
      this.nextPollAt = this.now() + this.intervalMs;
      void this.tick();
    }, intervalMs);
    this.interval.unref?.();
  }
  cancelCurrent() { this.active?.controller.abort(); this.waitController?.abort(); }
  async revalidate() {
    const active = this.active;
    if (active && !await this.allowed(active.job, active.config)) active.controller.abort();
  }
  async snapshot(): Promise<MemoryFallbackSnapshot> {
    const [settings, jobs] = await Promise.all([this.settings.get(), this.jobs.list()]);
    const grouped = new Map<string, MemoryFallbackJobStatus>();
    for (const job of jobs) {
      const current = grouped.get(job.partnerId);
      const state = this.active?.job.key === job.key ? 'running' : job.dirty && job.round ? 'waiting_retry' : 'waiting_idle';
      grouped.set(job.partnerId, { partnerId: job.partnerId, state: current?.state === 'running' ? 'running' : state,
        lastSuccessAt: [current?.lastSuccessAt, job.lastSuccessAt].filter((value): value is string => Boolean(value)).sort().at(-1) });
    }
    return { settings, jobs: [...grouped.values()] };
  }
  tick(): Promise<void> {
    if (this.disposed || this.running) return this.running ?? Promise.resolve();
    const work = this.scan().catch(() => { console.error('Memory fallback scan deferred; pending jobs retained.'); }).finally(() => { if (this.running === work) this.running = undefined; });
    this.running = work;
    return work;
  }
  async dispose() {
    this.disposed = true;
    if (this.interval) clearInterval(this.interval);
    this.cancelCurrent();
    await this.running;
  }
  private async scan() {
    await this.inventory.refresh();
    const config = await this.settings.get();
    if (!config.credentialConfigured || this.disposed) return;
    const candidates = (await this.jobs.list()).filter((job) => this.due(job, config)).sort((a, b) => (a.lastSuccessAt ?? '').localeCompare(b.lastSuccessAt ?? '') || a.lastMessageAt.localeCompare(b.lastMessageAt) || a.key.localeCompare(b.key));
    for (const candidate of candidates) {
      if (this.disposed) return;
      await this.process(candidate, config).catch(() => { console.error('Memory fallback job deferred; other jobs will continue.'); });
    }
  }
  private due(job: FallbackJob, config: MemoryFallbackSettings) {
    return job.dirty && !job.busy && this.eligible(job.partnerId) && config.partners[job.partnerId]?.enabled
      && this.now() - Date.parse(job.lastMessageAt) >= config.intervalMinutes * 60_000
      && (!job.round || job.round.attempts < 3 || this.now() >= Math.max(Date.parse(job.round.blockedUntil), Date.parse(job.round.nextAttemptAt)));
  }
  private async allowed(job: FallbackJob, config: MemoryFallbackSettings) {
    if (this.disposed) return false;
    const [current, settings] = await Promise.all([this.jobs.get(job.key), this.settings.get()]);
    return Boolean(!this.disposed && current && this.due({ ...current, round: undefined }, settings) && settings.credentialConfigured
      && settings.endpoint === config.endpoint && settings.model === config.model && settings.partners[job.partnerId]?.enabledAt === config.partners[job.partnerId]?.enabledAt
      && job.messages.every((message) => current.messages.some((item) => item.messageId === message.messageId && item.hash === message.hash)));
  }
  private async process(candidate: FallbackJob, config: MemoryFallbackSettings) {
    let job = (await this.jobs.get(candidate.key))!;
    if (!job || !await this.allowed(job, config)) return;
    if (job.round?.operationId) {
      const recovered = await this.consolidation.recover(job, job.round.operationId);
      if (recovered) { await this.jobs.complete(job.key, recovered); return; }
    }
    if (!job.round || job.round.attempts >= 3) {
      job = (await this.jobs.change(job.key, (current) => { current.round = { id: randomUUID(), attempts: 0, nextAttemptAt: new Date(this.now()).toISOString(), blockedUntil: new Date(this.nextPollAt || this.now() + config.intervalMinutes * 60_000).toISOString(), operationId: randomUUID() }; }))!;
    }
    while (job?.round && job.round.attempts < 3 && !this.disposed) {
      if (!await this.allowed(job, config)) return;
      const delay = Date.parse(job.round.nextAttemptAt) - this.now();
      if (delay > 0) {
        this.waitController = new AbortController();
        try { await abortableDelay(delay, this.waitController.signal); } catch { return; }
        finally { this.waitController = undefined; }
        if (!await this.allowed(job, config)) return;
      }
      const operationId = job.round.operationId ?? job.round.id;
      // Recover a durable receipt without spending a new API attempt.
      const recovered = await this.consolidation.recover(job, operationId);
      if (recovered) { await this.jobs.complete(job.key, recovered); return; }
      job = (await this.jobs.change(job.key, (current) => {
        current.round!.attempts++;
        current.round!.nextAttemptAt = new Date(this.now() + ATTEMPT_DEADLINE).toISOString();
        current.round!.blockedUntil = new Date(Math.max(this.nextPollAt, this.now() + ATTEMPT_DEADLINE)).toISOString();
      }))!;
      if (!job) return;
      const controller = new AbortController(); this.active = { job, config, controller };
      const timer = setTimeout(() => controller.abort(new Error('MEMORY_FALLBACK_TIMEOUT')), ATTEMPT_DEADLINE);
      try {
        const result = await untilAborted((async () => {
          const adapter = await this.createAdapter(config);
          return this.consolidation.execute(job, operationId, adapter, controller.signal, () => this.allowed(job, config));
        })(), controller.signal);
        await this.jobs.complete(job.key, result);
        return;
      } catch {
        const interrupted = this.disposed || !await this.allowed(job, config);
        job = (await this.jobs.change(job.key, (current) => {
          const round = current.round!;
          round.nextAttemptAt = new Date(this.now() + (round.attempts === 1 ? 30_000 : round.attempts === 2 ? 120_000 : 0)).toISOString();
          if (round.attempts >= 3) round.blockedUntil = new Date(this.nextPollAt > this.now() ? this.nextPollAt : this.now() + config.intervalMinutes * 60_000).toISOString();
        }))!;
        if (interrupted) return;
      } finally { clearTimeout(timer); this.active = undefined; }
    }
  }
}
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('MEMORY_FALLBACK_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('MEMORY_FALLBACK_CANCELLED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
