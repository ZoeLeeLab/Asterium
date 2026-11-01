import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { compareReleaseVersions, parseReleaseVersion, type UpdateRelease, type UpdateSnapshot } from '../../shared/appUpdates';

const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
interface Candidate extends UpdateRelease { assetName: string; url: string; sha256: string; size: number }
interface Options {
  repository: string;
  version: string;
  directory: string;
  includePrerelease: () => boolean;
  fetch?: typeof fetch;
  install: (file: string) => Promise<void>;
  openExternal: (url: string) => Promise<unknown>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const message = (code: string) => new Error(code);

export function selectUpdate(releases: unknown, repository: string, current: string, includePrerelease: boolean): Candidate | undefined {
  if (!Array.isArray(releases)) throw message('UPDATE_INVALID_RESPONSE');
  const newer = releases.filter(record).flatMap(release => {
    if (release.draft !== false || typeof release.tag_name !== 'string' || !release.published_at) return [];
    const version = release.tag_name.replace(/^v/, '');
    const parsed = parseReleaseVersion(version);
    if (!parsed || (!includePrerelease && (parsed.prerelease.length || release.prerelease === true)) || compareReleaseVersions(version, current) <= 0) return [];
    return [{ release, version }];
  }).sort((a, b) => compareReleaseVersions(b.version, a.version));
  const next = newer[0];
  if (!next) return undefined;
  const { release, version } = next;
  const assets = Array.isArray(release.assets) ? release.assets.filter(record).filter(asset => typeof asset.name === 'string'
    && asset.name.startsWith(`Asterium-${version}-win-x64-`) && /^Asterium-[0-9A-Za-z.-]+-win-x64-[a-f0-9]{12}-setup\.exe$/.test(asset.name)) : [];
  if (assets.length !== 1) throw message('UPDATE_WINDOWS_ASSET_MISSING');
  const asset = assets[0];
  if (asset.state !== 'uploaded' || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)
    || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_INSTALLER_BYTES) throw message('UPDATE_CHECKSUM_UNAVAILABLE');
  const expected = `https://github.com/${repository}/releases/download/${encodeURIComponent(String(release.tag_name))}/${encodeURIComponent(String(asset.name))}`;
  if (asset.browser_download_url !== expected) throw message('UPDATE_ASSET_ORIGIN_REJECTED');
  return { version, notes: typeof release.body === 'string' ? release.body.slice(0, 6000) : '', publishedAt: String(release.published_at),
    pageUrl: `https://github.com/${repository}/releases/tag/${encodeURIComponent(String(release.tag_name))}`,
    assetName: String(asset.name), url: expected, sha256: asset.digest.slice(7).toLowerCase(), size: asset.size };
}

