import type { PartnerEvent } from '../../shared/agentProtocol';
import { randomUUID } from 'node:crypto';
import { automationInputSchema, automationSnapshotSchema, AUTOMATION_ACTIVE_STATES, type Automation, type AutomationInput, type AutomationRun, type AutomationSnapshot } from '../../shared/automations';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';
import { automationOccurrenceId, automationRunExpired, dueAutomation } from './AutomationSchedule';

const clone = <T>(value: T): T => structuredClone(value);
export class AutomationStore {
  private readonly storage: AtomicJsonStore<AutomationSnapshot>;
  private readonly listeners = new Set<() => void>();
  constructor(filePath: AtomicJsonStorePath, private readonly now = () => Date.now()) {
    this.storage = new AtomicJsonStore({ filePath, empty: () => ({ version: 1, automations: [], runs: [] }), decode: value => automationSnapshotSchema.parse(value) });
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  snapshot() { return this.storage.read().then(clone); }
  private async mutate<T>(action: (data: AutomationSnapshot, at: string) => T) {
    return this.storage.runExclusive(async () => {
      const data = await this.storage.readNow(); const before = JSON.stringify(data); const result = action(data, new Date(this.now()).toISOString());
      const validated = automationSnapshotSchema.parse(data);
      if (before === JSON.stringify(validated)) return clone(result);
      await this.storage.writeNow(validated);
      for (const listener of this.listeners) { try { listener(); } catch { /* UI listeners cannot invalidate a committed mutation. */ } }
      return clone(result);
    });
  }
  create(input: AutomationInput, requestId: string) {
    const parsed = automationInputSchema.parse(input);
    if (!requestId || requestId.length > 256) throw new Error('AUTOMATION_REQUEST_ID_REQUIRED');
    const fingerprint = JSON.stringify(parsed);
    return this.mutate((data, at) => {
      const existing = data.automations.find(item => item.requestId === requestId);
      if (existing) { if (existing.requestFingerprint !== fingerprint) throw new Error('AUTOMATION_IDEMPOTENCY_CONFLICT'); return existing; }
      if (parsed.schedule.type === 'once' && Date.parse(parsed.schedule.at) <= this.now()) throw new Error('AUTOMATION_TIME_MUST_BE_FUTURE');
      const definition: Automation = { ...parsed, id: randomUUID(), revision: 1, scheduleRevision: 1, createdAt: at, updatedAt: at,
        effectiveFrom: new Date(this.now() + 1).toISOString(), requestId, requestFingerprint: fingerprint };
      data.automations.push(definition); return definition;
    });
  }
  update(id: string, revision: number, input: AutomationInput) {
    const parsed = automationInputSchema.parse(input);
    return this.mutate((data, at) => {
      const definition = data.automations.find(item => item.id === id && !item.deletedAt);
      if (!definition || definition.revision !== revision) throw new Error('AUTOMATION_REVISION_CONFLICT');
      const rescheduled = JSON.stringify(definition.schedule) !== JSON.stringify(parsed.schedule) || definition.timezone !== parsed.timezone || (!definition.enabled && parsed.enabled);
      if (rescheduled && parsed.schedule.type === 'once' && Date.parse(parsed.schedule.at) <= this.now()) throw new Error('AUTOMATION_TIME_MUST_BE_FUTURE');
      // Queued work uses the old instructions/target, so revoke it before accepting edits.
      for (const run of data.runs) if (run.automationId === id && run.state === 'queued') Object.assign(run, { state: 'cancelled', reason: 'configuration_changed', finishedAt: at, updatedAt: at });
      Object.assign(definition, parsed, { revision: definition.revision + 1, updatedAt: at });
      if (rescheduled) { definition.scheduleRevision++; definition.effectiveFrom = new Date(this.now() + 1).toISOString(); }
      return definition;
    });
  }
  remove(id: string, revision: number) {
    return this.mutate((data, at) => {
      const d = data.automations.find(item => item.id === id && !item.deletedAt);
      if (!d || d.revision !== revision) throw new Error('AUTOMATION_REVISION_CONFLICT');
      Object.assign(d, { enabled: false, deletedAt: at, updatedAt: at, revision: d.revision + 1 });
      for (const run of data.runs) if (run.automationId === id && run.state === 'queued') Object.assign(run, { state: 'cancelled', reason: 'automation_removed', finishedAt: at, updatedAt: at });
      return d;
    });
  }
  queueScheduled(id: string) {
    return this.mutate((data, at) => {
      const d = data.automations.find(item => item.id === id && !item.deletedAt); if (!d) return undefined;
      const due = dueAutomation(d, this.now()); if (due === undefined) return undefined;
      const occurrence = automationOccurrenceId(d, due);
      if (data.runs.some(run => run.occurrenceId === occurrence && !(run.state === 'cancelled' && run.reason === 'configuration_changed' && !run.startedAt))) return undefined;
      const active = data.runs.find(run => run.automationId === id && AUTOMATION_ACTIVE_STATES.includes(run.state));
      if (active) {
        if (active.state !== 'queued' || (!automationRunExpired(active, this.now()) && d.schedule.type !== 'interval')) return undefined;
        Object.assign(active, { state: 'skipped', reason: 'superseded', updatedAt: at, finishedAt: at });
      }
      return this.insertRun(data, d, due, occurrence, 'scheduled', at);
    });
  }
  queueManual(id: string, requestId: string) {
    if (!requestId || requestId.length > 128) throw new Error('AUTOMATION_REQUEST_ID_REQUIRED');
    return this.mutate((data, at) => {
      const d = data.automations.find(item => item.id === id && !item.deletedAt); if (!d) throw new Error('AUTOMATION_NOT_FOUND');
      const occurrence = `${id}:manual:${requestId}`;
      const existing = data.runs.find(run => run.occurrenceId === occurrence); if (existing) return existing;
      if (data.runs.some(run => run.automationId === id && AUTOMATION_ACTIVE_STATES.includes(run.state))) throw new Error('AUTOMATION_BUSY');
      return this.insertRun(data, d, this.now(), occurrence, 'manual', at);
    });
  }
  retry(id: string) {
    return this.mutate((data, at) => {
      const previous = data.runs.find(run => run.id === id); if (!previous || previous.state !== 'failed') throw new Error('AUTOMATION_RETRY_REQUIRES_FAILED');
      if (data.runs.some(run => run.automationId === previous.automationId && AUTOMATION_ACTIVE_STATES.includes(run.state))) throw new Error('AUTOMATION_BUSY');
      const definition = data.automations.find(item => item.id === previous.automationId && !item.deletedAt); if (!definition) throw new Error('AUTOMATION_NOT_FOUND');
      const run = this.insertRun(data, definition, Date.parse(previous.scheduledAt), previous.occurrenceId, 'retry', at);
      run.attempt = Math.max(...data.runs.filter(item => item.occurrenceId === run.occurrenceId).map(item => item.attempt)) + 1; return run;
    });
  }
  private insertRun(data: AutomationSnapshot, definition: Automation, due: number, occurrenceId: string, trigger: AutomationRun['trigger'], at: string) {
    const run: AutomationRun = { id: randomUUID(), automationId: definition.id, occurrenceId, trigger, attempt: 1,
      scheduledAt: new Date(due).toISOString(), createdAt: at, updatedAt: at, state: 'queued', events: [], definition: clone(definition) };
    data.runs.push(run); return run;
  }
  transition(id: string, expected: AutomationRun['state'][], patch: Partial<Pick<AutomationRun, 'state' | 'reason' | 'runtimeRunId' | 'summary' | 'messageId' | 'changed'>>) {
    return this.mutate((data, at) => {
      const run = data.runs.find(item => item.id === id); if (!run || !expected.includes(run.state)) return undefined;
      Object.assign(run, patch, { updatedAt: at });
      if (patch.state === 'starting') run.startedAt = at;
      if (patch.state && !AUTOMATION_ACTIVE_STATES.includes(patch.state)) run.finishedAt = at;
      return run;
    });
  }
  checkpoint(id: string, events: PartnerEvent[]) {
    return this.mutate(data => { const run = data.runs.find(r => r.id === id); if (run) run.events = clone(events); });
  }
  recover() {
    return this.mutate((data, at) => {
      for (const run of data.runs) {
        if (['starting', 'running', 'waiting_approval'].includes(run.state)) Object.assign(run, { state: 'uncertain', reason: 'interrupted', updatedAt: at });
        else if (run.state === 'queued' && automationRunExpired(run, this.now())) Object.assign(run, { state: 'skipped', reason: 'expired', finishedAt: at, updatedAt: at });
      }
    });
  }
}
