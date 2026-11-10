import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Conversation, Message } from '../../renderer/types/domain';
import type { SingleChatHistoryChange, SingleChatHistorySnapshot, SingleChatHistoryWrite, SingleChatMetadata, SingleChatProfile } from '../../shared/singleChatHistory';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';

type HistoryEvent =
  | { type: 'conversation.imported'; conversation: SingleChatMetadata }
  | { type: 'message.imported'; message: Message }
  | { type: 'checkpoint'; upsert: Message[]; remove: string[]; metadata?: SingleChatMetadata; busy?: boolean; order?: string[] };

interface HistoryManifest {
  version: 2;
  generation: string;
  chats: string[];
  deleted: string[];
}

export interface SingleChatLegacySource {
  conversations: Conversation[];
  deletedConversationIds: string[];
  profile?: SingleChatProfile;
}

export interface SingleChatCheckpoint {
  generation: string;
  conversationId: string;
  expectedRevision: number;
  upsert: Message[];
  remove?: string[];
}

/** Activation is the directory rename. Once that directory exists, legacy readers are never called again. */
export class SingleChatHistoryStore {
  private mutation: Promise<unknown> = Promise.resolve();
  private readonly logs = new Map<string, ReturnType<typeof replay>>();
  private profileCache?: SingleChatProfile;
  private readonly busy = new Set<string>();
  private readonly settings: AtomicJsonStore<SingleChatProfile>;
  private readonly manifests: AtomicJsonStore<HistoryManifest>;

  constructor(private readonly profile: string | (() => string)) {
    this.settings = new AtomicJsonStore({
      filePath: () => path.join(this.root, 'profile.json'),
      flush: true,
      empty: () => { throw new Error('SINGLE_CHAT_HISTORY_PROFILE_MISSING'); },
      decode: value => { assertHistoryProfile(value); return value; },
    });
    this.manifests = new AtomicJsonStore({
      filePath: () => path.join(this.root, 'manifest.json'),
      flush: true,
      empty: () => { throw new Error('SINGLE_CHAT_HISTORY_MANIFEST_MISSING'); },
      decode: value => { assertManifest(value); return value; },
    });
  }

