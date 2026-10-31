export type ExistingThreadWatchStarter<T> = (signal: AbortSignal) => Promise<T>;

interface ExistingThreadWatch<T> {
  signature: string;
  controller: AbortController;
  ready: Promise<T>;
}

export class ExistingThreadWatchRegistry<T> {
  private readonly watches = new Map<string, ExistingThreadWatch<T>>();

  watch(partnerId: string, signature: string, start: ExistingThreadWatchStarter<T>) {
    const current = this.watches.get(partnerId);
    if (current?.signature === signature) return current.ready;

    current?.controller.abort();
    const controller = new AbortController();
    const ready = Promise.resolve()
      .then(() => start(controller.signal))
      .then((value) => {
        if (controller.signal.aborted) throw new Error('EXISTING_THREAD_WATCH_ABORTED');
        return value;
      })
      .catch((error) => {
        this.release(partnerId, controller.signal);
        controller.abort();
        throw error;
      });

    this.watches.set(partnerId, { signature, controller, ready });
    return ready;
  }

  stop(partnerId: string) {
    const current = this.watches.get(partnerId);
    current?.controller.abort();
    this.watches.delete(partnerId);
  }

  release(partnerId: string, signal: AbortSignal) {
    const current = this.watches.get(partnerId);
    if (current?.controller.signal === signal) this.watches.delete(partnerId);
  }

  clear() {
    for (const watch of this.watches.values()) watch.controller.abort();
    this.watches.clear();
  }

  get size() {
    return this.watches.size;
  }
}
