// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROFILE_MARKER, canonicalDirectory, prepareRuntimeEnvironment, resolveRuntimeEnvironment, type RuntimeEnvironmentOptions } from '../../src/main/settings/runtimeEnvironment';

const tempBase = path.join(os.tmpdir(), 'Asterium-AutoTest');
mkdirSync(tempBase, { recursive: true });
const runRoot = mkdtempSync(path.join(tempBase, 'profile-unit-'));
writeFileSync(path.join(runRoot, 'test-owner'), 'profile-unit');
afterAll(() => {
  expect(lstatSync(runRoot).isSymbolicLink()).toBe(false);
  expect(path.dirname(realpathSync.native(runRoot))).toBe(realpathSync.native(tempBase));
  expect(readFileSync(path.join(runRoot, 'test-owner'), 'utf8')).toBe('profile-unit');
  rmSync(runRoot, { recursive: true, force: true });
});
function fixture(overrides: Partial<RuntimeEnvironmentOptions> = {}) {
  const worker = realpathSync.native(mkdtempSync(path.join(runRoot, 'worker-')));
  const options: RuntimeEnvironmentOptions = {
    isPackaged: false, appData: path.join(worker, 'roaming'), localAppData: path.join(worker, 'local'),
    documents: path.join(worker, 'documents'), temp: path.join(worker, 'temp'), ...overrides,
  };
  return { worker, options, resolve: (patch: Partial<RuntimeEnvironmentOptions> = {}) => resolveRuntimeEnvironment({ ...options, ...patch }) };
}

