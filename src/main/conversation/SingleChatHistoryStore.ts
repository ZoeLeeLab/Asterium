import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Conversation, Message } from '../../renderer/types/domain';

type HistoryMetadata = Omit<Conversation, 'messages'>;
type HistoryEvent =
  | { type: 'conversation.imported'; conversation: HistoryMetadata }
  | { type: 'message.imported'; message: Message }
  | { type: 'checkpoint'; upsert: Message[]; remove: string[] };

interface HistoryManifest {
  version: 2;
  generation: string;
  chats: string[];
  deleted: string[];
}

export interface SingleChatLegacySource {
  conversations: Conversation[];
  deletedConversationIds: string[];
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

  constructor(private readonly profile: string) {}

  initialize(readLegacy: () => Promise<SingleChatLegacySource>) {
    return this.exclusive(async () => {
      const active = await this.readManifest();
      if (active) return active;

      const { conversations, deletedConversationIds } = await readLegacy();
      const deleted = new Set(deletedConversationIds);
      const importable = conversations.filter(conversation => !deleted.has(conversation.id));
      const manifest: HistoryManifest = {
        version: 2, generation: randomUUID(), chats: importable.map(conversation => conversation.id), deleted: [...deleted],
      };
      assertManifest(manifest);
      await mkdir(this.profile, { recursive: true });
      const stage = await mkdtemp(path.join(this.profile, 'single-chat-history.stage-'));
      if (path.dirname(path.resolve(stage)) !== path.resolve(this.profile)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_STAGE');
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

  readConversation(conversationId: string) {
    return this.exclusive(async () => {
      const manifest = await this.readManifest();
      if (!manifest?.chats.includes(conversationId)) return undefined;
      const { conversation, revision, tail } = await this.readLog(conversationId);
      return { conversation, revision, incompleteTail: Boolean(tail.length) };
    });
  }

  checkpoint(request: SingleChatCheckpoint) {
    return this.exclusive(async () => {
      const manifest = await this.readManifest();
      if (!manifest || manifest.generation !== request.generation || !manifest.chats.includes(request.conversationId)) {
        throw new Error('SINGLE_CHAT_HISTORY_STALE_GENERATION');
      }
      const { revision, tail, length } = await this.readLog(request.conversationId);
      if (revision !== request.expectedRevision) throw new Error('SINGLE_CHAT_HISTORY_STALE_REVISION');
      const remove = request.remove ?? [];
      if (!request.upsert.every(validMessage) || !remove.every(validId)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_CHECKPOINT');
      const target = eventPath(this.root, request.conversationId);
      if (tail.length) {
        await writeFile(target + '.incomplete-' + randomUUID(), tail, { flag: 'wx', flush: true, mode: 0o600 });
        await truncate(target, length);
      }
      const event: HistoryEvent = { type: 'checkpoint', upsert: request.upsert, remove };
      await appendFile(target, JSON.stringify(event) + '\n', { flag: 'a', flush: true });
      return revision + 1;
    });
  }

  private get root() { return path.join(this.profile, 'single-chat-history.v2'); }

  private async readManifest(): Promise<HistoryManifest | undefined> {
    // A missing manifest within an existing active directory is a storage error, not permission to reimport.
    try {
      if (!(await lstat(this.root)).isDirectory()) throw new Error('SINGLE_CHAT_HISTORY_INVALID_DIRECTORY');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const manifest: unknown = JSON.parse(await readFile(path.join(this.root, 'manifest.json'), 'utf8'));
    assertManifest(manifest);
    return manifest;
  }

  private async readLog(conversationId: string) {
    return replay(await readFile(eventPath(this.root, conversationId)), conversationId);
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
  if (!isRecord(header) || header.type !== 'conversation.imported' || !isRecord(header.conversation)
    || header.conversation.id !== conversationId || !validId(header.conversation.partnerId)
    || typeof header.conversation.title !== 'string' || typeof header.conversation.updatedAt !== 'string') {
    throw new Error('SINGLE_CHAT_HISTORY_INVALID_HEADER');
  }
  const messages = new Map<string, Message>();
  for (const line of events) {
    const event: unknown = JSON.parse(line);
    if (!isRecord(event)) throw new Error('SINGLE_CHAT_HISTORY_INVALID_EVENT');
    if (event.type === 'message.imported' && validMessage(event.message) && !messages.has(event.message.id)) {
      messages.set(event.message.id, event.message);
    } else if (event.type === 'checkpoint' && Array.isArray(event.remove) && event.remove.every(validId)
      && Array.isArray(event.upsert) && event.upsert.every(validMessage)) {
      for (const id of event.remove) messages.delete(id);
      for (const message of event.upsert) messages.set(message.id, message);
    } else {
      throw new Error('SINGLE_CHAT_HISTORY_INVALID_EVENT');
    }
  }
  return {
    conversation: { ...header.conversation, messages: [...messages.values()] } as Conversation,
    revision: lines.length,
    length,
    tail,
  };
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
