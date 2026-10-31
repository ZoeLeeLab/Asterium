import type { StudioRoomMessage, StudioRoomSnapshot } from '../../shared/studioRuntime';
import { STUDIO_WAKE_LIMITS, type StudioWakeHint } from '../../shared/studioWake';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';

interface Recipient { partnerId: string; membershipGeneration: number; eligible: boolean }
interface WakeEvent { id: number; roomId: string; cursor: number; reason: StudioWakeHint['wakeReason']; recipients: Recipient[] }
interface Checkpoint { roomId: string; seq: number; signature: string; recipients: Recipient[]; processed: Array<{ partnerId: string; seq: number }> }
interface EventFile { version: 1; initialized: boolean; nextId: number; events: WakeEvent[]; checkpoints: Checkpoint[] }

/** Notifications are derived from committed public ledger state. No message body enters this file. */
export class StudioWakeEventStore {
  private readonly storage: AtomicJsonStore<EventFile>;
  private readonly listeners = new Set<() => void>();

  constructor(filePath: AtomicJsonStorePath) {
    this.storage = new AtomicJsonStore({ filePath,
      empty: () => ({ version: 1, initialized: false, nextId: 1, events: [], checkpoints: [] }),
      decode(value) {
        if (!record(value) || value.version !== 1 || typeof value.initialized !== 'boolean' || !positive(value.nextId)
          || !Array.isArray(value.events) || !Array.isArray(value.checkpoints)
          || !value.events.every((event) => record(event) && positive(event.id) && typeof event.roomId === 'string'
            && nonnegative(event.cursor) && ['user_message', 'mention', 'room_changed', 'processed'].includes(String(event.reason)) && recipients(event.recipients))
          || !value.checkpoints.every((point) => record(point) && typeof point.roomId === 'string' && nonnegative(point.seq)
            && typeof point.signature === 'string' && recipients(point.recipients) && Array.isArray(point.processed)
            && point.processed.every((cursor) => record(cursor) && typeof cursor.partnerId === 'string' && nonnegative(cursor.seq)))) throw new Error('STUDIO_WAKE_EVENTS_INVALID');
        const state = value as unknown as EventFile;
        if (state.events.some((event, index) => event.id >= state.nextId || (index > 0 && event.id <= state.events[index - 1].id))) throw new Error('STUDIO_WAKE_EVENTS_INVALID');
        return state;
      },
    });
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  reconcile(rooms: StudioRoomSnapshot[], externalIds: Set<string>) {
    return this.storage.runExclusive(async () => {
      const state = await this.storage.readNow();
      const before = state.nextId;
      const append = (roomId: string, cursor: number, reason: WakeEvent['reason'], targets: Recipient[]) => {
        if (targets.length) state.events.push({ id: state.nextId++, roomId, cursor, reason, recipients: targets });
      };
      const checkpoints: Checkpoint[] = [];
      for (const room of rooms) {
        const previous = state.checkpoints.find((point) => point.roomId === room.metadata.roomId);
        const current = checkpoint(room, externalIds);
        if (state.initialized) {
          if (!previous || previous.signature !== current.signature || previous.seq > current.seq) {
            const removed = (previous?.recipients ?? []).filter((target) => !current.recipients.some((item) => item.partnerId === target.partnerId))
              .map((target) => ({ ...target, eligible: false }));
            append(current.roomId, current.seq, 'room_changed', [...current.recipients, ...removed]);
          }
          for (const message of room.messages) if (message.seq > (previous?.seq ?? 0)) {
            const targets = current.recipients.filter((target) => target.eligible && shouldWakeForMessage(room, message, target.partnerId));
            append(current.roomId, message.seq, message.authorType === 'user' ? 'user_message' : 'mention', targets);
          }
          for (const cursor of current.processed) if (cursor.seq !== previous?.processed.find((item) => item.partnerId === cursor.partnerId)?.seq) {
            append(current.roomId, cursor.seq, 'processed', current.recipients.filter((target) => target.partnerId === cursor.partnerId));
          }
        }
        checkpoints.push(current);
      }
      if (state.initialized) for (const removed of state.checkpoints.filter((point) => !checkpoints.some((current) => current.roomId === point.roomId))) {
        append(removed.roomId, removed.seq, 'room_changed', removed.recipients.map((target) => ({ ...target, eligible: false })));
      }
      const changed = !state.initialized || state.nextId !== before || JSON.stringify(state.checkpoints) !== JSON.stringify(checkpoints);
      state.initialized = true;
      state.checkpoints = checkpoints;
      state.events = state.events.slice(-STUDIO_WAKE_LIMITS.replayEvents);
      if (changed) await this.storage.writeNow(state);
      if (state.nextId !== before) for (const listener of this.listeners) listener();
    });
  }

  async read(partnerId: string, afterEventId: number) {
    if (!nonnegative(afterEventId)) throw new Error('STUDIO_WAKE_CURSOR_INVALID');
    const state = await this.storage.read();
    const resetRequired = afterEventId > state.nextId - 1 || afterEventId < (state.events[0]?.id ?? state.nextId) - 1;
    const scan = state.events.filter((event) => event.id > afterEventId).slice(0, STUDIO_WAKE_LIMITS.pageEvents);
    return { resetRequired, latestEventId: state.nextId - 1,
      scanCursor: scan.at(-1)?.id ?? state.nextId - 1,
      hints: scan.flatMap((event): StudioWakeHint[] => {
        const target = event.recipients.find((item) => item.partnerId === partnerId);
        return target ? [{ latestEventId: event.id, roomId: event.roomId, cursor: event.cursor,
          membershipGeneration: target.membershipGeneration, wakeReason: event.reason, wakeEligible: target.eligible }] : [];
      }) };
  }
}

export function shouldWakeForMessage(room: StudioRoomSnapshot, message: StudioRoomMessage, partnerId: string) {
  if (message.status !== 'completed' || message.authorId === partnerId || message.authorType === 'system' || room.metadata.archived || room.mutedPartnerIds.includes(partnerId)) return false;
  if (room.settings.speakingMode === 'selected_partners' && !room.settings.selectedPartnerIds.includes(partnerId)) return false;
  if (message.authorType === 'user') {
    if (message.externalParticipantIds) return message.externalParticipantIds.includes(partnerId);
    return room.settings.speakingMode !== 'free_discussion' || !message.mentions?.length || message.mentions.some((mention) => mention.partnerId === partnerId);
  }
  return room.settings.speakingMode === 'free_discussion' && Boolean(message.mentions?.some((mention) => mention.partnerId === partnerId && mention.source === 'partner'));
}

function checkpoint(room: StudioRoomSnapshot, externalIds: Set<string>): Checkpoint {
  const targets = (room.externalState?.memberships ?? []).filter((member) => member.active && externalIds.has(member.partnerId))
    .map((member) => ({ partnerId: member.partnerId, membershipGeneration: member.membershipGeneration,
      eligible: !room.metadata.archived && !room.mutedPartnerIds.includes(member.partnerId)
        && (room.settings.speakingMode !== 'selected_partners' || room.settings.selectedPartnerIds.includes(member.partnerId)) }));
  return { roomId: room.metadata.roomId, seq: room.messages.at(-1)?.seq ?? 0,
    signature: JSON.stringify([room.metadata, room.mutedPartnerIds, room.settings, targets]), recipients: targets,
    processed: (room.externalState?.processed ?? []).map((cursor) => ({ partnerId: cursor.partnerId, seq: cursor.processedThroughSeq })) };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function positive(value: unknown) { return Number.isSafeInteger(value) && Number(value) > 0; }
function nonnegative(value: unknown) { return Number.isSafeInteger(value) && Number(value) >= 0; }
function recipients(value: unknown) { return Array.isArray(value) && value.every((item) => record(item) && typeof item.partnerId === 'string' && positive(item.membershipGeneration) && typeof item.eligible === 'boolean'); }
