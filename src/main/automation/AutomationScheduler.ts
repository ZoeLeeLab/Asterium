import { AUTOMATION_CONCURRENCY, AUTOMATION_POLL_MS, type AutomationRun, type AutomationRunOutcome } from '../../shared/automations';
import { automationRunExpired, nextAutomation } from './AutomationSchedule';
import type { AutomationStore } from './AutomationStore';

export interface AutomationExecutionPort {
  check(run: AutomationRun): Promise<{ available: boolean; reason?: string }>;
  execute(run: AutomationRun, signal: AbortSignal): Promise<AutomationRunOutcome>;
}
export class AutomationScheduler {
  private started = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private armEpoch = 0;
  private scanning?: Promise<void>;
  private readonly active = new Map<string, { controller: AbortController; target: string }>();
  constructor(private readonly store: AutomationStore, private readonly port: AutomationExecutionPort, private readonly now = () => Date.now()) {}
  async start() { if (this.started || this.disposed) return; this.started = true; await this.store.recover(); await this.tick(); }
  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.scanning) return this.scanning;
    const scan = this.scan().catch(() => { console.error('Automation scan deferred; no uncommitted run dispatched.'); }).finally(() => {
      if (this.scanning === scan) this.scanning = undefined;
      if (!this.disposed && this.started) void this.arm();
    }); this.scanning = scan; return scan;
  }
  private async arm() {
    const epoch = ++this.armEpoch;
    if (this.timer) clearTimeout(this.timer);
    const snapshot = await this.store.snapshot().catch(() => undefined); if (this.disposed || !snapshot || epoch !== this.armEpoch) return;
    const next = snapshot.automations.map(d => nextAutomation(d, this.now())).filter((at): at is number => at !== undefined);
    const wait = Math.max(1, Math.min(AUTOMATION_POLL_MS, ...(next.map(at => at - this.now()))));
    this.timer = setTimeout(() => { void this.tick(); }, wait); this.timer.unref?.();
  }
  private async scan() {
    for (const d of (await this.store.snapshot()).automations) if (d.enabled && !d.deletedAt) await this.store.queueScheduled(d.id);
    const snapshot = await this.store.snapshot();
    for (const queued of snapshot.runs.filter(run => run.state === 'queued')) {
      if (this.disposed) return;
      if (automationRunExpired(queued, this.now())) { await this.store.transition(queued.id, ['queued'], { state: 'skipped', reason: 'expired' }); continue; }
      if (this.active.size >= AUTOMATION_CONCURRENCY) break;
      const t = queued.definition.target, key = JSON.stringify([t.partnerId, t.nativeThreadId]);
      if ([...this.active.values()].some(item => item.target === key)) continue;
      const check = await this.port.check(queued).catch(() => ({ available: false, reason: 'target_check_failed' }));
      if (!check.available) {
        if (queued.reason !== check.reason) await this.store.transition(queued.id, ['queued'], { reason: check.reason ?? 'target_unavailable' });
        continue;
      }
      // Re-read inside the atomic transition: pause/edit/delete may have revoked the queued run.
      const starting = await this.store.transition(queued.id, ['queued'], { state: 'starting', reason: '' }); if (!starting || this.disposed) continue;
      const controller = new AbortController(); this.active.set(starting.id, { controller, target: key });
      const running = await this.store.transition(starting.id, ['starting'], { state: 'running' }).catch(error => { this.active.delete(starting.id); throw error; });
      if (!running) { this.active.delete(starting.id); continue; }
      void Promise.resolve().then(() => this.port.execute(running, controller.signal)).then(
        outcome => { if (!this.disposed) return this.store.transition(running.id, ['running', 'waiting_approval'], outcome); },
        () => { if (!this.disposed) return this.store.transition(running.id, ['running', 'waiting_approval'], { state: 'uncertain', reason: 'delivery_unknown' }); },
      ).catch(() => { console.error('Automation outcome could not be persisted; reconciliation required.'); }).finally(() => {
        this.active.delete(running.id); if (!this.disposed) void this.tick();
      });
    }
  }
  async cancel(id: string) {
    const active = this.active.get(id);
    if (active) { active.controller.abort(); return; }
    await this.store.transition(id, ['queued'], { state: 'cancelled', reason: 'user_cancelled' });
  }
  async dispose() {
    this.disposed = true; this.armEpoch++; if (this.timer) clearTimeout(this.timer);
    await this.scanning;
    for (const [id, active] of this.active) { active.controller.abort(); await this.store.transition(id, ['starting', 'running', 'waiting_approval'], { state: 'uncertain', reason: 'application_closed' }); }
  }
}
