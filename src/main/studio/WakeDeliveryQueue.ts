import { createHash } from 'node:crypto';
import { STUDIO_WAKE_LIMITS as limits, type StudioWakeHint, type StudioWakeTrigger } from '../../shared/studioWake';
import { studioWakeHintSchema, type StudioWakeReview } from '../../shared/studioWakeAdapter';
import { WakeDeliveryStore } from './WakeDeliveryStore';

export interface WakeEnqueuePort {
  /** Enter the HOST's original-thread queue; never wait for model completion. No automatic retry. */
  enqueue(trigger: StudioWakeTrigger, signal: AbortSignal): Promise<{ accepted: boolean; triggerId: string }>;
}
type Pending = { trigger: StudioWakeTrigger; dueAt: number };
type Review = { trigger: StudioWakeTrigger; reason: StudioWakeReview['reason'] };

/** Small RAM-only merge buffer. Unknown delivery blocks its group, never another group's work. */
export class WakeDeliveryQueue {
  private readonly pending = new Map<string, Pending>();
  private readonly reviews = new Map<string, Review>();
  private readonly authority = new Map<string, { generation: number; eligible: boolean; processed: number }>();
  private readonly starts: number[] = [];
  private mutation = Promise.resolve();
  private boundary?: number;
  private pause?: 'quota' | 'pending_limit';
  constructor(private readonly adapterId: string, private readonly host: WakeEnqueuePort, private readonly store: WakeDeliveryStore) {}
  status() { return { ...(this.pause ? { paused: this.pause } : {}), pendingRooms: this.pending.size,
    reviews: [...this.reviews.values()].map(({ trigger, reason }): StudioWakeReview => ({ roomId: trigger.roomId,
      membershipGeneration: trigger.membershipGeneration, eventId: trigger.latestEventId, triggerId: trigger.triggerId, reason })) }; }
  begin() { return this.run(async () => {
    this.boundary = (await this.store.read()).scanCursor; this.pending.clear(); this.reviews.clear(); this.authority.clear();
    if (this.pause === 'pending_limit') this.pause = undefined;
  }); }
  reset() { return this.run(async () => { this.pending.clear(); for (const value of this.authority.values()) value.eligible = false; }); }
  offer(hint: StudioWakeHint, now: number, recovered = false) {
    return this.run(async () => {
      if (!studioWakeHintSchema.safeParse(hint).success) throw new Error('STUDIO_WAKE_HINT_INVALID');
      if (this.boundary === undefined) this.boundary = (await this.store.read()).scanCursor;
      const state = await this.store.observe(hint), room = state.rooms.find((item) => item.roomId === hint.roomId)!;
      if (hint.membershipGeneration < room.membershipGeneration) return;
      const previous = this.authority.get(hint.roomId);
      if (!previous || previous.generation < hint.membershipGeneration) { this.pending.delete(hint.roomId); this.reviews.delete(hint.roomId); }
      const auth = previous?.generation === hint.membershipGeneration ? previous : { generation: hint.membershipGeneration, eligible: false, processed: 0 };
      auth.eligible = hint.wakeEligible; this.authority.set(hint.roomId, auth);
      if (hint.wakeReason === 'processed') {
        auth.processed = Math.max(auth.processed, hint.cursor);
        for (const collection of [this.pending, this.reviews]) {
          const item = collection.get(hint.roomId);
          if (item && item.trigger.cursor <= auth.processed) { await this.store.resolve(item.trigger, false); collection.delete(hint.roomId); }
        }
        return;
      }
      const trigger = makeTrigger(this.adapterId, hint);
      if (!hint.wakeEligible) {
        this.pending.delete(hint.roomId); this.reviews.delete(hint.roomId); await this.store.resolve(trigger, false); return;
      }
      if (hint.wakeReason === 'room_changed' || hint.cursor <= auth.processed || hint.latestEventId <= room.notificationCursor) return;
      if (room.lastDelivered?.triggerId === trigger.triggerId) { await this.store.resolve(trigger, false); return; }
      const review = this.reviews.get(hint.roomId);
      if (review?.trigger.triggerId === trigger.triggerId) return;
      if (recovered || hint.latestEventId <= this.boundary) {
        if (!review && this.reviews.size < limits.maximumPendingRooms) this.reviews.set(hint.roomId, { trigger, reason: 'replay' });
        else if (review?.reason === 'replay' && trigger.cursor > review.trigger.cursor) this.reviews.set(hint.roomId, { trigger, reason: 'replay' });
        else if (!review) this.pause = 'pending_limit';
        return;
      }
      const pending = this.pending.get(hint.roomId);
      if (pending && pending.trigger.cursor >= trigger.cursor) return;
      if (!pending && !review && new Set([...this.pending.keys(), ...this.reviews.keys()]).size >= limits.maximumPendingRooms) { this.pause = 'pending_limit'; return; }
      this.pending.set(hint.roomId, { trigger, dueAt: pending?.dueAt ?? now + limits.debounceMs });
    });
  }
  pump(now: number) {
    return this.run(async () => {
      if (this.pause) return;
      for (const [roomId, item] of this.pending) {
        if (item.dueAt > now || this.reviews.has(roomId)) continue;
        if (!this.withinBudget(now)) { this.pause = 'quota'; return; }
        this.pending.delete(roomId); await this.deliver(item.trigger, now);
      }
    });
  }
  decide(triggerId: string, decision: 'retry' | 'ignore', now: number) {
    return this.run(async () => {
      const review = [...this.reviews.values()].find((item) => item.trigger.triggerId === triggerId);
      if (!review) throw new Error('STUDIO_WAKE_REVIEW_NOT_FOUND');
      const { trigger } = review, auth = this.authority.get(trigger.roomId);
      if (!auth?.eligible || auth.generation !== trigger.membershipGeneration) throw new Error('STUDIO_MEMBERSHIP_STALE');
      if (decision === 'ignore') { await this.store.resolve(trigger, false); this.reviews.delete(trigger.roomId); return; }
      if (!this.withinBudget(now)) throw new Error('STUDIO_WAKE_QUOTA_PENDING');
      this.reviews.delete(trigger.roomId); await this.deliver(trigger, now);
    });
  }
  resume(now: number) { return this.run(async () => {
    if (this.pause === 'pending_limit') throw new Error('STUDIO_WAKE_RESYNC_REQUIRED');
    if (this.withinBudget(now)) this.pause = undefined;
  }); }

