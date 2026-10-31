import type { PartnerEvent, SendMessageCommand, SendMessageReceipt } from '../../shared/agentProtocol';
import type { AutomationRun, AutomationRunOutcome } from '../../shared/automations';
import type { AutomationExecutionPort } from './AutomationScheduler';
import type { AutomationStore } from './AutomationStore';

interface Active {
  run: AutomationRun; command?: SendMessageCommand; receipt?: SendMessageReceipt; events: PartnerEvent[];
  resolve: (outcome: AutomationRunOutcome) => void; settled: boolean; signal: AbortSignal; changed?: boolean;
}
export class AutomationRuntime implements AutomationExecutionPort {
  private readonly published = new Map<string, AutomationRun>();
  private readonly active = new Map<string, Active>();
  constructor(private readonly store: AutomationStore, private readonly options: {
    check: AutomationExecutionPort['check'];
    launch: (run: AutomationRun, signal: AbortSignal) => Promise<void>;
    cancel: (command: SendMessageCommand, receipt: SendMessageReceipt) => Promise<void>;
    saveResult: (run: AutomationRun, summary: string, messageId: string, completed: boolean) => Promise<void>;
  }) {}
  check(run: AutomationRun) { return this.options.check(run); }
  eventRunFor(event: Pick<PartnerEvent, 'clientMessageId'>) { const active = this.active.get(event.clientMessageId); return active ? { ...active.run, changed: active.changed } : this.published.get(event.clientMessageId); }
  runFor(command: Pick<SendMessageCommand, 'clientMessageId'>) { return this.active.get(command.clientMessageId)?.run; }
  pendingGroup(roomId: string, partnerId: string) { return [...this.active.values()].find(a => a.run.definition.target.roomId === roomId && a.run.definition.target.partnerId === partnerId)?.run; }
  attach(command: SendMessageCommand, runId?: string) {
    const active = this.active.get(runId ? `automation:${runId}` : command.clientMessageId); if (!active) return;
    const target = active.run.definition.target;
    if (command.partnerId !== target.partnerId || command.conversationId !== target.conversationId || command.sessionId !== target.nativeThreadId
      || (target.roomId && (command.route?.scope !== 'group' || command.route.roomId !== target.roomId || command.route.bindingGeneration !== target.bindingGeneration))) throw new Error('AUTOMATION_THREAD_MISMATCH');
    command.clientMessageId = `automation:${active.run.id}`; active.command = command;
  }
  validateFirst(command: SendMessageCommand, event: PartnerEvent) {
    const active = this.active.get(command.clientMessageId); if (!active) return;
    if (event.type !== 'session.bound' || event.sessionId !== active.run.definition.target.nativeThreadId || event.isNew) throw new Error('AUTOMATION_ORIGINAL_THREAD_REQUIRED');
  }
  async execute(run: AutomationRun, signal: AbortSignal): Promise<AutomationRunOutcome> {
    const key = `automation:${run.id}`;
    let resolve!: Active['resolve']; const completion = new Promise<AutomationRunOutcome>(r => { resolve = r; });
    const active: Active = { run, resolve, settled: false, signal, events: [] }; this.active.set(key, active);
    const cancel = () => { if (active.command && active.receipt) void this.options.cancel(active.command, active.receipt).catch(() => this.fail(active.command!)); };
    signal.addEventListener('abort', cancel);
    try {
      if (signal.aborted) return { state: 'cancelled', reason: 'cancelled_before_launch' };
      try { await this.options.launch(run, signal); }
      catch { if (!active.settled) await this.fail(active.command ?? { clientMessageId: key }); }
      return await completion;
    } finally { signal.removeEventListener('abort', cancel); this.published.set(key, { ...run, changed: active.changed }); while (this.published.size > 32) this.published.delete(this.published.keys().next().value!); this.active.delete(key); }
  }
  async bound(command: SendMessageCommand, receipt: SendMessageReceipt) {
    const active = this.active.get(command.clientMessageId); if (!active) return;
    active.receipt = receipt;
    await this.store.transition(active.run.id, ['running'], { runtimeRunId: receipt.runId });
    if (active.signal.aborted) await this.options.cancel(command, receipt);
  }
  async observe(event: PartnerEvent) {
    const active = this.active.get(event.clientMessageId); if (!active || active.settled) return;
    if (event.partnerId !== active.run.definition.target.partnerId || event.conversationId !== active.run.definition.target.conversationId
      || event.sessionId !== active.run.definition.target.nativeThreadId) throw new Error('AUTOMATION_EVENT_ROUTE_MISMATCH');
    const last = active.events.at(-1);
    if (last && event.sequence <= last.sequence) return;
    if (last && last.type === event.type && (!(last.type === 'reasoning.delta' && event.type === 'reasoning.delta') || last.reasoningId === event.reasoningId) && (last.type === 'text.delta' || last.type === 'reasoning.delta') && (event.type === 'text.delta' || event.type === 'reasoning.delta')) {
      active.events[active.events.length - 1] = { ...event, text: last.text + event.text };
    } else active.events.push(structuredClone(event));
    if (event.type === 'authorization.requested' || event.type === 'user_input.requested') {
      await this.store.checkpoint(active.run.id, active.events);
      await this.store.transition(active.run.id, ['running'], { state: 'waiting_approval' });
    }
    if (event.type === 'authorization.resolved' || event.type === 'user_input.resolved') await this.store.transition(active.run.id, ['waiting_approval'], { state: 'running' });
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
      const summary = active.events.filter((e): e is Extract<PartnerEvent, { type: 'text.delta' }> => e.type === 'text.delta').map(e => e.text).join('');
      const messageId = `automation-result:${active.run.id}`;
      await this.store.checkpoint(active.run.id, active.events);
      await this.options.saveResult(active.run, summary, messageId, event.type === 'run.completed');
      active.settled = true;
      active.resolve({ state: event.type === 'run.completed' ? 'succeeded' : event.type === 'run.failed' ? 'failed' : 'cancelled',
        summary, messageId, changed: active.changed, reason: event.type === 'run.failed' ? event.error.message : event.type === 'run.cancelled' ? event.reason : undefined });
    }
  }
  replaceEvent(event: PartnerEvent) { if (event.type !== 'file.produced') return; const active = this.active.get(event.clientMessageId); const index = active?.events.findIndex(e => e.eventId === event.eventId) ?? -1; if (active && index >= 0) active.events[index] = structuredClone(event); }
  isAborted(command: SendMessageCommand) { return this.active.get(command.clientMessageId)?.signal.aborted ?? false; }
  report(command: SendMessageCommand, changed: boolean) { const active = this.active.get(command.clientMessageId); if (!active) throw new Error('AUTOMATION_RUN_REQUIRED'); active.changed = changed; }
  async fail(command: Pick<SendMessageCommand, 'clientMessageId'>) {
    const active = this.active.get(command.clientMessageId); if (!active || active.settled) return;
    await this.store.checkpoint(active.run.id, active.events); active.settled = true;
    active.resolve({ state: 'uncertain', reason: 'runtime_interrupted', summary: active.events.filter((e): e is Extract<PartnerEvent, { type: 'text.delta' }> => e.type === 'text.delta').map(e => e.text).join('') });
  }
}
