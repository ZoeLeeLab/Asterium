import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AttachmentSendRecord, ConversationAttachmentInfo, MessageAttachment, PendingMessageAttachment } from '../../shared/agentProtocol';

export const MAX_MESSAGE_ATTACHMENTS = 10;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface PendingRecord extends PendingMessageAttachment {
  contentPath: string;
  sourcePath: string;
  createdAt: number;
}

interface StoredAttachment extends MessageAttachment {
  sha256: string;
  createdAt: string;
  sourceId: string;
  sourcePath: string;
  snapshotPath: string;
  sends: AttachmentSendRecord[];
  legacySourceMissing?: boolean;
}

interface AttachmentIndex {
  version: 3;
  conversationId: string;
  attachments: Record<string, StoredAttachment>;
}

interface V2StoredAttachment extends MessageAttachment {
  sha256?: string;
  createdAt?: string;
  legacySourceMissing?: boolean;
}

interface LegacyStoredAttachment extends MessageAttachment {
  attachmentRef?: string;
  conversationId: string;
  sourcePath: string;
  createdAt?: string;
}

interface StoreOptions {
  rootDirectory: string | (() => string);
  legacyIndexPath?: string | (() => string);
}

export class ConversationAttachmentStore {
  private readonly pending = new Map<string, PendingRecord>();
  private mutation = Promise.resolve();
  private initialized?: Promise<void>;
  private readonly rootDirectory: string | (() => string);
  private readonly legacyIndexPath?: string | (() => string);

  constructor(options: StoreOptions | string | (() => string)) {
    if (typeof options === 'object') {
      this.rootDirectory = options.rootDirectory;
      this.legacyIndexPath = options.legacyIndexPath;
    } else {
      this.legacyIndexPath = options;
      this.rootDirectory = () => path.join(path.dirname(resolveValue(options)), 'conversation-attachments', 'v2');
    }
  }

