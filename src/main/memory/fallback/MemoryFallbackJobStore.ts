import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../../storage/AtomicJsonStore';

const messageSchema = z.object({ messageId: z.string(), content: z.string(), authorId: z.string(), authorType: z.enum(['user', 'partner']), occurredAt: z.string().optional(), hash: z.string() });
const jobSchema = z.object({ key: z.string(), partnerId: z.string(), kind: z.enum(['single_chat', 'studio']), conversationId: z.string(),
  messages: z.array(messageSchema), processed: z.record(z.string(), z.string()), dirty: z.boolean(), busy: z.boolean(), lastMessageAt: z.string(),
  lastSuccessAt: z.string().optional(), enabledAt: z.string().optional(),
  round: z.object({ id: z.string(), attempts: z.number().int().min(0).max(3), nextAttemptAt: z.string(), blockedUntil: z.string(), operationId: z.string().optional() }).optional(),
});
const schema = z.object({ version: z.literal(1), jobs: z.record(z.string(), jobSchema), sqliteBaseline: z.string().optional() });
export type FallbackMessage = z.infer<typeof messageSchema>;
export type FallbackJob = z.infer<typeof jobSchema>;
export type FallbackInput = Pick<FallbackJob, 'partnerId' | 'kind' | 'conversationId' | 'messages' | 'busy'>;
export function fallbackHash(content: string) { return createHash('sha256').update(content).digest('hex'); }
export function fallbackJobKey(input: Pick<FallbackInput, 'partnerId' | 'kind' | 'conversationId'>) { return JSON.stringify([input.partnerId, input.kind, input.conversationId]); }
export class MemoryFallbackJobStore {
  private readonly storage: AtomicJsonStore<z.infer<typeof schema>>;
  constructor(filePath: AtomicJsonStorePath, private readonly now = () => new Date().toISOString()) {
    this.storage = new AtomicJsonStore({ filePath, empty: () => ({ version: 1, jobs: {} }), decode: (value) => schema.parse(value) });
  }
  async list() { return Object.values((await this.storage.read()).jobs); }
  async get(key: string) { return (await this.storage.read()).jobs[key]; }
  /** Apply exactly the captured revisions once, never consume messages arriving after the snapshot. */
  async establishSqliteBaseline(cutoverId: string, inputs: FallbackInput[]) {
    await this.storage.runExclusive(async () => {
      const data = await this.storage.readNow();
      if (data.sqliteBaseline === cutoverId) return;
      for (const input of inputs) {
        const key = fallbackJobKey(input);
        const job = data.jobs[key] ?? { ...input, key, processed: {}, dirty: false, lastMessageAt: input.messages.map((message) => message.occurredAt).filter((time): time is string => Boolean(time)).sort().at(-1) ?? this.now() };
        for (const message of input.messages) job.processed[message.messageId] = message.hash;
        delete job.round;
        job.dirty = job.messages.some((message) => job.processed[message.messageId] !== message.hash);
        data.jobs[key] = job;
      }
      // Old execution rounds have no matching receipts in the new empty archives.
      for (const job of Object.values(data.jobs)) delete job.round;
      data.sqliteBaseline = cutoverId;
      await this.storage.writeNow(data);
    });
  }
  async sync(inputs: FallbackInput[]) {
    await this.storage.runExclusive(async () => {
      const data = await this.storage.readNow();
      const next: typeof data.jobs = {};
      for (const input of inputs) {
        const key = fallbackJobKey(input);
        const old = data.jobs[key];
        const revisions = Object.fromEntries(input.messages.map((message) => [message.messageId, message.hash]));
        const changed = !old || JSON.stringify(old.messages.map((message) => [message.messageId, message.hash])) !== JSON.stringify(input.messages.map((message) => [message.messageId, message.hash]));
        const processed = Object.fromEntries(Object.entries(old?.processed ?? {}).filter(([id]) => id in revisions));
        next[key] = { ...old, ...input, key, processed,
          // Observe a revision change at its real arrival time, never assign a fake historical message date.
          lastMessageAt: changed ? (old ? this.now() : input.messages.map((message) => message.occurredAt).filter((time): time is string => Boolean(time)).sort().at(-1) ?? this.now()) : old.lastMessageAt,
          dirty: input.messages.some((message) => processed[message.messageId] !== message.hash),
        };
      }
      if (JSON.stringify(data.jobs) !== JSON.stringify(next)) await this.storage.writeNow({ ...data, jobs: next });
    });
  }
  async applyEnablement(partnerId: string, enabledAt: string, history: 'from_now' | 'unprocessed') {
    await this.storage.runExclusive(async () => {
      const data = await this.storage.readNow();
      let changed = false;
      for (const job of Object.values(data.jobs)) {
        if (job.partnerId !== partnerId || job.enabledAt === enabledAt) continue;
        job.enabledAt = enabledAt;
        changed = true;
        if (history === 'from_now') {
          for (const message of job.messages) if (!message.occurredAt || message.occurredAt <= enabledAt) job.processed[message.messageId] = message.hash;
        }
        job.dirty = job.messages.some((message) => job.processed[message.messageId] !== message.hash);
      }
      if (changed) await this.storage.writeNow(data);
    });
  }
  async change(key: string, mutate: (job: FallbackJob) => void) {
    return this.storage.runExclusive(async () => {
      const data = await this.storage.readNow();
      const job = data.jobs[key];
      if (!job) return undefined;
      mutate(job);
      schema.parse(data);
      await this.storage.writeNow(data);
      return structuredClone(job);
    });
  }
  async complete(key: string, messages: Pick<FallbackMessage, 'messageId' | 'hash'>[]) {
    return this.change(key, (job) => {
      for (const message of messages) job.processed[message.messageId] = message.hash;
      job.dirty = job.messages.some((message) => job.processed[message.messageId] !== message.hash);
      job.lastSuccessAt = this.now();
      delete job.round;
    });
  }
}
