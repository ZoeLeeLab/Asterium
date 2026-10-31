import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AtomicJsonStore } from '../storage/AtomicJsonStore';
import { SqliteMemoryArchiveStore } from './SqliteMemoryArchiveStore';
import { MemoryFallbackJobStore, type FallbackInput } from './fallback/MemoryFallbackJobStore';

const fileSchema = z.object({ scope: z.enum(['profiles', 'userData']), relative: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const manifestSchema = z.object({ version: z.literal(1), id: z.string().uuid(), createdAt: z.string().datetime(),
  state: z.enum(['prepared', 'backed_up', 'databases_ready', 'baselined', 'complete', 'rolled_back']),
  partners: z.array(z.object({ directory: z.string(), partnerId: z.string() })), files: z.array(fileSchema),
  baseline: z.array(z.object({ partnerId: z.string(), kind: z.enum(['single_chat', 'studio']), conversationId: z.string(), busy: z.boolean(),
    messages: z.array(z.object({ messageId: z.string(), content: z.string(), authorId: z.string(), authorType: z.enum(['user', 'partner']), occurredAt: z.string().optional(), hash: z.string() })) })),
});
export type MemoryCutoverManifest = z.infer<typeof manifestSchema>;
export { MemoryFallbackJobStore };
type ArchivedFile = z.infer<typeof fileSchema>;
const knownArchiveFiles = new Set(['briefing-cache.v1.json', 'fallback-provenance.v1.json', 'fallback-transaction.v1.json', 'migration.json']);

/** No import, dual write or automatic rollback. All removed bytes have verified backups. */
export class SqliteMemoryCutover {
  private readonly manifest: AtomicJsonStore<MemoryCutoverManifest | undefined>;
  private pending?: Promise<MemoryCutoverManifest>;
  readonly manifestPath: string;
  constructor(private readonly profileRoot: string, private readonly userDataRoot: string,
    private readonly jobs: MemoryFallbackJobStore,
    private readonly capture: () => Promise<FallbackInput[]>,
    private readonly afterStep?: (state: MemoryCutoverManifest['state']) => void) {
    this.manifestPath = path.join(profileRoot, 'memory-sqlite-cutover.v1.json');
    this.manifest = new AtomicJsonStore({ filePath: this.manifestPath, empty: () => undefined, decode: (value) => manifestSchema.parse(value) });
  }
  run() {
    if (!this.pending) this.pending = this.runNow().catch((error) => { this.pending = undefined; throw error; });
    return this.pending;
  }
  async status() { return this.manifest.read(); }
  backupDirectory(manifest: MemoryCutoverManifest) { return within(this.profileRoot, `memory-cutover-backups/${manifest.id}`); }
  private async runNow() {
    await assertDirectory(this.profileRoot, true);
    await assertSafeAncestors(this.manifestPath);
    if (await exists(this.manifestPath)) await assertFile(this.manifestPath);
    let manifest = await this.manifest.read();
    if (manifest?.state === 'rolled_back') throw new Error('MEMORY_CUTOVER_ROLLED_BACK_USE_PREVIOUS_VERSION');
    if (manifest?.state === 'complete') return manifest;
    if (!manifest) {
      manifest = await this.prepare(); await this.save(manifest, 'prepared');
    }
    this.validatePaths(manifest);
    if (manifest.state === 'prepared') {
      for (const file of manifest.files) {
        const target = this.backupFile(manifest, file); await mkdir(path.dirname(target), { recursive: true });
        await assertSafeAncestors(target);
        if (!await exists(target)) {
          await this.verify(this.sourceFile(file), file); await this.copyVerified(this.sourceFile(file), target, file);
        }
        await this.verify(target, file);
      }
      await this.save(manifest, 'backed_up');
    }
    for (const file of manifest.files) await this.verify(this.backupFile(manifest, file), file);
    if (manifest.state === 'backed_up') {
      for (const partner of manifest.partners) {
        const database = this.databaseFile(partner);
        if (!await exists(database)) {
          const temporary = path.join(this.backupDirectory(manifest), `empty-${randomUUID()}.sqlite`);
          await new SqliteMemoryArchiveStore(temporary, partner.partnerId).snapshot();
          await mkdir(path.dirname(database), { recursive: true }); await assertSafeAncestors(database);
          await rename(temporary, database);
        }
        const snapshot = await new SqliteMemoryArchiveStore(database, partner.partnerId).snapshot({ includeDeleted: true });
        if (snapshot.records.length) throw new Error('MEMORY_CUTOVER_DATABASE_NOT_EMPTY');
      }
      await this.save(manifest, 'databases_ready');
    }
    if (manifest.state === 'databases_ready') {
      await this.jobs.establishSqliteBaseline(manifest.id, manifest.baseline);
      await this.save(manifest, 'baselined');
    }
    if (manifest.state === 'baselined') {
      for (const file of manifest.files.filter((item) => item.scope === 'profiles')) {
        const source = this.sourceFile(file);
        if (await exists(source)) { await this.verify(source, file); await unlink(source); }
      }
      await this.save(manifest, 'complete');
    }
    return manifest;
  }
  /** Operator-only: the caller must have stopped Asterium and confirmed loss of post-cutover memory in the old version. */
  async rollback(confirmStopped: boolean) {
    if (!confirmStopped) throw new Error('MEMORY_ROLLBACK_REQUIRES_STOPPED_APP');
    const manifest = await this.manifest.read();
    if (!manifest || !['complete', 'rolled_back'].includes(manifest.state)) throw new Error('MEMORY_ROLLBACK_NOT_READY');
    this.validatePaths(manifest);
    if (manifest.state === 'rolled_back') return manifest;
    for (const file of manifest.files) await this.verify(this.backupFile(manifest, file), file);
    const currentDirectories = new Map<string, string>();
    const currentRoot = path.join(this.profileRoot, 'partners');
    for (const entry of await readdir(currentRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const metadataPath = path.join(currentRoot, entry.name, 'partner.json');
      if (!await exists(metadataPath)) continue;
      await assertFile(metadataPath);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { partnerId?: string };
      if (metadata.partnerId && manifest.partners.some((partner) => partner.partnerId === metadata.partnerId)) {
        if (currentDirectories.has(metadata.partnerId)) throw new Error('MEMORY_CUTOVER_PARTNER_DUPLICATE');
        currentDirectories.set(metadata.partnerId, entry.name);
      }
    }
    for (const partner of manifest.partners) if (!currentDirectories.has(partner.partnerId)) throw new Error('MEMORY_ROLLBACK_PARTNER_MISSING_RESTORE_PROFILE_FIRST');
    const snapshotRoot = path.join(this.backupDirectory(manifest), 'rollback-sqlite'); await mkdir(snapshotRoot, { recursive: true });
    await assertSafeAncestors(path.join(snapshotRoot, 'probe'));
    for (const partner of manifest.partners) {
      const database = this.databaseFile({ ...partner, directory: currentDirectories.get(partner.partnerId)! });
      if (await exists(`${database}-journal`) || await exists(`${database}-wal`)) throw new Error('MEMORY_ROLLBACK_DATABASE_NOT_CLOSED');
      const snapshot = within(snapshotRoot, `${partner.partnerId}.sqlite`);
      if (await exists(database) && !await exists(snapshot)) await this.copyVerified(database, snapshot, await fingerprint(database, 'profiles', 'snapshot'));
    }
    const jobsFile = path.join(this.userDataRoot, 'memory-fallback-jobs.v1.json');
    const jobsSnapshot = path.join(snapshotRoot, 'memory-fallback-jobs.v1.json');
    if (await exists(jobsFile) && !await exists(jobsSnapshot)) await this.copyVerified(jobsFile, jobsSnapshot, await fingerprint(jobsFile, 'userData', 'snapshot'));
    for (const file of manifest.files) {
      let target = this.sourceFile(file);
      if (file.scope === 'profiles') {
        const partner = manifest.partners.find((item) => file.relative.startsWith(`partners/${item.directory}/private-memory/`))!;
        target = within(this.profileRoot, file.relative.replace(`partners/${partner.directory}/`, `partners/${currentDirectories.get(partner.partnerId)!}/`));
      }
      await mkdir(path.dirname(target), { recursive: true }); await assertSafeAncestors(target);
      if (file.scope === 'profiles' && await exists(target)) await this.verify(target, file);
      await this.copyVerified(this.backupFile(manifest, file), target, file);
    }
    if (!manifest.files.some((file) => file.scope === 'userData') && await exists(jobsFile)) await unlink(jobsFile);
    await this.save(manifest, 'rolled_back'); this.pending = undefined; return manifest;
  }
  private async prepare(): Promise<MemoryCutoverManifest> {
    const partners: MemoryCutoverManifest['partners'] = []; const files: ArchivedFile[] = [];
    const root = path.join(this.profileRoot, 'partners');
    if (await exists(root)) {
      await assertDirectory(root);
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('MEMORY_CUTOVER_PATH_INVALID');
        if (!entry.isDirectory()) continue;
        const metadataPath = within(root, `${entry.name}/partner.json`);
        if (!await exists(metadataPath)) continue;
        await assertFile(metadataPath);
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { partnerId?: string; sourceMode?: string; management?: { memoryMode?: string; privateMemory?: boolean } };
        const managed = metadata.sourceMode === 'api_partner' || (metadata.sourceMode !== 'existing_thread' && (metadata.management?.memoryMode === 'asterium' || (!metadata.management?.memoryMode && metadata.management?.privateMemory === true)));
        if (!managed) continue;
        if (!metadata.partnerId || /[\\/]/u.test(metadata.partnerId) || ['.', '..'].includes(metadata.partnerId)) throw new Error('MEMORY_CUTOVER_PARTNER_INVALID');
        if (partners.some((partner) => partner.partnerId === metadata.partnerId)) throw new Error('MEMORY_CUTOVER_PARTNER_DUPLICATE');
        partners.push({ directory: entry.name, partnerId: metadata.partnerId });
        const memoryRoot = within(root, `${entry.name}/private-memory`);
        if (await exists(memoryRoot)) await this.collect(memoryRoot, `partners/${entry.name}/private-memory`, files);
      }
    }
    const jobs = path.join(this.userDataRoot, 'memory-fallback-jobs.v1.json');
    if (await exists(jobs)) files.push(await fingerprint(jobs, 'userData', 'memory-fallback-jobs.v1.json'));
    return { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), state: 'prepared', partners, files, baseline: await this.capture() };
  }
  private async collect(directory: string, relative: string, files: ArchivedFile[], depth = 0) {
    await assertDirectory(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = within(directory, entry.name); const next = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('MEMORY_CUTOVER_PATH_INVALID');
      if (entry.isDirectory() && ((depth === 0 && entry.name === 'archive-v1') || (depth === 1 && entry.name === 'records'))) await this.collect(file, next, files, depth + 1);
      else if (entry.isFile() && ((depth === 0 && entry.name === 'memory.md') || (depth === 1 && knownArchiveFiles.has(entry.name)) || (depth === 2 && /^[a-f0-9]{64}\.md$/u.test(entry.name)))) files.push(await fingerprint(file, 'profiles', next));
      else if (!(depth === 0 && entry.isFile() && entry.name === 'memory.sqlite')) throw new Error('MEMORY_CUTOVER_UNKNOWN_FILE');
    }
  }
  private validatePaths(manifest: MemoryCutoverManifest) {
    for (const partner of manifest.partners) {
      if (path.basename(partner.directory) !== partner.directory || ['.', '..'].includes(partner.directory) || /[\\/]/u.test(partner.partnerId) || ['.', '..'].includes(partner.partnerId)) throw new Error('MEMORY_CUTOVER_PATH_INVALID');
      within(this.profileRoot, `partners/${partner.directory}/private-memory`);
    }
    for (const file of manifest.files) {
      const valid = file.scope === 'userData' ? file.relative === 'memory-fallback-jobs.v1.json' : manifest.partners.some((partner) => {
        const prefix = `partners/${partner.directory}/private-memory/`;
        if (!file.relative.startsWith(prefix)) return false;
        const tail = file.relative.slice(prefix.length);
        return tail === 'memory.md' || (tail.startsWith('archive-v1/') && knownArchiveFiles.has(tail.slice(11))) || /^archive-v1\/records\/[a-f0-9]{64}\.md$/u.test(tail);
      });
      if (!valid) throw new Error('MEMORY_CUTOVER_PATH_INVALID');
      this.sourceFile(file);
    }
  }
  private sourceFile(file: ArchivedFile) { return within(file.scope === 'profiles' ? this.profileRoot : this.userDataRoot, file.relative); }
  private backupFile(manifest: MemoryCutoverManifest, file: ArchivedFile) { return within(this.backupDirectory(manifest), `${file.scope}/${file.relative}`); }
  private databaseFile(partner: MemoryCutoverManifest['partners'][number]) { return within(this.profileRoot, `partners/${partner.directory}/private-memory/memory.sqlite`); }
  private async verify(file: string, expected: ArchivedFile) {
    await assertSafeAncestors(file);
    const actual = await fingerprint(file, expected.scope, expected.relative);
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) throw new Error('MEMORY_CUTOVER_CHECKSUM_MISMATCH');
  }
  private async copyVerified(source: string, target: string, expected: ArchivedFile) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await copyFile(source, temporary); await this.verify(temporary, expected); await rename(temporary, target); }
    finally { if (await exists(temporary)) await unlink(temporary); }
  }
  private async save(manifest: MemoryCutoverManifest, state: MemoryCutoverManifest['state']) { manifest.state = state; await this.manifest.writeNow(manifest); this.afterStep?.(state); }
}
function within(root: string, relative: string) {
  const target = path.resolve(root, relative); const rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('MEMORY_CUTOVER_PATH_INVALID');
  return target;
}
async function exists(file: string) { try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function assertFile(file: string) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('MEMORY_CUTOVER_PATH_INVALID'); }
async function assertDirectory(directory: string, create = false) { if (create) await mkdir(directory, { recursive: true }); const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('MEMORY_CUTOVER_PATH_INVALID'); }
async function assertSafeAncestors(file: string) { let directory = path.dirname(file); while (path.dirname(directory) !== directory) { await assertDirectory(directory); directory = path.dirname(directory); } }
async function fingerprint(file: string, scope: ArchivedFile['scope'], relative: string): Promise<ArchivedFile> { await assertFile(file); const bytes = await readFile(file); return { scope, relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