describe('startup environment boundaries', () => {
  it('keeps packaged daily paths compatible and gives source startup independent defaults', () => {
    const f = fixture(), daily = f.resolve({ isPackaged: true }), dev = f.resolve();
    expect(daily.profile).toBe('daily'); expect(dev.profile).toBe('dev');
    expect(daily.userDataDirectory).toBe(path.join(f.options.appData, 'Asterium-Beta'));
    expect(daily.projectsDirectory).toBe(path.join(f.options.documents, 'Asterium Projects'));
    expect(dev.userDataDirectory).toBe(path.join(f.options.localAppData, 'Asterium-Dev'));
    expect(dev.projectsDirectory).toBe(path.join(dev.userDataDirectory, 'Projects'));
    expect(daily).toMatchObject({ allowStartup: true, allowUpdates: true, restoreBackgroundServices: true, mcpPort: 17361 });
    expect(dev).toMatchObject({ allowStartup: false, allowUpdates: false, restoreBackgroundServices: false, mcpPort: 17362 });
    expect(daily.appUserModelId).not.toBe(dev.appUserModelId);
  });
  it('requires explicit batch and port for acceptance, and an owned-layout directory for automatic tests', () => {
    const f = fixture();
    expect(() => f.resolve({ profile: 'acceptance' })).toThrow('ASTERIUM_ACCEPTANCE_BATCH_REQUIRED');
    expect(() => f.resolve({ profile: 'acceptance', acceptanceBatch: 'r1' })).toThrow('ASTERIUM_ACCEPTANCE_PORT_REQUIRED');
    const acceptance = f.resolve({ profile: 'acceptance', acceptanceBatch: 'r1', mcpPort: '17363' });
    expect(acceptance.userDataDirectory).toBe(path.join(f.options.localAppData, 'Asterium-Test', 'r1'));
    expect(() => f.resolve({ profile: 'autotest' })).toThrow('ASTERIUM_AUTOTEST_DIRECTORY_REQUIRED');
    expect(() => f.resolve({ profile: 'autotest', userData: path.join(f.worker, 'other') })).toThrow('ASTERIUM_AUTOTEST_DIRECTORY_REQUIRED');
    const automated = f.resolve({ profile: 'autotest', userData: path.join(f.options.temp, 'Asterium-AutoTest', 'run-1', 'worker-1', 'user-data') });
    expect(automated.mcpPort).toBe(0);
    expect(automated.restoreBackgroundServices).toBe(false);
  });
  it.each(['typo', 'constructor', '__proto__', ''])('rejects invalid profile %s', profile => {
    expect(() => fixture().resolve({ profile })).toThrow('ASTERIUM_PROFILE_INVALID');
  });
  it.each(['0', '80', '-1', '65536', 'abc', '17361.5', ''])('rejects invalid development port %s', mcpPort => {
    expect(() => fixture().resolve({ mcpPort })).toThrow('ASTERIUM_PROFILE_PORT_INVALID');
  });
  it('does not let a non-daily directory equal, contain, or descend from the daily default', () => {
    const f = fixture(), daily = f.resolve({ isPackaged: true });
    for (const userData of [daily.userDataDirectory, path.join(daily.userDataDirectory, 'dev'), f.options.appData]) {
      expect(() => f.resolve({ userData })).toThrow('ASTERIUM_PROFILE_DAILY_DIRECTORY');
    }
    expect(() => f.resolve({ userData: 'relative-folder' })).toThrow('ASTERIUM_PROFILE_ABSOLUTE_DIRECTORY_REQUIRED');
  });
  it('rejects Windows case variants of the daily path', () => {
    if (process.platform !== 'win32') return;
    const f = fixture(), daily = f.resolve({ isPackaged: true });
    expect(() => f.resolve({ userData: daily.userDataDirectory.toUpperCase() })).toThrow('ASTERIUM_PROFILE_DAILY_DIRECTORY');
  });
  it('preserves unmarked legacy daily data, adds ownership and refuses cross-profile reuse', () => {
    const f = fixture(), userData = path.join(f.worker, 'legacy-daily');
    mkdirSync(userData); writeFileSync(path.join(userData, 'private-sentinel'), 'synthetic-do-not-change');
    const daily = f.resolve({ profile: 'daily', userData }); prepareRuntimeEnvironment(daily);
    expect(readFileSync(path.join(userData, 'private-sentinel'), 'utf8')).toBe('synthetic-do-not-change');
    expect(() => prepareRuntimeEnvironment(f.resolve({ userData }))).toThrow('ASTERIUM_PROFILE_OWNER_MISMATCH');
    expect(() => prepareRuntimeEnvironment(f.resolve({ userData: path.join(userData, 'child') }))).toThrow('ASTERIUM_PROFILE_OWNER_MISMATCH');
    expect(readdirSync(userData).sort()).toEqual([PROFILE_MARKER, 'private-sentinel'].sort());
  });
  it('refuses to claim an unknown nonempty folder and permits same-profile restarts', () => {
    const f = fixture(), dev = f.resolve(); prepareRuntimeEnvironment(dev); prepareRuntimeEnvironment(f.resolve());
    const unknown = path.join(f.worker, 'unknown'); mkdirSync(unknown); writeFileSync(path.join(unknown, 'keep'), 'fixture');
    expect(() => prepareRuntimeEnvironment(f.resolve({ userData: unknown }))).toThrow('ASTERIUM_PROFILE_UNCLAIMED_DIRECTORY');
    expect(readdirSync(unknown)).toEqual(['keep']);
  });
  it('resolves the true path of a missing leaf and rejects junction and symlink aliases before writes', () => {
    const f = fixture(), daily = f.resolve({ profile: 'daily' }); prepareRuntimeEnvironment(daily);
    const alias = path.join(f.worker, 'alias'); symlinkSync(daily.userDataDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(canonicalDirectory(path.join(alias, 'new-child')).directory).toBe(path.join(realpathSync.native(daily.userDataDirectory), 'new-child'));
    expect(() => f.resolve({ userData: alias })).toThrow('ASTERIUM_PROFILE_LINKED_DIRECTORY');
    expect(() => f.resolve({ userData: path.join(alias, 'new-child') })).toThrow('ASTERIUM_PROFILE_LINKED_DIRECTORY');
    expect(readdirSync(daily.userDataDirectory)).toEqual([PROFILE_MARKER]);
    rmSync(alias, { recursive: true });
  });
  it('rejects a junction installed after resolution, including an internal temporary-directory junction', () => {
    const f = fixture(), target = f.resolve(), daily = f.resolve({ profile: 'daily' }); prepareRuntimeEnvironment(daily);
    mkdirSync(path.dirname(target.userDataDirectory), { recursive: true });
    symlinkSync(daily.userDataDirectory, target.userDataDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => prepareRuntimeEnvironment(target)).toThrow('ASTERIUM_PROFILE_DIRECTORY_CHANGED');
    rmSync(target.userDataDirectory, { recursive: true });
    prepareRuntimeEnvironment(target);
    symlinkSync(daily.userDataDirectory, target.temporaryDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => prepareRuntimeEnvironment(target)).toThrow('ASTERIUM_PROFILE_LINKED_DIRECTORY');
    rmSync(target.temporaryDirectory, { recursive: true });
    expect(readdirSync(daily.userDataDirectory)).toEqual([PROFILE_MARKER]);
  });
  it('does not accept a damaged ownership marker or overwrite it', () => {
    const f = fixture(), dev = f.resolve(); prepareRuntimeEnvironment(dev);
    writeFileSync(path.join(dev.userDataDirectory, PROFILE_MARKER), '{broken');
    expect(() => prepareRuntimeEnvironment(dev)).toThrow();
    expect(readFileSync(path.join(dev.userDataDirectory, PROFILE_MARKER), 'utf8')).toBe('{broken');
  });
  it('enables background restoration only for daily use or an explicit launch opt-in', () => {
    const f = fixture();
    expect(f.resolve().restoreBackgroundServices).toBe(false);
    expect(f.resolve({ backgroundServices: true }).restoreBackgroundServices).toBe(true);
    expect(f.resolve({ profile: 'daily' }).restoreBackgroundServices).toBe(true);
    expect(f.resolve({ profile: 'daily' }).allowUpdates).toBe(false);
  });
});
