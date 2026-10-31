import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { STUDIO_MCP_DEFAULT_PORT, type StudioMcpConfiguration, type StudioMcpCredential } from '../../shared/studioMcp';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';

interface AccessFile {
  version: 1;
  configuration: StudioMcpConfiguration;
  credentials: Array<StudioMcpCredential & { tokenHash: string }>;
}

export class StudioMcpAccessStore {
  private readonly storage: AtomicJsonStore<AccessFile>;
  private readonly listeners = new Set<() => void>();

  constructor(filePath: AtomicJsonStorePath) {
    this.storage = new AtomicJsonStore<AccessFile>({
      filePath,
      empty: () => ({ version: 1, configuration: { enabled: false, port: STUDIO_MCP_DEFAULT_PORT, publicOrigin: '' }, credentials: [] }),
      decode(value) {
        if (!record(value) || value.version !== 1 || !record(value.configuration) || !Array.isArray(value.credentials)) throw new Error('STUDIO_MCP_ACCESS_INVALID');
        validateConfiguration(value.configuration as unknown as StudioMcpConfiguration);
        if (!value.credentials.every((item) => record(item) && typeof item.credentialId === 'string' && typeof item.partnerId === 'string'
          && typeof item.createdAt === 'string' && (item.revokedAt === undefined || typeof item.revokedAt === 'string')
          && typeof item.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(item.tokenHash))) throw new Error('STUDIO_MCP_ACCESS_INVALID');
        return value as unknown as AccessFile;
      },
    });
  }

  async snapshot() {
    const state = await this.storage.read();
    return { configuration: { ...state.configuration }, credentials: state.credentials.map(publicCredential) };
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  configure(configuration: StudioMcpConfiguration) {
    validateConfiguration(configuration);
    return this.storage.runExclusive(async () => {
      const state = await this.storage.readNow();
      state.configuration = { enabled: configuration.enabled, port: configuration.port, publicOrigin: configuration.publicOrigin, ...(configuration.automationManagementEnabled === undefined ? {} : { automationManagementEnabled: configuration.automationManagementEnabled }) };
      await this.storage.writeNow(state);
    }).then(() => { for (const listener of this.listeners) listener(); });
  }

  issue(partnerId: string) {
    if (!partnerId.trim()) throw new Error('STUDIO_MCP_PARTNER_REQUIRED');
    return this.storage.runExclusive(async () => {
      const state = await this.storage.readNow();
      const token = `asterium_${randomBytes(32).toString('base64url')}`;
      const credential = { credentialId: randomUUID(), partnerId, createdAt: new Date().toISOString(), tokenHash: hash(token) };
      state.credentials.push(credential);
      await this.storage.writeNow(state);
      return { credential: publicCredential(credential), token };
    });
  }

  revoke(credentialId: string) {
    return this.storage.runExclusive(async () => {
      const state = await this.storage.readNow();
      const credential = state.credentials.find((item) => item.credentialId === credentialId);
      if (!credential) throw new Error('STUDIO_MCP_CREDENTIAL_NOT_FOUND');
      credential.revokedAt ??= new Date().toISOString();
      await this.storage.writeNow(state);
    }).then(() => { for (const listener of this.listeners) listener(); });
  }

  async authenticate(token: string) {
    if (!/^asterium_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('STUDIO_MCP_UNAUTHORIZED');
    const state = await this.storage.read();
    if (!state.configuration.enabled) throw new Error('STUDIO_MCP_DISABLED');
    const candidate = Buffer.from(hash(token), 'hex');
    const credential = state.credentials.find((item) => timingSafeEqual(candidate, Buffer.from(item.tokenHash, 'hex')));
    if (!credential || credential.revokedAt) throw new Error('STUDIO_MCP_UNAUTHORIZED');
    return publicCredential(credential);
  }
}

export function validateConfiguration(value: StudioMcpConfiguration) {
  if (value.automationManagementEnabled !== undefined && typeof value.automationManagementEnabled !== 'boolean') throw new Error('STUDIO_MCP_CONFIGURATION_INVALID');
  if (typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.port) || value.port < 1024 || value.port > 65535 || typeof value.publicOrigin !== 'string') throw new Error('STUDIO_MCP_CONFIGURATION_INVALID');
  if (!value.publicOrigin) return;
  let origin: URL;
  try { origin = new URL(value.publicOrigin); } catch { throw new Error('STUDIO_MCP_PRIVATE_ORIGIN_REQUIRED'); }
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.ts.net') || origin.port || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== value.publicOrigin) throw new Error('STUDIO_MCP_PRIVATE_ORIGIN_REQUIRED');
}

function publicCredential({ credentialId, partnerId, createdAt, revokedAt }: StudioMcpCredential): StudioMcpCredential {
  return { credentialId, partnerId, createdAt, ...(revokedAt ? { revokedAt } : {}) };
}

function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
