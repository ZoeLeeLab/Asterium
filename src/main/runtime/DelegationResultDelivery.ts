import type { PartnerEvent, SendMessageCommand, SendMessageReceipt } from '../../shared/agentProtocol';
import type { DelegationBatch, PartnerDelegation } from './PartnerDelegation';

export interface DelegationDeliveryRuntime {
  prepare: (batch: DelegationBatch, underLease?: boolean) => Promise<SendMessageCommand | undefined>;
  start: (command: SendMessageCommand) => Promise<SendMessageReceipt>;
  cancel: (command: SendMessageCommand, receipt: SendMessageReceipt) => Promise<void>;
  saveReply: (batch: DelegationBatch, event: PartnerEvent, text: string, completed: boolean) => Promise<void>;
}

interface ActiveDelivery {
  batch: DelegationBatch;
  command: SendMessageCommand;
  receipt?: SendMessageReceipt;
  cancelled: boolean;
  text: string;
  accepted: boolean;
  terminal: boolean;
  lastSequence: number;
}

/** Durable result inbox -> the original conversation's ordinary runtime.
 * Owns no runtime writer lease; the runtime must try-acquire and revalidate
 * under its own lease. This prevents double acquisition and stale queued sends.
 */
export class DelegationResultDelivery {
  private readonly active = new Map<string, ActiveDelivery>();
  private readonly userStarts = new Map<string, number>();
  private ticking?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private enabled = false;
  private tickRequested = false;

  constructor(private readonly store: PartnerDelegation, private readonly runtime: DelegationDeliveryRuntime) {}

  start() {
    if (this.closed || this.timer) return;
    this.enabled = true;
    this.timer = setInterval(() => this.kick(), 30_000);
    this.timer.unref?.();
    this.kick();
  }

  kick() {
    if (!this.enabled || this.closed) return;
    if (this.ticking) { this.tickRequested = true; return; }
    this.ticking = this.tick().catch(() => console.error('Delegation result delivery requires review.'))
      .finally(() => {
        this.ticking = undefined;
        if (this.tickRequested) { this.tickRequested = false; this.kick(); }
      });
  }

  owns(command: Pick<SendMessageCommand, 'clientMessageId'>) { return this.active.has(command.clientMessageId); }

  async tick() {
    if (this.closed) return;
    await this.store.recoverReviews();
    for (const batch of await this.store.pendingDeliveries()) {
      if (this.closed || this.userStarts.has(batch.conversationId) || [...this.active.values()].some(a => a.batch.conversationId === batch.conversationId)) continue;
      let command: SendMessageCommand | undefined;
      try { command = await this.runtime.prepare(batch); }
      catch (error) {
        if (error instanceof Error && error.message === 'DELEGATION_SOURCE_CHANGED') await this.store.transitionDelivery(batch.id, ['pending'], { state: 'blocked' });
        continue;
      }
      if (!command || this.closed || this.userStarts.has(batch.conversationId)) continue;
      if (!await this.store.transitionDelivery(batch.id, ['pending'], { state: 'starting' })) continue;
      const active: ActiveDelivery = { batch, command, cancelled: false, text: '', accepted: false, terminal: false, lastSequence: 0 };
      this.active.set(command.clientMessageId, active);
      try {
        active.receipt = await this.runtime.start(command);
        if (active.cancelled) await this.runtime.cancel(command, active.receipt);
      } catch (error) {
        // Only failures known to occur before adapter.sendMessage are retryable.
        const safe = error instanceof Error && ['RUNTIME_WRITER_BUSY', 'DELEGATION_DELIVERY_DEFERRED', 'DELEGATION_SOURCE_CHANGED'].includes(error.message);
        if (!active.terminal) await this.store.transitionDelivery(batch.id, ['starting', 'accepted'], {
          state: active.accepted ? 'interrupted' : error instanceof Error && error.message === 'DELEGATION_SOURCE_CHANGED' ? 'blocked' : safe ? 'pending' : 'uncertain',
        });
        this.active.delete(command.clientMessageId);
      }
    }
  }