export class AppUpdateService {
  private snapshot: UpdateSnapshot;
  private candidate?: Candidate;
  private downloaded?: string;
  private controller?: AbortController;
  private readonly listeners = new Set<(snapshot: UpdateSnapshot) => void>();
  private readonly request;
  private disposed = false;
  constructor(private readonly options: Options) {
    const configured = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(options.repository) && !options.repository.split('/').some(part => part === '.' || part === '..');
    this.snapshot = { configured, currentVersion: options.version, ...(configured ? { repository: options.repository } : {}), phase: configured ? 'idle' : 'unconfigured' };
    this.request = options.fetch ?? globalThis.fetch;
  }
  get() { return structuredClone(this.snapshot); }
  subscribe(listener: (snapshot: UpdateSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(patch: Partial<UpdateSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    if (!this.disposed) for (const listener of this.listeners) { try { listener(this.get()); } catch { /* A view cannot change download state. */ } }
    return this.get();
  }
  private get busy() { return Boolean(this.controller) || this.snapshot.phase === 'installing'; }
  async check() {
    if (!this.snapshot.configured || this.busy || this.disposed) return this.get();
    // A verified download remains available until installation, even if a later check fails.
    if (this.downloaded) return this.get();
    this.candidate = undefined;
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), 20_000);
    this.publish({ phase: 'checking', error: undefined, release: undefined, receivedBytes: undefined, totalBytes: undefined });
    try {
      const response = await this.request(`https://api.github.com/repos/${this.options.repository}/releases?per_page=20`, {
        signal: controller.signal, redirect: 'error', credentials: 'omit',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Asterium/${this.options.version}`, 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!response.ok) throw message(response.status === 403 || response.status === 429 ? 'UPDATE_RATE_LIMIT' : 'UPDATE_NETWORK_ERROR');
      const bytes = await this.readSmallResponse(response, 2 * 1024 * 1024);
      this.candidate = selectUpdate(JSON.parse(bytes), this.options.repository, this.options.version, this.options.includePrerelease());
      const { candidate } = this;
      return this.publish({ phase: candidate ? 'available' : 'up-to-date', ...(candidate ? { release: { version: candidate.version, notes: candidate.notes, publishedAt: candidate.publishedAt, pageUrl: candidate.pageUrl }, totalBytes: candidate.size } : {}) });
    } catch (error) { return this.publish({ phase: 'error', error: this.errorCode(error, controller) }); }
    finally { clearTimeout(timeout); if (this.controller === controller) this.controller = undefined; }
  }
  async download() {
    if (!this.candidate || this.busy || this.downloaded || this.disposed) return this.get();
    const candidate = this.candidate;
    if (!this.options.includePrerelease() && parseReleaseVersion(candidate.version)?.prerelease.length) return this.check();
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), 10 * 60_000);
    const prefix = path.join(this.options.directory, randomUUID());
    const temporary = `${prefix}.part`, final = `${prefix}-${candidate.assetName}`;
    this.publish({ phase: 'downloading', error: undefined, readyToInstall: false, receivedBytes: 0, totalBytes: candidate.size });
    try {
      await mkdir(this.options.directory, { recursive: true });
      if ((await lstat(this.options.directory)).isSymbolicLink()) throw message('UPDATE_CACHE_REJECTED');
      const response = await this.downloadResponse(candidate.url, controller.signal);
      if (!response.ok || !response.body) throw message('UPDATE_NETWORK_ERROR');
      const file = await open(temporary, 'wx');
      const hash = createHash('sha256'); let received = 0, lastProgress = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.byteLength;
          if (received > candidate.size || received > MAX_INSTALLER_BYTES) throw message('UPDATE_SIZE_MISMATCH');
          hash.update(chunk.value);
          await file.writeFile(chunk.value);
          if (Date.now() - lastProgress > 150) { lastProgress = Date.now(); this.publish({ receivedBytes: received }); }
        }
        if (received !== candidate.size || hash.digest('hex') !== candidate.sha256) throw message('UPDATE_CHECKSUM_MISMATCH');
        await file.sync();
      } finally { await reader.cancel().catch(() => undefined); await file.close(); }
      if (controller.signal.aborted) throw message('UPDATE_CANCELLED');
      await rename(temporary, final); this.downloaded = final;
      return this.publish({ phase: 'downloaded', readyToInstall: true, receivedBytes: candidate.size });
    } catch (error) {
      const code = this.errorCode(error, controller);
      controller.abort('failed');
      await rm(temporary, { force: true }).catch(() => undefined);
      return this.publish({ phase: 'error', error: code });
    } finally { clearTimeout(timeout); if (this.controller === controller) this.controller = undefined; }
  }
  cancel() { this.controller?.abort('cancelled'); }
  async install() {
    if (!this.downloaded || !this.candidate || this.busy || this.disposed) return this.get();
    this.publish({ phase: 'installing', error: undefined });
    let verified = false;
    try {
      const info = await lstat(this.downloaded);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== this.candidate.size) throw message('UPDATE_CHECKSUM_MISMATCH');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(this.downloaded)) hash.update(chunk);
      if (hash.digest('hex') !== this.candidate.sha256) throw message('UPDATE_CHECKSUM_MISMATCH');
      verified = true;
      await this.options.install(this.downloaded);
      return this.get();
    } catch {
      const code = verified ? 'UPDATE_INSTALL_FAILED' : 'UPDATE_CHECKSUM_MISMATCH';
      if (!verified) this.downloaded = undefined;
      return this.publish({ phase: 'error', error: code, readyToInstall: Boolean(this.downloaded) });
    }
  }
  async openReleases() {
    if (this.snapshot.configured && !this.disposed) await this.options.openExternal(`https://github.com/${this.options.repository}/releases`);
  }
  dispose() { this.disposed = true; this.cancel(); this.listeners.clear(); }
  private async downloadResponse(initial: string, signal: AbortSignal) {
    let url = initial;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
        || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(parsed.hostname)) throw message('UPDATE_ASSET_ORIGIN_REJECTED');
      const response = await this.request(url, { signal, redirect: 'manual', credentials: 'omit', headers: { Accept: 'application/octet-stream', 'User-Agent': `Asterium/${this.options.version}` } });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw message('UPDATE_ASSET_ORIGIN_REJECTED');
      url = new URL(location, url).href;
    }
    throw message('UPDATE_ASSET_ORIGIN_REJECTED');
  }
  private async readSmallResponse(response: Response, limit: number) {
    if (!response.body) throw message('UPDATE_INVALID_RESPONSE');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > limit) throw message('UPDATE_INVALID_RESPONSE'); chunks.push(chunk.value); }
      return Buffer.concat(chunks).toString('utf8');
    } finally { await reader.cancel().catch(() => undefined); }
  }
  private errorCode(error: unknown, controller?: AbortController) {
    if (controller?.signal.aborted) return controller.signal.reason === 'timeout' ? 'UPDATE_TIMEOUT' : 'UPDATE_CANCELLED';
    return error instanceof Error && /^UPDATE_[A-Z_]+$/.test(error.message) ? error.message : 'UPDATE_NETWORK_ERROR';
  }
}
