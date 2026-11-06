import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PartnerDiaryStore } from '../../src/main/diary/PartnerDiaryStore';
import { PartnerDiarySettingsStore } from '../../src/main/diary/PartnerDiarySettingsStore';

describe('partner diary configuration and Markdown storage', () => {
  it('requires source ownership and explicit upstream risk acknowledgement, regardless of memory mode', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-diary-config-'));
    try {
      const store = new PartnerDiarySettingsStore(path.join(dir, 'config.json'), async (id) => id === 'c' ? { partnerId: 'p', sessionId: 'upstream' } : undefined,
        () => ({ sourceMode: 'existing_thread', available: true, threadId: 'upstream' }));
      const input = { partnerId: 'p', enabled: true, conversationId: 'c', time: '21:30' };
      await expect(store.configure(input)).rejects.toThrow('ACK_REQUIRED');
      await expect(store.configure({ ...input, conversationId: 'foreign', acknowledgeUpstreamHistory: true })).rejects.toThrow('SOURCE_NOT_AVAILABLE');
      const saved = await store.configure({ ...input, acknowledgeUpstreamHistory: true }); expect(saved.upstreamThreadId).toBe('upstream');
      expect((await new PartnerDiarySettingsStore(path.join(dir, 'config.json'), async () => undefined, () => undefined).list())[0]).toEqual(saved);
      const deleted = new PartnerDiarySettingsStore(path.join(dir, 'config.json'), async () => undefined, () => undefined);
      await deleted.reconcileSources(); expect((await deleted.list())[0]).toMatchObject({ enabled: false, disabledReason: 'source_deleted' });
      await expect(store.configure({ ...input, time: '25:90' })).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('publishes exactly one immutable dated Markdown, and recovers crashes without retrying', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-diary-store-'));
    try {
      const store = new PartnerDiaryStore(dir, 'p');
      const claims = await Promise.all([store.claim('2026-10-21', 'c'), store.claim('2026-10-21', 'c')]);
      expect(claims.filter(Boolean)).toHaveLength(1); const entry = claims.find(Boolean)!;
      const content = '# 2026-10-21\n\n今天我和用户聊了读书。\n';
      await store.finish(entry.date, entry.generationId, { state: 'completed', content });
      expect(await readFile(path.join(dir, '2026-10-21.md'), 'utf8')).toBe(content);
      expect((await store.read(entry.date))?.content).toBe(content);
      expect(await store.claim(entry.date, 'c')).toBeUndefined();
      await expect(store.claim('../escape', 'c')).rejects.toThrow(); await expect(store.claim('2026-02-30', 'c')).rejects.toThrow();
      await store.claim('2026-10-22', 'c'); const restarted = new PartnerDiaryStore(dir, 'p'); await restarted.recover();
      expect((await restarted.read('2026-10-22'))?.entry).toMatchObject({ state: 'failed', reason: 'interrupted' });
      expect(await restarted.claim('2026-10-22', 'c')).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
