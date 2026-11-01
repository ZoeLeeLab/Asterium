import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppUpdateService, selectUpdate } from '../../src/main/settings/AppUpdateService';
import { PUBLIC_UPDATE_REPOSITORY, compareReleaseVersions, parseReleaseVersion } from '../../src/shared/appUpdates';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const payload = Buffer.from('synthetic installer bytes; never execute');
const sha256 = createHash('sha256').update(payload).digest('hex');
function release(version = '0.1.0-beta.2', overrides: Record<string, unknown> = {}) {
  const name = `Asterium-${version}-win-x64-abcdef123456-setup.exe`;
  return { draft: false, prerelease: version.includes('-'), published_at: '2026-11-01T00:00:00Z', tag_name: `v${version}`, body: 'Synthetic release notes',
    assets: [{ name, state: 'uploaded', size: payload.length, digest: `sha256:${sha256}`, browser_download_url: `https://github.com/example/asterium/releases/download/v${version}/${name}` }], ...overrides };
}
async function setup(options: { repository?: string; fetch?: typeof fetch; includePrerelease?: () => boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-updates-')); temporary.push(directory);
  const install = vi.fn(async (file: string) => { void file; }), openExternal = vi.fn(async (url: string) => { void url; });
  const fetcher = options.fetch ?? vi.fn(async (url: string | URL | Request) => String(url).startsWith('https://api.github.com/')
    ? new Response(JSON.stringify([release()]), { status: 200 }) : new Response(payload, { status: 200 }));
  const service = new AppUpdateService({ repository: options.repository ?? 'example/asterium', version: '0.1.0-beta.1', directory,
    includePrerelease: options.includePrerelease ?? (() => true), fetch: fetcher as typeof fetch, install, openExternal });
  return { service, directory, install, openExternal, fetcher };
}

describe('public GitHub update selection', () => {
  it('compares numeric semver and stable/prerelease boundaries, rejects invalid versions', () => {
    expect(compareReleaseVersions('0.1.0-beta.10', '0.1.0-beta.2')).toBe(1);
    expect(compareReleaseVersions('0.1.0', '0.1.0-beta.10')).toBe(1);
    expect(compareReleaseVersions('0.2.0-beta.1', '0.1.99')).toBe(1);
    expect(compareReleaseVersions('0.1.0-beta', '0.1.0-beta.1')).toBe(-1);
    expect(parseReleaseVersion('0.01.0')).toBeUndefined();
    expect(parseReleaseVersion('0.1.0-beta.01')).toBeUndefined();
    expect(parseReleaseVersion('../setup.exe')).toBeUndefined();
  });
  it('selects newer published versions, excludes drafts and honors the chosen channel', () => {
    const releases = [release('0.1.0-beta.2'), release('0.1.0-beta.10'), release('9.0.0', { draft: true }), release('0.1.0')];
    expect(selectUpdate(releases, 'example/asterium', '0.1.0-beta.1', true)?.version).toBe('0.1.0');
    expect(selectUpdate([release()], 'example/asterium', '0.1.0-beta.1', false)).toBeUndefined();
    expect(selectUpdate([release('0.1.0-beta.1')], 'example/asterium', '0.1.0-beta.1', true)).toBeUndefined();
  });
  it('refuses missing hashes, wrong repository origins, ambiguous installers and oversized assets', () => {
    const base = release(), asset = base.assets[0];
    for (const changed of [
      { ...asset, digest: null }, { ...asset, digest: 'sha256:bad' }, { ...asset, size: 600 * 1024 * 1024 },
    ]) expect(() => selectUpdate([{ ...base, assets: [changed] }], 'example/asterium', '0.1.0-beta.1', true)).toThrow('UPDATE_CHECKSUM_UNAVAILABLE');
    expect(() => selectUpdate([{ ...base, assets: [{ ...asset, browser_download_url: 'https://attacker.invalid/setup.exe' }] }], 'example/asterium', '0.1.0-beta.1', true)).toThrow('UPDATE_ASSET_ORIGIN_REJECTED');
    expect(() => selectUpdate([{ ...base, assets: [asset, asset] }], 'example/asterium', '0.1.0-beta.1', true)).toThrow('UPDATE_WINDOWS_ASSET_MISSING');
  });
});

describe('update download and installation consent', () => {
  it('uses the configured public source and does not download or install from an empty release catalog', async () => {
    const fetcher = vi.fn(async () => new Response('[]', { status: 200 }));
    const { service, directory, install, openExternal } = await setup({ repository: PUBLIC_UPDATE_REPOSITORY, fetch: fetcher as typeof fetch });
    expect(service.get().configured).toBe(true);
    expect((await service.check()).phase).toBe('up-to-date');
    expect(fetcher).toHaveBeenCalledWith(`https://api.github.com/repos/${PUBLIC_UPDATE_REPOSITORY}/releases?per_page=20`, expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
    await service.download(); await service.install(); await service.openReleases();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await readdir(directory)).toEqual([]); expect(install).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(`https://github.com/${PUBLIC_UPDATE_REPOSITORY}/releases`);
  });
  it('makes no network request when the public repository is not configured', async () => {
    const { service, fetcher, install } = await setup({ repository: '' });
    expect((await service.check()).phase).toBe('unconfigured');
    await service.download(); await service.install(); await service.openReleases();
    expect(fetcher).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
  });
  it('checks without credentials and never downloads or installs until explicitly requested', async () => {
    const { service, fetcher, directory, install } = await setup();
    expect((await service.check()).phase).toBe('available');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await readdir(directory)).toEqual([]); expect(install).not.toHaveBeenCalled();
    const init = vi.mocked(fetcher).mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('omit'); expect(JSON.stringify(init.headers)).not.toMatch(/authorization|token/i);
    await service.install(); expect(install).not.toHaveBeenCalled();
    expect((await service.download()).phase).toBe('downloaded'); expect(install).not.toHaveBeenCalled();
    const files = await readdir(directory); expect(files).toHaveLength(1); expect(files[0]).toMatch(/\.exe$/);
    expect(await readFile(path.join(directory, files[0]))).toEqual(payload);
    expect(service.get().readyToInstall).toBe(true);
    expect((await service.install()).phase).toBe('installing'); expect(install).toHaveBeenCalledTimes(1);
    await service.install(); expect(install).toHaveBeenCalledTimes(1);
  });
  it('does not expose cache paths and only opens the configured public Releases page', async () => {
    const { service, directory, openExternal } = await setup();
    await service.check(); await service.download(); await service.openReleases();
    expect(JSON.stringify(service.get())).not.toContain(directory);
    expect(openExternal).toHaveBeenCalledWith('https://github.com/example/asterium/releases');
  });
  it('rejects tampered downloads and removes its partial file without launching anything', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).startsWith('https://api.github.com/')
      ? new Response(JSON.stringify([release()])) : new Response(Buffer.alloc(payload.length, 120)));
    const { service, directory, install } = await setup({ fetch: fetcher as typeof fetch });
    await service.check(); expect((await service.download()).error).toBe('UPDATE_CHECKSUM_MISMATCH');
    expect(service.get().readyToInstall).toBe(false); expect(await readdir(directory)).toEqual([]);
    await service.install(); expect(install).not.toHaveBeenCalled();
  });
  it('rechecks cached bytes immediately before installation', async () => {
    const { service, directory, install } = await setup();
    await service.check(); await service.download();
    await writeFile(path.join(directory, (await readdir(directory))[0]), Buffer.alloc(payload.length, 121));
    expect((await service.install()).error).toBe('UPDATE_CHECKSUM_MISMATCH');
    expect(service.get().readyToInstall).toBe(false); expect(install).not.toHaveBeenCalled();
    expect((await service.download()).phase).toBe('downloaded');
  });
  it('follows approved HTTPS asset redirects and refuses other origins or HTTP', async () => {
    for (const location of ['http://release-assets.githubusercontent.com/file', 'https://attacker.invalid/file', 'https://github.com.evil.invalid/file']) {
      const fetcher = vi.fn(async (url: string | URL | Request) => String(url).startsWith('https://api.github.com/')
        ? new Response(JSON.stringify([release()])) : new Response(null, { status: 302, headers: { location } }));
      const { service, directory, install } = await setup({ fetch: fetcher as typeof fetch });
      await service.check(); expect((await service.download()).error).toBe('UPDATE_ASSET_ORIGIN_REJECTED');
      expect(fetcher).toHaveBeenCalledTimes(2); expect(await readdir(directory)).toEqual([]); expect(install).not.toHaveBeenCalled();
    }
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).startsWith('https://api.github.com/')
      ? new Response(JSON.stringify([release()])) : String(url).startsWith('https://github.com/')
        ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file?public=download' } }) : new Response(payload));
    const { service } = await setup({ fetch: fetcher as typeof fetch });
    await service.check(); expect((await service.download()).phase).toBe('downloaded');
  });
  it('bounds file size, reports rate limits and invalid metadata honestly', async () => {
    const { service, directory } = await setup({ fetch: vi.fn(async (url: string | URL | Request) => String(url).startsWith('https://api.github.com/')
      ? new Response(JSON.stringify([release()])) : new Response(Buffer.alloc(payload.length + 1))) as typeof fetch });
    await service.check(); expect((await service.download()).error).toBe('UPDATE_SIZE_MISMATCH'); expect(await readdir(directory)).toEqual([]);
    const limited = await setup({ fetch: vi.fn(async () => new Response('', { status: 403 })) as typeof fetch });
    expect((await limited.service.check()).error).toBe('UPDATE_RATE_LIMIT');
    const malformed = await setup({ fetch: vi.fn(async () => new Response('not JSON')) as typeof fetch });
    expect((await malformed.service.check()).phase).toBe('error');
  });
  it('cancels an active download, prevents parallel operations and can retry', async () => {
    let started!: () => void; const active = new Promise<void>(resolve => { started = resolve; });
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url).startsWith('https://api.github.com/')) return new Response(JSON.stringify([release()]));
      started(); return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const { service, install, directory } = await setup({ fetch: fetcher as typeof fetch });
    await service.check(); const pending = service.download(); await active;
    await service.download(); await service.check(); await service.install(); expect(fetcher).toHaveBeenCalledTimes(2);
    service.cancel(); expect((await pending).error).toBe('UPDATE_CANCELLED');
    expect(await readdir(directory)).toEqual([]); expect(install).not.toHaveBeenCalled();
  });
  it('does not download a previously selected Beta after the user disables that channel', async () => {
    let include = true; const { service, fetcher } = await setup({ includePrerelease: () => include });
    await service.check(); include = false;
    expect((await service.download()).phase).toBe('up-to-date');
    expect(vi.mocked(fetcher).mock.calls.every(call => String(call[0]).startsWith('https://api.github.com/'))).toBe(true);
  });
});