  async stage(filePaths: string[]): Promise<PendingMessageAttachment[]> {
    await this.initialize();
    if (!filePaths.length || filePaths.length > MAX_MESSAGE_ATTACHMENTS) throw new Error('ATTACHMENT_COUNT_LIMIT');
    const staged: PendingRecord[] = [];
    const createdSelectionIds: string[] = [];
    try {
      for (const sourcePath of filePaths) {
        const absolute = path.resolve(sourcePath);
        const sourceInfo = await stat(absolute);
        if (!sourceInfo.isFile()) throw new Error('ATTACHMENT_NOT_FILE');
        if (sourceInfo.size > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
        const selectionId = `pending-attachment-${randomUUID()}`;
        const directory = path.join(this.pendingDirectory(), selectionId);
        createdSelectionIds.push(selectionId);
        const contentPath = path.join(directory, 'preview');
        await mkdir(directory, { recursive: true });
        await copyFile(absolute, contentPath, constants.COPYFILE_EXCL);
        const copiedInfo = await stat(contentPath);
        if (!copiedInfo.isFile()) throw new Error('ATTACHMENT_NOT_FILE');
        if (copiedInfo.size > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
        const record: PendingRecord = {
          selectionId,
          name: path.basename(absolute),
          mediaType: normalizeMediaType(mediaTypeFor(absolute)),
          sizeBytes: copiedInfo.size,
          contentPath,
          sourcePath: absolute,
          createdAt: Date.now(),
        };
        staged.push(record);
        this.pending.set(selectionId, record);
      }
      return staged.map(publicPending);
    } catch (error) {
      await Promise.all(createdSelectionIds.map((selectionId) => this.removePending(selectionId)));
      throw error;
    }
  }

  async discard(selectionIds: string[]) {
    await this.initialize();
    await Promise.all(selectionIds.map((selectionId) => this.removePending(selectionId)));
  }

  async commit(conversationId: string, selectionIds: string[], messageId: string): Promise<MessageAttachment[]> {
    await this.initialize();
    assertSafeId(conversationId, 'ATTACHMENT_CONVERSATION_REQUIRED');
    assertSafeId(messageId, 'ATTACHMENT_MESSAGE_REQUIRED');
    if (!selectionIds.length || selectionIds.length > MAX_MESSAGE_ATTACHMENTS) throw new Error('ATTACHMENT_COUNT_LIMIT');
    const records = selectionIds.map((selectionId) => this.pending.get(selectionId));
    if (records.some((record) => !record)) throw new Error('ATTACHMENT_SELECTION_EXPIRED');
    return this.mutate(async () => {
      const index = await this.readIndex(conversationId);
      const createdDirectories: string[] = [];
      const temporaryFiles: string[] = [];
      const committed: StoredAttachment[] = [];
      const sentAt = new Date().toISOString();
      try {
        for (const record of records as PendingRecord[]) {
          const before = await stat(record.sourcePath);
          if (!before.isFile()) throw new Error('ATTACHMENT_NOT_FILE');
          if (before.size > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
          const temporary = path.join(path.dirname(record.contentPath), `commit-${randomUUID()}.tmp`);
          temporaryFiles.push(temporary);
          await copyFile(record.sourcePath, temporary, constants.COPYFILE_EXCL);
          const copied = await stat(temporary);
          if (!copied.isFile() || copied.size > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
          const after = await stat(record.sourcePath);
          if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || copied.size !== after.size) throw new Error('ATTACHMENT_SOURCE_CHANGED_DURING_COPY');
          const sha256 = await hashFile(temporary);
          const existing = await this.findReusable(index, conversationId, record.sourcePath, sha256, copied.size);
          if (existing) {
            existing.sends.push({ messageId, sentAt });
            committed.push(existing);
            await rm(temporary, { force: true });
            continue;
          }
          const id = `attachment-${randomUUID()}`;
          const attachmentDirectory = this.attachmentDirectory(conversationId, id);
          const snapshotPath = this.contentPath(conversationId, id);
          await mkdir(attachmentDirectory, { recursive: true });
          createdDirectories.push(attachmentDirectory);
          await rename(temporary, snapshotPath);
          const sameSource = Object.values(index.attachments).find((item) => sameSourcePath(item.sourcePath, record.sourcePath));
          const stored: StoredAttachment = {
            id,
            name: path.basename(record.sourcePath),
            mediaType: normalizeMediaType(mediaTypeFor(record.sourcePath)),
            sizeBytes: copied.size,
            sha256,
            createdAt: sentAt,
            sourceId: sameSource?.sourceId ?? `source-${randomUUID()}`,
            sourcePath: record.sourcePath,
            snapshotPath,
            sends: [{ messageId, sentAt }],
          };
          index.attachments[id] = stored;
          committed.push(stored);
        }
        await this.writeIndex(index);
        await Promise.all(selectionIds.map((selectionId) => this.removePending(selectionId).catch(() => undefined)));
        return committed.map(publicAttachment);
      } catch (error) {
        await Promise.all(temporaryFiles.map((file) => rm(file, { force: true }).catch(() => undefined)));
        await Promise.all(createdDirectories.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)));
        throw error;
      }
    });
  }

  async canonicalize(conversationId: string, attachments: MessageAttachment[] | undefined): Promise<MessageAttachment[] | undefined> {
    if (!attachments?.length) return undefined;
    return Promise.all(attachments.map(async (attachment) => {
      const info = await this.inspect(attachment.id, conversationId);
      if (info.availability !== 'available') throw new Error('ATTACHMENT_MISSING');
      return publicAttachment(info);
    }));
  }

  async list(conversationId: string): Promise<ConversationAttachmentInfo[]> {
    await this.initialize();
    assertSafeId(conversationId, 'ATTACHMENT_CONVERSATION_REQUIRED');
    await this.mutation;
    const index = await this.readIndex(conversationId);
    const values = await Promise.all(Object.values(index.attachments).map((record) => this.toInfo(conversationId, record)));
    return values.sort((left, right) => left.sentAt.localeCompare(right.sentAt));
  }

  async inspect(id: string, conversationId: string): Promise<ConversationAttachmentInfo> {
    await this.initialize();
    assertSafeId(conversationId, 'ATTACHMENT_CONVERSATION_REQUIRED');
    assertSafeId(id, 'ATTACHMENT_REFERENCE_INVALID');
    await this.mutation;
    const record = (await this.readIndex(conversationId)).attachments[id];
    if (!record) throw new Error('ATTACHMENT_REFERENCE_INVALID');
    return this.toInfo(conversationId, record);
  }

  async read(id: string, conversationId: string) { return readFile(await this.pathFor(id, conversationId)); }

  async pathFor(id: string, conversationId: string) {
    const info = await this.inspect(id, conversationId);
    if (info.availability !== 'available') throw new Error('ATTACHMENT_MISSING');
    return this.contentPath(conversationId, id);
  }

  async sourcePathFor(id: string, conversationId: string) {
    await this.initialize();
    assertSafeId(conversationId, 'ATTACHMENT_CONVERSATION_REQUIRED');
    assertSafeId(id, 'ATTACHMENT_REFERENCE_INVALID');
    await this.mutation;
    const record = (await this.readIndex(conversationId)).attachments[id];
    if (!record) throw new Error('ATTACHMENT_REFERENCE_INVALID');
    if (!record.sourcePath || !(await isFile(record.sourcePath))) throw new Error('ATTACHMENT_SOURCE_MISSING');
    return record.sourcePath;
  }

  async pendingPath(selectionId: string) {
    await this.initialize();
    const record = this.pending.get(selectionId);
    if (!record) throw new Error('ATTACHMENT_SELECTION_EXPIRED');
    return record.contentPath;
  }

  async deleteConversation(conversationId: string) {
    await this.initialize();
    assertSafeId(conversationId, 'ATTACHMENT_CONVERSATION_REQUIRED');
    const target = this.conversationDirectory(conversationId);
    assertPathInside(this.root(), target);
    await this.mutate(() => rm(target, { recursive: true, force: true }));
  }

  async dispose() {
    this.pending.clear();
    await this.mutate(() => rm(this.pendingDirectory(), { recursive: true, force: true }));
  }

  private async initialize() {
    this.initialized ??= this.mutate(async () => {
      await mkdir(this.root(), { recursive: true });
      await rm(this.pendingDirectory(), { recursive: true, force: true });
      await mkdir(this.pendingDirectory(), { recursive: true });
      await this.migrateLegacyIndex();
    });
    await this.initialized;
  }

  private async removePending(selectionId: string) {
    this.pending.delete(selectionId);
    if (selectionId.startsWith('pending-attachment-')) await rm(path.join(this.pendingDirectory(), selectionId), { recursive: true, force: true });
  }

  private async findReusable(index: AttachmentIndex, conversationId: string, sourcePath: string, sha256: string, sizeBytes: number) {
    for (const record of Object.values(index.attachments)) {
      if (!sameSourcePath(record.sourcePath, sourcePath) || record.sha256 !== sha256 || record.sizeBytes !== sizeBytes) continue;
      if (await this.snapshotIsValid(conversationId, record)) return record;
    }
    return undefined;
  }

  private async snapshotIsValid(conversationId: string, record: StoredAttachment) {
    try {
      const target = this.contentPath(conversationId, record.id);
      const info = await stat(target);
      return info.isFile() && info.size === record.sizeBytes && (!record.sha256 || await hashFile(target) === record.sha256);
    } catch { return false; }
  }

  private async toInfo(conversationId: string, record: StoredAttachment): Promise<ConversationAttachmentInfo> {
    const availability: ConversationAttachmentInfo['availability'] = await this.snapshotIsValid(conversationId, record) ? 'available' : 'missing';
    const sourceAvailability: ConversationAttachmentInfo['sourceAvailability'] = !record.sourcePath
      ? 'unknown'
      : await isFile(record.sourcePath) ? 'available' : 'missing';
    const sends = [...record.sends].sort((left, right) => left.sentAt.localeCompare(right.sentAt));
    return {
      ...publicAttachment(record),
      createdAt: record.createdAt,
      sentAt: sends.at(-1)?.sentAt ?? record.createdAt,
      sourceId: record.sourceId,
      sourceAvailability,
      sends,
      availability,
    };
  }

  private root() { return resolveValue(this.rootDirectory); }
  private pendingDirectory() { return path.join(this.root(), '.pending'); }
  private conversationDirectory(conversationId: string) { return path.join(this.root(), conversationId); }
  private attachmentDirectory(conversationId: string, id: string) { return path.join(this.conversationDirectory(conversationId), id); }
  private contentPath(conversationId: string, id: string) { return path.join(this.attachmentDirectory(conversationId, id), 'content'); }
  private indexPath(conversationId: string) { return path.join(this.conversationDirectory(conversationId), 'index.json'); }

  private async readIndex(conversationId: string): Promise<AttachmentIndex> {
    try {
      const value: unknown = JSON.parse(await readFile(this.indexPath(conversationId), 'utf8'));
      if (isRecord(value) && value.conversationId === conversationId && isRecord(value.attachments)) {
        if (value.version === 3) return normalizeV3Index(value as unknown as AttachmentIndex, conversationId, this.contentPath.bind(this));
        if (value.version === 2) return this.upgradeV2Index(conversationId, value.attachments);
      }
    } catch { /* Missing conversations have an empty index. */ }
    return { version: 3, conversationId, attachments: {} };
  }

  private upgradeV2Index(conversationId: string, attachments: Record<string, unknown>): AttachmentIndex {
    const upgraded: AttachmentIndex = { version: 3, conversationId, attachments: {} };
    for (const candidate of Object.values(attachments)) {
      if (!isV2Attachment(candidate)) continue;
      const createdAt = candidate.createdAt ?? new Date().toISOString();
      upgraded.attachments[candidate.id] = {
        ...publicAttachment(candidate), sha256: candidate.sha256 ?? '', createdAt,
        sourceId: `source-${candidate.id}`, sourcePath: '', snapshotPath: this.contentPath(conversationId, candidate.id),
        sends: [], legacySourceMissing: candidate.legacySourceMissing,
      };
    }
    return upgraded;
  }

  private async writeIndex(index: AttachmentIndex) {
    const target = this.indexPath(index.conversationId);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(index), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async migrateLegacyIndex() {
    if (!this.legacyIndexPath) return;
    const legacyPath = resolveValue(this.legacyIndexPath);
    let value: unknown;
    try { value = JSON.parse(await readFile(legacyPath, 'utf8')); } catch { return; }
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.attachments)) return;
    const grouped = new Map<string, LegacyStoredAttachment[]>();
    for (const candidate of Object.values(value.attachments)) {
      if (!isLegacyAttachment(candidate)) continue;
      try { assertSafeId(candidate.conversationId, 'INVALID'); assertSafeId(candidate.id, 'INVALID'); } catch { continue; }
      grouped.set(candidate.conversationId, [...(grouped.get(candidate.conversationId) ?? []), candidate]);
    }
    for (const [conversationId, records] of grouped) {
      const index = await this.readIndex(conversationId);
      for (const legacy of records) {
        if (index.attachments[legacy.id]) continue;
        const createdAt = legacy.createdAt ?? new Date().toISOString();
        const snapshotPath = this.contentPath(conversationId, legacy.id);
        let stored: StoredAttachment;
        if (await isFile(legacy.sourcePath)) {
          const directory = this.attachmentDirectory(conversationId, legacy.id);
          await mkdir(directory, { recursive: true });
          const temporary = path.join(directory, `content.${randomUUID()}.tmp`);
          await copyFile(legacy.sourcePath, temporary, constants.COPYFILE_EXCL);
          const copied = await stat(temporary);
          await rename(temporary, snapshotPath);
          stored = {
            id: legacy.id, name: legacy.name, mediaType: normalizeMediaType(legacy.mediaType), sizeBytes: copied.size,
            sha256: await hashFile(snapshotPath), createdAt, sourceId: `source-${randomUUID()}`,
            sourcePath: path.resolve(legacy.sourcePath), snapshotPath, sends: [],
          };
        } else {
          stored = {
            id: legacy.id, name: legacy.name, mediaType: normalizeMediaType(legacy.mediaType), sizeBytes: legacy.sizeBytes,
            sha256: '', createdAt, sourceId: `source-${randomUUID()}`, sourcePath: path.resolve(legacy.sourcePath),
            snapshotPath, sends: [], legacySourceMissing: true,
          };
        }
        index.attachments[stored.id] = stored;
      }
      await this.writeIndex(index);
    }
    await rename(legacyPath, `${legacyPath}.migrated`).catch(async () => {
      await writeFile(`${legacyPath}.migrated`, JSON.stringify({ version: 1, migratedAt: new Date().toISOString() }), 'utf8');
      await rm(legacyPath, { force: true });
    });
  }