  async validateBeforeStart(command: SendMessageCommand) {
    const active = this.active.get(command.clientMessageId);
    if (!active) return;
    if (this.closed || active.cancelled || this.userStarts.has(command.conversationId)) throw new Error('DELEGATION_DELIVERY_DEFERRED');
    const current = await this.runtime.prepare(active.batch, true);
    if (!current || current.sessionId !== command.sessionId) throw new Error('DELEGATION_DELIVERY_DEFERRED');
  }

  validateFirst(command: SendMessageCommand, event: PartnerEvent) {
    if (!this.active.has(command.clientMessageId)) return;
    if (event.type !== 'session.bound' || event.isNew || event.sessionId !== command.sessionId) throw new Error('DELEGATION_ORIGINAL_THREAD_REQUIRED');
  }

  async observe(event: PartnerEvent) {
    const active = this.active.get(event.clientMessageId);
    if (!active || active.terminal) return;
    const { command, batch } = active;
    if (event.partnerId !== command.partnerId || event.conversationId !== command.conversationId || event.sessionId !== command.sessionId) throw new Error('DELEGATION_DELIVERY_ROUTE_MISMATCH');
    if (active.receipt && active.receipt.runId !== event.runId) throw new Error('DELEGATION_DELIVERY_RUN_MISMATCH');
    if (event.sequence <= active.lastSequence) return;
    active.lastSequence = event.sequence;
    if (event.type === 'session.bound') {
      active.receipt = { runId: event.runId, sessionId: event.sessionId };
      // Persist the native turn before later history refreshes or a restart.
      await this.store.transitionDelivery(batch.id, ['starting'], { runId: event.runId });
    }
    if (event.type === 'message.accepted') {
      active.accepted = true;
      await this.store.transitionDelivery(batch.id, ['starting'], { state: 'accepted', runId: event.runId, acceptedAt: event.occurredAt });
    }
    if (event.type === 'text.delta') active.text += event.text;
    if (event.type !== 'run.completed' && event.type !== 'run.failed' && event.type !== 'run.cancelled') return;
    // Save with the renderer's normal assistant ID before acknowledging delivery.
    // A closed renderer must not be the sole owner of the returned reply.
    await this.runtime.saveReply(batch, event, active.text, event.type === 'run.completed');
    const completed = event.type === 'run.completed' && Boolean(active.text.trim());
    await this.store.transitionDelivery(batch.id, ['starting', 'accepted'], {
      state: completed ? 'completed' : active.accepted ? 'interrupted' : 'uncertain', runId: event.runId,
    }, completed ? active.text : undefined);
    active.terminal = true;
  }

  async released(command: Pick<SendMessageCommand, 'clientMessageId'>) {
    const active = this.active.get(command.clientMessageId);
    if (!active) return;
    if (!active.terminal) await this.store.transitionDelivery(active.batch.id, ['starting', 'accepted'], {
      state: active.accepted ? 'interrupted' : 'uncertain',
    });
    this.active.delete(command.clientMessageId);
    this.kick();
  }

  async withUserPriority<T>(conversationId: string, start: () => Promise<T>) {
    this.userStarts.set(conversationId, (this.userStarts.get(conversationId) ?? 0) + 1);
    try { await this.cancelConversation(conversationId); return await start(); }
    finally {
      const remaining = (this.userStarts.get(conversationId) ?? 1) - 1;
      if (remaining) this.userStarts.set(conversationId, remaining); else this.userStarts.delete(conversationId);
      this.kick();
    }
  }

  async cancelConversation(conversationId: string) {
    let found = false;
    for (const active of this.active.values()) {
      if (active.batch.conversationId !== conversationId) continue;
      found = true;
      active.cancelled = true;
      if (active.receipt) await this.runtime.cancel(active.command, active.receipt);
    }
    return found;
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all([...new Set([...this.active.values()].map(a => a.batch.conversationId))].map(id => this.cancelConversation(id)));
    await this.ticking;
  }
}
