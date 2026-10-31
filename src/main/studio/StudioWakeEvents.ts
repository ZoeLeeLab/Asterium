import type { StudioWakeHint } from '../../shared/studioWake';
import type { ProjectMutationCoordinator } from '../project/ProjectMutationCoordinator';
import type { StudioRoomStore } from './StudioRoomStore';
import type { StudioRuntimeCatalog } from './StudioRuntimeCatalog';
import type { StudioMcpService } from './StudioMcpService';
import { shouldWakeForMessage, StudioWakeEventStore } from './StudioWakeEventStore';

export class StudioWakeEvents {
  private readonly unsubscribe: () => void;
  private readonly ready: Promise<void>;
  private reconciliation?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private dirty = false;

  constructor(private readonly journal: StudioWakeEventStore, private readonly rooms: StudioRoomStore,
    private readonly catalog: StudioRuntimeCatalog, private readonly coordinator: ProjectMutationCoordinator,
    private readonly mcp: StudioMcpService) {
    this.ready = this.reconcile();
    void this.ready.catch(() => undefined);
    // A hint to re-read the committed authority, never trust ordering of UI snapshots.
    this.unsubscribe = rooms.subscribe(() => this.schedule());
  }

  subscribe(listener: () => void, invalidate = listener) {
    const journal = this.journal.subscribe(listener);
    const invalidation = this.rooms.subscribe(invalidate);
    return () => { journal(); invalidation(); };
  }
  async dispose() { this.disposed = true; clearTimeout(this.reconciliation); this.unsubscribe(); await this.ready.catch(() => undefined); }

  reconcile() {
    return this.coordinator.run(async () => {
      const rooms = await this.rooms.listAll();
      await this.journal.reconcile(rooms, this.externalIds(rooms.flatMap((room) => room.metadata.memberIds)));
    });
  }

  poll(token: string, afterEventId: number) {
    return this.coordinator.run(async () => {
      const identity = await this.mcp.authenticate(token);
      const rooms = await this.rooms.listAll();
      await this.journal.reconcile(rooms, this.externalIds(rooms.flatMap((room) => room.metadata.memberIds)));
      const batch = await this.journal.read(identity.partnerId, afterEventId);
      const hints: StudioWakeHint[] = [];
      if (batch.resetRequired) {
        for (const room of rooms) {
          const member = room.externalState?.memberships.find((item) => item.partnerId === identity.partnerId && item.active);
          if (!member) continue;
          try { this.coordinator.assertProjectActive(room.metadata.projectId); } catch { continue; }
          const processed = room.externalState?.processed.find((cursor) => cursor.partnerId === identity.partnerId && cursor.membershipGeneration === member.membershipGeneration)?.processedThroughSeq ?? 0;
          const eligible = !room.metadata.archived && !room.mutedPartnerIds.includes(identity.partnerId)
            && (room.settings.speakingMode !== 'selected_partners' || room.settings.selectedPartnerIds.includes(identity.partnerId));
          const latest = [...room.messages].reverse().find((message) => message.seq > processed && shouldWakeForMessage(room, message, identity.partnerId));
          hints.push({ latestEventId: batch.latestEventId, roomId: room.metadata.roomId, membershipGeneration: member.membershipGeneration,
            cursor: processed, wakeReason: 'processed', wakeEligible: eligible });
          hints.push({ latestEventId: batch.latestEventId, roomId: room.metadata.roomId, membershipGeneration: member.membershipGeneration,
            cursor: latest?.seq ?? processed, wakeReason: latest ? (latest.authorType === 'user' ? 'user_message' : 'mention') : 'room_changed', wakeEligible: eligible });
        }
        return { ...batch, hints, scanCursor: batch.latestEventId };
      }
      for (const hint of batch.hints) {
        const room = rooms.find((item) => item.metadata.roomId === hint.roomId);
        const member = room?.externalState?.memberships.find((item) => item.partnerId === identity.partnerId && item.active);
        if (hint.wakeReason === 'room_changed' && !hint.wakeEligible) { hints.push(hint); continue; }
        if (!room || !member || member.membershipGeneration !== hint.membershipGeneration) continue;
        try { this.coordinator.assertProjectActive(room.metadata.projectId); } catch { continue; }
        const eligible = !room.metadata.archived && !room.mutedPartnerIds.includes(identity.partnerId)
          && (room.settings.speakingMode !== 'selected_partners' || room.settings.selectedPartnerIds.includes(identity.partnerId));
        const processed = room.externalState?.processed.find((cursor) => cursor.partnerId === identity.partnerId && cursor.membershipGeneration === member.membershipGeneration)?.processedThroughSeq ?? 0;
        if ((hint.wakeReason === 'user_message' || hint.wakeReason === 'mention') && (hint.cursor <= processed || !eligible)) continue;
        hints.push({ ...hint, wakeEligible: hint.wakeEligible && eligible });
      }
      return { ...batch, hints };
    });
  }

  private externalIds(ids: string[]) { return new Set(ids.filter((id) => this.catalog.partner(id)?.sourceMode === 'existing_thread')); }

  private schedule() {
    this.dirty = true;
    if (this.reconciliation || this.disposed) return;
    this.reconciliation = setTimeout(() => {
      this.dirty = false;
      void this.reconcile().catch(() => undefined).finally(() => {
        this.reconciliation = undefined;
        if (this.dirty) this.schedule();
      });
    }, 50);
    this.reconciliation.unref();
  }
}