  private async deliver(trigger: StudioWakeTrigger, now: number) {
    const auth = this.authority.get(trigger.roomId);
    if (!auth?.eligible || auth.generation !== trigger.membershipGeneration) return;
    // Persist the observed boundary BEFORE host submission. A crash replays this as manual review.
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let submitted = false;
    try {
      await this.store.checkpoint(trigger.latestEventId); this.starts.push(now); submitted = true;
      const response = await Promise.race([this.host.enqueue(trigger, controller.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('RECEIPT_UNKNOWN')); }, limits.deliveryReceiptMs);
      })]);
      if (response.triggerId !== trigger.triggerId) throw new Error('RECEIPT_UNKNOWN');
      if (!response.accepted) { this.reviews.set(trigger.roomId, { trigger, reason: 'rejected' }); return; }
      await this.store.resolve(trigger, true);
    } catch { this.reviews.set(trigger.roomId, { trigger, reason: submitted ? 'uncertain' : 'rejected' }); }
    finally { clearTimeout(timer); }
  }
  private withinBudget(now: number) {
    while (this.starts.length && now - this.starts[0] >= 60_000) this.starts.shift();
    return this.starts.length < limits.startsPerMinute;
  }
  private run<T>(action: () => Promise<T>) { const next = this.mutation.then(action); this.mutation = next.then(() => undefined, () => undefined); return next; }
}
function makeTrigger(adapterId: string, hint: StudioWakeHint): StudioWakeTrigger {
  const hash = createHash('sha256').update(JSON.stringify([adapterId, hint.roomId, hint.membershipGeneration, hint.cursor])).digest();
  hash[6] = (hash[6] & 15) | 80; hash[8] = (hash[8] & 63) | 128;
  const hex = hash.subarray(0, 16).toString('hex'), triggerId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { type: 'asterium.group_wake', source: 'asterium', adapterId, triggerId, roomId: hint.roomId, cursor: hint.cursor,
    membershipGeneration: hint.membershipGeneration, latestEventId: hint.latestEventId, wakeReason: hint.wakeReason === 'mention' ? 'mention' : 'user_message' };
}
