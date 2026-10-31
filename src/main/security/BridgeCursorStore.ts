import { AtomicJsonStore } from '../storage/AtomicJsonStore';

interface CursorFile { version: 1; cursors: Record<string, string> }

export class BridgeCursorStore {
  private readonly storage: AtomicJsonStore<CursorFile>;

  constructor(filePath: string | (() => string)) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 1, cursors: {} }),
      decode: decodeCursorFile,
    });
  }

  async get(key: string) {
    return (await this.storage.read()).cursors[key];
  }

  async set(key: string, cursor: string) {
    if (!cursor) return;
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      data.cursors[key] = cursor;
      await this.writeUnlocked(data);
    });
  }

  async delete(key: string) {
    await this.mutate(async () => {
      const data = await this.readUnlocked();
      if (!(key in data.cursors)) return;
      delete data.cursors[key];
      await this.writeUnlocked(data);
    });
  }

  private readUnlocked() { return this.storage.readNow(); }
  private writeUnlocked(data: CursorFile) { return this.storage.writeNow(data); }
  private mutate<T>(operation: () => Promise<T>) {
    return this.storage.runExclusive(operation);
  }
}

function decodeCursorFile(value: unknown): CursorFile {
  if (!isRecord(value) || value.version !== 1 || !isStringRecord(value.cursors)) throw new Error('BRIDGE_CURSOR_STORE_INVALID');
  return { version: 1, cursors: { ...value.cursors } };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isStringRecord(value: unknown): value is Record<string, string> { return isRecord(value) && Object.values(value).every((item) => typeof item === 'string'); }
