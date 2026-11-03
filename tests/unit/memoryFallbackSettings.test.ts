import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryFallbackSettingsStore } from '../../src/main/memory/fallback/MemoryFallbackSettingsStore';
import { CredentialStore } from '../../src/main/security/CredentialStore';
import { AtomicJsonStore } from '../../src/main/storage/AtomicJsonStore';

describe('independent fallback settings', () => {
  it('defaults off, enforces one global interval and explicit opt-in scope, never exposes the key', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-fallback-config-'));
    try {
      const credentials = new CredentialStore(path.join(directory, 'secrets.json'), { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => value.toString().slice(10) });
      const store = new MemoryFallbackSettingsStore(path.join(directory, 'settings.json'), credentials, (id) => id === 'managed');
      expect((await store.get()).partners).toEqual({});
      await expect(store.setPartner({ partnerId: 'other', enabled: true, history: 'from_now' })).rejects.toThrow('NOT_ELIGIBLE');
      await expect(store.setPartner({ partnerId: 'managed', enabled: true })).rejects.toThrow('HISTORY_CHOICE');
      await store.setPartner({ partnerId: 'managed', enabled: true, history: 'from_now' });
      await expect(store.configure({ provider: 'deepseek', endpoint: 'https://api.deepseek.com', model: 'test', intervalMinutes: 1 })).rejects.toThrow();
      const result = await store.configure({ provider: 'deepseek', endpoint: 'https://api.deepseek.com/', model: 'test', intervalMinutes: 15, apiKey: 'independent-key' });
      expect(result.credentialConfigured).toBe(true);
      expect(JSON.stringify(result)).not.toContain('independent-key');
      expect(await readFile(path.join(directory, 'settings.json'), 'utf8')).not.toContain('independent-key');
      expect(await store.secret()).toBe('independent-key');
      const readModels = vi.fn(async () => [{ id: 'model-one' }]);
      expect(result.endpoint).toBe('https://api.deepseek.com/chat/completions');
      expect(await store.listModels({ endpoint: 'https://api.deepseek.com/' }, readModels)).toEqual([{ id: 'model-one' }]);
      expect(readModels).toHaveBeenLastCalledWith('deepseek', result.endpoint, 'independent-key');
      await store.listModels({ endpoint: result.endpoint, apiKey: 'unsaved-independent-key' }, readModels);
      expect(readModels).toHaveBeenLastCalledWith('deepseek', result.endpoint, 'unsaved-independent-key');
      expect(await store.secret()).toBe('independent-key');
      expect((await store.get()).model).toBe('test');
      await store.configure({ provider: 'deepseek', endpoint: result.endpoint, model: 'test', intervalMinutes: 30, clearCredential: true });
      expect((await store.get()).credentialConfigured).toBe(false);
      await expect(store.listModels({ endpoint: result.endpoint }, readModels)).rejects.toThrow('CREDENTIAL_REQUIRED');
      await expect(store.listModels({ endpoint: 'https://other.invalid/chat/completions', apiKey: 'test' }, readModels)).rejects.toThrow('INVALID_DEEPSEEK_ENDPOINT');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each([
    ['openai', 'https://compatible.invalid/v1', '/v1/chat/completions'],
    ['responses', 'https://compatible.invalid/v1', '/v1/responses'],
    ['anthropic', 'https://compatible.invalid/v1', '/v1/messages'],
    ['gemini', 'https://compatible.invalid/v1beta', '/v1beta/models'],
  ])('persists %s and requires a new key before sending to a different service', async (provider, endpoint, suffix) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-fallback-provider-'));
    try {
      const credentials = new CredentialStore(path.join(directory, 'secrets.json'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`encrypted:${value}`), decryptString: value => value.toString().slice(10) });
      const file = path.join(directory, 'settings.json');
      const store = new MemoryFallbackSettingsStore(file, credentials, () => true);
      const legacy = { ...await store.get(), apiKey: 'old-test-key' };
      await store.configure({ provider: legacy.provider, endpoint: legacy.endpoint, model: legacy.model, intervalMinutes: legacy.intervalMinutes, apiKey: legacy.apiKey });
      const update = { provider, endpoint, model: 'manual-model', intervalMinutes: 20 };
      const reader = vi.fn(async () => [{ id: 'remote-model' }]);
      await expect(store.configure(update)).rejects.toThrow('NEW_CREDENTIAL_REQUIRED');
      await expect(store.listModels({ provider, endpoint }, reader)).rejects.toThrow('NEW_CREDENTIAL_REQUIRED');
      expect(reader).not.toHaveBeenCalled(); expect((await store.get()).provider).toBe('deepseek');
      await store.listModels({ provider, endpoint, apiKey: 'new-test-key' }, reader);
      expect(reader).toHaveBeenLastCalledWith(provider, `https://compatible.invalid${suffix}`, 'new-test-key');
      expect(await store.secret()).toBe('old-test-key');
      await store.configure({ ...update, apiKey: 'new-test-key' });
      const restarted = new MemoryFallbackSettingsStore(file, credentials, () => true);
      expect(await restarted.get()).toMatchObject({ provider, endpoint: `https://compatible.invalid${suffix}`, model: 'manual-model', credentialConfigured: true, partners: {} });
      await restarted.listModels({ provider, endpoint }, reader);
      expect(reader).toHaveBeenLastCalledWith(provider, `https://compatible.invalid${suffix}`, 'new-test-key');
      await expect(restarted.configure({ ...update, endpoint: 'https://other.invalid/v1' })).rejects.toThrow('NEW_CREDENTIAL_REQUIRED');
      await expect(restarted.configure({ ...update, endpoint: 'https://key:secret@invalid/v1', apiKey: 'rejected' })).rejects.toThrow();
      expect(await restarted.secret()).toBe('new-test-key');
      expect(await readFile(file, 'utf8')).not.toContain('test-key');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('keeps the legacy key paired with its endpoint when saving a replacement fails', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-fallback-write-failure-'));
    let write: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const credentials = new CredentialStore(path.join(directory, 'secrets.json'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`encrypted:${value}`), decryptString: value => value.toString().slice(10) });
      await credentials.save('legacy-test-key', 'asterium-memory-fallback-api');
      const store = new MemoryFallbackSettingsStore(path.join(directory, 'settings.json'), credentials, () => true);
      const original = await store.get();
      expect(original.credentialConfigured).toBe(true);
      write = vi.spyOn(AtomicJsonStore.prototype, 'writeNow').mockRejectedValueOnce(new Error('synthetic disk failure'));
      await expect(store.configure({ provider: 'openai', endpoint: 'https://new.invalid/v1', model: 'other', intervalMinutes: 20, apiKey: 'replacement-test-key' })).rejects.toThrow('disk failure');
      write.mockRestore(); write = undefined;
      expect(await store.get()).toEqual(original); expect(await store.secret(original)).toBe('legacy-test-key');
      const reader = vi.fn(async () => []);
      const listing = store.listModels({ endpoint: original.endpoint }, reader);
      const replacement = store.configure({ provider: 'openai', endpoint: 'https://new.invalid/v1', model: 'other', intervalMinutes: 20, apiKey: 'replacement-test-key' });
      await Promise.all([listing, replacement]);
      expect(reader).toHaveBeenCalledWith('deepseek', original.endpoint, 'legacy-test-key');
      await expect(store.secret(original)).rejects.toThrow('CANCELLED');
      expect(await store.secret()).toBe('replacement-test-key');
    } finally { write?.mockRestore(); await rm(directory, { recursive: true, force: true }); }
  });
});
