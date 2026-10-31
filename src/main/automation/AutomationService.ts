import { automationMutationSchema, automationTargetKey, type AutomationTargetOption, type AutomationView } from '../../shared/automations';
import { nextAutomation } from './AutomationSchedule';
import type { AutomationStore } from './AutomationStore';
import type { AutomationScheduler } from './AutomationScheduler';

export class AutomationService {
  constructor(readonly store: AutomationStore, private readonly options: {
    targets(): Promise<AutomationTargetOption[]>;
    scheduler?: AutomationScheduler;
    runtimeReady(): boolean;
    now?: () => number;
  }) {}
  async get(ownerPartnerId?: string): Promise<AutomationView> {
    const snapshot = await this.store.snapshot();
    if (ownerPartnerId) { snapshot.automations = snapshot.automations.filter(d => d.target.partnerId === ownerPartnerId); snapshot.runs = snapshot.runs.filter(r => r.definition.target.partnerId === ownerPartnerId); }
    return { ...snapshot, targets: (await this.options.targets()).filter(t => !ownerPartnerId || t.target.partnerId === ownerPartnerId), runtimeReady: this.options.runtimeReady(), nextRuns: Object.fromEntries(snapshot.automations.map(d => {
      const at = nextAutomation(d, this.options.now?.() ?? Date.now()); return [d.id, at === undefined ? undefined : new Date(at).toISOString()];
    })) };
  }
  async mutate(request: unknown, ownerPartnerId?: string) {
    const value = automationMutationSchema.parse(request);
    const snapshot = await this.store.snapshot();
    const runId = 'runId' in value ? value.runId : undefined;
    const run = runId ? snapshot.runs.find(item => item.id === runId) : undefined;
    const definitionId = 'id' in value ? value.id : run?.automationId;
    const current = definitionId ? snapshot.automations.find(d => d.id === definitionId) : undefined;
    if (value.action !== 'create' && (!current || (ownerPartnerId && current.target.partnerId !== ownerPartnerId))) throw new Error('AUTOMATION_NOT_FOUND');
    if ('input' in value) {
      if (ownerPartnerId && value.input.target.partnerId !== ownerPartnerId) throw new Error('AUTOMATION_OWNER_MISMATCH');
      const target = (await this.options.targets()).find(t => automationTargetKey(t.target) === automationTargetKey(value.input.target));
      if (!target) throw new Error('AUTOMATION_TARGET_STALE');
    }
    switch (value.action) {
      case 'create': await this.store.create(value.input, value.requestId); break;
      case 'update': await this.store.update(value.id, value.revision, value.input); break;
      case 'remove': await this.store.remove(value.id, value.revision); break;
      case 'run_now': if (!this.options.runtimeReady()) throw new Error('AUTOMATION_RUNTIME_NOT_READY'); await this.store.queueManual(value.id, value.requestId); break;
      case 'cancel': if (this.options.scheduler) await this.options.scheduler.cancel(value.runId); else await this.store.transition(value.runId, ['queued'], { state: 'cancelled' }); break;
      case 'retry': if (!this.options.runtimeReady()) throw new Error('AUTOMATION_RUNTIME_NOT_READY'); await this.store.retry(value.runId); break;
      case 'resolve': await this.store.transition(value.runId, ['uncertain'], { state: value.outcome, reason: 'user_resolved' }); break;
    }
    if (this.options.scheduler) await this.options.scheduler.tick();
    return this.get(ownerPartnerId);
  }
}
