import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Conversation, Message } from '../../renderer/types/domain';
import type { SingleChatHistoryChange, SingleChatHistorySnapshot, SingleChatHistoryWrite, SingleChatMetadata, SingleChatProfile } from '../../shared/singleChatHistory';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';
import type { SingleChatHistoryPage, SingleChatPageRequest, SingleChatSearchRequest, SingleChatSearchResult } from '../../shared/singleChatHistory';
import { SingleChatHistoryIndex } from './SingleChatHistoryIndex';

type HistoryEvent =
  | { type: 'conversation.imported'; conversation: SingleChatMetadata }
  | { type: 'message.imported'; message: Message }
  | { type: 'checkpoint'; upsert: Message[]; remove: string[]; metadata?: SingleChatMetadata; busy?: boolean; order?: string[] };

type LogTip = Omit<ReturnType<typeof replay>, 'messages'> & { messages?: Map<string, Message> };

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
  private indexedGeneration?: string;
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
      const conversations: Conversation[] = [];
      const interruptedConversationIds: string[] = [];
      for (const id of manifest.chats) {
        const log = await this.readLog(id);
        conversations.push(materialize(log));
        if (log.pending && !this.busy.has(id)) interruptedConversationIds.push(id);
      }
      return { generation: manifest.generation, profile, conversations, interruptedConversationIds };
    });
  }

  openRecent() {
    return this.exclusive(async (): Promise<SingleChatHistorySnapshot | undefined> => {
      const manifest = await this.readManifest();
      if (!manifest) return undefined;
      const profile = await this.readProfile();
      return this.withIndex(manifest.generation, async index => {
        const conversations: Conversation[] = [];
        const interruptedConversationIds: string[] = [];
        const recentPages: NonNullable<SingleChatHistorySnapshot['recentPages']> = Object.create(null);
        for (const id of manifest.chats) {
          const marker = await this.ensureIndexed(index, id);
          if (marker.pending && !this.busy.has(id)) interruptedConversationIds.push(id);
          if (id === profile.activeConversationId) {
            const { messages, hasOlder, hasNewer, turnOffset } = index.page({ conversationId: id });
            recentPages[id] = { hasOlder, hasNewer, turnOffset };
            conversations.push({ ...marker.metadata, messages });
          } else {
            conversations.push({ ...marker.metadata, messages: [] });
          }
        }
        return { generation: manifest.generation, profile, conversations, interruptedConversationIds, recentPages };
      });
    });
  }

  readPage(request: SingleChatPageRequest) {
    return this.exclusive(async (): Promise<SingleChatHistoryPage | undefined> => {
      const manifest = await this.readManifest();
      if (!manifest?.chats.includes(request.conversationId)) return undefined;
      return this.withIndex(manifest.generation, async index => {
        const marker = await this.ensureIndexed(index, request.conversationId);
        return { ...index.page(request), interrupted: marker.pending && !this.busy.has(request.conversationId) };
      });
    });
  }

  search(request: SingleChatSearchRequest) {
    return this.exclusive(async (): Promise<SingleChatSearchResult> => {
      const manifest = await this.readManifest();
      const id = request.conversationId;
      if (!manifest || (id && !manifest.chats.includes(id))) return { conversationIds: [], messageIds: [], hasMore: false };
      return this.withIndex(manifest.generation, async index => {
        for (const chat of id ? [id] : manifest.chats) await this.ensureIndexed(index, chat);
        const result = index.search(request);
        const allowed = new Set(manifest.chats);
        return { ...result, conversationIds: result.conversationIds.filter(chat => allowed.has(chat)) };
      });
    });
  }

  readProjection(conversationId?: string, includesPartner?: (partnerId: string) => boolean) {
    return this.exclusive(async () => {
      const manifest = await this.readManifest();
      if (!manifest) return undefined;
      const ids = conversationId === undefined ? manifest.chats : manifest.chats.includes(conversationId) ? [conversationId] : [];
      const conversations = await this.withIndex(manifest.generation, async index => {
        const result: Conversation[] = [];
        for (const id of ids) {
          const marker = await this.ensureIndexed(index, id);
          if (!includesPartner || includesPartner(marker.metadata.partnerId)) result.push({ ...marker.metadata, messages: index.projection(id) });
        }
        return result;
      });
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
      const log = await this.readTip(conversationId);
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
      const current = await this.readTip(conversationId);
      if (current.metadata.partnerId !== partnerId) throw new Error('SINGLE_CHAT_HISTORY_WRONG_PARTNER');
      const existing = current.messages
        ? current.messages.get(message.id)
        : await this.withIndex(manifest.generation, index => index.message(conversationId, message.id))
          .catch(async () => (await this.readLog(conversationId)).messages.get(message.id));
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
      if (this.indexedGeneration) {
        await this.withIndex(manifest.generation, index => index.delete(conversationId)).catch(() => undefined);
      }
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

  readMetadata(conversationId: string) {
    return this.exclusive(async () => {
      const manifest = await this.readManifest();
      if (!manifest?.chats.includes(conversationId)) return undefined;
      return this.withIndex(manifest.generation, async index => (await this.ensureIndexed(index, conversationId)).metadata);
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
      const log = await this.readTip(request.conversationId);
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
      this.cacheLog(conversationId, verified);
      return;
    }

    const log = await this.readTip(conversationId);
    if (metadata && metadata.partnerId !== log.metadata.partnerId) throw new Error('SINGLE_CHAT_HISTORY_WRONG_PARTNER');
    await this.append(conversationId, log, {
      type: 'checkpoint', metadata: metadataOnCreateOnly ? undefined : metadata, upsert, remove, busy, order,
    });
  }

  private async append(conversationId: string, log: LogTip, event: Extract<HistoryEvent, { type: 'checkpoint' }>) {
    const target = eventPath(this.root, conversationId);
    const serialized = JSON.stringify(event) + '\n';
    const previousFingerprint = this.indexedGeneration ? await fingerprint(target) : undefined;
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
    if (log.messages) applyMessages(log.messages, event.upsert, event.remove, event.order);
    else this.logs.delete(conversationId);
    log.pending = event.busy ?? log.pending;
    log.length += Buffer.byteLength(serialized);
    log.tail = Buffer.alloc(0);
    log.revision += 1;
    const generation = this.indexedGeneration;
    if (generation) {
      // JSONL is already durable. A failed projection update is repaired on the next indexed read.
      await this.withIndex(generation, async index => {
        const indexed = index.marker(conversationId);
        if (indexed?.revision !== log.revision - 1 || indexed.fingerprint !== previousFingerprint) return;
        index.checkpoint({
          metadata: log.metadata, pending: log.pending, revision: log.revision, length: log.length, fingerprint: await fingerprint(target),
        }, event.upsert, event.remove, event.order);
      }).catch(() => undefined);
    }
  }

  private async ensureIndexed(index: SingleChatHistoryIndex, id: string) {
    const target = eventPath(this.root, id);
    const signature = await fingerprint(target);
    const existing = index.marker(id);
    if (existing?.fingerprint === signature) return existing;
    const log = await scanLog(target, id);
    const marker = { metadata: log.metadata, pending: log.pending, revision: log.revision, length: log.length, fingerprint: signature };
    index.replace(marker, log.messages.values());
    return marker;
  }

  private async withIndex<T>(generation: string, action: (index: SingleChatHistoryIndex) => T | Promise<T>): Promise<T> {
    const file = path.join(this.root, 'history-index.v1.sqlite');
    const run = async () => {
      const index = new SingleChatHistoryIndex(file, generation);
      try { return await action(index); } finally { index.close(); }
    };
    this.indexedGeneration = generation;
    try {
      return await run();
    } catch (error) {
      if (!isBrokenIndex(error)) throw error;
      const damaged = file + '.invalid-' + randomUUID();
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        await rename(file + suffix, damaged + suffix).catch(failure => {
          if (!isMissing(failure)) throw failure;
        });
      }
      return run();
    }
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

  private async readTip(conversationId: string): Promise<LogTip> {
    const generation = this.indexedGeneration;
    if (!generation || this.logs.has(conversationId)) return this.readLog(conversationId);
    const marker = await this.withIndex(generation, index => this.ensureIndexed(index, conversationId)).catch(() => undefined);
    if (!marker) return this.readLog(conversationId);
    const size = Number(marker.fingerprint.split(':')[0]);
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(marker.length) || marker.length < 0 || marker.length > size) {
      return this.readLog(conversationId);
    }
    const tail = Buffer.alloc(size - marker.length);
    if (tail.length) {
      const file = await open(eventPath(this.root, conversationId), 'r');
      try {
        const { bytesRead } = await file.read(tail, 0, tail.length, marker.length);
        if (bytesRead !== tail.length) throw new Error('SINGLE_CHAT_HISTORY_LOG_CHANGED');
      } finally { await file.close(); }
    }
    return { ...marker, tail };
  }

  private async readLog(conversationId: string) {
    const cached = this.logs.get(conversationId);
    const log = cached ?? await scanLog(eventPath(this.root, conversationId), conversationId);
    this.cacheLog(conversationId, log);
    return log;
  }

  private cacheLog(conversationId: string, log: ReturnType<typeof replay>) {
    this.logs.delete(conversationId);
    this.logs.set(conversationId, log);
    const oldest = this.logs.keys().next().value;
    if (this.logs.size > 4 && oldest) this.logs.delete(oldest);
  }

  private exclusive<T>(operation: () => Promise<T>) {
    const next = this.mutation.then(operation);
    this.mutation = next.catch(() => undefined);
    return next;
  }
}

async function fingerprint(target: string) {
  const file = await stat(target, { bigint: true });
  return String(file.size) + ':' + String(file.mtimeNs);
}

function isBrokenIndex(error: unknown) {
  return error instanceof Error && /file is not a database|database disk image is malformed|SINGLE_CHAT_INDEX_INVALID_ROW|SINGLE_CHAT_INDEX_SCHEMA_UNSUPPORTED|malformed JSON|no such (?:table|column)/i.test(error.message);
}

function eventPath(root: string, conversationId: string) {
  return path.join(root, 'conversations', createHash('sha256').update(conversationId).digest('hex'), 'events.jsonl');
}

type Replay = { metadata?: SingleChatMetadata; messages: Map<string, Message>; pending: boolean; revision: number };

function createReplay(): Replay {
  return { messages: new Map(), pending: false, revision: 0 };
}

function acceptRecord(state: Replay, line: string, conversationId: string) {
  const event: unknown = JSON.parse(line);
  if (!isRecord(event)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_EVENT');
  if (state.revision === 0) {
    if (event.type !== 'conversation.imported' || !validMetadata(event.conversation, conversationId)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_HEADER');
    state.metadata = event.conversation;
  } else if (event.type === 'message.imported' && validMessage(event.message) && !state.messages.has(event.message.id)) {
    state.messages.set(event.message.id, event.message);
  } else if (event.type === 'checkpoint' && Array.isArray(event.remove) && event.remove.every(validId)
    && Array.isArray(event.upsert) && event.upsert.every(validMessage)
    && (event.metadata === undefined || (validMetadata(event.metadata, conversationId) && event.metadata.partnerId === state.metadata?.partnerId))
    && (event.busy === undefined || typeof event.busy === 'boolean')
    && (event.order === undefined || (Array.isArray(event.order) && event.order.every(validId)))) {
    state.metadata = event.metadata ?? state.metadata;
    state.pending = event.busy ?? state.pending;
    applyMessages(state.messages, event.upsert, event.remove, event.order);
  } else {
    throw new Error('SINGLE_CHAT_HISTORY_INVALID_EVENT');
  }
  state.revision++;
}

function finishReplay(state: Replay, length: number, tail: Buffer) {
  if (!state.metadata) throw new Error('SINGLE_CHAT_HISTORY_INVALID_HEADER');
  return { ...state, metadata: state.metadata, length, tail };
}

function replay(file: Buffer, conversationId: string) {
  const state = createReplay();
  const length = file.lastIndexOf(10) + 1;
  const lines = file.subarray(0, length).toString('utf8').split('\n');
  lines.pop();
  for (const line of lines) acceptRecord(state, line, conversationId);
  return finishReplay(state, length, file.subarray(length));
}

async function scanLog(target: string, conversationId: string) {
  const state = createReplay();
  let fragments: Buffer[] = [];
  let length = 0;
  for await (const chunk of createReadStream(target)) {
    const buffer: Buffer = chunk;
    let start = 0;
    for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
      const segment = buffer.subarray(start, end);
      const record = fragments.length ? Buffer.concat([...fragments, segment]) : segment;
      acceptRecord(state, record.toString('utf8'), conversationId);
      length += record.length + 1;
      fragments = [];
      start = end + 1;
    }
    if (start < buffer.length) fragments.push(buffer.subarray(start));
  }
  return finishReplay(state, length, Buffer.concat(fragments));
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

export function assertHistoryPage(value: unknown): asserts value is SingleChatPageRequest {
  if (!isRecord(value) || !validId(value.conversationId)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_PAGE');
  const anchors = [value.before, value.after, value.around].filter(id => id !== undefined);
  if (anchors.length > 1 || !anchors.every(validId)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_PAGE');
}

export function assertHistorySearch(value: unknown): asserts value is SingleChatSearchRequest {
  if (!isRecord(value) || typeof value.query !== 'string' || value.query.length > 512
    || (value.conversationId !== undefined && !validId(value.conversationId))
    || (value.after !== undefined && (!validId(value.conversationId) || !validId(value.after)))) {
    throw new Error('SINGLE_CHAT_HISTORY_INVALID_SEARCH');
  }
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
