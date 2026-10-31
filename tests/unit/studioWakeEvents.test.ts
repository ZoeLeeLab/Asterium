// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioRoomStore } from '../../src/main/studio/StudioRoomStore';
import { StudioMcpAccessStore } from '../../src/main/studio/StudioMcpAccessStore';
import { StudioMcpService } from '../../src/main/studio/StudioMcpService';
import { StudioMcpHost } from '../../src/main/studio/StudioMcpHost';
import { StudioRuntimeCatalog } from '../../src/main/studio/StudioRuntimeCatalog';
import { StudioWakeEventStore } from '../../src/main/studio/StudioWakeEventStore';
import { StudioWakeEvents } from '../../src/main/studio/StudioWakeEvents';
import { ProjectMutationCoordinator } from '../../src/main/project/ProjectMutationCoordinator';
import { STUDIO_WAKE_LIMITS } from '../../src/shared/studioWake';

const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
const room = { roomId: 'group', projectId: 'project', name: '公开群', memberIds: ['chuan', 'other'] };
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-wake-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const roomsFile = path.join(directory, 'rooms.json'), journalFile = path.join(directory, 'events.json');
  const rooms = new StudioRoomStore(roomsFile); await rooms.syncRoom(room);
  await rooms.syncRoom({ ...room, roomId: 'private', memberIds: ['other'] });
  const catalog = new StudioRuntimeCatalog();
  for (const partnerId of room.memberIds) catalog.upsert({ partnerId, sourceMode: 'existing_thread', connectionSettings: {},
    publicIdentity: { displayName: partnerId, introduction: '', expertise: '', mentionName: partnerId },
    management: { userProfile: false, personality: false, memoryMode: 'self_managed' } });
  const coordinator = new ProjectMutationCoordinator(), access = new StudioMcpAccessStore(path.join(directory, 'access.json'));
  const service = new StudioMcpService(access, rooms, coordinator, (id) => Boolean(catalog.partner(id)));
  const journal = new StudioWakeEventStore(journalFile), events = new StudioWakeEvents(journal, rooms, catalog, coordinator, service);
  disposers.push(() => events.dispose()); await events.reconcile();
  const probe = createServer(); await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port; await new Promise<void>((resolve) => probe.close(() => resolve()));
  const host = new StudioMcpHost(access, service, events); disposers.push(() => host.dispose());
  await host.configure({ enabled: true, port, publicOrigin: '' });
  const issued = await access.issue('chuan'), other = await access.issue('other');
  const publish = (id: string, target = room, audience = ['chuan']) => coordinator.run(() => rooms.publishUserMessage({ room: target,
    messageId: id, content: `secret-body-${id}`, authorId: 'user', speakerQueue: [] }, 'manual', audience));
  return { roomsFile, journalFile, rooms, access, service, journal, events, host, issued, other, publish, coordinator,
    endpoint: `http://127.0.0.1:${port}/wake/events` };
}

async function stream(endpoint: string, token: string) {
  const controller = new AbortController(); disposers.push(async () => controller.abort());
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
  async function next(type: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([(async () => {
        for (;;) {
          const index = buffer.indexOf('\n\n');
          if (index >= 0) {
            const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            if (frame.includes(`event: ${type}\n`)) return JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
          } else {
            const chunk = await reader.read(); if (chunk.done) throw new Error(`STREAM_ENDED_BEFORE_${type}`);
            buffer += decoder.decode(chunk.value, { stream: true });
          }
        }
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`TIMED_OUT_${type}`)); }, 3000); })]);
    } finally { clearTimeout(timer); }
  }
  return { next, close: () => controller.abort() };
}

