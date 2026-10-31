import { projectPreviewKind } from '../project/ProjectContentReader';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactAvailability, ArtifactRegistrationMethod, ArtifactSourceClaim, ArtifactSourceKind } from '../../shared/agentProtocol';
import { normalizeReportedLocalPath } from './localPath';
import { assertPublicHostname, validatePublicHttpsUrl } from './PublicHttps';

export interface ArtifactInfo {
  id: string;
  name: string;
  extension: string;
  mediaType: string;
  sizeBytes?: number;
  previewKind: 'markdown' | 'text' | 'html' | 'pdf' | 'image' | 'word' | 'sheet' | 'slides' | 'unsupported';
  sourceKind: ArtifactSourceKind;
  registrationMethod: ArtifactRegistrationMethod;
  availability: ArtifactAvailability;
  cached: boolean;
  createdAt: string;
  partnerId?: string;
  conversationId?: string;
}

export interface ArtifactRegistrationContext {
  id?: string;
  name?: string;
  mediaType?: string;
  baseDirectory?: string;
  partnerId?: string;
  conversationId?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  method: ArtifactRegistrationMethod;
  createdAt?: string;
}

export interface RemoteArtifactPayload {
  bytes: Buffer;
  name?: string;
  mediaType?: string;
}

export interface RemoteArtifactResolver {
  readonly provider: string;
  resolve(reference: string): Promise<RemoteArtifactPayload>;
}

export interface ArtifactCacheStats {
  sizeBytes: number;
  itemCount: number;
  limitBytes: number;
}

export interface ArtifactProjectDelivery {
  artifactId: string;
  projectId: string;
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  savedAt: string;
  sourcePartnerId?: string;
  sourcePartnerName?: string;
}

interface RegisteredArtifact extends ArtifactInfo {
  source: ArtifactSourceClaim | { kind: 'content'; transport: 'cache_blob'; value: string };
  blobHash?: string;
  lastAccessedAt?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  projectDeliveries?: ArtifactProjectDelivery[];
  removedAt?: string;
}

export interface ArtifactDeletionSnapshot {
  id: string;
  name: string;
  sourceKind: ArtifactSourceKind;
  sourcePath?: string;
  availability: ArtifactAvailability;
  conversationId?: string;
  projectDeliveries: ArtifactProjectDelivery[];
}

interface ArtifactRegistryOptions {
  storePath?: string;
  cacheDirectory?: string;
  cacheLimitBytes?: number;
  fetchImplementation?: typeof fetch;
}

const TEXT_LIMIT = 5 * 1024 * 1024;
const HTML_LIMIT = 20 * 1024 * 1024;
const BINARY_LIMIT = 50 * 1024 * 1024;
const DEFAULT_CACHE_LIMIT = 1024 * 1024 * 1024;

export class ArtifactRegistry {
  private readonly items = new Map<string, RegisteredArtifact>();
  private readonly resolvers = new Map<string, RemoteArtifactResolver>();
  private readonly storePath?: string;
  private readonly cacheDirectory: string;
  private readonly cacheLimitBytes: number;
  private readonly fetchImplementation: typeof fetch;
  private loaded = false;

  constructor(options: string | ArtifactRegistryOptions = {}) {
    const normalized = typeof options === 'string' ? { storePath: options } : options;
    this.storePath = normalized.storePath;
    const base = this.storePath ? path.dirname(this.storePath) : path.join(process.cwd(), '.asterium-artifacts');
    this.cacheDirectory = normalized.cacheDirectory ?? path.join(base, 'artifact-cache-v2');
    this.cacheLimitBytes = normalized.cacheLimitBytes ?? DEFAULT_CACHE_LIMIT;
    this.fetchImplementation = normalized.fetchImplementation ?? fetch;
  }

  addResolver(resolver: RemoteArtifactResolver) {
    this.resolvers.set(resolver.provider, resolver);
  }

