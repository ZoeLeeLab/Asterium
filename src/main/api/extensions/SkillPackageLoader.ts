import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { assertCanonicalPathOutsideProtectedRoots } from '../../security/ProtectedPathPolicy';
import { ApiExtensionStore } from '../ApiExtensionStore';
import type { ApiExtensionSummary } from '../../../shared/apiExtensions';

export interface SkillPackage {
  root: string;
  name: string;
  description: string;
  instructions: string;
  digest: string;
  files: Map<string, Buffer>;
}
const MAX_FILE = 1024 * 1024, MAX_TOTAL = 8 * MAX_FILE, MAX_FILES = 256;
const skipped = new Set(['.git', 'node_modules', '__pycache__']);

/** Package reads never execute code. All executable and reference bytes share one fingerprint. */
export class SkillPackageLoader {
  constructor(private readonly store: ApiExtensionStore, private readonly protectedRoots: readonly string[]) {}

  async inspect(entry: ApiExtensionSummary) {
    if (entry.configuration.type !== 'skill') throw new Error('SKILL_CONFIGURATION_INVALID');
    try {
      const loaded = await this.read(entry.configuration.directory);
      const current = await this.store.recordInventory(entry.id, entry.generation, { root: loaded.root, digest: loaded.digest });
      return { entry: current, loaded };
    } catch (error) {
      // Broken/deleted packages must not leave an established fingerprint usable.
      await this.store.invalidateInventory(entry.id, entry.generation, Symbol('skill-invalid')).catch(() => undefined);
      throw error;
    }
  }

  async read(directory: string): Promise<SkillPackage> {
    try {
      const root = await realpath(directory);
      await assertCanonicalPathOutsideProtectedRoots(root, this.protectedRoots);
      const files = new Map<string, Buffer>(); let total = 0, entries = 0;
      const walk = async (folder: string, depth: number): Promise<void> => {
        if (depth > 12) throw new Error('SKILL_PACKAGE_LIMIT');
        const children = await readdir(folder, { withFileTypes: true });
        if (children.length > MAX_FILES) throw new Error('SKILL_PACKAGE_LIMIT');
        for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
          if (++entries > 512) throw new Error('SKILL_PACKAGE_LIMIT');
          if (skipped.has(child.name) || child.name.startsWith('.')) continue;
          const filename = path.join(folder, child.name), info = await lstat(filename);
          if (info.isSymbolicLink()) throw new Error('SKILL_PACKAGE_LINK');
          const canonical = await realpath(filename);
          if (!inside(root, canonical)) throw new Error('SKILL_PACKAGE_ESCAPE');
          await assertCanonicalPathOutsideProtectedRoots(canonical, this.protectedRoots);
          if (info.isDirectory()) { await walk(filename, depth + 1); continue; }
          if (!info.isFile() || info.size > MAX_FILE || files.size >= MAX_FILES) throw new Error('SKILL_PACKAGE_LIMIT');
          // Bounded reads also cover a file growing after stat, without allocating its entire contents.
          const handle = await open(filename, 'r');
          try {
            const before = await handle.stat(), buffer = Buffer.alloc(MAX_FILE + 1);
            if (!before.isFile() || before.size > MAX_FILE) throw new Error('SKILL_PACKAGE_LIMIT');
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0), after = await handle.stat();
            if (bytesRead > MAX_FILE || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytesRead !== after.size
              || await realpath(filename) !== canonical || (await lstat(filename)).ino !== after.ino) throw new Error('SKILL_PACKAGE_CHANGED');
            total += bytesRead; if (total > MAX_TOTAL) throw new Error('SKILL_PACKAGE_LIMIT');
            files.set(path.relative(root, filename).split(path.sep).join('/'), Buffer.from(buffer.subarray(0, bytesRead)));
          } finally { await handle.close(); }
        }
      };
      await walk(root, 0);
      const skill = files.get('SKILL.md');
      if (!skill || skill.length > 256 * 1024) throw new Error('SKILL_DOCUMENT_MISSING');
      const text = decodeSkillText(skill), match = /^---\r?\n([\s\S]{0,16384}?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
      if (!match) throw new Error('SKILL_FRONTMATTER_INVALID');
      const doc = parseDocument(match[1], { strict: true, uniqueKeys: true, stringKeys: true, logLevel: 'silent' });
      if (doc.errors.length || doc.warnings.length) throw new Error('SKILL_FRONTMATTER_INVALID');
      const metadata: unknown = doc.toJS({ maxAliasCount: 0 });
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('SKILL_FRONTMATTER_INVALID');
      const { name, description } = metadata as Record<string, unknown>;
      if (typeof name !== 'string' || !name.trim() || name.length > 120 || typeof description !== 'string' || !description.trim() || description.length > 2048
        || !match[2].trim()) throw new Error('SKILL_FRONTMATTER_INVALID');
      const hash = createHash('sha256');
      for (const [key, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(JSON.stringify([key, bytes.length])).update(bytes);
      return { root, name: name.trim(), description: description.trim(), instructions: match[2], digest: hash.digest('hex'), files };
    } catch (error) {
      // Do not surface local filenames, YAML excerpts or arbitrary filesystem errors to the model/renderer.
      if (error instanceof Error && /^SKILL_[A-Z_]+$/.test(error.message)) throw error;
      // eslint-disable-next-line preserve-caught-error -- Original causes can contain private file paths or YAML excerpts.
      throw new Error('SKILL_PACKAGE_UNAVAILABLE');
    }
  }
}
export function decodeSkillText(bytes: Buffer) {
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\0')) throw new Error(); return text; }
  catch { throw new Error('SKILL_RESOURCE_NOT_TEXT'); }
}
function inside(root: string, target: string) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
