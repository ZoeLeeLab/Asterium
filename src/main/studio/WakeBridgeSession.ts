import { studioWakeControlRequestSchema, type StudioWakeControlRequest, type StudioWakeControlReply } from '../../shared/studioWakeAdapter';
import { WakeSingleConnection } from './WakeSingleConnection';
import { WakeDeliveryStore } from './WakeDeliveryStore';
import { WakeDeliveryQueue, type WakeEnqueuePort } from './WakeDeliveryQueue';

/** Server-side reference module; the host supplies its own fixed-thread enqueue function. */
export class WakeBridgeSession {
  private readonly queue: WakeDeliveryQueue;
  private readonly connection: WakeSingleConnection;
  private readonly controls = new Map<string, { fingerprint: string; promise: Promise<StudioWakeControlReply> }>();
  private caughtUp = false;
  private recovered = false;
  private ticker?: ReturnType<typeof setInterval>;
  private starting = false;
  constructor(private readonly bindingId: string, origin: string, token: string, host: WakeEnqueuePort,
    private readonly store: WakeDeliveryStore, fetcher?: typeof fetch) {
    this.queue = new WakeDeliveryQueue(bindingId, host, store);
    this.connection = new WakeSingleConnection(origin, token, async (event) => {
      this.caughtUp = false;
      if (event.type === 'reset') { this.recovered = true; await this.queue.reset(); }
      else if (event.type === 'wake') await this.queue.offer(event.hint, Date.now(), this.recovered);
      else { await store.checkpoint(event.latestEventId); this.caughtUp = event.caughtUp; if (event.caughtUp) this.recovered = false; }
    }, fetcher);
  }
  control(input: StudioWakeControlRequest): Promise<StudioWakeControlReply> {
    if (!studioWakeControlRequestSchema.safeParse(input).success || input.connectionBindingId !== this.bindingId) return Promise.reject(new Error('STUDIO_WAKE_CONTROL_INVALID'));
    if (input.action === 'status') return Promise.resolve(this.status(input.requestId));
    const fingerprint = JSON.stringify([input.action, input.triggerId]);
    const previous = this.controls.get(input.requestId);
    if (previous) return previous.fingerprint === fingerprint ? previous.promise.then(() => this.status(input.requestId, true)) : Promise.reject(new Error('STUDIO_WAKE_CONTROL_CONFLICT'));
    const promise = this.apply(input);
    this.controls.set(input.requestId, { fingerprint, promise });
    if (this.controls.size > 128) this.controls.delete(this.controls.keys().next().value!);
    return promise;
  }
  async tick(now = Date.now()) { if (this.caughtUp && this.connection.status().phase === 'connected') await this.queue.pump(now); }
  async dispose() { clearInterval(this.ticker); await this.connection.stop(); }

  private status(requestId: string, duplicate = false): StudioWakeControlReply {
    const { paused, reviews } = this.queue.status();
    return { protocolVersion: 2, requestId, connectionBindingId: this.bindingId, connection: this.connection.status(), duplicate,
      ...(paused ? { paused } : {}), reviews };
  }
  private async apply(input: StudioWakeControlRequest) {
    if (input.action === 'connect_once') {
      if (this.starting || this.connection.status().phase !== 'stopped') return this.status(input.requestId, true);
      this.starting = true;
      try {
        await this.queue.begin(); this.caughtUp = false; this.recovered = false;
        this.connection.start(input.requestId, await this.store.replayCursor());
        const ticker = setInterval(() => { void this.tick().catch(() => { this.caughtUp = false; }); }, 250);
        this.ticker = ticker; ticker.unref();
        void this.connection.settled().finally(() => { clearInterval(ticker); if (this.ticker === ticker) { this.ticker = undefined; this.caughtUp = false; } });
      } finally { this.starting = false; }
    } else {
      if (input.action !== 'ignore' && (!this.caughtUp || this.connection.status().phase !== 'connected')) throw new Error('STUDIO_WAKE_NOT_CONNECTED');
      if (input.action === 'retry' || input.action === 'ignore') await this.queue.decide(input.triggerId!, input.action, Date.now());
      else if (input.action === 'resume') await this.queue.resume(Date.now());
    }
    return this.status(input.requestId);
  }
}
