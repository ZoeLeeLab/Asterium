/** Bind this public owner/repository before public distribution. Never put a token here. */
export const PUBLIC_UPDATE_REPOSITORY = 'ZoeLeeLab/Asterium';

export type UpdatePhase = 'unconfigured' | 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'installing' | 'error';
export interface UpdateRelease {
  version: string;
  notes: string;
  publishedAt: string;
  pageUrl: string;
}
export interface UpdateSnapshot {
  configured: boolean;
  currentVersion: string;
  repository?: string;
  phase: UpdatePhase;
  release?: UpdateRelease;
  receivedBytes?: number;
  totalBytes?: number;
  readyToInstall?: boolean;
  error?: string;
}
export interface AsteriumUpdatesApi {
  get: () => Promise<UpdateSnapshot>;
  check: () => Promise<UpdateSnapshot>;
  download: () => Promise<UpdateSnapshot>;
  cancel: () => Promise<void>;
  install: () => Promise<UpdateSnapshot>;
  openReleases: () => Promise<void>;
  onChanged: (listener: (snapshot: UpdateSnapshot) => void) => () => void;
}

export function parseReleaseVersion(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return undefined;
  const core = match.slice(1, 4).map(Number);
  const prerelease = match[4]?.split('.') ?? [];
  if (core.some(n => !Number.isSafeInteger(n)) || prerelease.some(part => /^\d+$/.test(part) && (part.length > 1 && part.startsWith('0') || !Number.isSafeInteger(Number(part))))) return undefined;
  return { core, prerelease };
}
export function compareReleaseVersions(left: string, right: string) {
  const a = parseReleaseVersion(left), b = parseReleaseVersion(right);
  if (!a || !b) throw new Error('INVALID_RELEASE_VERSION');
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) > Number(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
