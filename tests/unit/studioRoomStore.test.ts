import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_PROTOCOL_VERSION, type PartnerEvent } from '../../src/shared/agentProtocol';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';
import { StudioRoomStore } from '../../src/main/studio/StudioRoomStore';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function store() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-room-'));
  temporary.push(directory);
  return new StudioRoomStore(path.join(directory, 'rooms.json'));
}

function event(type: 'text.delta' | 'run.completed' | 'run.cancelled', route: { roomId?: string; roundId: string; inputThroughSeq: number; bindingGeneration: number }, extra: Record<string, unknown> = {}) {
  const partnerId = String(extra.partnerId ?? 'partner-a');
  const runId = String(extra.runId ?? 'run-a');
  const sessionId = String(extra.sessionId ?? 'thread-a');
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    type,
    eventId: `${type}-1`,
    partnerId,
    conversationId: String(extra.conversationId ?? `group:v2:room-a:${partnerId}`),
    connectionSource: 'local_cli',
    clientMessageId: `assistant-${runId}`,
    sessionId,
    runId,
    sequence: type === 'text.delta' ? 2 : 3,
    occurredAt: new Date().toISOString(),
    route: { scope: 'group', roomId: route.roomId ?? 'room-a', roundId: route.roundId, inputThroughSeq: route.inputThroughSeq, bindingGeneration: route.bindingGeneration },
    ...(type === 'text.delta' ? { text: String(extra.text ?? '') } : {}),
    ...(type === 'run.completed' ? { finishReason: 'completed' as const } : {}),
    ...(type === 'run.cancelled' ? { reason: 'stopped' } : {}),
  } as PartnerEvent;
}

