import { createHash, randomUUID } from 'node:crypto';
import { selectStudioPublicContext } from '../../shared/studioHistory';
import { STUDIO_MCP_CONTENT_CHUNK_CHARACTERS } from '../../shared/studioMcp';
import {
  STUDIO_PUBLIC_HISTORY_BUDGET,
  type StudioExternalHistoryPage,
  type StudioExternalHistoryRequest,
  type StudioExternalMemberContext,
  type StudioExternalRoomState,
  type StudioRoomSnapshot,
} from '../../shared/studioRuntime';

const MAX_READ_RECEIPTS_PER_MEMBER = 32;
const MAX_REQUEST_ID_CHARACTERS = 200;

/** Invalid persisted authority must not silently become generation 1 again. */
export function validateExternalState(room: StudioRoomSnapshot) {
  const state: unknown = room.externalState;
  if (state === undefined) return; // Additive migration of existing v1/v2 rooms.
  const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  const generation = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
  const sequence = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  const context = (value: unknown): value is Record<string, unknown> => record(value)
    && value.roomId === room.metadata.roomId && typeof value.partnerId === 'string' && Boolean(value.partnerId) && generation(value.membershipGeneration);
  if (!record(state) || !Array.isArray(state.memberships) || !Array.isArray(state.reads)
    || !Array.isArray(state.processed) || !Array.isArray(state.sends)
    || !state.memberships.every((item) => record(item) && typeof item.partnerId === 'string' && Boolean(item.partnerId)
      && generation(item.membershipGeneration) && typeof item.active === 'boolean'
      && item.active === room.metadata.memberIds.includes(item.partnerId))
    || new Set(state.memberships.map((item) => item.partnerId)).size !== state.memberships.length
    || !state.reads.every((item) => context(item) && typeof item.readId === 'string' && Boolean(item.readId) && sequence(item.throughSeq)
      && (item.content === undefined || (record(item.content) && typeof item.content.messageId === 'string'
        && sequence(item.content.nextOffset) && sequence(item.content.lastOffset) && generation(item.content.lastLimit))))
    || !state.processed.every((item) => context(item) && sequence(item.processedThroughSeq))
    || !state.sends.every((item) => context(item) && typeof item.requestId === 'string' && Boolean(item.requestId)
      && typeof item.contentHash === 'string' && typeof item.messageId === 'string')) throw new Error('STUDIO_EXTERNAL_STATE_INVALID');
  const memberships = state.memberships;
  if (room.metadata.memberIds.some((id) => !memberships.some((item) => item.partnerId === id && item.active))) throw new Error('STUDIO_EXTERNAL_STATE_INVALID');
}

export function externalState(room: StudioRoomSnapshot): StudioExternalRoomState {
  return room.externalState ??= {
    memberships: room.metadata.memberIds.map((partnerId) => ({ partnerId, membershipGeneration: 1, active: true })),
    reads: [], processed: [], sends: [],
  };
}

/** Keep removed member tombstones: rejoining must never revive an old authority context. */
export function reconcileStudioMemberships(room: StudioRoomSnapshot) {
  const state = externalState(room);
  for (const membership of state.memberships) {
    const active = room.metadata.memberIds.includes(membership.partnerId);
    if (active === membership.active) continue;
    membership.active = active;
    membership.membershipGeneration += 1;
    state.reads = state.reads.filter((read) => read.partnerId !== membership.partnerId);
    state.processed = state.processed.filter((cursor) => cursor.partnerId !== membership.partnerId);
  }
  for (const partnerId of room.metadata.memberIds) {
    if (!state.memberships.some((membership) => membership.partnerId === partnerId)) {
      state.memberships.push({ partnerId, membershipGeneration: 1, active: true });
    }
  }
}

export function requireExternalMember(room: StudioRoomSnapshot, context: StudioExternalMemberContext, write = false) {
  const state = externalState(room);
  const membership = state.memberships.find((item) => item.partnerId === context.partnerId);
  if (context.roomId !== room.metadata.roomId || !room.metadata.memberIds.includes(context.partnerId) || !membership?.active) {
    throw new Error('STUDIO_MEMBERSHIP_REQUIRED');
  }
  if (membership.membershipGeneration !== context.membershipGeneration) throw new Error('STUDIO_MEMBERSHIP_STALE');
  if (write && room.metadata.archived) throw new Error('STUDIO_ROOM_ARCHIVED');
  return state;
}

