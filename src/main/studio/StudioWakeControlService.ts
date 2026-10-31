import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExistingThreadConnection } from '../../shared/agentProtocol';
import type { StudioWakeControlReply } from '../../shared/studioWakeAdapter';
import type { StudioWakeAction, StudioWakeBinding, StudioWakeEntry, StudioWakeStatus } from '../../shared/studioWakeControl';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';
import { CyberBossBridgeClient } from '../adapters/CyberBossBridgeClient';

const bindingSchema = z.object({ partnerId: z.string().min(1).max(200), connectionBindingId: z.string().trim().min(1).max(200), connectOnLaunch: z.boolean() }).strict();
const schema = z.object({ version: z.literal(1), bindings: z.array(bindingSchema) }).strict();
type LocalState = { state: StudioWakeEntry['state']; remote?: StudioWakeControlReply; error?: string };
interface Options {
  connection(partnerId: string): ExistingThreadConnection | undefined;
  ready(partnerId: string): Promise<boolean>;
  secret(ref: string): Promise<string | undefined>;
  client?: (connection: ExistingThreadConnection, secret: string) => Pick<CyberBossBridgeClient, 'wakeControl'>;
}

/** One startup intent per configured partner, gated on readiness. No retry timer or watch hook. */
export class StudioWakeControlService {
  private readonly storage: AtomicJsonStore<z.infer<typeof schema>>;
  private readonly attempted = new Set<string>();
  private readonly states = new Map<string, LocalState>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly clients = new Map<string, { fingerprint: string; client: Pick<CyberBossBridgeClient, 'wakeControl'> }>();
  private readonly closed = new AbortController();
  private changes = Promise.resolve();
  constructor(file: AtomicJsonStorePath, private readonly options: Options) {
    this.storage = new AtomicJsonStore({ filePath: file, empty: () => ({ version: 1, bindings: [] }), decode(value) {
      const result = schema.safeParse(value);
      if (!result.success || new Set(result.data.bindings.map((item) => item.partnerId)).size !== result.data.bindings.length) throw new Error('STUDIO_WAKE_SETTINGS_INVALID');
      return result.data;
    } });
  }
  async status(): Promise<StudioWakeStatus> {
    const settings = await this.storage.read();
    return { entries: await Promise.all(settings.bindings.map(async (binding) => {
      const ready = Boolean(this.options.connection(binding.partnerId)) && await this.options.ready(binding.partnerId);
      return { ...binding, ready, ...(this.states.get(binding.partnerId) ?? { state: 'waiting' as const }) };
    })) };
  }
  async configure(input: StudioWakeBinding) {
    const result = bindingSchema.safeParse(input);
    if (!result.success || !this.options.connection(result.data.partnerId)) throw new Error('STUDIO_WAKE_SETTINGS_INVALID');
    if (this.inFlight.has(input.partnerId)) throw new Error('STUDIO_WAKE_CONTROL_BUSY');
    await this.storage.runExclusive(async () => {
      const state = await this.storage.readNow();
      state.bindings = state.bindings.filter((item) => item.partnerId !== input.partnerId); state.bindings.push(result.data); await this.storage.writeNow(state);
    });
    this.states.delete(input.partnerId);
    void this.changed().catch(() => undefined);
    return this.status();
  }
  changed() {
    const next = this.changes.then(async () => {
      if (this.closed.signal.aborted) return;
      const { bindings } = await this.storage.read();
      for (const binding of bindings) {
        if (!binding.connectOnLaunch || this.attempted.has(binding.partnerId) || !this.options.connection(binding.partnerId) || !await this.options.ready(binding.partnerId)) continue;
        this.attempted.add(binding.partnerId); // Mark BEFORE the request; failures are never retried this launch.
        await this.send(binding, 'connect_once');
      }
    });
    this.changes = next.catch(() => undefined); return next;
  }
  async control(partnerId: string, action: StudioWakeAction, triggerId?: string) {
    if (!['connect_once', 'status', 'retry', 'ignore', 'resume'].includes(action) || (['retry', 'ignore'].includes(action) !== Boolean(triggerId))
      || (triggerId && !z.uuid().safeParse(triggerId).success)) throw new Error('STUDIO_WAKE_CONTROL_INVALID');
    const binding = (await this.storage.read()).bindings.find((item) => item.partnerId === partnerId);
    if (!binding) throw new Error('STUDIO_WAKE_SETTINGS_REQUIRED');
    if (!['status', 'ignore'].includes(action) && !await this.options.ready(partnerId)) throw new Error('STUDIO_WAKE_MCP_NOT_READY');
    if (action === 'connect_once') this.attempted.add(partnerId);
    await this.send(binding, action, triggerId); return this.status();
  }
  async dispose() { this.closed.abort(); await Promise.allSettled([...this.inFlight.values()]); }

  private send(binding: StudioWakeBinding, action: StudioWakeAction, triggerId?: string) {
    const running = this.inFlight.get(binding.partnerId); if (running) return running;
    const next = this.execute(binding, action, triggerId).finally(() => { this.inFlight.delete(binding.partnerId); });
    this.inFlight.set(binding.partnerId, next); return next;
  }
  private async execute(binding: StudioWakeBinding, action: StudioWakeAction, triggerId?: string) {
    this.states.set(binding.partnerId, { ...this.states.get(binding.partnerId), state: 'requesting' });
    try {
      this.closed.signal.throwIfAborted();
      const connection = this.options.connection(binding.partnerId);
      if (!connection) throw new Error('STUDIO_WAKE_PARTNER_UNAVAILABLE');
      const secret = await this.options.secret(connection.credentialRef);
      this.closed.signal.throwIfAborted(); if (!secret) throw new Error('STUDIO_WAKE_PARTNER_UNAVAILABLE');
      const fingerprint = JSON.stringify([connection.serviceUrl, connection.credentialRef, createHash('sha256').update(secret).digest('hex')]);
      let cached = this.clients.get(binding.partnerId);
      if (!cached || cached.fingerprint !== fingerprint) {
        cached = { fingerprint, client: this.options.client?.(connection, secret) ?? new CyberBossBridgeClient({ serviceUrl: connection.serviceUrl, secret }) };
        this.clients.set(binding.partnerId, cached);
      }
      const remote = await cached.client.wakeControl({ protocolVersion: 2, source: 'asterium', action, requestId: randomUUID(),
        connectionBindingId: binding.connectionBindingId, ...(triggerId ? { triggerId } : {}) }, this.closed.signal);
      this.states.set(binding.partnerId, { state: remote.connection.phase, remote });
    } catch (error) {
      const code = error instanceof Error && /^(STUDIO_WAKE|CYBERBOSS)_[A-Z_]+$/.test(error.message) ? error.message : 'STUDIO_WAKE_CONTROL_RESULT_UNKNOWN';
      this.states.set(binding.partnerId, { ...this.states.get(binding.partnerId),
        state: code === 'STUDIO_WAKE_CONTROL_UNSUPPORTED' ? 'unavailable' : code === 'STUDIO_WAKE_PARTNER_UNAVAILABLE' ? 'waiting' : 'unknown', error: code });
    }
  }
}