  async register(claim: ArtifactSourceClaim, context: ArtifactRegistrationContext): Promise<ArtifactInfo> {
    await this.load();
    const id = context.id ?? randomUUID();
    const createdAt = context.createdAt ?? new Date().toISOString();
    let source: RegisteredArtifact['source'] = claim;
    let name = context.name;
    let sizeBytes: number | undefined;
    let mediaType = context.mediaType;
    let availability: ArtifactAvailability;
    let blobHash: string | undefined;

    if (claim.kind === 'local_path') {
      const absolutePath = normalizeReportedLocalPath(claim.path, context.baseDirectory ?? process.cwd());
      source = { kind: 'local_path', path: absolutePath };
      name ??= path.basename(absolutePath);
      const fileStat = await stat(absolutePath).catch(() => undefined);
      if (fileStat?.isFile()) {
        sizeBytes = fileStat.size;
        availability = 'available';
        const existing = context.runId ? [...this.items.values()].find((item) => item.runId === context.runId
          && item.source.kind === 'local_path'
          && localPathKey(item.source.path) === localPathKey(absolutePath)
          && item.availability === 'available') : undefined;
        if (existing) return publicInfo(existing);
      } else availability = 'missing';
    } else if (claim.kind === 'content') {
      name ??= suggestedContentName(claim, mediaType);
      if (claim.transport === 'https_url') {
        validatePublicHttpsUrl(claim.value, 'ARTIFACT_URL_REJECTED');
        availability = 'available';
      } else {
        const decoded = decodeInlineContent(claim, mediaType);
        mediaType ??= decoded.mediaType;
        sizeBytes = decoded.bytes.byteLength;
        blobHash = await this.putCacheBlob(decoded.bytes);
        source = { kind: 'content', transport: 'cache_blob', value: blobHash };
        availability = 'available';
      }
    } else {
      name ??= '服务器文件';
      availability = this.resolvers.has(claim.provider) ? 'available' : 'unavailable';
    }

    name = sanitizeFileName(name ?? '未命名文件');
    const extension = path.extname(name).toLowerCase();
    mediaType ??= mediaTypeFor(extension);
    const item: RegisteredArtifact = {
      id, name, extension, mediaType, sizeBytes,
      previewKind: previewKindFor(extension, mediaType),
      sourceKind: source.kind,
      registrationMethod: context.method,
      availability,
      cached: Boolean(blobHash),
      createdAt,
      partnerId: context.partnerId,
      conversationId: context.conversationId,
      sessionId: context.sessionId,
      runId: context.runId,
      toolCallId: context.toolCallId,
      source,
      blobHash,
      lastAccessedAt: blobHash ? createdAt : undefined,
    };
    this.items.set(id, item);
    await this.persist();
    await this.enforceCacheLimit(blobHash);
    return publicInfo(item);
  }

  async inspect(id: string): Promise<ArtifactInfo> {
    const item = await this.requireRecord(id);
    if (item.source.kind === 'local_path') await this.refreshLocal(item);
    if (item.source.kind === 'remote_ref') item.availability = this.resolvers.has(item.source.provider) ? 'available' : 'unavailable';
    if (item.blobHash) item.cached = await exists(this.cachePath(item.blobHash));
    if (item.source.kind === 'content' && item.source.transport === 'cache_blob') item.availability = item.cached ? 'available' : 'unavailable';
    return publicInfo(item);
  }

  async inspectIfRegistered(id: string): Promise<ArtifactInfo | undefined> {
    await this.load();
    if (!this.items.has(id) || this.items.get(id)?.removedAt) return undefined;
    return this.inspect(id);
  }

  async listConversation(conversationId: string): Promise<ArtifactInfo[]> {
    await this.load();
    const matches = [...this.items.values()].filter((item) => item.conversationId === conversationId && !item.removedAt);
    return Promise.all(matches.map(async (item) => {
      if (item.source.kind === 'local_path') await this.refreshLocal(item);
      return publicInfo(item);
    }));
  }

  async read(id: string) {
    const item = await this.requireAvailable(id);
    const absolutePath = await this.materialize(item);
    const fileStat = await stat(absolutePath);
    item.sizeBytes = fileStat.size;
    const limit = item.previewKind === 'html' ? HTML_LIMIT : item.previewKind === 'markdown' || item.previewKind === 'text' ? TEXT_LIMIT : BINARY_LIMIT;
    if (fileStat.size > limit) throw new Error('ARTIFACT_TOO_LARGE');
    if (item.previewKind === 'markdown' || item.previewKind === 'text' || item.previewKind === 'html') return { info: publicInfo(item), text: await readFile(absolutePath, 'utf8') };
    if (['image', 'pdf', 'word', 'sheet', 'slides'].includes(item.previewKind)) {
      const data = await readFile(absolutePath);
      return { info: publicInfo(item), dataUrl: `data:${item.mediaType};base64,${data.toString('base64')}` };
    }
    return { info: publicInfo(item) };
  }

