// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioRoomStore } from '../../src/main/studio/StudioRoomStore';
import { StudioOrchestrator } from '../../src/main/studio/StudioOrchestrator';
import { StudioRuntimeCatalog } from '../../src/main/studio/StudioRuntimeCatalog';
import { selectStudioPublicContext } from '../../src/shared/studioHistory';
import { STUDIO_PUBLIC_HISTORY_BUDGET, type StudioExternalMemberContext, type StudioRoomMessage } from '../../src/shared/studioRuntime';
import type { PartnerProfileSeed } from '../../src/shared/agentProtocol';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const room = { roomId: 'room-external', projectId: 'project-one', name: '外部伙伴群', memberIds: ['chuan', 'local'] };
const context: StudioExternalMemberContext = { roomId: room.roomId, partnerId: 'chuan', membershipGeneration: 1 };
const userMessage = (messageId = 'user-1', content = '大家讨论一下') => ({ room, messageId, content, authorId: 'untrusted-renderer-value', speakerQueue: [] as string[] });

async function create(messages: StudioRoomMessage[] = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-external-room-'));
  temporary.push(directory);
  const file = path.join(directory, 'rooms.json');
  let store = new StudioRoomStore(file);
  const snapshot = await store.syncRoom(room);
  if (messages.length) {
    // Exercise additive migration of old v2 ledgers, without writing 160 separate transactions.
    delete snapshot.externalState;
    await writeFile(file, JSON.stringify({ version: 2, rooms: { [room.roomId]: { ...snapshot, messages, nextSeq: messages.length + 1 } } }));
    store = new StudioRoomStore(file);
  }
  return { store, file };
}

function history(count: number, content = '公开历史'): StudioRoomMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    roomId: room.roomId, messageId: `history-${i + 1}`, seq: i + 1, roundId: 'history',
    authorType: 'partner', authorId: 'chuan', content, createdAt: new Date(0).toISOString(), status: 'completed',
  }));
}

function seed(partnerId: string, external: boolean): PartnerProfileSeed {
  return {
    partnerId, sourceMode: external ? 'existing_thread' : 'local_cli',
    publicIdentity: { displayName: partnerId, introduction: '', expertise: '', mentionName: partnerId },
    management: { userProfile: false, personality: false, memoryMode: 'self_managed' },
    connectionSettings: external ? {} : { __studioRuntime: { available: true, runtime: { kind: 'local', adapterType: 'codex_cli', workspaceGrantIds: [] } } },
  };
}

