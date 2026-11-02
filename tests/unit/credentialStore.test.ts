import { testRm as rm } from '../helpers/autoTest.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { API_EXTENSION_CREDENTIAL_PREFIX, CredentialStore, type CredentialCrypto } from '../../src/main/security/CredentialStore';

const directories: string[] = [];
const crypto: CredentialCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, ''),
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('CredentialStore', () => {
  it('isolates extension references from every ordinary credential operation and keeps both scopes on one write queue', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-credentials-')); directories.push(directory);
    const store = new CredentialStore(path.join(directory, 'secure.json'), crypto);
    const scoped = store.forNamespace(API_EXTENSION_CREDENTIAL_PREFIX);
    const ref = `${API_EXTENSION_CREDENTIAL_PREFIX}synthetic`;
    await Promise.all([scoped.save('extension-original', ref), store.save('provider-original', 'provider-ref')]);
    await expect(store.get(ref)).rejects.toThrow('NAMESPACE_RESERVED');
    await expect(store.has(ref)).rejects.toThrow('NAMESPACE_RESERVED');
    await expect(store.delete(ref)).rejects.toThrow('NAMESPACE_RESERVED');
    await expect(store.save('overwrite', ` ${ref} `)).rejects.toThrow('NAMESPACE_RESERVED');
    await expect(scoped.get('provider-ref')).rejects.toThrow('NAMESPACE_RESERVED');
    await expect(scoped.save('overwrite', 'provider-ref')).rejects.toThrow('NAMESPACE_RESERVED');
    await expect(scoped.delete('provider-ref')).rejects.toThrow('NAMESPACE_RESERVED');
    expect(await store.get('provider-ref')).toBe('provider-original');
    expect(await scoped.get(ref)).toBe('extension-original');
  });
  it('persists only encrypted ciphertext and supports rotation and deletion', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-credentials-'));
    directories.push(directory);
    const file = path.join(directory, 'secure-credentials.v1.json');
    const store = new CredentialStore(file, crypto);
    const reference = await store.save('first-secret');

    expect(await store.get(reference)).toBe('first-secret');
    expect(await readFile(file, 'utf8')).not.toContain('first-secret');
    expect(await store.save('rotated-secret', reference)).toBe(reference);
    expect(await store.get(reference)).toBe('rotated-secret');
    await store.delete(reference);
    expect(await store.has(reference)).toBe(false);
  });

  it('rejects storage when operating-system encryption is unavailable', async () => {
    const store = new CredentialStore('unused.json', { ...crypto, isEncryptionAvailable: () => false });
    await expect(store.save('never-written')).rejects.toThrow('SECURE_STORAGE_UNAVAILABLE');
  });
});
