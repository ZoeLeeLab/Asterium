import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryFallbackInventory } from '../../src/main/memory/fallback/MemoryFallbackInventory';
import { MemoryFallbackJobStore } from '../../src/main/memory/fallback/MemoryFallbackJobStore';
import { MemoryFallbackSettingsStore } from '../../src/main/memory/fallback/MemoryFallbackSettingsStore';

describe('coalesced fallback inventory', () => {
  it('collapses a burst into one inventory read and never initiates model requests', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-fallback-inventory-'));
    try {
      const list = vi.fn(async () => [{ conversationId: 'c', partnerId: 'p', messages: [{ messageId: 'm', content: 'test', authorType: 'user' as const, authorId: 'u', createdAt: '12:00' }] }]);
      const jobs = new MemoryFallbackJobStore(path.join(dir, 'jobs.json'));
      const settings = new MemoryFallbackSettingsStore(path.join(dir, 'settings.json'), { has: async () => false, get: async () => undefined, save: async () => '', delete: async () => undefined }, () => true);
      const inventory = new MemoryFallbackInventory({ list }, { listAll: async () => [] }, jobs, settings, () => true);
      const active = inventory.activate();
      await Promise.all([active, ...Array.from({ length: 100 }, () => inventory.refresh())]);
      expect(list).toHaveBeenCalledTimes(1); expect((await jobs.list())[0].dirty).toBe(true);
      await inventory.refresh(); expect(list).toHaveBeenCalledTimes(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