describe('external Studio membership and public ledger', () => {
  it.each(['external only', 'mixed'])('publishes %s without scheduling an external native runtime', async (kind) => {
    const { store } = await create();
    const members = kind === 'external only' ? ['chuan'] : ['chuan', 'local'];
    await store.syncRoom({ ...room, memberIds: members });
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: '' }, [seed('chuan', true), seed('local', false)]);
    const runtime = { prepareStudioTurn: vi.fn(), startStudioTurn: vi.fn(), cancelRun: vi.fn() };
    const orchestrator = new StudioOrchestrator(store, catalog, runtime);
    const snapshot = await orchestrator.startRound(userMessage());
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0].authorId).toBe(ASTERIUM_USER_ID);
    expect(snapshot.activeRound?.speakerQueue ?? []).toEqual(kind === 'external only' ? [] : ['local']);
    expect(runtime.prepareStudioTurn).not.toHaveBeenCalled();
    expect(runtime.startStudioTurn).not.toHaveBeenCalled();
  });

  it('selects an external mention in free discussion without also running local members', async () => {
    const { store } = await create();
    await store.setSettings(room.roomId, { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: true });
    const catalog = new StudioRuntimeCatalog();
    catalog.sync({ displayName: '用户', introduction: '', updatedAt: '' }, [seed('chuan', true), seed('local', false)]);
    const runtime = { prepareStudioTurn: vi.fn(), startStudioTurn: vi.fn(), cancelRun: vi.fn() };
    const result = await new StudioOrchestrator(store, catalog, runtime).startRound({ ...userMessage(), mentions: [{ partnerId: 'chuan', label: '外部伙伴', source: 'user' }] });
    expect(result.activeRound).toBeUndefined();
    expect(result.messages[0].mentions?.[0].partnerId).toBe('chuan');
  });

  it('deduplicates user publication during an active managed round and rejects conflicting reuse', async () => {
    const { store } = await create();
    const request = { ...userMessage(), speakerQueue: ['local'] };
    const first = await store.publishUserMessage(request);
    const retry = await store.publishUserMessage(request);
    expect(retry.messages).toHaveLength(1);
    expect(retry.activeRound?.roundId).toBe(first.activeRound?.roundId);
    await expect(store.publishUserMessage({ ...request, content: '不同内容' })).rejects.toThrow('STUDIO_MESSAGE_ID_CONFLICT');
  });

  it('durably deduplicates simultaneous external sends and binds the author to its authority context', async () => {
    const { store, file } = await create();
    const request = { requestId: 'retry-same', content: '我的公开回复' };
    const results = await Promise.all([store.appendExternalMessage(context, request), store.appendExternalMessage(context, request)]);
    expect(results[0].messageId).toBe(results[1].messageId);
    const reopened = new StudioRoomStore(file);
    const retry = await reopened.appendExternalMessage(context, request);
    expect(retry.snapshot.messages).toHaveLength(1);
    expect(retry.snapshot.messages[0]).toMatchObject({ authorType: 'partner', authorId: 'chuan', content: request.content });
    await expect(reopened.appendExternalMessage(context, { ...request, content: '换了内容' })).rejects.toThrow('STUDIO_REQUEST_ID_CONFLICT');
  });

  it('invalidates reads, acknowledgements, and sends on leave and rejects the old generation after rejoin', async () => {
    const { store, file } = await create(history(2));
    const read = await store.readExternalHistory(context);
    await store.applyProjectMemberships(room.projectId, [{ room: { ...room, memberIds: ['local'] } }]);
    await expect(store.readExternalHistory(context)).rejects.toThrow('STUDIO_MEMBERSHIP_REQUIRED');
    await expect(store.acknowledgeExternalRead(context, read.readId)).rejects.toThrow('STUDIO_MEMBERSHIP_REQUIRED');
    await expect(store.appendExternalMessage(context, { requestId: 'late', content: '迟到' })).rejects.toThrow('STUDIO_MEMBERSHIP_REQUIRED');
    await store.applyProjectMemberships(room.projectId, [{ room }]);
    const reopened = new StudioRoomStore(file);
    const member = await reopened.getMembership(room.roomId, 'chuan');
    expect(member?.membershipGeneration).toBeGreaterThan(context.membershipGeneration);
    await expect(reopened.readExternalHistory(context)).rejects.toThrow('STUDIO_MEMBERSHIP_STALE');
    const nextContext = { ...context, membershipGeneration: member!.membershipGeneration };
    // Rejoining does not hide the old public history or revive old receipts.
    expect((await reopened.readExternalHistory(nextContext)).messages).toHaveLength(2);
    await expect(reopened.acknowledgeExternalRead(nextContext, read.readId)).rejects.toThrow('STUDIO_READ_RECEIPT_INVALID');
  });

  it('acknowledges only a frozen read boundary, independently from native binding cursors', async () => {
    const { store, file } = await create(history(2));
    const read = await store.readExternalHistory(context);
    await store.appendExternalMessage(context, { requestId: 'newer', content: '读取之后的新消息' });
    expect(await store.acknowledgeExternalRead(context, read.readId)).toEqual({ processedThroughSeq: 2 });
    expect(await store.acknowledgeExternalRead(context, read.readId)).toEqual({ processedThroughSeq: 2 });
    const reopened = new StudioRoomStore(file);
    const page = await reopened.readExternalHistory(context, { afterSeq: 2 });
    expect(page.messages).toEqual([]);
    expect(page.throughSeq).toBe(3);
    expect(page.processedThroughSeq).toBe(2);
    expect((await reopened.getRoom(room.roomId))?.cursors).toEqual([]);
    await expect(reopened.acknowledgeExternalRead({ ...context, partnerId: 'local' }, read.readId)).rejects.toThrow('STUDIO_READ_RECEIPT_INVALID');
  });

  it('retains the shared bootstrap tail and permits paging back through every public message', async () => {
    const messages = history(STUDIO_PUBLIC_HISTORY_BUDGET.maxMessages + 7);
    const { store } = await create(messages);
    const bootstrap = await store.readExternalHistory(context);
    expect(bootstrap.messages).toEqual(selectStudioPublicContext(messages).messages);
    expect(bootstrap.hasOlder).toBe(true);
    expect(bootstrap.hasNewer).toBe(false);
    const older = await store.readExternalHistory(context, { beforeSeq: bootstrap.messages[0].seq });
    expect(older.messages.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(older.hasOlder).toBe(false);
    expect(older.hasNewer).toBe(true);
    expect(bootstrap.processedThroughSeq).toBe(0); // Reading alone never acknowledges processing.
  });

  it('bounds forward pages by the same character budget without skipping unread messages', async () => {
    const text = 'x'.repeat(STUDIO_PUBLIC_HISTORY_BUDGET.maxCharacters / 2);
    const { store } = await create(history(5, text).map((message) => ({ ...message, authorId: 'local' })));
    const first = await store.readExternalHistory(context, { afterSeq: 0 });
    expect(first.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(first.hasNewer).toBe(true);
    const second = await store.readExternalHistory(context, { afterSeq: first.throughSeq });
    expect(second.messages.map((message) => message.seq)).toEqual([3, 4]);
    expect(selectStudioPublicContext(history(2, text.repeat(3))).messages).toHaveLength(1);
  });

  it('omits own incremental output without consuming the page limit or skipping another member', async () => {
    const messages = history(6).map((message) => ({ ...message, authorId: [2, 5].includes(message.seq) ? 'local' : 'chuan' }));
    const { store } = await create(messages);
    const first = await store.readExternalHistory(context, { afterSeq: 0, limit: 1 });
    expect(first.messages.map((message) => message.seq)).toEqual([2]);
    expect(first).toMatchObject({ throughSeq: 4, latestSeq: 6, hasNewer: true, processedThroughSeq: 0 });
    const second = await store.readExternalHistory(context, { afterSeq: first.throughSeq, limit: 1 });
    expect(second.messages.map((message) => message.seq)).toEqual([5]);
    expect(second).toMatchObject({ throughSeq: 6, latestSeq: 6, hasNewer: false });
    const other = await store.readExternalHistory({ ...context, partnerId: 'local' }, { afterSeq: 0 });
    expect(other.messages.map((message) => message.seq)).toEqual([1, 3, 4, 6]);
    expect((await store.readExternalHistory(context)).messages).toEqual(messages);
    expect((await store.readExternalHistory(context, { beforeSeq: 4 })).messages.map((message) => message.seq)).toEqual([1, 2, 3]);
    expect((await store.getRoom(room.roomId))?.messages).toEqual(messages);
  });

  it('advances empty/self-only scans safely, freezing acknowledgements before newer messages arrive', async () => {
    const { store, file } = await create(history(3));
    const page = await store.readExternalHistory(context, { afterSeq: 0 });
    expect(page).toMatchObject({ messages: [], throughSeq: 3, latestSeq: 3, hasNewer: false, processedThroughSeq: 0 });
    await store.appendExternalMessage({ ...context, partnerId: 'local' }, { requestId: 'other-new', content: '不能跳过' });
    const reopened = new StudioRoomStore(file);
    expect(await reopened.acknowledgeExternalRead(context, page.readId)).toEqual({ processedThroughSeq: 3 });
    const next = await reopened.readExternalHistory(context, { afterSeq: page.throughSeq });
    expect(next.messages.map((message) => message.seq)).toEqual([4]);
    expect(await reopened.readExternalHistory(context, { afterSeq: 4 })).toMatchObject({ messages: [], throughSeq: 4, hasNewer: false });
    expect(await reopened.readExternalHistory(context, { afterSeq: 1000 })).toMatchObject({ messages: [], throughSeq: 4 });
  });

  it('does not charge own messages against the increment character budget, including oversized own output', async () => {
    const half = 'x'.repeat(STUDIO_PUBLIC_HISTORY_BUDGET.maxCharacters / 2);
    const messages = history(5).map((message) => ({ ...message, authorId: [1, 3].includes(message.seq) ? 'chuan' : 'local',
      content: [1, 3].includes(message.seq) ? half.repeat(3) : half }));
    const { store } = await create(messages);
    const first = await store.readExternalHistory(context, { afterSeq: 0 });
    expect(first.messages.map((message) => message.seq)).toEqual([2, 4]);
    expect(first).toMatchObject({ throughSeq: 4, hasNewer: true });
    const second = await store.readExternalHistory(context, { afterSeq: first.throughSeq });
    expect(second.messages.map((message) => message.seq)).toEqual([5]);
  });

  it.each([{ afterSeq: -1 }, { afterSeq: 0, beforeSeq: 2 }, { beforeSeq: 0 }, { limit: 0 }, { limit: STUDIO_PUBLIC_HISTORY_BUDGET.maxMessages + 1 }])('rejects invalid pagination %j', async (request) => {
    const { store } = await create();
    await expect(store.readExternalHistory(context, request)).rejects.toThrow('STUDIO_HISTORY_PAGE_INVALID');
  });

  it('keeps archived history readable, forbids writes, and does not unarchive on membership changes', async () => {
    const { store } = await create(history(2));
    await store.syncRoom({ ...room, archived: true });
    expect((await store.readExternalHistory(context)).messages).toHaveLength(2);
    await expect(store.appendExternalMessage(context, { requestId: 'archive', content: '不应写入' })).rejects.toThrow('STUDIO_ROOM_ARCHIVED');
    await expect(store.publishUserMessage(userMessage(), 'manual', ['chuan'])).rejects.toThrow('STUDIO_ROOM_ARCHIVED');
    await store.applyProjectMemberships(room.projectId, [{ room }]);
    expect((await store.getRoom(room.roomId))?.metadata.archived).toBe(true);
    await store.syncRoom({ ...room, archived: false });
    await expect(store.appendExternalMessage(context, { requestId: 'restored', content: '恢复后发言' })).resolves.toBeDefined();
  });

  it('enforces mute and selected-partner rules', async () => {
    const { store } = await create();
    await store.setMuted(room.roomId, ['chuan']);
    await expect(store.appendExternalMessage(context, { requestId: 'mute', content: '不能发' })).rejects.toThrow('STUDIO_PARTNER_MUTED');
    await store.setMuted(room.roomId, []);
    await store.setSettings(room.roomId, { speakingMode: 'selected_partners', selectedPartnerIds: ['local'], discussionProtectionEnabled: false });
    await expect(store.appendExternalMessage(context, { requestId: 'selected', content: '不能发' })).rejects.toThrow('STUDIO_PARTNER_NOT_SELECTED');
    await expect(store.publishUserMessage(userMessage(), 'manual', ['chuan'])).rejects.toThrow('STUDIO_ROUND_HAS_NO_SPEAKERS');
  });

  it('restores membership and receipt state with project transaction snapshots and denies deleted rooms', async () => {
    const { store } = await create(history(2));
    const read = await store.readExternalHistory(context);
    const snapshots = await store.listProject(room.projectId);
    await store.applyProjectMemberships(room.projectId, [{ room: { ...room, memberIds: [] } }]);
    await store.restoreProject(room.projectId, snapshots);
    expect(await store.acknowledgeExternalRead(context, read.readId)).toEqual({ processedThroughSeq: 2 });
    await store.removeProject(room.projectId);
    await expect(store.readExternalHistory(context)).rejects.toThrow('STUDIO_ROOM_NOT_FOUND');
  });

  it('fails closed on corrupt persisted membership instead of resetting its generation', async () => {
    const { file } = await create();
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.rooms[room.roomId].externalState.memberships[0].membershipGeneration = 0;
    await writeFile(file, JSON.stringify(data));
    await expect(new StudioRoomStore(file).getRoom(room.roomId)).rejects.toThrow('STUDIO_EXTERNAL_STATE_INVALID');
  });
});