  async pathFor(id: string) {
    return this.materialize(await this.requireAvailable(id));
  }

  async originalPathFor(id: string) {
    const item = await this.requireRecord(id);
    return item.source.kind === 'local_path' ? item.source.path : undefined;
  }

  async recordProjectDelivery(id: string, delivery: Omit<ArtifactProjectDelivery, 'artifactId'>) {
    const item = await this.requireRecord(id);
    const next: ArtifactProjectDelivery = { artifactId: id, ...delivery };
    const previous = structuredClone(item.projectDeliveries ?? []);
    item.projectDeliveries = [
      ...(item.projectDeliveries ?? []).filter((entry) => !(entry.projectId === next.projectId && localPathKey(entry.relativePath) === localPathKey(next.relativePath))),
      next,
    ];
    try {
      await this.persist();
    } catch (error) {
      item.projectDeliveries = previous;
      throw error;
    }
    return structuredClone(next);
  }

  async listProjectDeliveries(projectId: string) {
    await this.load();
    return structuredClone([...this.items.values()].flatMap((item) => (item.projectDeliveries ?? []).filter((entry) => entry.projectId === projectId)));
  }

  async allProjectDeliveries() {
    await this.load();
    return structuredClone([...this.items.values()].flatMap((item) => item.projectDeliveries ?? []));
  }

  async deletionSnapshot(id: string): Promise<ArtifactDeletionSnapshot> {
    const item = await this.requireRecord(id, true);
    if (item.removedAt) throw new Error('ARTIFACT_NOT_REGISTERED');
    if (item.source.kind === 'local_path') await this.refreshLocal(item);
    return {
      id: item.id,
      name: item.name,
      sourceKind: item.sourceKind,
      ...(item.source.kind === 'local_path' ? { sourcePath: item.source.path } : {}),
      availability: item.availability,
      ...(item.conversationId ? { conversationId: item.conversationId } : {}),
      projectDeliveries: structuredClone(item.projectDeliveries ?? []),
    };
  }

  async allDeletionSnapshots() {
    await this.load();
    return [...this.items.values()].filter((item) => !item.removedAt).map((item): ArtifactDeletionSnapshot => ({
      id: item.id,
      name: item.name,
      sourceKind: item.sourceKind,
      ...(item.source.kind === 'local_path' ? { sourcePath: item.source.path } : {}),
      availability: item.availability,
      ...(item.conversationId ? { conversationId: item.conversationId } : {}),
      projectDeliveries: structuredClone(item.projectDeliveries ?? []),
    }));
  }

  async markRemoved(id: string, removedAt = new Date().toISOString()) {
    const item = await this.requireRecord(id, true);
    if (item.removedAt) return;
    const previous = { removedAt: item.removedAt, availability: item.availability, cached: item.cached };
    item.removedAt = removedAt;
    item.availability = 'unavailable';
    item.cached = false;
    try {
      await this.persist();
    } catch (error) {
      item.removedAt = previous.removedAt;
      item.availability = previous.availability;
      item.cached = previous.cached;
      throw error;
    }
    if (item.blobHash && ![...this.items.values()].some((candidate) => candidate.id !== item.id && !candidate.removedAt && candidate.blobHash === item.blobHash)) {
      await unlink(this.cachePath(item.blobHash)).catch(() => undefined);
    }
  }

  async removeProjectDeliveries(projectId: string) {
    await this.load();
    const previous = new Map([...this.items].map(([id, item]) => [id, structuredClone(item.projectDeliveries ?? [])]));
    let changed = false;
    for (const item of this.items.values()) {
      const next = (item.projectDeliveries ?? []).filter((entry) => entry.projectId !== projectId);
      if (next.length === (item.projectDeliveries ?? []).length) continue;
      item.projectDeliveries = next;
      changed = true;
    }
    if (changed) {
      try {
        await this.persist();
      } catch (error) {
        for (const [id, deliveries] of previous) this.items.get(id)!.projectDeliveries = deliveries;
        throw error;
      }
    }
  }

