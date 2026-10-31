import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import type { PartnerEvent } from '../../shared/agentProtocol';
import { ASTERIUM_USER_ID, normalizeAsteriumUserAuthorId } from '../../shared/identity';
import type { ProjectMembershipRoomChange } from '../../shared/projectWorkspace';
import type {
  StudioMention,
  StudioMemberCursor,
  StudioPreparedTurn,
  StudioRoomMetadata,
  StudioRoomMessage,
  StudioRoomSnapshot,
  StudioRound,
  StudioStartRoundRequest,
  StudioExternalMemberContext,
  StudioExternalHistoryRequest,
} from '../../shared/studioRuntime';
import { DEFAULT_STUDIO_SPEAKING_MODE, STUDIO_DISCUSSION_LIMITS } from '../../shared/studioRuntime';
import { selectStudioPublicContext } from '../../shared/studioHistory';
import type { ProjectPermissionMode } from '../../shared/projectExecutionPolicy';
import { isProjectPermissionMode } from '../../shared/projectExecutionPolicy';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';
import { studioPassPolicy } from './StudioPassPolicy';
import { acknowledgeExternalHistory, externalSendHash, externalState, prepareExternalContent, prepareExternalHistory, reconcileStudioMemberships, requireExternalMember, validateExternalState } from './StudioExternalState';

interface StoredRoom extends StudioRoomSnapshot {
  nextSeq: number;
}

interface RoomFile {
  version: 2;
  rooms: Record<string, StoredRoom>;
  migratedFromVersion?: 1;
}

export class StudioRoomStore {
  private readonly storage: AtomicJsonStore<RoomFile>;
  private initialization?: Promise<void>;
  private readonly streamedText = new Map<string, string>();
  private readonly listeners = new Set<(snapshot: StudioRoomSnapshot) => void>();
  private readonly initializedRooms = new Set<string>();
  private readonly pendingPassRetries = new Map<string, { roomId: string; roundId: string; partnerId: string; turnId: string }>();
  private readonly passRetryCounts = new Map<string, number>();

