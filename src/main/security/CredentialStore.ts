import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CredentialCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface CredentialFile {
  version: 1;
  credentials: Record<string, string>;
}

const EMPTY_FILE: CredentialFile = { version: 1, credentials: {} };
export const API_EXTENSION_CREDENTIAL_PREFIX = 'api-extension-';
export type CredentialAccess = Pick<CredentialStore, 'save' | 'get' | 'has' | 'delete'>;

export class CredentialStore {
  private mutation = Promise.resolve();

  constructor(
    private readonly filePath: string | (() => string),
    private readonly crypto: CredentialCrypto,
  ) {}

  async save(secret: string, existingRef?: string) {
    assertPublicReference(existingRef);
    return this.saveInternal(secret, existingRef);
  }

  async get(credentialRef: string) {
    assertPublicReference(credentialRef);
    return this.getInternal(credentialRef);
  }

  async has(credentialRef: string) {
    assertPublicReference(credentialRef);
    return this.hasInternal(credentialRef);
  }

  async delete(credentialRef: string) {
    assertPublicReference(credentialRef);
    return this.deleteInternal(credentialRef);
  }

  /** Main-only capability. Shares this vault's mutation queue; cannot access ordinary provider/bridge credentials. */
  forNamespace(prefix: typeof API_EXTENSION_CREDENTIAL_PREFIX): CredentialAccess {
    if (prefix !== API_EXTENSION_CREDENTIAL_PREFIX) throw new Error('CREDENTIAL_NAMESPACE_INVALID');
    const requireOwned = (ref: string) => {
      if (!ref.startsWith(prefix) || ref !== ref.trim()) throw new Error('CREDENTIAL_NAMESPACE_RESERVED');
      return ref;
    };
    return {
      save: async (secret, ref) => this.saveInternal(secret, requireOwned(ref ?? `${prefix}${randomUUID()}`)),
      get: async (ref) => this.getInternal(requireOwned(ref)),
      has: async (ref) => this.hasInternal(requireOwned(ref)),
      delete: async (ref) => this.deleteInternal(requireOwned(ref)),
    };
  }

  private async saveInternal(secret: string, existingRef?: string) {
    if (!secret) throw new Error('CREDENTIAL_EMPTY');
    this.requireEncryption();
    const credentialRef = existingRef?.trim() || `credential-${randomUUID()}`;
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      data.credentials[credentialRef] = this.crypto.encryptString(secret).toString('base64');
      await this.writeUnlocked(data);
    });
    return credentialRef;
  }

  private async getInternal(credentialRef: string) {
    this.requireEncryption();
    await this.mutation;
    const encrypted = (await this.readUnlocked()).credentials[credentialRef];
    if (!encrypted) return undefined;
    try {
      return this.crypto.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      throw new Error('CREDENTIAL_DECRYPT_FAILED');
    }
  }

  private async hasInternal(credentialRef: string) {
    this.requireEncryption();
    await this.mutation;
    return Boolean((await this.readUnlocked()).credentials[credentialRef]);
  }

  private async deleteInternal(credentialRef: string) {
    this.requireEncryption();
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      if (!data.credentials[credentialRef]) return;
      delete data.credentials[credentialRef];
      await this.writeUnlocked(data);
    });
  }

  private requireEncryption() {
    if (!this.crypto.isEncryptionAvailable()) throw new Error('SECURE_STORAGE_UNAVAILABLE');
  }

  private resolvedPath() {
    return typeof this.filePath === 'function' ? this.filePath() : this.filePath;
  }

  private async readUnlocked(): Promise<CredentialFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.resolvedPath(), 'utf8'));
      if (!isRecord(parsed) || parsed.version !== 1 || !isStringRecord(parsed.credentials)) throw new Error('CREDENTIAL_STORE_INVALID');
      return { version: 1, credentials: { ...parsed.credentials } };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return structuredClone(EMPTY_FILE);
      throw error;
    }
  }

  private async writeUnlocked(data: CredentialFile) {
    const target = this.resolvedPath();
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }

  private mutate<T>(operation: () => Promise<T>) {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function assertPublicReference(ref: string | undefined) {
  if (ref?.trim().startsWith(API_EXTENSION_CREDENTIAL_PREFIX)) throw new Error('CREDENTIAL_NAMESPACE_RESERVED');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
