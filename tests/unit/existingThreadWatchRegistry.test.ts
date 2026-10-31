import { describe, expect, it, vi } from 'vitest';
import { ExistingThreadWatchRegistry } from '../../src/main/runtime/ExistingThreadWatchRegistry';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ExistingThreadWatchRegistry', () => {
  it('shares one in-flight startup for duplicate watches', async () => {
    const registry = new ExistingThreadWatchRegistry<string>();
    const gate = deferred<string>();
    const start = vi.fn(async () => gate.promise);

    const first = registry.watch('partner-1', 'same', start);
    const second = registry.watch('partner-1', 'same', start);
    await Promise.resolve();

    expect(first).toBe(second);
    expect(start).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);

    gate.resolve('ready');
    await expect(first).resolves.toBe('ready');
    registry.stop('partner-1');
    expect(registry.size).toBe(0);
  });

  it('aborts a watch that is stopped during initialization', async () => {
    const registry = new ExistingThreadWatchRegistry<string>();
    const gate = deferred<string>();
    let signal: AbortSignal | undefined;
    const ready = registry.watch('partner-1', 'same', async (watchSignal) => {
      signal = watchSignal;
      return gate.promise;
    });
    await Promise.resolve();

    registry.stop('partner-1');
    expect(signal?.aborted).toBe(true);
    expect(registry.size).toBe(0);

    gate.resolve('late');
    await expect(ready).rejects.toThrow('EXISTING_THREAD_WATCH_ABORTED');
    expect(registry.size).toBe(0);
  });

  it('replaces a changed signature without allowing the old watch to remove the new one', async () => {
    const registry = new ExistingThreadWatchRegistry<string>();
    const firstGate = deferred<string>();
    let firstSignal: AbortSignal | undefined;
    const first = registry.watch('partner-1', 'old', async (watchSignal) => {
      firstSignal = watchSignal;
      return firstGate.promise;
    });
    await Promise.resolve();

    const second = registry.watch('partner-1', 'new', async () => 'new-ready');
    expect(firstSignal?.aborted).toBe(true);
    await expect(second).resolves.toBe('new-ready');
    expect(registry.size).toBe(1);

    firstGate.resolve('old-ready');
    await expect(first).rejects.toThrow('EXISTING_THREAD_WATCH_ABORTED');
    expect(registry.size).toBe(1);
  });
});