  constructor(private readonly filePath: string | (() => string)) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 2, rooms: {} }),
      decode: decodeRoomFile,
    });
  }

  subscribe(listener: (snapshot: StudioRoomSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async syncRoom(metadata: StudioRoomMetadata) {
    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const current = data.rooms[metadata.roomId];
      if (current) {
        if (current.metadata.projectId !== metadata.projectId) throw new Error('PROJECT_ROOM_SCOPE_MISMATCH');
        if (metadata.archived && current.activeRound && !isTerminal(current.activeRound.state)) throw new Error('STUDIO_ROUND_ALREADY_ACTIVE');
        current.metadata = normalizeMetadata({ ...current.metadata, ...metadata });
        reconcileStudioMemberships(current);
        current.mutedPartnerIds = current.mutedPartnerIds.filter((id) => current.metadata.memberIds.includes(id));
        current.settings = normalizeSettings(current.settings, current.metadata.memberIds);
        if (current.activeRound) {
          current.activeRound.participantIds ??= unique(current.activeRound.members.map((member) => member.partnerId));
          current.activeRound.permissionMode = normalizeProjectPermissionMode(current.activeRound.permissionMode);
          for (const member of current.activeRound.members) member.turnId ??= randomUUID();
        }
        if (!this.initializedRooms.has(metadata.roomId)) recoverInterruptedRound(current);
      }
      else data.rooms[metadata.roomId] = emptyRoom(metadata);
      this.initializedRooms.add(metadata.roomId);
      await this.writeUnlocked(data);
      return publicSnapshot(data.rooms[metadata.roomId]);
    });
    this.notify(snapshot);
    return snapshot;
  }

  async getRoom(roomId: string) {
    await this.initialize();
    const room = (await this.storage.read()).rooms[roomId];
    return room ? publicSnapshot(room) : undefined;
  }

  async listProject(projectId: string) {
    await this.initialize();
    const rooms = Object.values((await this.storage.read()).rooms).filter((room) => room.metadata.projectId === projectId);
    return rooms.map(publicSnapshot);
  }

  async listAll() {
    await this.initialize();
    return Object.values((await this.storage.read()).rooms).map(publicSnapshot);
  }

  async applyProjectMemberships(projectId: string, changes: ProjectMembershipRoomChange[]) {
    const snapshots = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const seen = new Set<string>();
      for (const change of changes) {
        if (change.room.projectId !== projectId || seen.has(change.room.roomId)) throw new Error('PROJECT_ROOM_SCOPE_MISMATCH');
        seen.add(change.room.roomId);
        const current = data.rooms[change.room.roomId];
        if (current && current.metadata.projectId !== projectId) throw new Error('PROJECT_ROOM_SCOPE_MISMATCH');
        if (current?.activeRound && !isTerminal(current.activeRound.state)
          && !sameMembers(current.metadata.memberIds, change.room.memberIds)) throw new Error('STUDIO_PROJECT_HAS_ACTIVE_ROUND');
      }
      for (const change of changes) {
        const room = data.rooms[change.room.roomId] ?? emptyRoom(change.room);
        data.rooms[change.room.roomId] = room;
        room.metadata = normalizeMetadata({ ...room.metadata, ...change.room });
        reconcileStudioMemberships(room);
        room.mutedPartnerIds = room.mutedPartnerIds.filter((id) => room.metadata.memberIds.includes(id));
        room.settings = normalizeSettings(room.settings, room.metadata.memberIds);
        for (const content of change.announcements ?? []) appendSystemMessage(room, content);
        this.initializedRooms.add(change.room.roomId);
      }
      await this.writeUnlocked(data);
      return changes.map((change) => publicSnapshot(data.rooms[change.room.roomId]));
    });
    for (const snapshot of snapshots) this.notify(snapshot);
    return snapshots;
  }

  async removeProject(projectId: string) {
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      for (const [roomId, room] of Object.entries(data.rooms)) {
        if (room.metadata.projectId !== projectId) continue;
        if (room.activeRound && !isTerminal(room.activeRound.state)) throw new Error('STUDIO_PROJECT_HAS_ACTIVE_ROUND');
        delete data.rooms[roomId];
        this.initializedRooms.delete(roomId);
      }
      await this.writeUnlocked(data);
    });
  }

  async restoreProject(projectId: string, snapshots: StudioRoomSnapshot[]) {
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      for (const [roomId, room] of Object.entries(data.rooms)) if (room.metadata.projectId === projectId) delete data.rooms[roomId];
      for (const snapshot of snapshots) {
        if (snapshot.metadata.projectId !== projectId) throw new Error('PROJECT_ROOM_SCOPE_MISMATCH');
        data.rooms[snapshot.metadata.roomId] = storedSnapshot(snapshot);
        this.initializedRooms.add(snapshot.metadata.roomId);
      }
      await this.writeUnlocked(data);
    });
  }

  async removeRoom(roomId: string) {
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      delete data.rooms[roomId];
      await this.writeUnlocked(data);
    });
  }

  async setMuted(roomId: string, partnerIds: string[]) {
    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = requireRoom(data, roomId);
      room.mutedPartnerIds = unique(partnerIds.filter((id) => room.metadata.memberIds.includes(id)));
      await this.writeUnlocked(data);
      return publicSnapshot(room);
    });
    this.notify(snapshot);
    return snapshot;
  }

  async setSettings(roomId: string, settings: StudioRoomSnapshot['settings']) {
    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = requireRoom(data, roomId);
      if (room.activeRound && !isTerminal(room.activeRound.state)) throw new Error('STUDIO_ROUND_ALREADY_ACTIVE');
      room.settings = normalizeSettings(settings, room.metadata.memberIds);
      await this.writeUnlocked(data);
      return publicSnapshot(room);
    });
    this.notify(snapshot);
    return snapshot;
  }

  async appendSystemMessage(roomId: string, content: string) {
    const normalized = content.trim();
    if (!normalized) throw new Error('STUDIO_ANNOUNCEMENT_REQUIRED');
    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = requireRoom(data, roomId);
      const now = new Date().toISOString();
      room.messages.push({
        roomId,
        messageId: `studio-system:${randomUUID()}`,
        seq: room.nextSeq++,
        roundId: `system:${randomUUID()}`,
        authorType: 'system',
        authorId: 'system',
        content: normalized,
        createdAt: now,
        status: 'completed',
      });
      await this.writeUnlocked(data);
      return publicSnapshot(room);
    });
    this.notify(snapshot);
    return snapshot;
  }

  async publishAutomationMessage(roomId: string, partnerId: string, automation: { automationId: string; runId: string; name: string }, content: string, permissionMode: ProjectPermissionMode) {
    const current = await this.getRoom(roomId); if (!current) throw new Error('STUDIO_ROOM_NOT_FOUND');
    return this.publishUserMessage({ room: current.metadata, messageId: `automation-trigger:${automation.runId}`, content, authorId: 'system', speakerQueue: [partnerId] }, permissionMode, [], automation);
  }

  startRound(request: StudioStartRoundRequest, permissionMode: ProjectPermissionMode = 'manual') {
    return this.publishUserMessage(request, permissionMode);
  }

  /** Publishing is independent of managed runtime scheduling. External participants never enter its queue. */
  async publishUserMessage(request: StudioStartRoundRequest, permissionMode: ProjectPermissionMode = 'manual', externalParticipantIds: string[] = [], automation?: { automationId: string; runId: string; name: string }) {
    if (!request.messageId.trim() || !request.content.trim()) throw new Error('STUDIO_MESSAGE_CONTENT_INVALID');
    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = data.rooms[request.room.roomId] ?? emptyRoom(request.room);
      data.rooms[request.room.roomId] = room;
      // Existing Main metadata is authoritative, including members and archive status.
      if (room.metadata.projectId !== request.room.projectId) throw new Error('PROJECT_ROOM_SCOPE_MISMATCH');
      if (room.metadata.archived) throw new Error('STUDIO_ROOM_ARCHIVED');
      const duplicate = room.messages.find((message) => message.messageId === request.messageId);
      if (duplicate) {
        if (duplicate.authorType !== (automation ? 'system' : 'user') || duplicate.content !== request.content.trim()
          || JSON.stringify(duplicate.mentions ?? []) !== JSON.stringify(request.mentions ?? [])) throw new Error('STUDIO_MESSAGE_ID_CONFLICT');
        return publicSnapshot(room);
      }
      if (room.activeRound && !isTerminal(room.activeRound.state)) throw new Error('STUDIO_ROUND_ALREADY_ACTIVE');
      room.settings = normalizeSettings(room.settings, room.metadata.memberIds);
      const requestedQueue = request.speakerQueue.filter((id) => room.metadata.memberIds.includes(id) && !room.mutedPartnerIds.includes(id));
      const queue = unique(room.settings.speakingMode === 'selected_partners'
        ? requestedQueue.filter((id) => room.settings.selectedPartnerIds.includes(id))
        : requestedQueue);
      const external = unique(externalParticipantIds.filter((id) => room.metadata.memberIds.includes(id) && !room.mutedPartnerIds.includes(id)
        && (room.settings.speakingMode !== 'selected_partners' || room.settings.selectedPartnerIds.includes(id))));
      if (!queue.length && !external.length) throw new Error('STUDIO_ROUND_HAS_NO_SPEAKERS');
      const now = new Date().toISOString();
      const roundId = randomUUID();
      const message: StudioRoomMessage = {
        roomId: room.metadata.roomId,
        messageId: request.messageId,
        seq: room.nextSeq++,
        roundId,
        authorType: automation ? 'system' : 'user',
        authorId: automation ? 'system' : ASTERIUM_USER_ID,
        ...(automation ? { automation } : {}),
        content: request.content.trim(),
        createdAt: now,
        status: 'completed',
        externalParticipantIds: external,
        ...(request.mentions?.length ? { mentions: request.mentions.map((mention) => ({ ...mention })) } : {}),
      };
      room.messages.push(message);
      if (queue.length) room.activeRound = {
        roundId,
        roomId: room.metadata.roomId,
        triggerMessageId: message.messageId,
        speakerQueue: queue,
        members: queue.map((partnerId) => queuedTurn(partnerId)),
        state: 'queued',
        participantIds: [...queue],
        permissionMode: normalizeProjectPermissionMode(permissionMode),
        createdAt: now,
        updatedAt: now,
      };
      room.rotationOffset = (room.rotationOffset + 1) % Math.max(1, room.metadata.memberIds.length);
      await this.writeUnlocked(data);
      return publicSnapshot(room);
    });
    this.notify(snapshot);
    return snapshot;
  }

  async getMembership(roomId: string, partnerId: string) {
    await this.initialize();
    const room = requireRoom(await this.storage.read(), roomId);
    const membership = externalState(room).memberships.find((item) => item.partnerId === partnerId && item.active);
    return membership ? structuredClone(membership) : undefined;
  }

  /** Internal APIs: callers must authenticate partnerId before constructing context. */
  async readExternalHistory(context: StudioExternalMemberContext, request: StudioExternalHistoryRequest = {}) {
    return this.mutate(async () => {
      const data = await this.readUnlocked();
      const page = prepareExternalHistory(requireRoom(data, context.roomId), context, request);
      await this.writeUnlocked(data);
      return page;
    });
  }

  async acknowledgeExternalRead(context: StudioExternalMemberContext, readId: string) {
    const result = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const processedThroughSeq = acknowledgeExternalHistory(requireRoom(data, context.roomId), context, readId);
      await this.writeUnlocked(data);
      return { processedThroughSeq };
    });
    const snapshot = await this.getRoom(context.roomId);
    if (snapshot) this.notify(snapshot);
    return result;
  }

  async readExternalContent(context: StudioExternalMemberContext, request: { messageId: string; offset: number; limit: number; readId?: string }) {
    return this.mutate(async () => {
      const data = await this.readUnlocked();
      const page = prepareExternalContent(requireRoom(data, context.roomId), context, request);
      await this.writeUnlocked(data);
      return page;
    });
  }

  async appendExternalMessage(context: StudioExternalMemberContext, request: { requestId: string; content: string; mentionPartnerIds?: string[] }) {
    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = requireRoom(data, context.roomId);
      const state = requireExternalMember(room, context, true);
      const content = request.content.trim();
      const targets = unique(request.mentionPartnerIds ?? []).sort();
      const contentHash = externalSendHash(request.requestId, content, targets);
      const previous = state.sends.find((send) => send.partnerId === context.partnerId
        && send.membershipGeneration === context.membershipGeneration && send.requestId === request.requestId);
      if (previous) {
        if (previous.contentHash !== contentHash) throw new Error('STUDIO_REQUEST_ID_CONFLICT');
        return { snapshot: publicSnapshot(room), messageId: previous.messageId };
      }
      if (room.mutedPartnerIds.includes(context.partnerId)) throw new Error('STUDIO_PARTNER_MUTED');
      if (room.settings.speakingMode === 'selected_partners' && !room.settings.selectedPartnerIds.includes(context.partnerId)) throw new Error('STUDIO_PARTNER_NOT_SELECTED');
      if (targets.length && room.settings.speakingMode !== 'free_discussion') throw new Error('STUDIO_MENTION_DISABLED_IN_CURRENT_MODE');
      for (const target of targets) {
        if (target === context.partnerId) throw new Error('STUDIO_MENTION_SELF');
        if (!room.metadata.memberIds.includes(target)) throw new Error('STUDIO_MENTION_TARGET_NOT_MEMBER');
        if (room.mutedPartnerIds.includes(target)) throw new Error('STUDIO_MENTION_TARGET_MUTED');
      }
      const messageId = `studio-external:${randomUUID()}`;
      room.messages.push({
        roomId: context.roomId, messageId, seq: room.nextSeq++, roundId: `external:${randomUUID()}`,
        authorType: 'partner', authorId: context.partnerId, content, createdAt: new Date().toISOString(), status: 'completed',
        ...(targets.length ? { mentions: targets.map((partnerId) => ({ partnerId, label: partnerId, source: 'partner' as const })) } : {}),
      });
      state.sends.push({ ...context, requestId: request.requestId, contentHash, messageId });
      await this.writeUnlocked(data);
      return { snapshot: publicSnapshot(room), messageId };
    });
    this.notify(snapshot.snapshot);
    return snapshot;
  }

  async prepareTurn(roomId: string, roundId: string, partnerId: string, bindingGeneration: number, conversationId: string, nativeThreadId?: string, previousSpeakingMode?: StudioPreparedTurn['settings']['speakingMode']): Promise<StudioPreparedTurn> {
    const prepared = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = requireRoom(data, roomId);
      const round = requireRound(room, roundId);
      if (round.state !== 'queued' && round.state !== 'running') throw new Error('STUDIO_ROUND_NOT_RUNNABLE');
      const member = round.members.find((item) => item.partnerId === partnerId && item.state === 'queued');
      if (!member || nextQueuedPartner(round) !== partnerId) throw new Error('STUDIO_PARTNER_NOT_NEXT');

      // Freeze the exact input boundary before starting the native run. Messages
      // appended while this partner streams are deliberately outside the cursor commit.
      const inputThroughSeq = room.messages.at(-1)?.seq ?? 0;
      const cursor = room.cursors.find((item) => item.partnerId === partnerId && item.bindingGeneration === bindingGeneration);
      const processedAfterSeq = cursor?.processedThroughSeq ?? 0;
      // Keep every reply in the canonical public ledger, but do not resend a
      // partner's own public output as a new input on its next turn. Other
      // members still receive that reply through their independent cursors.
      const eligible = room.messages.filter((message) => message.seq > processedAfterSeq
        && message.seq <= inputThroughSeq
        && message.authorId !== partnerId);
      const { messages, omittedRange } = selectStudioPublicContext(eligible);
      member.state = 'running';
      member.inputThroughSeq = inputThroughSeq;
      member.bindingGeneration = bindingGeneration;
      member.conversationId = conversationId;
      round.currentPartnerId = partnerId;
      round.state = 'running';
      round.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
      return {
        room: { ...room.metadata, memberIds: [...room.metadata.memberIds] },
        round: cloneRound(round),
        settings: { ...room.settings, selectedPartnerIds: [...room.settings.selectedPartnerIds] },
        mutedPartnerIds: [...room.mutedPartnerIds],
        conversationId,
        bindingGeneration,
        ...(nativeThreadId ? { nativeThreadId } : {}),
        ...(previousSpeakingMode ? { previousSpeakingMode } : {}),
        inputThroughSeq,
        processedAfterSeq,
        messages,
        models: { ...(room.models ?? {}) },
        ...(omittedRange ? { omittedRange } : {}),
      };
    });
    const snapshot = await this.getRoom(roomId);
    if (snapshot) this.notify(snapshot);
    return prepared;
  }

  async bindRun(roomId: string, roundId: string, partnerId: string, runId: string, sessionId: string) {
    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = requireRoom(data, roomId);
      const round = requireRound(room, roundId);
      // A user may stop the round while the adapter is still binding its
      // native session. Let the receipt reach the renderer so it can cancel
      // that late run, but never revive the already-cancelled queue.
      if (isTerminal(round.state)) return publicSnapshot(room);
      const member = round.members.find((item) => item.partnerId === partnerId && item.state === 'running');
      if (!member) throw new Error('STUDIO_RUNNING_MEMBER_NOT_FOUND');
      member.runId = runId;
      member.sessionId = sessionId;
      round.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
      return publicSnapshot(room);
    });
    this.notify(snapshot);
    return snapshot;
  }

  async mentionPartner(input: {
    roomId: string;
    roundId: string;
    partnerId: string;
    targetPartnerId: string;
    bindingGeneration: number;
    inputThroughSeq: number;
    label: string;
    externalTarget?: boolean;
  }) {
    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = requireRoom(data, input.roomId);
      const round = requireRound(room, input.roundId);
      const member = round.members.find((item) => item.partnerId === input.partnerId && item.state === 'running');
      if (!member || member.bindingGeneration !== input.bindingGeneration || member.inputThroughSeq !== input.inputThroughSeq) throw new Error('STUDIO_EVENT_ROUTE_MISMATCH');
      if (room.settings.speakingMode !== 'free_discussion') throw new Error('STUDIO_MENTION_DISABLED_IN_CURRENT_MODE');
      if (!room.metadata.memberIds.includes(input.targetPartnerId)) throw new Error('STUDIO_MENTION_TARGET_NOT_MEMBER');
      if (room.mutedPartnerIds.includes(input.targetPartnerId)) throw new Error('STUDIO_MENTION_TARGET_MUTED');
      if (input.targetPartnerId === input.partnerId) throw new Error('STUDIO_MENTION_SELF');
      const mention: StudioMention = {
        partnerId: input.targetPartnerId,
        label: input.label.trim() || input.targetPartnerId,
        source: 'partner',
      };
      const alreadyMentioned = member.mentions?.some((item) => item.partnerId === mention.partnerId);
      member.mentions = [...(member.mentions ?? []).filter((item) => item.partnerId !== mention.partnerId), mention];
      const alreadyQueued = round.members.some((item) => item.partnerId === input.targetPartnerId && (item.state === 'queued' || item.state === 'running'));
      const queuedTarget = round.members.findIndex((item) => item.partnerId === input.targetPartnerId && item.state === 'queued');
      if (!input.externalTarget && queuedTarget >= 0) {
        const [targetTurn] = round.members.splice(queuedTarget, 1);
        const currentIndex = round.members.findIndex((item) => item.turnId === member.turnId);
        round.members.splice(currentIndex + 1, 0, targetTurn);
        round.speakerQueue = round.members.map((item) => item.partnerId);
      }
      if (!input.externalTarget && !alreadyMentioned && !alreadyQueued) {
        round.speakerQueue.push(input.targetPartnerId);
        round.members.push(queuedTurn(input.targetPartnerId));
      }
      if (!input.externalTarget && !round.participantIds.includes(input.targetPartnerId)) round.participantIds.push(input.targetPartnerId);
      round.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
      return publicSnapshot(room);
    });
    this.notify(snapshot);
    return snapshot;
  }

  async resolveDiscussion(roomId: string, decision: 'continue' | 'end') {
    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = requireRoom(data, roomId);
      const round = room.activeRound;
      if (!round || round.state !== 'waiting_discussion_decision') throw new Error('STUDIO_DISCUSSION_DECISION_NOT_PENDING');
      if (decision === 'continue') {
        round.discussionPauseCount = (round.discussionPauseCount ?? 0) + 1;
        round.state = nextQueuedPartner(round) ? 'queued' : 'completed';
      } else {
        for (const member of round.members) if (member.state === 'queued') member.state = 'cancelled';
        round.state = 'completed';
      }
      round.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
      return publicSnapshot(room);
    });
    this.notify(snapshot);
    return snapshot;
  }

  async cancelRound(roomId: string) {
    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = requireRoom(data, roomId);
      const round = room.activeRound;
      if (!round || isTerminal(round.state)) return publicSnapshot(room);
      const now = new Date().toISOString();
      for (const member of round.members) {
        if (member.state !== 'queued' && member.state !== 'running') continue;
        if (member.state === 'running' && member.runId) {
          const partial = stripStudioPassMarker(this.streamedText.get(member.runId) ?? '');
          this.streamedText.delete(member.runId);
          if (partial) room.messages.push({
            roomId,
            messageId: `studio-interrupted:${member.turnId}`,
            seq: room.nextSeq++,
            roundId: round.roundId,
            authorType: 'partner',
            authorId: member.partnerId,
            content: partial,
            createdAt: now,
            status: 'interrupted',
            ...(member.mentions?.length ? { mentions: member.mentions.map((mention) => ({ ...mention })) } : {}),
          });
        }
        member.state = 'cancelled';
      }
      round.currentPartnerId = undefined;
      round.state = 'cancelled';
      round.updatedAt = now;
      this.clearPassRetryState(round);
      await this.writeUnlocked(data);
      return publicSnapshot(room);
    });
    this.notify(snapshot);
    return snapshot;
  }

  async failPreparedTurn(roomId: string, roundId: string, partnerId: string) {
    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = requireRoom(data, roomId);
      const round = requireRound(room, roundId);
      const member = round.members.find((item) => item.partnerId === partnerId && item.state === 'running');
      if (!member) return publicSnapshot(room);
      member.state = 'failed';
      round.currentPartnerId = undefined;
      round.state = 'failed';
      round.updatedAt = new Date().toISOString();
      this.clearPassRetryState(round);
      await this.writeUnlocked(data);
      return publicSnapshot(room);
    });
    this.notify(snapshot);
    return snapshot;
  }

  async observeEvent(event: PartnerEvent) {
    if (event.route?.scope !== 'group') return;
    const route = event.route;
    const streamKey = event.runId;
    if (event.type === 'session.bound' && event.model) {
      const model = event.model;
      const snapshot = await this.mutate(async () => {
        const data = await this.readUnlocked();
        const room = requireRoom(data, route.roomId);
        room.models ??= {};
        room.models[event.partnerId] = {
          model,
          status: 'current',
          observedAt: event.occurredAt,
          source: event.modelSource ?? 'runtime',
          conversationId: event.conversationId,
          threadId: event.sessionId,
        };
        await this.writeUnlocked(data);
        return publicSnapshot(room);
      });
      this.notify(snapshot);
      return;
    }
    if (event.type === 'text.delta') {
      const current = await this.getRoom(route.roomId);
      if (!current?.activeRound || current.activeRound.roundId !== route.roundId || isTerminal(current.activeRound.state)) return;
      const content = `${this.streamedText.get(streamKey) ?? ''}${event.text}`;
      this.streamedText.set(streamKey, content);
      const snapshot = await this.getRoom(route.roomId);
      if (snapshot) this.notify({ ...snapshot, streaming: { partnerId: event.partnerId, runId: event.runId, content } });
      return;
    }
    if (!['authorization.requested', 'user_input.requested', 'authorization.resolved', 'user_input.resolved', 'run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) return;

    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = requireRoom(data, route.roomId);
      const round = requireRound(room, route.roundId);
      if (isTerminal(round.state)) return publicSnapshot(room);
      const member = round.members.find((item) => item.partnerId === event.partnerId
        && item.runId === event.runId
        && item.sessionId === event.sessionId
        && item.conversationId === event.conversationId);
      if (!member || member.bindingGeneration !== route.bindingGeneration || member.inputThroughSeq !== route.inputThroughSeq) throw new Error('STUDIO_EVENT_ROUTE_MISMATCH');
      const now = event.occurredAt;
      if (event.type === 'authorization.requested') round.state = 'waiting_authorization';
      else if (event.type === 'user_input.requested') round.state = 'waiting_user_input';
      else if (event.type === 'authorization.resolved' || event.type === 'user_input.resolved') round.state = 'running';
      else {
        const rawText = (this.streamedText.get(streamKey) ?? '').trim();
        const text = stripStudioPassMarker(rawText);
        const passed = event.type === 'run.completed' && Boolean(rawText) && !text;
        this.streamedText.delete(streamKey);
        const retryKey = passRetryKey(round, member);
        const passPolicy = studioPassPolicy({ settings: room.settings, messages: room.messages, round, partnerId: member.partnerId });
        if (passed && !passPolicy.allowed) {
          if ((this.passRetryCounts.get(retryKey) ?? 0) === 0) {
            this.passRetryCounts.set(retryKey, 1);
            this.pendingPassRetries.set(event.runId, {
              roomId: route.roomId,
              roundId: route.roundId,
              partnerId: event.partnerId,
              turnId: member.turnId,
            });
            round.updatedAt = now;
            await this.writeUnlocked(data);
            return publicSnapshot(room);
          }
          member.state = 'failed';
          round.currentPartnerId = undefined;
          round.state = 'failed';
          this.passRetryCounts.delete(retryKey);
          round.updatedAt = now;
          await this.writeUnlocked(data);
          return publicSnapshot(room);
        }
        if (text && !passed) room.messages.push({
          roomId: route.roomId,
          messageId: event.clientMessageId,
          automation: room.messages.find(m => m.messageId === round.triggerMessageId)?.automation,
          seq: room.nextSeq++,
          roundId: route.roundId,
          authorType: 'partner',
          authorId: event.partnerId,
          content: text,
          createdAt: now,
          status: event.type === 'run.completed' ? 'completed' : 'interrupted',
          ...(member.mentions?.length ? { mentions: member.mentions.map((mention) => ({ ...mention })) } : {}),
        });
        if (event.type === 'run.completed') {
          if (!rawText) {
            member.state = 'failed';
            round.state = 'failed';
          } else {
            member.state = passed ? 'passed' : 'completed';
            upsertCursor(room.cursors, {
              roomId: route.roomId,
              partnerId: event.partnerId,
              bindingGeneration: route.bindingGeneration,
              // Commit only the boundary frozen at turn start, never the reply seq.
              processedThroughSeq: route.inputThroughSeq,
              updatedAt: now,
            });
            round.state = nextQueuedPartner(round) ? nextRoundState(room, round) : 'completed';
          }
          this.passRetryCounts.delete(retryKey);
          round.currentPartnerId = undefined;
        } else {
          member.state = event.type === 'run.cancelled' ? 'cancelled' : 'failed';
          if (event.type === 'run.cancelled') {
            for (const pending of round.members) if (pending.state === 'queued') pending.state = 'cancelled';
          }
          round.state = event.type === 'run.cancelled' ? 'cancelled' : 'failed';
          round.currentPartnerId = undefined;
          this.passRetryCounts.delete(retryKey);
        }
      }
      round.updatedAt = now;
      await this.writeUnlocked(data);
      return publicSnapshot(room);
    });
    this.notify(snapshot);
  }

  hasPendingPassRetry(runId: string) {
    return this.pendingPassRetries.has(runId);
  }

  async retryPassAfterRelease(runId: string) {
    const pending = this.pendingPassRetries.get(runId);
    if (!pending) return undefined;
    this.pendingPassRetries.delete(runId);
    const snapshot = await this.mutate(async () => {
      const data = await this.readUnlocked();
      const room = data.rooms[pending.roomId];
      const round = room?.activeRound;
      const member = round?.members.find((item) => item.turnId === pending.turnId);
      if (!room || !round || round.roundId !== pending.roundId || isTerminal(round.state)
        || !member || member.partnerId !== pending.partnerId || member.runId !== runId || member.state !== 'running') return undefined;
      member.state = 'queued';
      delete member.runId;
      delete member.sessionId;
      delete member.conversationId;
      delete member.bindingGeneration;
      delete member.inputThroughSeq;
      round.currentPartnerId = undefined;
      round.state = 'queued';
      round.updatedAt = new Date().toISOString();
      await this.writeUnlocked(data);
      return publicSnapshot(room);
    });
    if (snapshot) this.notify(snapshot);
    return snapshot;
  }

  private notify(snapshot: StudioRoomSnapshot) {
    const running = snapshot.activeRound?.members.find((member) => member.state === 'running' && member.runId);
    const content = running?.runId ? stripStudioPassMarker(this.streamedText.get(running.runId) ?? '') : '';
    const base = { ...snapshot };
    delete base.streaming;
    const visible = running?.runId && content
      ? { ...base, streaming: { partnerId: running.partnerId, runId: running.runId, content } }
      : base;
    for (const listener of this.listeners) listener(visible);
  }

  private readUnlocked() { return this.storage.readNow(); }
  private writeUnlocked(data: RoomFile) { return this.storage.writeNow(data); }

  private mutate<T>(operation: () => Promise<T>) {
    return this.initialize().then(() => this.storage.runExclusive(operation));
  }

  private clearPassRetryState(round: StudioRound) {
    for (const [runId, pending] of this.pendingPassRetries) {
      if (pending.roomId === round.roomId && pending.roundId === round.roundId) this.pendingPassRetries.delete(runId);
    }
    for (const member of round.members) this.passRetryCounts.delete(passRetryKey(round, member));
  }

  private initialize() {
    this.initialization ??= this.storage.runExclusive(async () => {
      const data = await this.storage.readNow();
      if (data.migratedFromVersion !== 1) return;
      const target = typeof this.filePath === 'function' ? this.filePath() : this.filePath;
      try {
        await copyFile(target, `${target}.v1.backup`, constants.COPYFILE_EXCL);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      }
      delete data.migratedFromVersion;
      await this.storage.writeNow(data);
    });
    return this.initialization;
  }
}

