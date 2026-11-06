import { z } from 'zod';
import { cyberBossChatFileSchema } from '../../shared/cyberBossChatAttachments';

const chatFilesSchema = z.array(cyberBossChatFileSchema).max(10);

export interface CyberBossChatEvent {
  event: 'chat';
  id: string;
  role: 'user' | 'assistant' | 'status' | 'error';
  text: string;
  status: string;
  clientMessageId: string;
  createdAt: string;
  media: unknown[];
  attachments?: z.infer<typeof chatFilesSchema>;
}

export interface CyberBossThreadChangedEvent {
  event: 'thread_changed';
  id: string;
  threadId: string;
  previousThreadId?: string;
  workspaceRoot: string;
  reason: string;
}

export type CyberBossSseEvent = CyberBossChatEvent | CyberBossThreadChangedEvent;

export class CyberBossSseParser {
  private buffer = '';

  push(chunk: string) {
    if (!chunk) return [];
    this.buffer += chunk;
    const events: CyberBossSseEvent[] = [];
    for (;;) {
      const boundary = this.buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) break;
      const separator = this.buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + separator.length);
      const parsed = parseBlock(block);
      if (parsed) events.push(parsed);
    }
    return events;
  }

  finish() {
    const block = this.buffer.trim();
    this.buffer = '';
    const parsed = block ? parseBlock(block) : undefined;
    return parsed ? [parsed] : [];
  }
}

function parseBlock(block: string): CyberBossSseEvent | undefined {
  let id = '';
  let eventName = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    if (field === 'event') eventName = value;
    if (field === 'data') data.push(value);
  }
  if (!['chat', 'thread_changed'].includes(eventName) || !id || !data.length) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data.join('\n'));
  } catch {
    throw new Error('CYBERBOSS_MALFORMED_SSE');
  }
  if (!isRecord(value)) throw new Error('CYBERBOSS_MALFORMED_SSE');
  if (eventName === 'thread_changed') {
    if (typeof value.threadId !== 'string' || !value.threadId || typeof value.workspaceRoot !== 'string' || !value.workspaceRoot) throw new Error('CYBERBOSS_MALFORMED_SSE');
    return {
      event: 'thread_changed',
      id,
      threadId: value.threadId,
      ...(typeof value.previousThreadId === 'string' && value.previousThreadId ? { previousThreadId: value.previousThreadId } : {}),
      workspaceRoot: value.workspaceRoot,
      reason: typeof value.reason === 'string' ? value.reason : '',
    };
  }
  if (!['user', 'assistant', 'status', 'error'].includes(String(value.role))) throw new Error('CYBERBOSS_MALFORMED_SSE');
  const attachments = chatFilesSchema.safeParse(value.attachments);
  return {
    event: 'chat',
    id,
    role: value.role as CyberBossChatEvent['role'],
    text: typeof value.text === 'string' ? value.text : '',
    status: typeof value.status === 'string' ? value.status : '',
    clientMessageId: typeof value.clientMessageId === 'string' ? value.clientMessageId : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    media: Array.isArray(value.media) ? value.media : [],
    ...(attachments.success ? { attachments: attachments.data } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
