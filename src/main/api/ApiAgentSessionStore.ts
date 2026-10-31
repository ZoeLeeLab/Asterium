import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MessageAttachment } from '../../shared/agentProtocol';

export interface ApiRuntimeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ApiRuntimeMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; reasoningContent: string; toolCalls?: ApiRuntimeToolCall[]; native?: { binding: string; items: unknown[] } }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ApiRuntimeTurn {
  clientMessageId: string;
  userContent: string;
  attachments?: MessageAttachment[];
  messages: ApiRuntimeMessage[];
  completedAt: string;
}

export interface ApiAgentSession {
  version: 1;
  partnerId: string;
  conversationId: string;
  provider: string;
  bindingKey?: string;
  /** Identity and user context captured once when this API conversation starts. */
  bootstrapSystemPrompt?: string;
  bootstrapVersion?: number;
  legacyContext?: string;
  compaction?: { summary: string; throughClientMessageId: string; createdAt: string };
  turns: ApiRuntimeTurn[];
  updatedAt: string;
}

interface ApiAgentSessionStoreOptions {
  maxTurns?: number;
  maxBytes?: number;
}

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export class ApiAgentSessionStore {
  private readonly maxTurns: number;
  private readonly maxBytes: number;
  private mutation = Promise.resolve();

  constructor(private readonly directory: string | (() => string), options: ApiAgentSessionStoreOptions = {}) {
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async load(partnerId: string, conversationId: string): Promise<ApiAgentSession | undefined> {
    await this.mutation;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath(partnerId, conversationId), 'utf8'));
      return normalizeSession(parsed, partnerId, conversationId);
    } catch (error) {
      if (error instanceof Error && ['API_COMPACTION_RECORD_INVALID', 'API_PROTOCOL_STATE_INVALID'].includes(error.message)) throw error;
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      return undefined;
    }
  }

  async save(session: ApiAgentSession) {
    return this.mutate(() => this.writeSession(session));
  }

  async replaceIfUnchanged(original: ApiAgentSession, next: ApiAgentSession) {
    return this.mutate(async () => {
      let current: ApiAgentSession | undefined;
      try { current = normalizeSession(JSON.parse(await readFile(this.filePath(original.partnerId, original.conversationId), 'utf8')), original.partnerId, original.conversationId); } catch { throw new Error('COMPACT_SESSION_CHANGED'); }
      if (JSON.stringify(current) !== JSON.stringify(original)) throw new Error('COMPACT_SESSION_CHANGED');
      return this.writeSession(next);
    });
  }

  private async writeSession(session: ApiAgentSession) {
    const normalized = pruneSession({
      ...session,
      turns: session.turns.map((turn) => ({ ...turn, ...(turn.attachments ? { attachments: turn.attachments.map(publicAttachment) } : {}) })),
      updatedAt: new Date().toISOString(),
    }, this.maxTurns, this.maxBytes);
    const target = this.filePath(session.partnerId, session.conversationId);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(normalized), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
    return normalized;
  }

  async delete(partnerId: string, conversationId: string) {
    return this.mutate(async () => {
      await rm(this.filePath(partnerId, conversationId), { force: true });
      const indexPath = path.join(this.resolvedDirectory(), 'index.json');
      const index = await readIndex(indexPath);
      delete index.sessions[this.key(partnerId, conversationId)];
      await writeIndex(indexPath, index);
    });
  }

  async deletePartner(partnerId: string) {
    return this.mutate(async () => {
      const directory = this.resolvedDirectory();
      try {
        const indexPath = path.join(directory, 'index.json');
        const index = await readIndex(indexPath);
        const targets = Object.entries(index.sessions).filter(([, value]) => value.partnerId === partnerId);
        for (const [key] of targets) {
          await rm(path.join(directory, `${key}.json`), { force: true });
          delete index.sessions[key];
        }
        await writeIndex(indexPath, index);
      } catch {
        // Missing or corrupt indexes are harmless; individual sessions stay inaccessible without their key.
      }
    });
  }

  async remember(session: ApiAgentSession) {
    const saved = await this.save(session);
    await this.mutate(async () => {
      const directory = this.resolvedDirectory();
      const indexPath = path.join(directory, 'index.json');
      const index = await readIndex(indexPath);
      index.sessions[this.key(session.partnerId, session.conversationId)] = {
        partnerId: session.partnerId,
        conversationId: session.conversationId,
      };
      await writeIndex(indexPath, index);
    });
    return saved;
  }

  async size(partnerId: string, conversationId: string) {
    try {
      return (await stat(this.filePath(partnerId, conversationId))).size;
    } catch {
      return 0;
    }
  }

  private resolvedDirectory() {
    return typeof this.directory === 'function' ? this.directory() : this.directory;
  }

  private key(partnerId: string, conversationId: string) {
    return createHash('sha256').update(`${partnerId}\0${conversationId}`).digest('hex');
  }

  private filePath(partnerId: string, conversationId: string) {
    return path.join(this.resolvedDirectory(), `${this.key(partnerId, conversationId)}.json`);
  }

  private mutate<T>(operation: () => Promise<T>) {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function pruneSession(session: ApiAgentSession, maxTurns: number, maxBytes: number) {
  if (session.turns.length > maxTurns) session.turns = session.turns.slice(-maxTurns);
  if (session.legacyContext && Buffer.byteLength(JSON.stringify(session), 'utf8') > maxBytes) session.legacyContext = undefined;
  while (session.turns.length > 1 && Buffer.byteLength(JSON.stringify(session), 'utf8') > maxBytes) session.turns.shift();
  if (session.turns.length === 1 && Buffer.byteLength(JSON.stringify(session), 'utf8') > maxBytes) session.turns = [];
  return session;
}

function normalizeSession(value: unknown, partnerId: string, conversationId: string): ApiAgentSession | undefined {
  if (!isRecord(value) || value.version !== 1 || value.partnerId !== partnerId || value.conversationId !== conversationId || !Array.isArray(value.turns)) return undefined;
  for (const turn of value.turns) {
    if (isRecord(turn) && Array.isArray(turn.messages) && turn.messages.some(message => isRecord(message) && message.native !== undefined && (!isRecord(message.native) || typeof message.native.binding !== 'string' || !Array.isArray(message.native.items)))) throw new Error('API_PROTOCOL_STATE_INVALID');
  }
  if (value.compaction !== undefined && (!isRecord(value.compaction) || typeof value.compaction.summary !== 'string' || !value.compaction.summary.trim() || value.compaction.summary.length > 8000 || typeof value.compaction.throughClientMessageId !== 'string' || typeof value.compaction.createdAt !== 'string')) throw new Error('API_COMPACTION_RECORD_INVALID');
  const turns = value.turns.filter(isRuntimeTurn).map((turn) => ({
    ...turn,
    ...(turn.attachments ? { attachments: turn.attachments.map(publicAttachment) } : {}),
  }));
  return {
    version: 1,
    partnerId,
    conversationId,
    provider: typeof value.provider === 'string' ? value.provider : 'deepseek',
    ...(typeof value.bindingKey === 'string' ? { bindingKey: value.bindingKey } : {}),
    ...(typeof value.bootstrapSystemPrompt === 'string' ? { bootstrapSystemPrompt: value.bootstrapSystemPrompt } : {}),
    ...(value.bootstrapVersion === 1 ? { bootstrapVersion: 1 } : {}),
    ...(typeof value.legacyContext === 'string' ? { legacyContext: value.legacyContext } : {}),
    ...(isRecord(value.compaction) ? { compaction: value.compaction as unknown as ApiAgentSession['compaction'] } : {}),
    turns,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
  };
}

function isRuntimeTurn(value: unknown): value is ApiRuntimeTurn {
  return isRecord(value)
    && typeof value.clientMessageId === 'string'
    && typeof value.userContent === 'string'
    && typeof value.completedAt === 'string'
    && (value.attachments === undefined || (Array.isArray(value.attachments) && value.attachments.every(isMessageAttachment)))
    && Array.isArray(value.messages)
    && value.messages.every(isRuntimeMessage);
}

function isMessageAttachment(value: unknown): value is MessageAttachment {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
    && typeof value.mediaType === 'string'
    && Number.isSafeInteger(value.sizeBytes) && (value.sizeBytes as number) >= 0;
}

function publicAttachment(attachment: MessageAttachment): MessageAttachment {
  return { id: attachment.id, name: attachment.name, mediaType: attachment.mediaType.toLocaleLowerCase(), sizeBytes: attachment.sizeBytes };
}

function isRuntimeMessage(value: unknown): value is ApiRuntimeMessage {
  if (!isRecord(value)) return false;
  if (value.role === 'user') return typeof value.content === 'string';
  if (value.role === 'tool') return typeof value.toolCallId === 'string' && typeof value.content === 'string';
  return value.role === 'assistant'
    && typeof value.content === 'string'
    && typeof value.reasoningContent === 'string'
    && (value.native === undefined || (isRecord(value.native) && typeof value.native.binding === 'string' && Array.isArray(value.native.items)))
    && (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every((call) => isRecord(call)
      && typeof call.id === 'string' && typeof call.name === 'string' && typeof call.arguments === 'string')));
}

interface SessionIndex {
  version: 1;
  sessions: Record<string, { partnerId: string; conversationId: string }>;
}

async function readIndex(filePath: string): Promise<SessionIndex> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.sessions)) return parsed as unknown as SessionIndex;
  } catch {
    // Create a fresh index below.
  }
  return { version: 1, sessions: {} };
}

async function writeIndex(filePath: string, index: SessionIndex) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(index), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Preserve public dialogue and completed tool facts; discard binding-specific state on a switch. */
export function bindApiSession(session: ApiAgentSession, provider: string, bindingKey?: string): ApiAgentSession {
  const changed = session.provider !== provider || (session.bindingKey !== undefined && session.bindingKey !== bindingKey);
  return { ...session, provider, bindingKey, turns: changed ? session.turns.map(turn => ({ ...turn,
    messages: turn.messages.map(message => message.role === 'assistant' ? { role: 'assistant' as const, content: message.content, reasoningContent: '', ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}) } : { ...message }),
  })) : session.turns };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
