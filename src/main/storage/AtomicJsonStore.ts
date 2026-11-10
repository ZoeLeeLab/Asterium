import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type AtomicJsonStorePath = string | (() => string);

export interface AtomicJsonStoreOptions<T> {
  filePath: AtomicJsonStorePath;
  empty: () => T;
  decode: (value: unknown) => T;
  encode?: (value: T) => string;
  mode?: number;
  flush?: boolean;
}

/**
 * Shared JSON persistence mechanics. Entity stores still own schema validation,
 * version migration and domain-specific errors.
 */
export class AtomicJsonStore<T> {
  private mutation = Promise.resolve();

  constructor(private readonly options: AtomicJsonStoreOptions<T>) {}

  async read() {
    await this.mutation;
    return this.readNow();
  }

  async readNow(): Promise<T> {
    try {
      const value: unknown = JSON.parse(await readFile(this.resolvedPath(), 'utf8'));
      return this.options.decode(value);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return this.options.empty();
      throw error;
    }
  }

  async writeNow(value: T) {
    const target = this.resolvedPath();
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, (this.options.encode ?? JSON.stringify)(value), {
        encoding: 'utf8',
        mode: this.options.mode ?? 0o600,
        flush: this.options.flush,
      });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  runExclusive<R>(operation: () => Promise<R>) {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private resolvedPath() {
    return typeof this.options.filePath === 'function' ? this.options.filePath() : this.options.filePath;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
