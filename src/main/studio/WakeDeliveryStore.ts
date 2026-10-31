import { z } from 'zod';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';
import type { StudioWakeHint, StudioWakeTrigger } from '../../shared/studioWake';

const integer = z.number().int().nonnegative();
const schema = z.object({ version: z.literal(1), scanCursor: integer, rooms: z.array(z.object({ roomId: z.string().min(1),
  membershipGeneration: z.number().int().positive(), notificationCursor: integer,
  lastDelivered: z.object({ eventId: integer, triggerId: z.string().uuid() }).strict().optional() }).strict()) }).strict();
export type WakeDeliveryCheckpoint = z.infer<typeof schema>;

/** Only notification positions and the last accepted delivery are durable. No active job table. */
export class WakeDeliveryStore {
  private readonly store: AtomicJsonStore<WakeDeliveryCheckpoint>;
  constructor(filePath: AtomicJsonStorePath) {
    this.store = new AtomicJsonStore({ filePath, empty: () => ({ version: 1, scanCursor: 0, rooms: [] }), decode(value) {
      const parsed = schema.safeParse(value);
      if (!parsed.success || new Set(parsed.data.rooms.map((room) => room.roomId)).size !== parsed.data.rooms.length
        || parsed.data.rooms.some((room) => room.notificationCursor > parsed.data.scanCursor
          || (room.lastDelivered && room.lastDelivered.eventId > room.notificationCursor))) throw new Error('STUDIO_WAKE_CHECKPOINT_INVALID');
      return parsed.data;
    } });
  }
  read() { return this.store.read(); }
  async replayCursor() {
    const state = await this.read();
    return Math.min(state.scanCursor, ...state.rooms.map((room) => room.notificationCursor));
  }
  observe(hint: StudioWakeHint) {
    return this.change((state) => {
      state.scanCursor = Math.max(state.scanCursor, hint.latestEventId);
      const room = state.rooms.find((item) => item.roomId === hint.roomId);
      if (!room) state.rooms.push({ roomId: hint.roomId, membershipGeneration: hint.membershipGeneration, notificationCursor: 0 });
      else if (room.membershipGeneration < hint.membershipGeneration) Object.assign(room, { membershipGeneration: hint.membershipGeneration, notificationCursor: 0, lastDelivered: undefined });
    });
  }
  checkpoint(eventId: number) {
    if (!Number.isSafeInteger(eventId) || eventId < 0) throw new Error('STUDIO_WAKE_CURSOR_INVALID');
    return this.change((state) => { state.scanCursor = Math.max(state.scanCursor, eventId); });
  }
  resolve(trigger: Pick<StudioWakeTrigger, 'roomId' | 'membershipGeneration' | 'latestEventId' | 'triggerId'>, delivered: boolean) {
    return this.change((state) => {
      const room = state.rooms.find((item) => item.roomId === trigger.roomId && item.membershipGeneration === trigger.membershipGeneration);
      if (!room) throw new Error('STUDIO_MEMBERSHIP_STALE');
      state.scanCursor = Math.max(state.scanCursor, trigger.latestEventId);
      room.notificationCursor = Math.max(room.notificationCursor, trigger.latestEventId);
      if (delivered) room.lastDelivered = { eventId: trigger.latestEventId, triggerId: trigger.triggerId };
    });
  }
  private change(operation: (value: WakeDeliveryCheckpoint) => void) {
    return this.store.runExclusive(async () => { const state = await this.store.readNow(); operation(state); await this.store.writeNow(state); return state; });
  }
}
