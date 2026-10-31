import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { diaryDate, type PartnerDiaryDocument, type PartnerDiaryEntry } from '../../shared/partnerDiary';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';

const entrySchema = z.object({ partnerId: z.string().min(1), date: diaryDate, generationId: z.string().min(1), conversationId: z.string().min(1),
  state: z.enum(['running', 'completed', 'skipped', 'failed']), attemptedAt: z.string().datetime(), finishedAt: z.string().datetime().optional(), reason: z.string().optional(), contentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() });
const schema = z.object({ version: z.literal(1), entries: z.record(z.string(), entrySchema) });
export class PartnerDiaryStore {
  private readonly storage: AtomicJsonStore<z.infer<typeof schema>>;
  constructor(private readonly directory: string, private readonly partnerId: string, private readonly now = () => new Date().toISOString()) {
    this.storage = new AtomicJsonStore({ filePath: path.join(directory, 'entries.v1.json'), empty: () => ({ version: 1, entries: {} }), decode: (value) => {
      const data = schema.parse(value);
      if (Object.entries(data.entries).some(([date, entry]) => date !== entry.date || entry.partnerId !== partnerId)) throw new Error('DIARY_INDEX_INVALID');
      return data;
    } });
  }
  async list(): Promise<PartnerDiaryEntry[]> { return Object.values((await this.storage.read()).entries).sort((a, b) => b.date.localeCompare(a.date)); }
  async read(date: string): Promise<PartnerDiaryDocument | undefined> {
    diaryDate.parse(date); const entry = (await this.storage.read()).entries[date]; if (!entry) return undefined;
    if (entry.state !== 'completed') return { entry };
    const content = await readFile(this.file(date), 'utf8');
    if (diaryHash(content) !== entry.contentHash) throw new Error('DIARY_CONTENT_CHANGED');
    return { entry, content };
  }
  async claim(date: string, conversationId: string) {
    diaryDate.parse(date);
    return this.storage.runExclusive(async () => {
      const data = await this.storage.readNow(); if (data.entries[date]) return undefined;
      const existing = await readFile(this.file(date), 'utf8').then(() => true).catch((error: unknown) => { if (isMissing(error)) return false; throw error; });
      const entry: PartnerDiaryEntry = { partnerId: this.partnerId, date, conversationId, generationId: randomUUID(), state: existing ? 'skipped' : 'running', attemptedAt: this.now(), ...(existing ? { reason: 'file_exists', finishedAt: this.now() } : {}) };
      data.entries[date] = entry; await this.storage.writeNow(data); return existing ? undefined : entry;
    });
  }
  async finish(date: string, generationId: string, result: { state: 'skipped' | 'failed'; reason: string } | { state: 'completed'; content: string }) {
    diaryDate.parse(date);
    return this.storage.runExclusive(async () => {
      const data = await this.storage.readNow(); const entry = data.entries[date];
      if (!entry || entry.generationId !== generationId || entry.state !== 'running') throw new Error('DIARY_GENERATION_CONFLICT');
      if (result.state === 'completed') {
        if (!result.content.trim() || result.content.length > 100_000) throw new Error('DIARY_CONTENT_INVALID');
        entry.contentHash = diaryHash(result.content);
        await this.storage.writeNow(data); // Recovery knows the exact expected bytes before publishing the MD.
        await mkdir(this.directory, { recursive: true }); const temporary = path.join(this.directory, `${date}.${randomUUID()}.tmp`);
        try { await writeFile(temporary, result.content, { encoding: 'utf8', mode: 0o600 }); await link(temporary, this.file(date)); }
        finally { await rm(temporary, { force: true }).catch(() => undefined); }
      } else entry.reason = result.reason;
      entry.state = result.state; entry.finishedAt = this.now(); await this.storage.writeNow(data); return entry;
    });
  }
  /** Startup-only recovery never sends a request or repeats a daily claim. */
  async recover() {
    await this.storage.runExclusive(async () => {
      const data = await this.storage.readNow(); let changed = false;
      for (const entry of Object.values(data.entries)) if (entry.state === 'running') {
        const content = await readFile(this.file(entry.date), 'utf8').catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
        entry.state = content !== undefined && entry.contentHash === diaryHash(content) ? 'completed' : 'failed';
        if (entry.state === 'failed') entry.reason = 'interrupted'; entry.finishedAt = this.now(); changed = true;
      }
      if (changed) await this.storage.writeNow(data);
    });
  }
  private file(date: string) { diaryDate.parse(date); return path.join(this.directory, `${date}.md`); }
}
export function diaryHash(content: string) { return createHash('sha256').update(content).digest('hex'); }
function isMissing(error: unknown) { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
