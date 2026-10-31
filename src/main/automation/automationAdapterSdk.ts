import { createHash } from 'node:crypto';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';
import { z } from 'zod';
import {
  automationAdapterBindingSchema, automationAdapterCapabilitiesSchema, automationAdapterReceiptSchema, automationAdapterTriggerSchema,
  type AutomationAdapterBinding, type AutomationAdapterPort, type AutomationAdapterReceipt, type AutomationAdapterTrigger,
} from '../../shared/automationAdapter';
export * from '../../shared/automationAdapter';

const ledgerSchema = z.object({ version: z.literal(1), entries: z.array(z.object({ fingerprint: z.string(), binding: automationAdapterBindingSchema, receipt: automationAdapterReceiptSchema })) });
type Ledger = z.infer<typeof ledgerSchema>;
const stableBinding = (b: AutomationAdapterBinding) => JSON.stringify([b.adapterId, b.partnerId, b.conversationId, b.nativeThreadId, b.bindingGeneration, b.projectId, b.roomId, b.membershipGeneration, b.workspaceSignature]);
const fingerprint = (t: AutomationAdapterTrigger) => createHash('sha256').update(JSON.stringify([t.triggerId, t.occurrenceId, t.automationId, t.scheduledAt, t.name, t.instructions, stableBinding(t.binding)])).digest('hex');
const terminal = (s: AutomationAdapterReceipt['state']) => ['succeeded', 'failed', 'cancelled'].includes(s);

/** Reference host boundary, not a CyberBoss implementation. No HTTP listener, model, thread creation or WeChat transport. */
export class AutomationAdapterSession implements AutomationAdapterPort {
  private readonly storage: AtomicJsonStore<Ledger>;
  constructor(filePath: string, private readonly binding: () => Promise<AutomationAdapterBinding>, private readonly host: {
    start(trigger: AutomationAdapterTrigger): Promise<{ runtimeRunId: string }>;
    cancel(triggerId: string): Promise<void>;
  }) {
    this.storage = new AtomicJsonStore<Ledger>({ filePath, empty: () => ({ version: 1, entries: [] }), decode: value => ledgerSchema.parse(value) });
  }
  async capabilities() { return automationAdapterCapabilitiesSchema.parse({ protocolVersion: 1, automation: true, originalThread: true, serialized: true, permissionsPreserved: true, noPublicEcho: true, durableIdempotency: true }); }
  async recover() {
    await this.storage.runExclusive(async () => {
      const state = await this.storage.readNow();
      for (const entry of state.entries) if (!terminal(entry.receipt.state)) entry.receipt.state = 'uncertain';
      await this.storage.writeNow(state);
    });
  }
  private async authorize(binding?: AutomationAdapterBinding) {
    const actual = automationAdapterBindingSchema.parse(await this.binding());
    if (binding && stableBinding(actual) !== stableBinding(binding)) throw new Error('AUTOMATION_ADAPTER_BINDING_REVOKED');
    return actual;
  }
  async dispatch(raw: AutomationAdapterTrigger, signal: AbortSignal): Promise<AutomationAdapterReceipt> {
    const trigger = automationAdapterTriggerSchema.parse(raw); signal.throwIfAborted(); await this.authorize(trigger.binding);
    const reserved = await this.storage.runExclusive(async () => {
      const state = await this.storage.readNow(), found = state.entries.find(e => e.receipt.triggerId === trigger.triggerId);
      if (found) { if (found.fingerprint !== fingerprint(trigger)) throw new Error('AUTOMATION_ADAPTER_IDEMPOTENCY_CONFLICT'); return { fresh: false, receipt: found.receipt }; }
      if (state.entries.some(e => !terminal(e.receipt.state) && e.binding.partnerId === trigger.binding.partnerId && e.binding.nativeThreadId === trigger.binding.nativeThreadId)) throw new Error('AUTOMATION_ADAPTER_THREAD_BUSY');
      const receipt: AutomationAdapterReceipt = { protocolVersion: 1, triggerId: trigger.triggerId, state: 'accepted' };
      state.entries.push({ fingerprint: fingerprint(trigger), binding: trigger.binding, receipt }); await this.storage.writeNow(state); return { fresh: true, receipt };
    });
    if (!reserved.fresh) return reserved.receipt;
    try {
      signal.throwIfAborted(); await this.authorize(trigger.binding);
      const started = await this.host.start(trigger);
      // A synchronous host callback may already have recorded completion. Never regress it to running.
      return await this.update(trigger.triggerId, { state: 'running', runtimeRunId: started.runtimeRunId }, true);
    } catch {
      await this.update(trigger.triggerId, { state: 'uncertain' }, true);
      throw new Error('AUTOMATION_ADAPTER_DELIVERY_UNKNOWN');
    }
  }
  async status(triggerId: string, signal: AbortSignal) {
    signal.throwIfAborted(); const actual = await this.authorize();
    const entry = (await this.storage.read()).entries.find(e => e.receipt.triggerId === triggerId);
    if (entry && stableBinding(entry.binding) !== stableBinding(actual)) throw new Error('AUTOMATION_ADAPTER_BINDING_REVOKED');
    return entry?.receipt;
  }
  async cancel(triggerId: string, signal: AbortSignal) {
    const receipt = await this.status(triggerId, signal); if (!receipt) throw new Error('AUTOMATION_ADAPTER_NOT_FOUND');
    if (terminal(receipt.state)) return receipt;
    await this.host.cancel(triggerId); // Acceptance is not proof of cancellation. Host must record its actual terminal event.
    return (await this.status(triggerId, signal))!;
  }
  async record(receipt: AutomationAdapterReceipt) { return this.update(receipt.triggerId, automationAdapterReceiptSchema.parse(receipt)); }
  private async update(triggerId: string, patch: Partial<AutomationAdapterReceipt>, keepTerminal = false) {
    return this.storage.runExclusive(async () => {
      const state = await this.storage.readNow(), entry = state.entries.find(e => e.receipt.triggerId === triggerId); if (!entry) throw new Error('AUTOMATION_ADAPTER_NOT_FOUND');
      await this.authorize(entry.binding);
      if (terminal(entry.receipt.state)) {
        if (!keepTerminal && JSON.stringify(entry.receipt) !== JSON.stringify(patch)) throw new Error('AUTOMATION_ADAPTER_TERMINAL_CONFLICT');
        return entry.receipt;
      }
      entry.receipt = automationAdapterReceiptSchema.parse({ ...entry.receipt, ...patch, triggerId }); await this.storage.writeNow(state); return entry.receipt;
    });
  }
}
