import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AtomicJsonStore } from '../../src/main/storage/AtomicJsonStore';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-atomic-json-'));
  temporaryDirectories.push(root);
  const file = path.join(root, 'nested', 'state.json');
  const store = new AtomicJsonStore<{ version: 1; values: string[] }>({
    filePath: file,
    empty: () => ({ version: 1, values: [] }),
    decode: (value) => {
      if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.values) || !value.values.every((item) => typeof item === 'string')) {
        throw new Error('TEST_STORE_INVALID');
      }
      return { version: 1, values: [...value.values] };
    },
    encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
  });
  return { root, file, store };
}

describe('AtomicJsonStore', () => {
  it('uses the store-owned empty value only when the file is absent', async () => {
    const { file, store } = await fixture();
    await expect(store.read()).resolves.toEqual({ version: 1, values: [] });
    await store.writeNow({ version: 1, values: [] });
    await writeFile(file, '{broken', 'utf8');
    await expect(store.read()).rejects.toBeInstanceOf(SyntaxError);
    await writeFile(file, JSON.stringify({ version: 2, values: [] }), 'utf8');
    await expect(store.read()).rejects.toThrow('TEST_STORE_INVALID');
  });

  it('serializes mutations and makes queued reads wait for them', async () => {
    const { store } = await fixture();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const order: string[] = [];
    const first = store.runExclusive(async () => {
      const data = await store.readNow();
      order.push('first-start');
      markFirstStarted();
      await firstGate;
      data.values.push('first');
      await store.writeNow(data);
      order.push('first-end');
    });
    const second = store.runExclusive(async () => {
      order.push('second-start');
      const data = await store.readNow();
      data.values.push('second');
      await store.writeNow(data);
    });
    const waitingRead = store.read();
    await firstStarted;
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    await expect(waitingRead).resolves.toEqual({ version: 1, values: ['first', 'second'] });
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('continues the mutation queue after an operation fails', async () => {
    const { store } = await fixture();
    const failed = store.runExclusive(async () => {
      throw new Error('EXPECTED_FAILURE');
    });
    const recovered = store.runExclusive(async () => {
      await store.writeNow({ version: 1, values: ['recovered'] });
      return 'done';
    });

    await expect(failed).rejects.toThrow('EXPECTED_FAILURE');
    await expect(recovered).resolves.toBe('done');
    await expect(store.read()).resolves.toEqual({ version: 1, values: ['recovered'] });
  });

  it('resolves a path function for each read and write', async () => {
    const { root } = await fixture();
    let file = path.join(root, 'first.json');
    const store = new AtomicJsonStore<{ version: 1; values: string[] }>({
      filePath: () => file,
      empty: () => ({ version: 1, values: [] }),
      decode: (value) => value as { version: 1; values: string[] },
    });

    await store.writeNow({ version: 1, values: ['first'] });
    file = path.join(root, 'second.json');
    await expect(store.read()).resolves.toEqual({ version: 1, values: [] });
    await store.writeNow({ version: 1, values: ['second'] });
    await expect(readFile(path.join(root, 'first.json'), 'utf8')).resolves.toBe('{"version":1,"values":["first"]}');
    await expect(readFile(path.join(root, 'second.json'), 'utf8')).resolves.toBe('{"version":1,"values":["second"]}');
  });

  it('creates parent folders, atomically replaces JSON and removes temporary files', async () => {
    const { root, file, store } = await fixture();
    await store.writeNow({ version: 1, values: ['saved'] });
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify({ version: 1, values: ['saved'] }, null, 2)}\n`);
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(path.dirname(file)).toBe(path.join(root, 'nested'));
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