  initialize(readLegacy: () => Promise<SingleChatLegacySource>) {
    return this.exclusive(async () => {
      const active = await this.readManifest();
      if (active) return active;

      const { conversations, deletedConversationIds, profile } = await readLegacy();
      if (profile) assertHistoryProfile(profile);
      const deleted = new Set(deletedConversationIds);
      const importable = conversations.filter(conversation => !deleted.has(conversation.id));
      const manifest: HistoryManifest = {
        version: 2, generation: randomUUID(), chats: importable.map(conversation => conversation.id), deleted: [...deleted],
      };
      assertManifest(manifest);
      const profileDirectory = this.profileDirectory;
      await mkdir(profileDirectory, { recursive: true });
      const stage = await mkdtemp(path.join(profileDirectory, 'single-chat-history.stage-'));
      if (path.dirname(path.resolve(stage)) !== path.resolve(profileDirectory)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_STAGE');
      try {
        for (const conversation of importable) {
          const { messages, ...metadata } = conversation;
          const target = eventPath(stage, metadata.id);
          await mkdir(path.dirname(target), { recursive: true });
          const events: HistoryEvent[] = [
            { type: 'conversation.imported', conversation: metadata },
            ...messages.map((message): HistoryEvent => ({ type: 'message.imported', message })),
          ];
          const source = events.map(event => JSON.stringify(event)).join('\n') + '\n';
          await writeFile(target, source, { flag: 'wx', flush: true, mode: 0o600 });
          const stored = await readFile(target);
          if (!stored.equals(Buffer.from(source)) || replay(stored, metadata.id).revision !== events.length) {
            throw new Error('SINGLE_CHAT_HISTORY_MIGRATION_VERIFICATION_FAILED');
          }
        }
        if (profile) {
          await writeFile(path.join(stage, 'profile.json'), JSON.stringify(profile), { flag: 'wx', flush: true, mode: 0o600 });
          assertHistoryProfile(JSON.parse(await readFile(path.join(stage, 'profile.json'), 'utf8')));
        }
        await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', flush: true, mode: 0o600 });
        try {
          await rename(stage, this.root);
          return manifest;
        } catch (error) {
          const winner = await this.readManifest();
          if (winner) return winner;
          throw error;
        }
      } finally {
        // stage was created directly under this profile. After activation its old path no longer exists.
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async flush() {
    await this.mutation;
  }

  isActive() {
    return this.exclusive(async () => Boolean(await this.readManifest()));
  }

  open() {
    return this.exclusive(async (): Promise<SingleChatHistorySnapshot | undefined> => {
      const manifest = await this.readManifest();
      if (!manifest) return undefined;
      const profile = await this.readProfile();
      const conversations = await this.readConversations(manifest);
      return {
        generation: manifest.generation, profile, conversations,
        interruptedConversationIds: manifest.chats.filter(id => this.logs.get(id)?.pending && !this.busy.has(id)),
      };
    });
  }

  readProjection(conversationId?: string) {
    return this.exclusive(async () => {
      const manifest = await this.readManifest();
      if (!manifest) return undefined;
      const conversations = conversationId === undefined ? await this.readConversations(manifest)
        : manifest.chats.includes(conversationId) ? [materialize(await this.readLog(conversationId))] : [];
      return { conversations, profile: await this.readProfile(), busy: new Set(this.busy) };
    });
  }

  write(request: SingleChatHistoryWrite) {
    return this.exclusive(async () => {
      const manifest = await this.readManifest();
      if (!manifest || manifest.generation !== request.generation) throw new Error('SINGLE_CHAT_HISTORY_STALE_GENERATION');
      for (const change of request.changes) {
        await this.applyChange(manifest, change);
        if (change.busy === true && !manifest.deleted.includes(change.conversationId)) this.busy.add(change.conversationId);
        else if (change.busy === false) this.busy.delete(change.conversationId);
      }
      if (request.profile) {
        await this.settings.writeNow(request.profile);
        this.profileCache = request.profile;
      }
    });
  }

  bindInitialSession(conversationId: string, partnerId: string, sessionId: string) {
    return this.exclusive(async () => {
      const manifest = await this.readManifest();
      if (!manifest?.chats.includes(conversationId)) return false;
      const log = await this.readLog(conversationId);
      if (log.metadata.partnerId !== partnerId) throw new Error('SINGLE_CHAT_HISTORY_WRONG_PARTNER');
      if (log.metadata.sessionId) return log.metadata.sessionId === sessionId;
      await this.append(conversationId, log, { type: 'checkpoint', upsert: [], remove: [],
        metadata: { ...log.metadata, sessionId } });
      return true;
    });
  }

  // Main-owned activity reaches the same log even when no renderer is open.
  upsertManagedMessage(conversationId: string, partnerId: string, message: Message) {
    return this.exclusive(async () => {
      const manifest = await this.readManifest();
      if (!manifest) return false;
      if (manifest.deleted.includes(conversationId)) return true;
      if (!manifest.chats.includes(conversationId)) throw new Error('SINGLE_CHAT_HISTORY_UNKNOWN_CONVERSATION');
      const current = await this.readLog(conversationId);
      if (current.metadata.partnerId !== partnerId) throw new Error('SINGLE_CHAT_HISTORY_WRONG_PARTNER');
      const existing = current.messages.get(message.id);
      if (existing && !message.automation) return true;
      await this.append(conversationId, current, {
        type: 'checkpoint', upsert: [{ ...existing, ...message, automation: existing?.automation ?? message.automation }], remove: [],
      });
      return true;
    });
  }

  deleteConversation(conversationId: string) {
    return this.exclusive(async () => {
      const manifest = await this.readManifest();
      if (!manifest) return false;
      if (!manifest.deleted.includes(conversationId)) {
        await this.manifests.writeNow({
          ...manifest, chats: manifest.chats.filter(id => id !== conversationId), deleted: [...manifest.deleted, conversationId],
        });
      }
      this.logs.delete(conversationId);
      this.busy.delete(conversationId);
      const directory = path.dirname(eventPath(this.root, conversationId));
      const files = await readdir(directory).catch(error => {
        if (isMissing(error)) return [];
        throw error;
      });
      for (const name of files) {
        if (name === 'events.jsonl' || name.startsWith('events.jsonl.incomplete-')) await rm(path.join(directory, name), { force: true });
      }
      return true;
    });
  }

  readConversation(conversationId: string) {
    return this.exclusive(async () => {
      const manifest = await this.readManifest();
      if (!manifest?.chats.includes(conversationId)) return undefined;
      const log = await this.readLog(conversationId);
      return { conversation: materialize(log), revision: log.revision, incompleteTail: Boolean(log.tail.length) };
    });
  }

  checkpoint(request: SingleChatCheckpoint) {
    return this.exclusive(async () => {
      const manifest = await this.readManifest();
      if (!manifest || manifest.generation !== request.generation || !manifest.chats.includes(request.conversationId)) {
        throw new Error('SINGLE_CHAT_HISTORY_STALE_GENERATION');
      }
      const log = await this.readLog(request.conversationId);
      if (log.revision !== request.expectedRevision) throw new Error('SINGLE_CHAT_HISTORY_STALE_REVISION');
      const remove = request.remove ?? [];
      if (!request.upsert.every(validMessage) || !remove.every(validId)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_CHECKPOINT');
      await this.append(request.conversationId, log, { type: 'checkpoint', upsert: request.upsert, remove });
      return log.revision;
    });
  }

  private get profileDirectory() { return typeof this.profile === 'function' ? this.profile() : this.profile; }
  private get root() { return path.join(this.profileDirectory, 'single-chat-history.v2'); }

  private async readProfile() {
    this.profileCache ??= await this.settings.readNow();
    return this.profileCache;
  }

  private async readConversations(manifest: HistoryManifest) {
    const conversations: Conversation[] = [];
    for (const id of manifest.chats) conversations.push(materialize(await this.readLog(id)));
    return conversations;
  }

  private async applyChange(manifest: HistoryManifest, change: SingleChatHistoryChange) {
    const { conversationId, metadata, metadataOnCreateOnly, upsert, remove, busy, order } = change;
    if (manifest.deleted.includes(conversationId)) {
      if (upsert.some(message => message.status === 'sending')) throw new Error('SINGLE_CHAT_HISTORY_CONVERSATION_DELETED');
      return;
    }
    if (!manifest.chats.includes(conversationId)) {
      if (!metadata) throw new Error('SINGLE_CHAT_HISTORY_UNKNOWN_CONVERSATION');
      const target = eventPath(this.root, conversationId);
      await mkdir(path.dirname(target), { recursive: true });
      const source = JSON.stringify({ type: 'conversation.imported', conversation: metadata }) + '\n'
        + JSON.stringify({ type: 'checkpoint', upsert, remove, busy, order }) + '\n';
      const verified = replay(Buffer.from(source), conversationId);
      await writeFile(target, source, { flush: true, mode: 0o600 });
      const chats = [conversationId, ...manifest.chats];
      await this.manifests.writeNow({ ...manifest, chats });
      manifest.chats = chats;
      this.logs.set(conversationId, verified);
      return;
    }

    const log = await this.readLog(conversationId);
    if (metadata && metadata.partnerId !== log.metadata.partnerId) throw new Error('SINGLE_CHAT_HISTORY_WRONG_PARTNER');
    await this.append(conversationId, log, {
      type: 'checkpoint', metadata: metadataOnCreateOnly ? undefined : metadata, upsert, remove, busy, order,
    });
  }

  private async append(conversationId: string, log: ReturnType<typeof replay>, event: Extract<HistoryEvent, { type: 'checkpoint' }>) {
    const target = eventPath(this.root, conversationId);
    const serialized = JSON.stringify(event) + '\n';
    try {
      if (log.tail.length) {
        await writeFile(target + '.incomplete-' + randomUUID(), log.tail, { flag: 'wx', flush: true, mode: 0o600 });
        await truncate(target, log.length);
      }
      await appendFile(target, serialized, { flag: 'a', flush: true });
    } catch (error) {
      this.logs.delete(conversationId);
      throw error;
    }
    log.metadata = event.metadata ?? log.metadata;
    applyMessages(log.messages, event.upsert, event.remove, event.order);
    log.pending = event.busy ?? log.pending;
    log.length += Buffer.byteLength(serialized);
    log.tail = Buffer.alloc(0);
    log.revision += 1;
  }

  private async readManifest(): Promise<HistoryManifest | undefined> {
    // A missing manifest within an existing active directory is a storage error, not permission to reimport.
    try {
      if (!(await lstat(this.root)).isDirectory()) throw new Error('SINGLE_CHAT_HISTORY_INVALID_DIRECTORY');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    return this.manifests.readNow();
  }

  private async readLog(conversationId: string) {
    const cached = this.logs.get(conversationId);
    if (cached) return cached;
    const log = replay(await readFile(eventPath(this.root, conversationId)), conversationId);
    this.logs.set(conversationId, log);
    return log;
  }

  private exclusive<T>(operation: () => Promise<T>) {
    const next = this.mutation.then(operation);
    this.mutation = next.catch(() => undefined);
    return next;
  }
}

function eventPath(root: string, conversationId: string) {
  return path.join(root, 'conversations', createHash('sha256').update(conversationId).digest('hex'), 'events.jsonl');
}

function replay(file: Buffer, conversationId: string) {
  const length = file.lastIndexOf(10) + 1;
  const tail = file.subarray(length);
  const lines = file.subarray(0, length).toString('utf8').split('\n');
  lines.pop();
  const [first, ...events] = lines;
  const header = JSON.parse(first ?? 'null') as unknown;
  if (!isRecord(header) || header.type !== 'conversation.imported' || !validMetadata(header.conversation, conversationId)) {
    throw new Error('SINGLE_CHAT_HISTORY_INVALID_HEADER');
  }
  let metadata = header.conversation;
  let pending = false;
  const messages = new Map<string, Message>();
  for (const line of events) {
    const event: unknown = JSON.parse(line);
    if (!isRecord(event)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_EVENT');
    if (event.type === 'message.imported' && validMessage(event.message) && !messages.has(event.message.id)) {
      messages.set(event.message.id, event.message);
    } else if (event.type === 'checkpoint' && Array.isArray(event.remove) && event.remove.every(validId)
      && Array.isArray(event.upsert) && event.upsert.every(validMessage)
      && (event.metadata === undefined || (validMetadata(event.metadata, conversationId) && event.metadata.partnerId === metadata.partnerId))
      && (event.busy === undefined || typeof event.busy === 'boolean')
      && (event.order === undefined || (Array.isArray(event.order) && event.order.every(validId)))) {
      metadata = event.metadata ?? metadata;
      pending = event.busy ?? pending;
      applyMessages(messages, event.upsert, event.remove, event.order);
    } else {
      throw new Error('SINGLE_CHAT_HISTORY_INVALID_EVENT');
    }
  }
  return { metadata, messages, pending, revision: lines.length, length, tail };
}

function materialize(log: ReturnType<typeof replay>): Conversation {
  return { ...log.metadata, messages: [...log.messages.values()] };
}

function applyMessages(messages: Map<string, Message>, upsert: Message[], remove: string[], order?: string[]) {
  for (const id of remove) messages.delete(id);
  for (const message of upsert) messages.set(message.id, message);
  if (!order) return;
  const ordered: Message[] = [];
  for (const id of order) {
    const message = messages.get(id);
    if (!message) continue;
    ordered.push(message);
    messages.delete(id);
  }
  ordered.push(...messages.values());
  messages.clear();
  for (const message of ordered) messages.set(message.id, message);
}

function validMetadata(value: unknown, conversationId: string): value is SingleChatMetadata {
  return isRecord(value) && value.id === conversationId && validId(value.partnerId)
    && typeof value.title === 'string' && typeof value.updatedAt === 'string' && !('messages' in value);
}

export function assertHistoryImport(value: unknown): asserts value is import('../../shared/singleChatHistory').SingleChatHistoryImport {
  if (!isRecord(value) || !Array.isArray(value.conversations)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_IMPORT');
  assertHistoryProfile(value.profile);
  for (const item of value.conversations) {
    if (!isRecord(item) || !validId(item.id) || !Array.isArray(item.messages) || !item.messages.every(validMessage)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_IMPORT');
    if (typeof item.title !== 'string' || typeof item.updatedAt !== 'string' || !validId(item.partnerId)) {
      throw new Error('SINGLE_CHAT_HISTORY_INVALID_IMPORT');
    }
  }
}

export function assertHistoryWrite(value: unknown): asserts value is SingleChatHistoryWrite {
  if (!isRecord(value) || !validId(value.generation) || !Array.isArray(value.changes)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_WRITE');
  if (value.profile !== undefined) assertHistoryProfile(value.profile);
  for (const change of value.changes) {
    if (!isRecord(change) || !validId(change.conversationId) || !Array.isArray(change.upsert) || !change.upsert.every(validMessage)
      || !Array.isArray(change.remove) || !change.remove.every(validId) || (change.busy !== undefined && typeof change.busy !== 'boolean')
      || (change.order !== undefined && (!Array.isArray(change.order) || !change.order.every(validId)))
      || (change.metadataOnCreateOnly !== undefined && typeof change.metadataOnCreateOnly !== 'boolean')
      || (change.metadata !== undefined && !validMetadata(change.metadata, change.conversationId))) throw new Error('SINGLE_CHAT_HISTORY_INVALID_WRITE');
  }
}

function assertHistoryProfile(value: unknown): asserts value is SingleChatProfile {
  if (!isRecord(value) || value.version !== 7 || !isRecord(value.userProfile) || !Array.isArray(value.partners)
    || !Array.isArray(value.projects) || !Array.isArray(value.groupChats) || 'conversations' in value) {
    throw new Error('SINGLE_CHAT_HISTORY_INVALID_PROFILE');
  }
}

function assertManifest(value: unknown): asserts value is HistoryManifest {
  if (!isRecord(value) || value.version !== 2 || !validId(value.generation)
    || !Array.isArray(value.chats) || !value.chats.every(validId) || new Set(value.chats).size !== value.chats.length
    || !Array.isArray(value.deleted) || !value.deleted.every(validId) || value.deleted.some(id => (value.chats as unknown[]).includes(id))) {
    throw new Error('SINGLE_CHAT_HISTORY_INVALID_MANIFEST');
  }
}

function validMessage(value: unknown): value is Message {
  return isRecord(value) && validId(value.id) && validId(value.authorId)
    && typeof value.content === 'string' && typeof value.createdAt === 'string';
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