  async restoreProjectDeliveries(deliveries: ArtifactProjectDelivery[]) {
    await this.load();
    const previous = new Map([...this.items].map(([id, item]) => [id, structuredClone(item.projectDeliveries ?? [])]));
    let changed = false;
    for (const delivery of deliveries) {
      const item = this.items.get(delivery.artifactId);
      if (!item) continue;
      item.projectDeliveries = [
        ...(item.projectDeliveries ?? []).filter((entry) => !(entry.projectId === delivery.projectId && localPathKey(entry.relativePath) === localPathKey(delivery.relativePath))),
        structuredClone(delivery),
      ];
      changed = true;
    }
    if (changed) {
      try {
        await this.persist();
      } catch (error) {
        for (const [id, values] of previous) this.items.get(id)!.projectDeliveries = values;
        throw error;
      }
    }
  }

  async cacheStats(): Promise<ArtifactCacheStats> {
    await this.load();
    const entries = await readdir(this.cacheDirectory, { withFileTypes: true }).catch(() => []);
    let sizeBytes = 0;
    let itemCount = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const value = await stat(path.join(this.cacheDirectory, entry.name)).catch(() => undefined);
      if (value) { sizeBytes += value.size; itemCount += 1; }
    }
    return { sizeBytes, itemCount, limitBytes: this.cacheLimitBytes };
  }

  async clearCache() {
    await this.load();
    const entries = await readdir(this.cacheDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isFile()) await unlink(path.join(this.cacheDirectory, entry.name)).catch(() => undefined);
    for (const item of this.items.values()) if (item.source.kind !== 'local_path') {
      item.blobHash = undefined;
      item.cached = false;
      item.availability = item.source.kind === 'content' && item.source.transport === 'cache_blob'
        ? 'unavailable'
        : item.source.kind === 'remote_ref' && !this.resolvers.has(item.source.provider) ? 'unavailable' : 'available';
    }
    await this.persist();
    return this.cacheStats();
  }

  private async requireRecord(id: string, includeRemoved = false) {
    await this.load();
    const item = this.items.get(id);
    if (!item || (!includeRemoved && item.removedAt)) throw new Error('ARTIFACT_NOT_REGISTERED');
    normalizePreviewMetadata(item);
    return item;
  }

  private async requireAvailable(id: string) {
    const item = await this.requireRecord(id);
    if (item.source.kind === 'local_path') await this.refreshLocal(item);
    if (item.availability !== 'available') throw new Error(item.availability === 'missing' ? 'ARTIFACT_SOURCE_MISSING' : 'ARTIFACT_SOURCE_UNAVAILABLE');
    return item;
  }

  private async refreshLocal(item: RegisteredArtifact) {
    if (item.source.kind !== 'local_path') return;
    const value = await stat(item.source.path).catch(() => undefined);
    item.availability = value?.isFile() ? 'available' : 'missing';
    if (value?.isFile()) item.sizeBytes = value.size;
  }

  private async materialize(item: RegisteredArtifact) {
    if (item.source.kind === 'local_path') return item.source.path;
    if (item.blobHash && await exists(this.cachePath(item.blobHash))) {
      item.cached = true;
      item.lastAccessedAt = new Date().toISOString();
      await this.persist();
      return this.cachePath(item.blobHash);
    }
    let payload: RemoteArtifactPayload;
    if (item.source.kind === 'content') {
      if (item.source.transport === 'cache_blob') {
        item.availability = 'unavailable';
        throw new Error('ARTIFACT_SOURCE_UNAVAILABLE');
      }
      payload = item.source.transport === 'https_url'
        ? await this.fetchHttps(item.source.value)
        : decodeInlineContent(item.source, item.mediaType);
    } else {
      const resolver = this.resolvers.get(item.source.provider);
      if (!resolver) { item.availability = 'unavailable'; throw new Error('ARTIFACT_SOURCE_UNAVAILABLE'); }
      payload = await resolver.resolve(item.source.reference);
    }
    item.blobHash = await this.putCacheBlob(payload.bytes);
    item.cached = true;
    item.availability = 'available';
    item.sizeBytes = payload.bytes.byteLength;
    item.lastAccessedAt = new Date().toISOString();
    if (payload.name) { item.name = payload.name; item.extension = path.extname(payload.name).toLowerCase(); }
    if (payload.mediaType) item.mediaType = payload.mediaType;
    item.previewKind = previewKindFor(item.extension, item.mediaType);
    await this.persist();
    await this.enforceCacheLimit(item.blobHash);
    return this.cachePath(item.blobHash);
  }

  private async fetchHttps(source: string): Promise<RemoteArtifactPayload> {
    let current = validatePublicHttpsUrl(source, 'ARTIFACT_URL_REJECTED');
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      await assertPublicHostname(current.hostname, 'ARTIFACT_URL_REJECTED');
      const response = await this.fetchImplementation(current, { redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirect === 5) throw new Error('ARTIFACT_REDIRECT_REJECTED');
        current = validatePublicHttpsUrl(new URL(location, current), 'ARTIFACT_URL_REJECTED');
        continue;
      }
      if (!response.ok) throw new Error(`ARTIFACT_DOWNLOAD_FAILED_${response.status}`);
      return { bytes: Buffer.from(await response.arrayBuffer()), mediaType: response.headers.get('content-type')?.split(';')[0] || undefined };
    }
    throw new Error('ARTIFACT_REDIRECT_REJECTED');
  }

  private async putCacheBlob(bytes: Buffer) {
    const hash = sha256(bytes);
    const destination = this.cachePath(hash);
    await mkdir(this.cacheDirectory, { recursive: true });
    if (!(await exists(destination))) await writeFile(destination, bytes, { mode: 0o600 });
    return hash;
  }

  private cachePath(hash: string) { return path.join(this.cacheDirectory, hash); }

  private async enforceCacheLimit(protectedHash?: string) {
    const stats = await this.cacheStats();
    if (stats.sizeBytes <= stats.limitBytes) return;
    const usage = new Map<string, number>();
    for (const item of this.items.values()) if (item.blobHash) usage.set(item.blobHash, Math.max(usage.get(item.blobHash) ?? 0, Date.parse(item.lastAccessedAt ?? item.createdAt)));
    const candidates: Array<{ hash: string; size: number; lastUsed: number }> = [];
    for (const entry of await readdir(this.cacheDirectory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || entry.name === protectedHash) continue;
      const value = await stat(this.cachePath(entry.name)).catch(() => undefined);
      if (value) candidates.push({ hash: entry.name, size: value.size, lastUsed: usage.get(entry.name) ?? 0 });
    }
    candidates.sort((a, b) => a.lastUsed - b.lastUsed);
    let total = stats.sizeBytes;
    for (const candidate of candidates) {
      if (total <= this.cacheLimitBytes) break;
      await unlink(this.cachePath(candidate.hash)).catch(() => undefined);
      total -= candidate.size;
      for (const item of this.items.values()) if (item.blobHash === candidate.hash) item.cached = false;
    }
    await this.persist();
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storePath) return;
    try {
      const value = JSON.parse(await readFile(this.storePath, 'utf8')) as { items?: unknown[] };
      let metadataChanged = false;
      for (const raw of value.items ?? []) {
        if (!raw || typeof raw !== 'object') continue;
        const candidate = raw as RegisteredArtifact & { absolutePath?: string; projectCopies?: unknown };
        if (typeof candidate.id !== 'string') continue;
        if ('projectCopies' in candidate) {
          delete candidate.projectCopies;
          metadataChanged = true;
        }
        if (candidate.projectDeliveries) candidate.projectDeliveries = candidate.projectDeliveries.filter((entry) => entry
          && typeof entry.projectId === 'string' && typeof entry.relativePath === 'string' && typeof entry.contentHash === 'string'
          && typeof entry.sizeBytes === 'number' && typeof entry.savedAt === 'string').map((entry) => ({ ...entry, artifactId: candidate.id }));
        if (typeof candidate.absolutePath === 'string' && !candidate.source) {
          const migrated: RegisteredArtifact = {
            ...candidate,
            source: { kind: 'local_path', path: candidate.absolutePath },
            sourceKind: 'local_path', registrationMethod: 'automatic', availability: 'available', cached: false,
            createdAt: candidate.createdAt ?? new Date(0).toISOString(),
          };
          delete (migrated as RegisteredArtifact & { absolutePath?: string }).absolutePath;
          metadataChanged = normalizePreviewMetadata(migrated) || metadataChanged;
          this.items.set(migrated.id, migrated);
        } else if (candidate.source && candidate.sourceKind) {
          metadataChanged = normalizePreviewMetadata(candidate) || metadataChanged;
          this.items.set(candidate.id, candidate);
        }
      }
      if (metadataChanged) await this.persist();
    } catch {
      // Missing or invalid metadata is recoverable; new registrations rebuild it.
    }
  }

  private async persist() {
    if (!this.storePath) return;
    await mkdir(path.dirname(this.storePath), { recursive: true });
    const temporary = `${this.storePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 2, items: [...this.items.values()] }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.storePath);
  }
}

function localPathKey(value: string) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function decodeInlineContent(claim: Extract<ArtifactSourceClaim, { kind: 'content' }>, fallbackMediaType?: string) {
  if (claim.transport === 'base64') return { bytes: Buffer.from(claim.value, 'base64'), mediaType: fallbackMediaType };
  if (claim.transport === 'bytes') return { bytes: Buffer.from(claim.value), mediaType: fallbackMediaType };
  if (claim.transport === 'data_url') {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(claim.value);
    if (!match) throw new Error('ARTIFACT_INVALID_DATA_URL');
    return { bytes: match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8'), mediaType: match[1] || fallbackMediaType };
  }
  throw new Error('ARTIFACT_CONTENT_REQUIRES_NETWORK');
}

function suggestedContentName(claim: Extract<ArtifactSourceClaim, { kind: 'content' }>, mediaType?: string) {
  if (claim.transport === 'https_url') {
    const candidate = path.basename(new URL(claim.value).pathname);
    if (candidate) return candidate;
  }
  return `交付文件${extensionForMediaType(mediaType)}`;
}

function previewKindFor(extension: string, mediaType?: string): ArtifactInfo['previewKind'] {
  if (extension === '.md' || extension === '.markdown' || mediaType === 'text/markdown') return 'markdown';
  if (extension === '.html' || extension === '.htm' || mediaType === 'text/html') return 'html';
  if (extension === '.docx' || mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'word';
  if (['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods', '.csv'].includes(extension) || ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/vnd.oasis.opendocument.spreadsheet', 'text/csv'].includes(mediaType ?? '')) return 'sheet';
  if (extension === '.pptx' || mediaType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'slides';
  if (extension === '.txt' || mediaType?.startsWith('text/')) return 'text';
  if (extension === '.pdf' || mediaType === 'application/pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension) || mediaType?.startsWith('image/')) return 'image';
  return projectPreviewKind(`file${extension}`, mediaType);
}

function mediaTypeFor(extension: string) {
  return ({
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.html': 'text/html', '.htm': 'text/html', '.csv': 'text/csv',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroEnabled.12', '.xls': 'application/vnd.ms-excel', '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

function normalizePreviewMetadata(item: RegisteredArtifact) {
  const extension = path.extname(item.name).toLowerCase();
  const inferredMediaType = mediaTypeFor(extension);
  const mediaType = !item.mediaType || item.mediaType === 'application/octet-stream' ? inferredMediaType : item.mediaType;
  const previewKind = previewKindFor(extension, mediaType);
  const changed = item.extension !== extension || item.mediaType !== mediaType || item.previewKind !== previewKind;
  item.extension = extension;
  item.mediaType = mediaType;
  item.previewKind = previewKind;
  return changed;
}

function extensionForMediaType(mediaType?: string) {
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf', 'text/markdown': '.md', 'text/plain': '.txt' } as Record<string, string>)[mediaType ?? ''] ?? '';
}

function sanitizeFileName(value: string) {
  const name = [...path.posix.basename(value.replace(/\\/g, '/')).replace(/[<>:"|?*]/g, '_')]
    .map((character) => character.charCodeAt(0) < 32 ? '_' : character).join('').trim();
  return name && name !== '.' && name !== '..' ? name.slice(0, 240) : '未命名文件';
}

function publicInfo(item: RegisteredArtifact): ArtifactInfo {
  const { id, name, extension, mediaType, sizeBytes, previewKind, sourceKind, registrationMethod, availability, cached, createdAt, partnerId, conversationId } = item;
  return { id, name, extension, mediaType, sizeBytes, previewKind, sourceKind, registrationMethod, availability, cached, createdAt, partnerId, conversationId };
}

function sha256(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
async function exists(filePath: string) { return Boolean(await stat(filePath).catch(() => undefined)); }
