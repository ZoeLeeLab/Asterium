import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryFallbackJobStore, fallbackHash, fallbackJobKey, type FallbackInput } from '../../src/main/memory/fallback/MemoryFallbackJobStore';
import { singleChatFallbackInputs, studioFallbackInputs } from '../../src/main/memory/fallback/MemoryFallbackInputs';
import type { StudioRoomSnapshot } from '../../src/shared/studioRuntime';

describe('durable fallback cursors', () => {
  it('tracks revisions while disabled, baselines explicitly, and advances only the frozen batch', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-fallback-jobs-'));
    try {
      let now = '2026-10-21T00:00:00.000Z';
      const file = path.join(dir, 'jobs.json');
      const store = new MemoryFallbackJobStore(file, () => now);
      const input: FallbackInput = { partnerId: 'p', kind: 'single_chat', conversationId: 'c', busy: false, messages: [{ messageId: 'old', content: 'old', hash: fallbackHash('old'), authorId: 'u', authorType: 'user' }] };
      const key = fallbackJobKey(input);
      await store.sync([input]); expect((await store.get(key))?.dirty).toBe(true);
      await store.applyEnablement('p', now, 'from_now'); expect((await store.get(key))?.dirty).toBe(false);
      now = '2026-10-21T01:00:00.000Z';
      input.messages.push({ ...input.messages[0], messageId: 'new', content: 'new', hash: fallbackHash('new'), occurredAt: now });
      await store.sync([input]);
      const frozen = (await store.get(key))!;
      input.messages[1] = { ...input.messages[1], content: 'edited', hash: fallbackHash('edited') };
      await store.sync([input]); await store.complete(key, frozen.messages);
      const restarted = new MemoryFallbackJobStore(file);
      expect((await restarted.get(key))?.dirty).toBe(true);
      await store.change(key, (job) => { job.round = { id: 'r', attempts: 3, nextAttemptAt: now, blockedUntil: now }; });
      expect((await restarted.get(key))?.round?.attempts).toBe(3);
      await store.sync([]); expect(await store.list()).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('ignores unstable text without changing source indexing or guessing old dates', () => {
    const inputs = singleChatFallbackInputs([{ conversationId: 'c', partnerId: 'p', busy: true, messages: [
      { messageId: 'm', content: 'failed', authorType: 'partner', authorId: 'p', createdAt: '12:00', fallbackEligible: false },
      { messageId: 'u', content: 'real', authorType: 'user', authorId: 'u', createdAt: '12:00' },
    ] }]);
    expect(inputs[0].busy).toBe(true); expect(inputs[0].messages.map((message) => message.messageId)).toEqual(['u']);
    expect(inputs[0].messages[0].occurredAt).toBeUndefined();
  });
  it('indexes only stable public Studio text, separately for current members', () => {
    const room: StudioRoomSnapshot = { metadata: { roomId: 'r', projectId: 'project', name: 'room', memberIds: ['p', 'q'] },
      messages: [
        { roomId: 'r', roundId: 'round', seq: 1, messageId: 'user', authorId: 'u', authorType: 'user', content: 'public', createdAt: '2026-10-21T00:00:00.000Z', status: 'completed' },
        { roomId: 'r', roundId: 'round', seq: 2, messageId: 'system', authorId: 'system', authorType: 'system', content: 'notice', createdAt: '2026-10-21T00:00:00.000Z', status: 'completed' },
        { roomId: 'r', roundId: 'round', seq: 3, messageId: 'partial', authorId: 'p', authorType: 'partner', content: 'unfinished', createdAt: '2026-10-21T00:00:00.000Z', status: 'interrupted' },
      ], cursors: [], mutedPartnerIds: [], settings: { speakingMode: 'free_discussion', selectedPartnerIds: [], discussionProtectionEnabled: true }, rotationOffset: 0, models: {} };
    expect(studioFallbackInputs([room]).map((input) => [input.partnerId, input.messages.map((message) => message.messageId)])).toEqual([['p', ['user']], ['q', ['user']]]);
    room.metadata.memberIds = ['q']; expect(studioFallbackInputs([room]).map((input) => input.partnerId)).toEqual(['q']);
  });
});
