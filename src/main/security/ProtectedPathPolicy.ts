import path from 'node:path';
import { realpath } from 'node:fs/promises';

export const PROFILE_DATA_ACCESS_DENIED = 'PROFILE_DATA_ACCESS_DENIED';

export function pathsOverlap(left: string, right: string) {
  const a = normalize(left);
  const b = normalize(right);
  return contains(a, b) || contains(b, a);
}

export function assertPathOutsideProtectedRoots(candidate: string, protectedRoots: readonly string[]) {
  if (protectedRoots.some((root) => pathsOverlap(candidate, root))) throw new Error(PROFILE_DATA_ACCESS_DENIED);
}

export async function assertCanonicalPathOutsideProtectedRoots(candidate: string, protectedRoots: readonly string[]) {
  const canonicalCandidate = await canonicalFuturePath(candidate);
  const canonicalRoots = await Promise.all(protectedRoots.map(canonicalFuturePath));
  assertPathOutsideProtectedRoots(canonicalCandidate, canonicalRoots);
}

export function textReferencesProtectedRoot(value: string, protectedRoots: readonly string[]) {
  const normalized = value.replaceAll('/', '\\').toLocaleLowerCase();
  return protectedRoots.some((root) => {
    const target = path.resolve(root).replaceAll('/', '\\').toLocaleLowerCase();
    if (normalized.includes(target)) return true;
    const relativeToAppData = process.env.APPDATA ? path.relative(process.env.APPDATA, root).replaceAll('/', '\\').toLocaleLowerCase() : '';
    return Boolean(relativeToAppData && (
      normalized.includes(`%appdata%\\${relativeToAppData}`)
      || normalized.includes(`$env:appdata\\${relativeToAppData}`)
      || normalized.includes(relativeToAppData)
    ));
  });
}

function normalize(value: string) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

function contains(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalFuturePath(target: string): Promise<string> {
  let cursor = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(cursor), ...tail.reverse());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(target);
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
}