export function prepareExternalHistory(
  room: StudioRoomSnapshot,
  context: StudioExternalMemberContext,
  request: StudioExternalHistoryRequest,
): StudioExternalHistoryPage {
  const state = requireExternalMember(room, context);
  const { afterSeq, beforeSeq } = request;
  const limit = request.limit ?? STUDIO_PUBLIC_HISTORY_BUDGET.maxMessages;
  if ((afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0))
    || (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1))
    || (afterSeq !== undefined && beforeSeq !== undefined)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > STUDIO_PUBLIC_HISTORY_BUDGET.maxMessages) {
    throw new Error('STUDIO_HISTORY_PAGE_INVALID');
  }
  const eligible = room.messages.filter((message) => (afterSeq === undefined || message.seq > afterSeq)
    && (beforeSeq === undefined || message.seq < beforeSeq));
  const latestSeq = room.messages.at(-1)?.seq ?? 0;
  let throughSeq = Math.min(afterSeq ?? 0, latestSeq);
  let messages;
  if (afterSeq === undefined) {
    messages = selectStudioPublicContext(eligible.slice(-limit)).messages;
    throughSeq = messages.at(-1)?.seq ?? 0;
  } else {
    // Forward input excludes this partner's output, just like managed Studio turns.
    // Advance across skipped own messages, but stop BEFORE any unread other message
    // that cannot fit. A self-only page still has a usable frozen scan boundary.
    let characters = 0;
    messages = [] as StudioExternalHistoryPage['messages'];
    for (const message of eligible) {
      if (message.authorId === context.partnerId) { throughSeq = message.seq; continue; }
      if (messages.length >= limit || (messages.length && characters + message.content.length > STUDIO_PUBLIC_HISTORY_BUDGET.maxCharacters)) break;
      messages.push(structuredClone(message));
      characters += message.content.length;
      throughSeq = message.seq;
    }
  }
  const firstSeq = messages[0]?.seq;
  const readId = randomUUID();
  addReadReceipt(state, { ...context, readId, throughSeq });
  return {
    messages, readId, throughSeq,
    latestSeq,
    processedThroughSeq: state.processed.find((cursor) => cursor.partnerId === context.partnerId
      && cursor.membershipGeneration === context.membershipGeneration)?.processedThroughSeq ?? 0,
    hasOlder: firstSeq !== undefined && room.messages.some((message) => message.seq < firstSeq),
    hasNewer: room.messages.some((message) => message.seq > throughSeq),
  };
}

export function prepareExternalContent(room: StudioRoomSnapshot, context: StudioExternalMemberContext,
  request: { messageId: string; offset: number; limit: number; readId?: string }) {
  const state = requireExternalMember(room, context);
  const { offset, limit } = request;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 256
    || limit > STUDIO_MCP_CONTENT_CHUNK_CHARACTERS) throw new Error('STUDIO_CONTENT_PAGE_INVALID');
  const message = room.messages.find((item) => item.messageId === request.messageId);
  if (!message || offset > message.content.length) throw new Error('STUDIO_MESSAGE_NOT_FOUND');
  let read = request.readId ? state.reads.find((item) => item.readId === request.readId && item.partnerId === context.partnerId
    && item.membershipGeneration === context.membershipGeneration && item.content?.messageId === request.messageId) : undefined;
  if (!read) {
    if (request.readId || offset !== 0) throw new Error('STUDIO_READ_RECEIPT_INVALID');
    read = { ...context, readId: randomUUID(), throughSeq: message.seq - 1, content: { messageId: request.messageId, nextOffset: 0, lastOffset: 0, lastLimit: limit } };
    addReadReceipt(state, read);
  }
  const progress = read.content!;
  if (offset !== progress.nextOffset && (offset !== progress.lastOffset || limit !== progress.lastLimit)) throw new Error('STUDIO_CONTENT_PAGE_OUT_OF_ORDER');
  let end = Math.min(message.content.length, offset + limit);
  // Never split a UTF-16 surrogate pair across protocol chunks.
  if (end < message.content.length && /[\uD800-\uDBFF]/.test(message.content[end - 1])) end -= 1;
  progress.nextOffset = Math.max(progress.nextOffset, end);
  progress.lastOffset = offset;
  progress.lastLimit = limit;
  if (end === message.content.length) read.throughSeq = message.seq;
  return { messageId: message.messageId, seq: message.seq, content: message.content.slice(offset, end), offset,
    nextOffset: end, totalCharacters: message.content.length, complete: end === message.content.length,
    readId: read.readId, throughSeq: read.throughSeq };
}

function addReadReceipt(state: StudioExternalRoomState, receipt: StudioExternalRoomState['reads'][number]) {
  // Bounded leases, scoped to this membership. Eviction never advances processing.
  const previous = state.reads.filter((read) => read.partnerId === receipt.partnerId);
  const retained = new Set(previous.slice(-(MAX_READ_RECEIPTS_PER_MEMBER - 1)).map((read) => read.readId));
  state.reads = state.reads.filter((read) => read.partnerId !== receipt.partnerId || retained.has(read.readId));
  state.reads.push(receipt);
}

export function acknowledgeExternalHistory(room: StudioRoomSnapshot, context: StudioExternalMemberContext, readId: string) {
  const state = requireExternalMember(room, context, true);
  const read = state.reads.find((item) => item.readId === readId && item.partnerId === context.partnerId
    && item.membershipGeneration === context.membershipGeneration);
  if (!read) throw new Error('STUDIO_READ_RECEIPT_INVALID');
  let cursor = state.processed.find((item) => item.partnerId === context.partnerId
    && item.membershipGeneration === context.membershipGeneration);
  if (!cursor) {
    cursor = { ...context, processedThroughSeq: 0 };
    state.processed.push(cursor);
  }
  cursor.processedThroughSeq = Math.max(cursor.processedThroughSeq, read.throughSeq);
  return cursor.processedThroughSeq;
}

export function externalSendHash(requestId: string, content: string, mentions: string[] = []) {
  if (!requestId.trim() || requestId.length > MAX_REQUEST_ID_CHARACTERS) throw new Error('STUDIO_REQUEST_ID_INVALID');
  if (!content || content.length > STUDIO_PUBLIC_HISTORY_BUDGET.maxCharacters) throw new Error('STUDIO_MESSAGE_CONTENT_INVALID');
  return createHash('sha256').update(mentions.length ? JSON.stringify([content, mentions]) : content).digest('hex');
}