describe('persistent minimal Wake events and live authenticated SSE', () => {
  it('streams committed user hints without bodies or private groups, prevents a second connection and revokes immediately', async () => {
    const s = await setup();
    const live = await stream(s.endpoint, s.issued.token); await live.next('checkpoint');
    const duplicate = await fetch(s.endpoint, { headers: { Authorization: `Bearer ${s.issued.token}` } }); expect(duplicate.status).toBe(409);
    await s.publish('private', { ...room, roomId: 'private', memberIds: ['other'] }, ['other']);
    await s.publish('one');
    const wake = await live.next('wake');
    expect(wake).toMatchObject({ roomId: 'group', cursor: 1, membershipGeneration: 1, wakeEligible: true, wakeReason: 'user_message' });
    expect(JSON.stringify(wake)).not.toMatch(/secret-body|private|content|token/);
    expect(await readFile(s.journalFile, 'utf8')).not.toContain('secret-body');
    const revoked = live.next('access_revoked'); await s.access.revoke(s.issued.credential.credentialId); await revoked;
    expect((await fetch(s.endpoint, { headers: { Authorization: `Bearer ${s.issued.token}` } })).status).toBe(401);
  });

  it('separates notification scan from message and processing cursors, and never wakes on an ordinary partner reply', async () => {
    const s = await setup(); await s.publish('one');
    const batch = await s.events.poll(s.issued.token, 0);
    expect(batch.hints.filter((item) => item.wakeReason === 'user_message')).toHaveLength(1);
    const scope = { roomId: room.roomId, membershipGeneration: 1 };
    await s.service.send(s.issued.token, scope.roomId, 1, { requestId: 'reply', content: '公开回复' });
    await s.service.send(s.other.token, scope.roomId, 1, { requestId: 'other-reply', content: '不自动乒乓' });
    expect((await s.events.poll(s.issued.token, batch.scanCursor)).hints).toEqual([]);
    const page = await s.service.history(s.issued.token, scope.roomId, 1, {});
    expect(page.processedThroughSeq).toBe(0);
    if (!('readId' in page)) throw new Error('EXPECTED_BOUNDED_RECEIPT');
    await s.publish('later'); await s.service.acknowledge(s.issued.token, scope.roomId, 1, page.readId);
    const after = await s.events.poll(s.issued.token, batch.scanCursor);
    expect(after.hints).toContainEqual(expect.objectContaining({ wakeReason: 'user_message', cursor: 4 }));
    expect(after.hints).toContainEqual(expect.objectContaining({ wakeReason: 'processed', cursor: 3 }));
  });

  it('only explicit free-discussion invitations wake another external partner, with idempotent mention payloads', async () => {
    const s = await setup(); await s.publish('one');
    expect((await s.service.listRooms(s.issued.token)).rooms[0].members).toEqual([
      { partnerId: 'chuan', participation: 'external' }, { partnerId: 'other', participation: 'external' },
    ]);
    await s.rooms.setSettings(room.roomId, { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: true });
    const start = await s.events.poll(s.other.token, 0);
    const request = { requestId: 'invite', content: '请你看看', mentionPartnerIds: ['other'] };
    const reply = await s.service.send(s.issued.token, room.roomId, 1, request);
    expect(await s.service.send(s.issued.token, room.roomId, 1, request)).toEqual(reply);
    await expect(s.service.send(s.issued.token, room.roomId, 1, { ...request, mentionPartnerIds: [] })).rejects.toThrow('STUDIO_REQUEST_ID_CONFLICT');
    const batch = await s.events.poll(s.other.token, start.scanCursor);
    expect(batch.hints).toContainEqual(expect.objectContaining({ wakeReason: 'mention', cursor: 2, wakeEligible: true }));
    expect((await s.events.poll(s.issued.token, start.scanCursor)).hints.filter((item) => item.wakeReason === 'mention')).toEqual([]);
    await expect(s.service.send(s.issued.token, room.roomId, 1, { ...request, requestId: 'self', mentionPartnerIds: ['chuan'] })).rejects.toThrow('STUDIO_MENTION_SELF');
    await s.rooms.setSettings(room.roomId, { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: true });
    await expect(s.service.send(s.issued.token, room.roomId, 1, { ...request, requestId: 'ordered' })).rejects.toThrow('STUDIO_MENTION_DISABLED_IN_CURRENT_MODE');
  });

  it('revalidates mute, selection, archive and membership generation before replaying any wake', async () => {
    const s = await setup(); await s.publish('one');
    await s.rooms.setMuted(room.roomId, ['chuan']);
    const muted = await s.events.poll(s.issued.token, 0);
    expect(muted.hints.some((item) => item.wakeReason === 'user_message')).toBe(false);
    expect(muted.hints).toContainEqual(expect.objectContaining({ wakeReason: 'room_changed', wakeEligible: false }));
    await s.rooms.setMuted(room.roomId, []);
    await s.rooms.setSettings(room.roomId, { speakingMode: 'selected_partners', selectedPartnerIds: ['other'], discussionProtectionEnabled: true });
    expect((await s.events.poll(s.issued.token, 0)).hints.some((item) => item.wakeEligible)).toBe(false);
    await s.rooms.syncRoom({ ...room, archived: true });
    expect((await s.events.poll(s.issued.token, 0)).hints.some((item) => item.wakeEligible)).toBe(false);
    await s.rooms.applyProjectMemberships(room.projectId, [{ room: { ...room, archived: false, memberIds: ['other'] } }]);
    await s.rooms.applyProjectMemberships(room.projectId, [{ room }]);
    expect((await s.events.poll(s.issued.token, 0)).hints.some((item) => item.wakeReason === 'user_message')).toBe(false);
    await expect(s.service.history(s.issued.token, room.roomId, 1, {})).rejects.toThrow('STUDIO_MEMBERSHIP_STALE');
    expect((await s.service.history(s.issued.token, room.roomId, 3, {})).messages[0]).toMatchObject({ content: 'secret-body-one' });
  });

  it('reconciles offline ledger writes after restart without duplicate events and treats an unknown cursor as bounded resync', async () => {
    const s = await setup(); await s.publish('one'); await s.events.reconcile();
    const before = await s.journal.read('chuan', 0);
    await s.events.reconcile(); expect(await s.journal.read('chuan', 0)).toEqual(before);
    await s.events.dispose(); await s.coordinator.run(async () => undefined);
    const reloaded = new StudioWakeEventStore(s.journalFile);
    await s.publish('two'); await reloaded.reconcile(await s.rooms.listAll(), new Set(room.memberIds));
    const increment = await reloaded.read('chuan', before.scanCursor);
    expect(increment.hints.filter((item) => item.wakeReason === 'user_message')).toMatchObject([{ cursor: 2 }]);
    const reset = await s.events.poll(s.issued.token, 9999999);
    expect(reset).toMatchObject({ resetRequired: true, scanCursor: reset.latestEventId });
    expect(reset.hints.filter((item) => item.wakeReason === 'user_message')).toMatchObject([{ roomId: 'group', cursor: 2 }]);
    expect(reset.hints).toContainEqual(expect.objectContaining({ wakeReason: 'processed', cursor: 0 }));
  });

  it('baselines old history at first upgrade, retains bounded replay, and fails closed on corrupt journal', async () => {
    const s = await setup();
    const oldRoom = (await s.rooms.getRoom(room.roomId))!;
    oldRoom.messages = Array.from({ length: STUDIO_WAKE_LIMITS.replayEvents + 10 }, (_, index) => ({
      roomId: room.roomId, messageId: `old-${index}`, seq: index + 1, roundId: 'old', authorType: 'user', authorId: 'user',
      content: 'old public history', createdAt: new Date(0).toISOString(), status: 'completed', externalParticipantIds: ['chuan'] }));
    const initial = new StudioWakeEventStore(path.join(path.dirname(s.journalFile), 'initial.json'));
    await initial.reconcile([oldRoom], new Set(room.memberIds)); expect((await initial.read('chuan', 0)).hints).toEqual([]);
    // A pre-existing initialized journal sees these ledger writes, then trims only the notification log.
    await s.journal.reconcile([oldRoom], new Set(room.memberIds));
    const state = JSON.parse(await readFile(s.journalFile, 'utf8'));
    expect(state.events).toHaveLength(STUDIO_WAKE_LIMITS.replayEvents);
    expect((await s.journal.read('chuan', 0)).resetRequired).toBe(true);
    await writeFile(s.journalFile, JSON.stringify({ ...state, nextId: 1 }));
    await expect(new StudioWakeEventStore(s.journalFile).read('chuan', 0)).rejects.toThrow('STUDIO_WAKE_EVENTS_INVALID');
  });

  it('rejects unsafe HTTP paths, origin, invalid cursor and missing credentials without opening a stream', async () => {
    const s = await setup(); const headers = { Authorization: `Bearer ${s.issued.token}` };
    expect((await fetch(s.endpoint)).status).toBe(401);
    expect((await fetch(s.endpoint, { headers: { ...headers, Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${s.endpoint}?afterEventId=-1`, { headers })).status).toBe(400);
    expect((await fetch(`${s.endpoint}?afterEventId=1.5`, { headers })).status).toBe(400);
    expect((await fetch(s.endpoint, { method: 'POST', headers })).status).toBe(405);
  });

  it('rebuilds the independent processed boundary during resync and marks partial notification pages as not caught up', async () => {
    const s = await setup(); await s.publish('one');
    const page = await s.service.history(s.issued.token, room.roomId, 1, {});
    if (!('readId' in page)) throw new Error('EXPECTED_RECEIPT');
    await s.service.acknowledge(s.issued.token, room.roomId, 1, page.readId);
    await s.publish('two');
    const reset = await s.events.poll(s.issued.token, Number.MAX_SAFE_INTEGER);
    expect(reset.hints).toContainEqual(expect.objectContaining({ wakeReason: 'processed', cursor: 1 }));
    expect(reset.hints).toContainEqual(expect.objectContaining({ wakeReason: 'user_message', cursor: 2 }));
    await s.events.dispose(); await s.coordinator.run(async () => undefined);
    const snapshot = (await s.rooms.getRoom(room.roomId))!;
    for (let seq = 3; seq <= 200; seq++) snapshot.messages.push({ roomId: room.roomId, seq, messageId: `bulk-${seq}`, roundId: 'bulk',
      authorType: 'user', authorId: 'user', content: 'bounded event replay', createdAt: new Date(0).toISOString(), status: 'completed', externalParticipantIds: ['chuan'] });
    await writeFile(s.roomsFile, JSON.stringify({ version: 2, rooms: { [room.roomId]: { ...snapshot, nextSeq: 201 } } }));
    const live = await stream(s.endpoint, s.issued.token);
    expect(await live.next('checkpoint')).toMatchObject({ caughtUp: false });
    expect(await live.next('checkpoint')).toMatchObject({ caughtUp: true });
  });
});