describe('StudioRoomStore', () => {
  it('defaults new rooms to free discussion and preserves a saved explicit mode', async () => {
    const rooms = await store();
    const room = { roomId: 'default-room', projectId: 'project-a', name: '新群聊', memberIds: [] };
    const created = await rooms.syncRoom(room);
    expect(created.settings.speakingMode).toBe('free_discussion');
    await rooms.setSettings(room.roomId, { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false });
    expect((await rooms.syncRoom(room)).settings.speakingMode).toBe('round_robin');
  });
  it('reads the v1 ledger, migrates only user author ids, and preserves a versioned backup', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-room-'));
    temporary.push(directory);
    const filePath = path.join(directory, 'rooms.json');
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['fixture-user'] };
    const first = new StudioRoomStore(filePath);
    await first.startRound({ room, messageId: 'user-1', content: '旧记录', authorId: 'legacy-renderer-value', speakerQueue: ['fixture-user'] });
    const legacy = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number;
      rooms: Record<string, { messages: Array<{ authorId: string; authorType: string }> }>;
    };
    legacy.version = 1;
    legacy.rooms['room-a'].messages[0].authorId = 'fixture-user';
    await writeFile(filePath, JSON.stringify(legacy), 'utf8');

    const migrated = await new StudioRoomStore(filePath).getRoom('room-a');
    const stored = JSON.parse(await readFile(filePath, 'utf8')) as typeof legacy;
    const backup = JSON.parse(await readFile(`${filePath}.v1.backup`, 'utf8')) as typeof legacy;

    expect(migrated?.messages[0].authorId).toBe(ASTERIUM_USER_ID);
    expect(stored.version).toBe(2);
    expect(stored.rooms['room-a'].messages[0].authorId).toBe(ASTERIUM_USER_ID);
    expect(backup.version).toBe(1);
    expect(backup.rooms['room-a'].messages[0].authorId).toBe('fixture-user');
    expect(migrated?.metadata.memberIds).toEqual(['fixture-user']);
  });

  it('uses the stable local user id regardless of the compatible renderer request value', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a'] };
    const started = await rooms.startRound({ room, messageId: 'user-1', content: '新记录', authorId: 'legacy-renderer-value', speakerQueue: ['partner-a'] }, 'full');
    expect(started.messages[0].authorId).toBe(ASTERIUM_USER_ID);
    expect(started.activeRound?.permissionMode).toBe('full');
  });

  it('stores membership announcements in the canonical ledger without starting a round', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a'] };
    await rooms.syncRoom(room);
    const announced = await rooms.appendSystemMessage('room-a', '测试伙伴加入了群聊');
    expect(announced.activeRound).toBeUndefined();
    expect(announced.messages).toEqual([
      expect.objectContaining({ seq: 1, authorType: 'system', authorId: 'system', content: '测试伙伴加入了群聊' }),
    ]);

    const started = await rooms.startRound({ room, messageId: 'user-1', content: '欢迎一下', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const prepared = await rooms.prepareTurn('room-a', started.activeRound!.roundId, 'partner-a', 1, 'group:v2:room-a:partner-a');
    expect(prepared.messages.map((message) => [message.authorType, message.content])).toEqual([
      ['system', '测试伙伴加入了群聊'],
      ['user', '欢迎一下'],
    ]);
  });

  it('commits only the input boundary frozen at turn start', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a'] };
    const started = await rooms.startRound({ room, messageId: 'user-1', content: '第一轮', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const roundId = started.activeRound!.roundId;
    const prepared = await rooms.prepareTurn('room-a', roundId, 'partner-a', 1, 'group:v2:room-a:partner-a');
    expect(prepared.inputThroughSeq).toBe(1);
    await rooms.bindRun('room-a', roundId, 'partner-a', 'run-a', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId, inputThroughSeq: 1, bindingGeneration: 1 }, { text: '第一轮回复' }));
    await rooms.observeEvent(event('run.completed', { roundId, inputThroughSeq: 1, bindingGeneration: 1 }));

    const complete = await rooms.getRoom('room-a');
    expect(complete?.messages.map((item) => item.seq)).toEqual([1, 2]);
    expect(complete?.cursors).toContainEqual(expect.objectContaining({ partnerId: 'partner-a', bindingGeneration: 1, processedThroughSeq: 1 }));

    const second = await rooms.startRound({ room, messageId: 'user-2', content: '第二轮', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const next = await rooms.prepareTurn('room-a', second.activeRound!.roundId, 'partner-a', 1, 'group:v2:room-a:partner-a', 'thread-a');
    expect(next.processedAfterSeq).toBe(1);
    expect(next.messages.map((item) => [item.seq, item.authorId])).toEqual([[3, ASTERIUM_USER_ID]]);

    await rooms.bindRun('room-a', second.activeRound!.roundId, 'partner-a', 'run-b', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId: second.activeRound!.roundId, inputThroughSeq: 3, bindingGeneration: 1 }, { runId: 'run-b', text: '第二轮回复' }));
    await rooms.observeEvent(event('run.completed', { roundId: second.activeRound!.roundId, inputThroughSeq: 3, bindingGeneration: 1 }, { runId: 'run-b' }));
    const third = await rooms.startRound({ room, messageId: 'user-3', content: '第三轮', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const afterCommit = await rooms.prepareTurn('room-a', third.activeRound!.roundId, 'partner-a', 1, 'group:v3:room-a:partner-a', 'thread-a');
    expect(afterCommit.messages.map((item) => [item.seq, item.authorId])).toEqual([[5, ASTERIUM_USER_ID]]);
  });

  it('rebuilds other-party context from the canonical ledger for a new binding generation', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a'] };
    const first = await rooms.startRound({ room, messageId: 'user-1', content: '第一轮', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const firstRound = first.activeRound!.roundId;
    await rooms.prepareTurn('room-a', firstRound, 'partner-a', 1, 'group:v2:room-a:partner-a');
    await rooms.bindRun('room-a', firstRound, 'partner-a', 'run-a', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId: firstRound, inputThroughSeq: 1, bindingGeneration: 1 }, { text: '旧线程回复' }));
    await rooms.observeEvent(event('run.completed', { roundId: firstRound, inputThroughSeq: 1, bindingGeneration: 1 }));

    const second = await rooms.startRound({ room, messageId: 'user-2', content: '重建后继续', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const rebuilt = await rooms.prepareTurn('room-a', second.activeRound!.roundId, 'partner-a', 2, 'group:v2:room-a:partner-a');
    expect(rebuilt.processedAfterSeq).toBe(0);
    expect(rebuilt.messages.map((item) => item.content)).toEqual(['第一轮', '重建后继续']);
    expect((await rooms.getRoom('room-a'))?.messages.map((item) => item.content)).toEqual(['第一轮', '旧线程回复', '重建后继续']);
  });

  it('gives a later speaker every reply already completed in the same round', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a', 'partner-b'] };
    const started = await rooms.startRound({ room, messageId: 'user-1', content: '请依次回答', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a', 'partner-b'] });
    const roundId = started.activeRound!.roundId;
    const first = await rooms.prepareTurn('room-a', roundId, 'partner-a', 1, 'group:v3:room-a:partner-a');
    await rooms.bindRun('room-a', roundId, 'partner-a', 'run-a', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId, inputThroughSeq: first.inputThroughSeq, bindingGeneration: 1 }, { conversationId: first.conversationId, text: 'A 的回复' }));
    await rooms.observeEvent(event('run.completed', { roundId, inputThroughSeq: first.inputThroughSeq, bindingGeneration: 1 }, { conversationId: first.conversationId }));

    const second = await rooms.prepareTurn('room-a', roundId, 'partner-b', 1, 'group:v3:room-a:partner-b');
    expect(second.messages.map((item) => [item.seq, item.authorId, item.content])).toEqual([
      [1, ASTERIUM_USER_ID, '请依次回答'],
      [2, 'partner-a', 'A 的回复'],
    ]);
  });

  it('keeps public increments cursor-scoped, omits own replies, and delivers them to other partners', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a', 'partner-b'] };
    const first = await rooms.startRound({ room, messageId: 'user-1', content: '第一轮', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a', 'partner-b'] });
    const firstRound = first.activeRound!.roundId;
    const preparedA = await rooms.prepareTurn('room-a', firstRound, 'partner-a', 1, 'group:v3:room-a:partner-a');
    await rooms.bindRun('room-a', firstRound, 'partner-a', 'run-a-1', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId: firstRound, inputThroughSeq: preparedA.inputThroughSeq, bindingGeneration: 1 }, { runId: 'run-a-1', conversationId: preparedA.conversationId, text: 'A 第一轮回复' }));
    await rooms.observeEvent(event('run.completed', { roundId: firstRound, inputThroughSeq: preparedA.inputThroughSeq, bindingGeneration: 1 }, { runId: 'run-a-1', conversationId: preparedA.conversationId }));

    const preparedB = await rooms.prepareTurn('room-a', firstRound, 'partner-b', 1, 'group:v3:room-a:partner-b');
    expect(preparedB.processedAfterSeq).toBe(0);
    expect(preparedB.messages.map((item) => [item.seq, item.authorId, item.content])).toEqual([
      [1, ASTERIUM_USER_ID, '第一轮'],
      [2, 'partner-a', 'A 第一轮回复'],
    ]);
    await rooms.bindRun('room-a', firstRound, 'partner-b', 'run-b-1', 'thread-b');
    await rooms.observeEvent(event('text.delta', { roundId: firstRound, inputThroughSeq: preparedB.inputThroughSeq, bindingGeneration: 1 }, { partnerId: 'partner-b', runId: 'run-b-1', sessionId: 'thread-b', conversationId: preparedB.conversationId, text: 'B 第一轮回复' }));
    await rooms.observeEvent(event('run.completed', { roundId: firstRound, inputThroughSeq: preparedB.inputThroughSeq, bindingGeneration: 1 }, { partnerId: 'partner-b', runId: 'run-b-1', sessionId: 'thread-b', conversationId: preparedB.conversationId }));

    const second = await rooms.startRound({ room, messageId: 'user-2', content: '第二轮', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a', 'partner-b'] });
    const nextA = await rooms.prepareTurn('room-a', second.activeRound!.roundId, 'partner-a', 1, 'group:v3:room-a:partner-a', 'thread-a');
    expect(nextA.processedAfterSeq).toBe(1);
    expect(nextA.messages.map((item) => [item.seq, item.authorId, item.content])).toEqual([
      [3, 'partner-b', 'B 第一轮回复'],
      [4, ASTERIUM_USER_ID, '第二轮'],
    ]);
    expect(nextA.messages.filter((item) => item.authorId === 'partner-a')).toHaveLength(0);
    expect(nextA.messages.filter((item) => item.authorId === 'partner-b')).toHaveLength(1);
    expect((await rooms.getRoom('room-a'))?.messages.map((item) => [item.seq, item.authorId, item.content])).toEqual([
      [1, ASTERIUM_USER_ID, '第一轮'],
      [2, 'partner-a', 'A 第一轮回复'],
      [3, 'partner-b', 'B 第一轮回复'],
      [4, ASTERIUM_USER_ID, '第二轮'],
    ]);
  });

  it('sends only the new user increment on the next turn in a user-and-partner room', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '双人讨论', memberIds: ['partner-a'] };
    const first = await rooms.startRound({ room, messageId: 'user-1', content: '第一句话', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const firstRound = first.activeRound!.roundId;
    const prepared = await rooms.prepareTurn('room-a', firstRound, 'partner-a', 1, 'group:v3:room-a:partner-a');
    await rooms.bindRun('room-a', firstRound, 'partner-a', 'run-a-1', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId: firstRound, inputThroughSeq: prepared.inputThroughSeq, bindingGeneration: 1 }, { runId: 'run-a-1', conversationId: prepared.conversationId, text: '伙伴回答' }));
    await rooms.observeEvent(event('run.completed', { roundId: firstRound, inputThroughSeq: prepared.inputThroughSeq, bindingGeneration: 1 }, { runId: 'run-a-1', conversationId: prepared.conversationId }));

    const second = await rooms.startRound({ room, messageId: 'user-2', content: '第二句话', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const next = await rooms.prepareTurn('room-a', second.activeRound!.roundId, 'partner-a', 1, 'group:v3:room-a:partner-a', 'thread-a');

    expect(next.messages.map((item) => [item.seq, item.authorId, item.content])).toEqual([
      [3, ASTERIUM_USER_ID, '第二句话'],
    ]);
    expect((await rooms.getRoom('room-a'))?.messages.map((item) => [item.seq, item.authorId, item.content])).toEqual([
      [1, ASTERIUM_USER_ID, '第一句话'],
      [2, 'partner-a', '伙伴回答'],
      [3, ASTERIUM_USER_ID, '第二句话'],
    ]);
  });

  it('keeps interrupted output and does not advance the cursor', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a'] };
    const started = await rooms.startRound({ room, messageId: 'user-1', content: '请回复', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const roundId = started.activeRound!.roundId;
    await rooms.prepareTurn('room-a', roundId, 'partner-a', 1, 'group:v2:room-a:partner-a');
    await rooms.bindRun('room-a', roundId, 'partner-a', 'run-a', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId, inputThroughSeq: 1, bindingGeneration: 1 }, { text: '只写了一半' }));
    await rooms.observeEvent(event('run.cancelled', { roundId, inputThroughSeq: 1, bindingGeneration: 1 }));
    const snapshot = await rooms.getRoom('room-a');
    expect(snapshot?.messages.at(-1)).toMatchObject({ content: '只写了一半', status: 'interrupted' });
    expect(snapshot?.cursors).toEqual([]);
    expect(snapshot?.activeRound?.state).toBe('cancelled');
  });

  it('commits an explicit pass without exposing its internal marker as a message', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a'] };
    await rooms.syncRoom(room);
    await rooms.setSettings('room-a', { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: false });
    const started = await rooms.startRound({ room, messageId: 'user-1', content: '还有补充吗', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const roundId = started.activeRound!.roundId;
    await rooms.prepareTurn('room-a', roundId, 'partner-a', 1, 'group:v2:room-a:partner-a');
    await rooms.bindRun('room-a', roundId, 'partner-a', 'run-a', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId, inputThroughSeq: 1, bindingGeneration: 1 }, { text: '<asterium_group_pass/>' }));
    await rooms.observeEvent(event('run.completed', { roundId, inputThroughSeq: 1, bindingGeneration: 1 }));
    const snapshot = await rooms.getRoom('room-a');
    expect(snapshot?.messages).toHaveLength(1);
    expect(snapshot?.messages[0].content).toBe('还有补充吗');
    expect(snapshot?.activeRound?.members[0].state).toBe('passed');
    expect(snapshot?.cursors[0]).toMatchObject({ bindingGeneration: 1, processedThroughSeq: 1 });
  });

  it('requeues a forbidden pass only after release and accepts the corrective reply', async () => {
    const rooms = await store();
    await rooms.syncRoom({ roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a'] });
    await rooms.setSettings('room-a', { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false });
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a'] };
    const started = await rooms.startRound({ room, messageId: 'user-1', content: '必须回复', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const roundId = started.activeRound!.roundId;
    const first = await rooms.prepareTurn('room-a', roundId, 'partner-a', 1, 'group:v3:room-a:partner-a');
    await rooms.bindRun('room-a', roundId, 'partner-a', 'run-a', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId, inputThroughSeq: first.inputThroughSeq, bindingGeneration: 1 }, { conversationId: first.conversationId, text: '<asterium_group_pass />' }));
    await rooms.observeEvent(event('run.completed', { roundId, inputThroughSeq: first.inputThroughSeq, bindingGeneration: 1 }, { conversationId: first.conversationId }));

    expect(rooms.hasPendingPassRetry('run-a')).toBe(true);
    expect((await rooms.getRoom('room-a'))?.activeRound).toMatchObject({
      state: 'running',
      currentPartnerId: 'partner-a',
      members: [expect.objectContaining({ partnerId: 'partner-a', state: 'running', runId: 'run-a' })],
    });

    const queued = await rooms.retryPassAfterRelease('run-a');
    expect(queued?.activeRound).toMatchObject({
      state: 'queued',
      members: [expect.objectContaining({ partnerId: 'partner-a', state: 'queued' })],
    });
    const retry = await rooms.prepareTurn('room-a', roundId, 'partner-a', 1, 'group:v3:room-a:partner-a', 'thread-a');
    await rooms.bindRun('room-a', roundId, 'partner-a', 'run-retry', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId, inputThroughSeq: retry.inputThroughSeq, bindingGeneration: 1 }, { runId: 'run-retry', conversationId: retry.conversationId, text: '这次正常回复' }));
    await rooms.observeEvent(event('run.completed', { roundId, inputThroughSeq: retry.inputThroughSeq, bindingGeneration: 1 }, { runId: 'run-retry', conversationId: retry.conversationId }));

    const completed = await rooms.getRoom('room-a');
    expect(completed?.activeRound?.state).toBe('completed');
    expect(completed?.messages.map((message) => message.content)).toEqual(['必须回复', '这次正常回复']);
    expect(completed?.cursors).toEqual([expect.objectContaining({ partnerId: 'partner-a', processedThroughSeq: 1 })]);
  });

  it('fails a second forbidden pass instead of retrying forever', async () => {
    const rooms = await store();
    await rooms.syncRoom({ roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a'] });
    await rooms.setSettings('room-a', { speakingMode: 'round_robin', selectedPartnerIds: [], discussionProtectionEnabled: false });
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a'] };
    const started = await rooms.startRound({ room, messageId: 'user-1', content: '必须回复', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const roundId = started.activeRound!.roundId;
    const first = await rooms.prepareTurn('room-a', roundId, 'partner-a', 1, 'group:v3:room-a:partner-a');
    await rooms.bindRun('room-a', roundId, 'partner-a', 'run-a', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId, inputThroughSeq: first.inputThroughSeq, bindingGeneration: 1 }, { conversationId: first.conversationId, text: '<asterium_group_pass />' }));
    await rooms.observeEvent(event('run.completed', { roundId, inputThroughSeq: first.inputThroughSeq, bindingGeneration: 1 }, { conversationId: first.conversationId }));
    await rooms.retryPassAfterRelease('run-a');

    const retry = await rooms.prepareTurn('room-a', roundId, 'partner-a', 1, 'group:v3:room-a:partner-a', 'thread-a');
    await rooms.bindRun('room-a', roundId, 'partner-a', 'run-retry', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId, inputThroughSeq: retry.inputThroughSeq, bindingGeneration: 1 }, { runId: 'run-retry', conversationId: retry.conversationId, text: '<asterium_group_pass />' }));
    await rooms.observeEvent(event('run.completed', { roundId, inputThroughSeq: retry.inputThroughSeq, bindingGeneration: 1 }, { runId: 'run-retry', conversationId: retry.conversationId }));

    expect(rooms.hasPendingPassRetry('run-retry')).toBe(false);
    expect((await rooms.getRoom('room-a'))?.activeRound).toMatchObject({
      state: 'failed',
      members: [expect.objectContaining({ partnerId: 'partner-a', state: 'failed' })],
    });
  });

  it('does not treat an empty completed run as a voluntary pass', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a'] };
    await rooms.syncRoom(room);
    await rooms.setSettings('room-a', { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: false });
    const started = await rooms.startRound({ room, messageId: 'user-1', content: '说点什么', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const roundId = started.activeRound!.roundId;
    const prepared = await rooms.prepareTurn('room-a', roundId, 'partner-a', 1, 'group:v3:room-a:partner-a');
    await rooms.bindRun('room-a', roundId, 'partner-a', 'run-a', 'thread-a');
    await rooms.observeEvent(event('run.completed', { roundId, inputThroughSeq: prepared.inputThroughSeq, bindingGeneration: 1 }, { conversationId: prepared.conversationId }));

    expect((await rooms.getRoom('room-a'))?.activeRound).toMatchObject({
      state: 'failed',
      members: [expect.objectContaining({ partnerId: 'partner-a', state: 'failed' })],
    });
  });

  it('recovers a non-terminal round as cancelled after the app restarts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-room-'));
    temporary.push(directory);
    const file = path.join(directory, 'rooms.json');
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a', 'partner-b'] };
    const firstProcess = new StudioRoomStore(file);
    const started = await firstProcess.startRound({ room, messageId: 'user-1', content: '请讨论', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a', 'partner-b'] });
    await firstProcess.prepareTurn('room-a', started.activeRound!.roundId, 'partner-a', 1, 'group:v2:room-a:partner-a');

    const restartedProcess = new StudioRoomStore(file);
    const recovered = await restartedProcess.syncRoom(room);
    expect(recovered.activeRound?.state).toBe('cancelled');
    expect(recovered.activeRound?.members.map((member) => member.state)).toEqual(['cancelled', 'cancelled']);
    expect(recovered.cursors).toEqual([]);
  });

  it('persists speaking settings and limits selected mode to its chosen partners', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a', 'partner-b'] };
    await rooms.syncRoom(room);
    const configured = await rooms.setSettings('room-a', {
      speakingMode: 'selected_partners',
      selectedPartnerIds: ['partner-b'],
      discussionProtectionEnabled: false,
    });
    expect(configured.settings).toEqual({ speakingMode: 'selected_partners', selectedPartnerIds: ['partner-b'], discussionProtectionEnabled: false });
    const started = await rooms.startRound({ room, messageId: 'user-1', content: '只请 B 回答', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a', 'partner-b'] });
    expect(started.activeRound?.speakerQueue).toEqual(['partner-b']);
    expect(started.activeRound?.members).toEqual([expect.objectContaining({ partnerId: 'partner-b', state: 'queued' })]);
  });

  it('records structured user and partner mentions and queues an invited partner', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a', 'partner-b', 'partner-c'] };
    await rooms.syncRoom(room);
    await rooms.setSettings('room-a', { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: false });
    const started = await rooms.startRound({
      room,
      messageId: 'user-1',
      content: '@小A 先看看',
      authorId: ASTERIUM_USER_ID,
      speakerQueue: ['partner-a', 'partner-b', 'partner-c'],
      mentions: [{ partnerId: 'partner-a', label: '小A', start: 0, end: 3, source: 'user' }],
    });
    const roundId = started.activeRound!.roundId;
    const prepared = await rooms.prepareTurn('room-a', roundId, 'partner-a', 1, 'group:v2:room-a:partner-a');
    await rooms.bindRun('room-a', roundId, 'partner-a', 'run-a', 'thread-a');
    const notifications: Array<NonNullable<Awaited<ReturnType<StudioRoomStore['getRoom']>>>> = [];
    rooms.subscribe((value) => { notifications.push(value); });
    await rooms.observeEvent(event('text.delta', { roundId, inputThroughSeq: prepared.inputThroughSeq, bindingGeneration: 1 }, { text: '@小C 你先看看' }));
    const mentioned = await rooms.mentionPartner({ roomId: 'room-a', roundId, partnerId: 'partner-a', targetPartnerId: 'partner-c', bindingGeneration: 1, inputThroughSeq: prepared.inputThroughSeq, label: '小C' });
    expect(mentioned.activeRound?.members.map((member) => member.partnerId)).toEqual(['partner-a', 'partner-c', 'partner-b']);
    expect(mentioned.activeRound?.speakerQueue).toEqual(['partner-a', 'partner-c', 'partner-b']);
    expect(notifications.at(-1)?.streaming?.content).toBe('@小C 你先看看');
    await rooms.observeEvent(event('run.completed', { roundId, inputThroughSeq: prepared.inputThroughSeq, bindingGeneration: 1 }));
    const snapshot = await rooms.getRoom('room-a');
    expect(snapshot?.messages[0].mentions).toEqual([{ partnerId: 'partner-a', label: '小A', start: 0, end: 3, source: 'user' }]);
    expect(snapshot?.messages[1].mentions).toEqual([{ partnerId: 'partner-c', label: '小C', source: 'partner' }]);
    expect(snapshot?.activeRound?.state).toBe('queued');
    expect(snapshot?.activeRound?.members.find((member) => member.state === 'queued')?.partnerId).toBe('partner-c');
  });

  it('cancels a queued or binding round immediately and ignores late terminal events', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a', 'partner-b'] };
    const queued = await rooms.startRound({ room, messageId: 'user-1', content: '请讨论', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a', 'partner-b'] });
    const cancelledQueued = await rooms.cancelRound('room-a');
    expect(cancelledQueued.activeRound?.state).toBe('cancelled');
    expect(cancelledQueued.activeRound?.members.map((member) => member.state)).toEqual(['cancelled', 'cancelled']);

    const restarted = await rooms.startRound({ room, messageId: 'user-2', content: '再试一次', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const roundId = restarted.activeRound!.roundId;
    const prepared = await rooms.prepareTurn('room-a', roundId, 'partner-a', 1, 'group:v2:room-a:partner-a');
    await rooms.bindRun('room-a', roundId, 'partner-a', 'run-a', 'thread-a');
    await rooms.observeEvent(event('text.delta', { roundId, inputThroughSeq: prepared.inputThroughSeq, bindingGeneration: 1 }, { text: '只说了一半' }));
    const cancelledRunning = await rooms.cancelRound('room-a');
    expect(cancelledRunning.messages.at(-1)).toMatchObject({ content: '只说了一半', status: 'interrupted' });
    expect(cancelledRunning.cursors).toEqual([]);
    await rooms.observeEvent(event('run.cancelled', { roundId, inputThroughSeq: prepared.inputThroughSeq, bindingGeneration: 1 }));
    expect((await rooms.getRoom('room-a'))?.messages.filter((message) => message.content === '只说了一半')).toHaveLength(1);
    expect(queued.activeRound?.roundId).not.toBe(roundId);
  });

  it('keeps queues, cancellation, and late events isolated between rooms', async () => {
    const rooms = await store();
    const roomA = { roomId: 'room-a', projectId: 'project-a', name: '讨论组 A', memberIds: ['partner-a'] };
    const roomB = { roomId: 'room-b', projectId: 'project-b', name: '讨论组 B', memberIds: ['partner-a'] };
    const startedA = await rooms.startRound({ room: roomA, messageId: 'user-a', content: 'A 的任务', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const startedB = await rooms.startRound({ room: roomB, messageId: 'user-b', content: 'B 的任务', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    const preparedA = await rooms.prepareTurn('room-a', startedA.activeRound!.roundId, 'partner-a', 1, 'group:v3:room-a:partner-a');
    const preparedB = await rooms.prepareTurn('room-b', startedB.activeRound!.roundId, 'partner-a', 1, 'group:v3:room-b:partner-a');
    await rooms.bindRun('room-a', startedA.activeRound!.roundId, 'partner-a', 'run-room-a', 'thread-room-a');
    await rooms.bindRun('room-b', startedB.activeRound!.roundId, 'partner-a', 'run-room-b', 'thread-room-b');

    await rooms.cancelRound('room-a');
    await rooms.observeEvent(event('text.delta', { roomId: 'room-b', roundId: startedB.activeRound!.roundId, inputThroughSeq: preparedB.inputThroughSeq, bindingGeneration: 1 }, {
      partnerId: 'partner-a', runId: 'run-room-b', sessionId: 'thread-room-b', conversationId: preparedB.conversationId, text: '只属于 B',
    }));
    await rooms.observeEvent(event('run.completed', { roomId: 'room-b', roundId: startedB.activeRound!.roundId, inputThroughSeq: preparedB.inputThroughSeq, bindingGeneration: 1 }, {
      partnerId: 'partner-a', runId: 'run-room-b', sessionId: 'thread-room-b', conversationId: preparedB.conversationId,
    }));
    await rooms.observeEvent(event('run.cancelled', { roundId: startedA.activeRound!.roundId, inputThroughSeq: preparedA.inputThroughSeq, bindingGeneration: 1 }, {
      runId: 'run-room-a', sessionId: 'thread-room-a', conversationId: preparedA.conversationId,
    }));

    expect((await rooms.getRoom('room-a'))?.activeRound?.state).toBe('cancelled');
    expect((await rooms.getRoom('room-a'))?.messages.map((item) => item.content)).toEqual(['A 的任务']);
    expect((await rooms.getRoom('room-b'))?.activeRound?.state).toBe('completed');
    expect((await rooms.getRoom('room-b'))?.messages.map((item) => item.content)).toEqual(['B 的任务', '只属于 B']);
  });

  it('warns after three replies each and pauses after five replies each', async () => {
    const rooms = await store();
    const room = { roomId: 'room-a', projectId: 'project-a', name: '讨论组', memberIds: ['partner-a', 'partner-b'] };
    await rooms.syncRoom(room);
    await rooms.setSettings('room-a', { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: true });
    let snapshot = await rooms.startRound({ room, messageId: 'user-1', content: '自由讨论', authorId: ASTERIUM_USER_ID, speakerQueue: ['partner-a'] });
    for (let index = 0; index < 10; index += 1) {
      const partnerId = index % 2 === 0 ? 'partner-a' : 'partner-b';
      const targetPartnerId = partnerId === 'partner-a' ? 'partner-b' : 'partner-a';
      const roundId = snapshot.activeRound!.roundId;
      const runId = `run-${index}`;
      const prepared = await rooms.prepareTurn('room-a', roundId, partnerId, 1, `group:v2:room-a:${partnerId}`);
      await rooms.bindRun('room-a', roundId, partnerId, runId, `thread-${partnerId}`);
      await rooms.mentionPartner({ roomId: 'room-a', roundId, partnerId, targetPartnerId, bindingGeneration: 1, inputThroughSeq: prepared.inputThroughSeq, label: targetPartnerId });
      await rooms.observeEvent(event('text.delta', { roundId, inputThroughSeq: prepared.inputThroughSeq, bindingGeneration: 1 }, { partnerId, runId, sessionId: `thread-${partnerId}`, text: `回复 ${index + 1}` }));
      await rooms.observeEvent(event('run.completed', { roundId, inputThroughSeq: prepared.inputThroughSeq, bindingGeneration: 1 }, { partnerId, runId, sessionId: `thread-${partnerId}` }));
      snapshot = (await rooms.getRoom('room-a'))!;
      if (index === 5) expect(snapshot.activeRound?.discussionWarningIssued).toBe(true);
    }
    expect(snapshot.activeRound?.state).toBe('waiting_discussion_decision');
    const continued = await rooms.resolveDiscussion('room-a', 'continue');
    expect(continued.activeRound?.state).toBe('queued');
    expect(continued.activeRound?.discussionPauseCount).toBe(1);
  });
});