function decodeRoomFile(parsed: unknown): RoomFile {
  if (isRecord(parsed) && parsed.version === 2 && isRecord(parsed.rooms)) {
    const rooms = structuredClone(parsed.rooms) as Record<string, StoredRoom>;
    for (const room of Object.values(rooms)) {
      validateExternalState(room);
      externalState(room);
      if (room.activeRound) room.activeRound.permissionMode = normalizeProjectPermissionMode(room.activeRound.permissionMode);
    }
    return { version: 2, rooms };
  }
  if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.rooms)) {
    const rooms = structuredClone(parsed.rooms) as Record<string, StoredRoom>;
    for (const room of Object.values(rooms)) {
      validateExternalState(room);
      externalState(room);
      room.messages = room.messages.map((message) => ({
        ...message,
        authorId: normalizeAsteriumUserAuthorId(message.authorId, message.authorType),
      }));
      if (room.activeRound) room.activeRound.permissionMode = normalizeProjectPermissionMode(room.activeRound.permissionMode);
    }
    return { version: 2, rooms, migratedFromVersion: 1 };
  }
  throw new Error('STUDIO_ROOM_STORE_INVALID');
}

function emptyRoom(metadata: StudioRoomMetadata): StoredRoom {
  const room: StoredRoom = { metadata: normalizeMetadata(metadata), messages: [], cursors: [], mutedPartnerIds: [], settings: defaultSettings(), rotationOffset: 0, models: {}, nextSeq: 1 };
  externalState(room);
  return room;
}