  private mutate<T>(operation: () => Promise<T>) {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function publicPending(record: PendingRecord): PendingMessageAttachment {
  return { selectionId: record.selectionId, name: record.name, mediaType: record.mediaType, sizeBytes: record.sizeBytes };
}

function publicAttachment(record: MessageAttachment): MessageAttachment {
  return { id: record.id, name: record.name, mediaType: normalizeMediaType(record.mediaType), sizeBytes: record.sizeBytes };
}

function normalizeV3Index(index: AttachmentIndex, conversationId: string, contentPath: (conversationId: string, id: string) => string): AttachmentIndex {
  const attachments: Record<string, StoredAttachment> = {};
  for (const candidate of Object.values(index.attachments)) {
    if (!isV3Attachment(candidate)) continue;
    attachments[candidate.id] = { ...candidate, mediaType: normalizeMediaType(candidate.mediaType), snapshotPath: contentPath(conversationId, candidate.id), sends: candidate.sends.filter(isSendRecord) };
  }
  return { version: 3, conversationId, attachments };
}

function resolveValue(value: string | (() => string)) { return path.resolve(typeof value === 'function' ? value() : value); }
function assertSafeId(value: string, code: string) { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)) throw new Error(code); }
function assertPathInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ATTACHMENT_PATH_REJECTED');
}
function isV2Attachment(value: unknown): value is V2StoredAttachment {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.mediaType === 'string' && Number.isSafeInteger(value.sizeBytes);
}
function isV3Attachment(value: unknown): value is StoredAttachment {
  if (!isV2Attachment(value)) return false;
  const record = value as V2StoredAttachment & Record<string, unknown>;
  return typeof record.sha256 === 'string' && typeof record.createdAt === 'string' && typeof record.sourceId === 'string'
    && typeof record.sourcePath === 'string' && typeof record.snapshotPath === 'string' && Array.isArray(record.sends);
}
function isSendRecord(value: unknown): value is AttachmentSendRecord { return isRecord(value) && typeof value.messageId === 'string' && typeof value.sentAt === 'string'; }
function isLegacyAttachment(value: unknown): value is LegacyStoredAttachment {
  if (!isV2Attachment(value)) return false;
  const record = value as V2StoredAttachment & Record<string, unknown>;
  return typeof record.conversationId === 'string' && typeof record.sourcePath === 'string';
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
async function isFile(filePath: string) { try { return (await stat(filePath)).isFile(); } catch { return false; } }
function sameSourcePath(left: string, right: string) {
  if (!left || !right) return false;
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32' ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase() : normalizedLeft === normalizedRight;
}
async function hashFile(filePath: string) { return createHash('sha256').update(await readFile(filePath)).digest('hex'); }
function normalizeMediaType(value: string) { return value.trim().toLocaleLowerCase() || 'application/octet-stream'; }

export function mediaTypeFor(filePath: string) {
  const extension = path.extname(filePath).toLocaleLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
    '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/tsx', '.jsx': 'text/jsx', '.json': 'application/json', '.xml': 'application/xml', '.csv': 'text/csv',
    '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}
