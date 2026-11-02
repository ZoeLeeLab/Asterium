import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryFallbackSettingsStore } from '../../src/main/memory/fallback/MemoryFallbackSettingsStore';
import { CredentialStore } from '../../src/main/security/CredentialStore';

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
      const result = await store.configure({ provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'test', intervalMinutes: 15, apiKey: 'independent-key' });
      expect(result.credentialConfigured).toBe(true);
      expect(JSON.stringify(result)).not.toContain('independent-key');
      expect(await readFile(path.join(directory, 'settings.json'), 'utf8')).not.toContain('independent-key');
      expect(await store.secret()).toBe('independent-key');
      const readModels = vi.fn(async () => [{ id: 'model-one' }]);
      expect(await store.listModels({ endpoint: result.endpoint }, readModels)).toEqual([{ id: 'model-one' }]);
      expect(readModels).toHaveBeenLastCalledWith(result.endpoint, 'independent-key');
      await store.listModels({ endpoint: result.endpoint, apiKey: 'unsaved-independent-key' }, readModels);
      expect(readModels).toHaveBeenLastCalledWith(result.endpoint, 'unsaved-independent-key');
      expect(await store.secret()).toBe('independent-key');
      expect((await store.get()).model).toBe('test');
      await store.configure({ provider: 'deepseek', endpoint: result.endpoint, model: 'test', intervalMinutes: 30, clearCredential: true });
      expect((await store.get()).credentialConfigured).toBe(false);
      await expect(store.listModels({ endpoint: result.endpoint }, readModels)).rejects.toThrow('CREDENTIAL_REQUIRED');
      await expect(store.listModels({ endpoint: 'https://other.invalid/chat/completions', apiKey: 'test' }, readModels)).rejects.toThrow('INVALID_DEEPSEEK_ENDPOINT');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