function storedSnapshot(snapshot: StudioRoomSnapshot): StoredRoom {
  const copy = structuredClone(snapshot) as StoredRoom;
  copy.nextSeq = Math.max(1, ...copy.messages.map((message) => message.seq + 1));
  return copy;
}

function appendSystemMessage(room: StoredRoom, content: string) {
  const normalized = content.trim();
  if (!normalized) throw new Error('STUDIO_ANNOUNCEMENT_REQUIRED');
  const now = new Date().toISOString();
  room.messages.push({
    roomId: room.metadata.roomId,
    messageId: `studio-system:${randomUUID()}`,
    seq: room.nextSeq++,
    roundId: `system:${randomUUID()}`,
    authorType: 'system',
    authorId: 'system',
    content: normalized,
    createdAt: now,
    status: 'completed',
  });
}

function sameMembers(left: string[], right: string[]) {
  const a = unique(left).sort();
  const b = unique(right).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeMetadata(metadata: StudioRoomMetadata): StudioRoomMetadata {
  return { roomId: metadata.roomId, projectId: metadata.projectId, name: metadata.name.trim(), memberIds: unique(metadata.memberIds), ...(metadata.archived !== undefined ? { archived: metadata.archived } : {}) };
}

function publicSnapshot(room: StoredRoom): StudioRoomSnapshot {
  return JSON.parse(JSON.stringify({
    metadata: room.metadata,
    messages: room.messages,
    cursors: room.cursors,
    ...(room.activeRound ? { activeRound: room.activeRound } : {}),
    mutedPartnerIds: room.mutedPartnerIds,
    settings: room.settings ?? defaultSettings(),
    rotationOffset: room.rotationOffset,
    models: room.models ?? {},
    externalState: externalState(room),
  })) as StudioRoomSnapshot;
}

function requireRoom(data: RoomFile, roomId: string) {
  const room = data.rooms[roomId];
  if (!room) throw new Error('STUDIO_ROOM_NOT_FOUND');
  return room;
}

function requireRound(room: StoredRoom, roundId: string) {
  if (!room.activeRound || room.activeRound.roundId !== roundId) throw new Error('STUDIO_ROUND_NOT_FOUND');
  return room.activeRound;
}

function nextQueuedPartner(round: StudioRound) {
  return round.members.find((item) => item.state === 'queued')?.partnerId;
}

function normalizeProjectPermissionMode(value: unknown): ProjectPermissionMode {
  return isProjectPermissionMode(value) ? value : 'manual';
}

function queuedTurn(partnerId: string): StudioRound['members'][number] {
  return { turnId: randomUUID(), partnerId, state: 'queued' };
}

function passRetryKey(round: StudioRound, member: StudioRound['members'][number]) {
  return `${round.roomId}:${round.roundId}:${member.turnId}`;
}

function defaultSettings(): StudioRoomSnapshot['settings'] {
  return { speakingMode: DEFAULT_STUDIO_SPEAKING_MODE, selectedPartnerIds: [], discussionProtectionEnabled: false };
}

function normalizeSettings(settings: StudioRoomSnapshot['settings'] | undefined, memberIds: string[]): StudioRoomSnapshot['settings'] {
  const fallback = defaultSettings();
  if (!settings) return fallback;
  return {
    speakingMode: ['free_discussion', 'selected_partners', 'round_robin'].includes(settings.speakingMode) ? settings.speakingMode : fallback.speakingMode,
    selectedPartnerIds: unique((settings.selectedPartnerIds ?? []).filter((id) => memberIds.includes(id))),
    discussionProtectionEnabled: Boolean(settings.discussionProtectionEnabled),
  };
}

function nextRoundState(room: StoredRoom, round: StudioRound): StudioRound['state'] {
  if (!room.settings.discussionProtectionEnabled || room.settings.speakingMode !== 'free_discussion') return 'queued';
  const participants = round.participantIds;
  if (!participants.length) return 'queued';
  const counts = participants.map((partnerId) => round.members.filter((member) => member.partnerId === partnerId && member.state === 'completed').length);
  if (!round.discussionWarningIssued && counts.every((count) => count >= STUDIO_DISCUSSION_LIMITS.summarizeAfterRepliesPerParticipant)) {
    round.discussionWarningIssued = true;
  }
  const pauseAt = STUDIO_DISCUSSION_LIMITS.pauseAfterRepliesPerParticipant
    + (round.discussionPauseCount ?? 0) * STUDIO_DISCUSSION_LIMITS.repliesPerParticipantAfterContinue;
  return round.discussionWarningIssued && counts.every((count) => count >= pauseAt) ? 'waiting_discussion_decision' : 'queued';
}

function isTerminal(state: StudioRound['state']) {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function recoverInterruptedRound(room: StoredRoom) {
  const round = room.activeRound;
  if (!round || isTerminal(round.state)) return;
  for (const member of round.members) {
    if (member.state === 'queued' || member.state === 'running') member.state = 'cancelled';
  }
  round.currentPartnerId = undefined;
  round.state = 'cancelled';
  round.updatedAt = new Date().toISOString();
}

function stripStudioPassMarker(value: string) {
  return value
    .replace(/<asterium_group_pass\s*\/>/giu, '')
    .replace(/<asterium_group_pass[^>]*$/iu, '')
    .trim();
}

function upsertCursor(cursors: StudioMemberCursor[], cursor: StudioMemberCursor) {
  const index = cursors.findIndex((item) => item.partnerId === cursor.partnerId && item.bindingGeneration === cursor.bindingGeneration);
  if (index >= 0) cursors[index] = cursor;
  else cursors.push(cursor);
}


function cloneRound(round: StudioRound) {
  return JSON.parse(JSON.stringify(round)) as StudioRound;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
