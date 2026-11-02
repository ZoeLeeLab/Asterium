import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const base = path.join(os.tmpdir(), 'Asterium-AutoTest');
await mkdir(base, { recursive: true });
assert.equal((await lstat(base)).isSymbolicLink(), false);
const run = await realpath(await mkdtemp(path.join(base, 'profile-process-')));
const token = randomUUID();
await writeFile(path.join(run, 'test-owner.json'), JSON.stringify({ token }));
const worker = path.join(run, 'worker-0');
await mkdir(worker);
const common = { appData: path.join(worker, 'roaming'), localAppData: path.join(worker, 'local'),
  documents: path.join(worker, 'documents'), temp: os.tmpdir(), isPackaged: false };
const children = [];
const links = [];
let passed = false;

async function waitFor(test, description) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const result = await test(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}
async function launch(name, options, shortcut) {
  const directory = path.join(worker, name); await mkdir(directory);
  const config = { options: { ...common, ...options }, shortcut, report: path.join(directory, 'report.json'), stop: path.join(directory, 'stop') };
  const configFile = path.join(directory, 'input.json'); await writeFile(configFile, JSON.stringify(config));
  const env = { ...process.env, ASTERIUM_PROFILE_DRIVER_CONFIG: configFile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(worker, 'bundle', 'driver.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { child, config, exited: false, code: undefined, output: '' }; children.push(entry);
  child.stdout.on('data', bytes => { entry.output += bytes.toString(); });
  child.stderr.on('data', bytes => { entry.output += bytes.toString(); });
  child.once('error', error => { entry.exited = true; entry.output += String(error); });
  child.once('exit', code => { entry.exited = true; entry.code = code; });
  const result = await waitFor(async () => {
    try { return JSON.parse(await readFile(config.report, 'utf8')); }
    catch (error) { if (entry.exited) throw new Error(`${name} exited ${entry.code}: ${entry.output}`, { cause: error }); if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }, `${name} report`);
  return { ...entry, entry, result };
}
async function stop(entry) {
  if (!entry.exited) await writeFile(entry.config.stop, 'stop');
  await waitFor(() => entry.exited, 'Electron exit');
  assert.equal(entry.code, 0, entry.output);
}
async function rejectLinks(directory) {
  assert.equal((await lstat(directory)).isSymbolicLink(), false, `Refusing linked cleanup: ${directory}`);
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name), stat = await lstat(file);
    assert.equal(stat.isSymbolicLink(), false, `Refusing linked cleanup: ${file}`);
    if (stat.isDirectory()) await rejectLinks(file);
  }
}

try {
  // Build only this fixture into the new run directory; no product package or installer.
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true },
    build: { ssr: path.join(root, 'tests/fixtures/profile-isolation-driver.mjs'), target: 'node22', outDir: path.join(worker, 'bundle'), emptyOutDir: false,
      rollupOptions: { external: ['electron', /^node:/], output: { format: 'cjs', entryFileNames: 'driver.cjs' } } } });
  assert.equal((await lstat(path.join(worker, 'bundle', 'driver.cjs'))).isFile(), true);
  const dailyOptions = { profile: 'daily', isPackaged: true };
  const devOptions = { profile: 'dev' };
  const acceptanceOptions = { profile: 'acceptance', acceptanceBatch: 'minimal-r1', mcpPort: '17363' };
  const autoOptions = { profile: 'autotest', userData: path.join(run, 'worker-0', 'user-data') };
  // os.tmpdir() is the real system temp, so the auto profile lies under its run/worker layout.
  const active = await Promise.all([
    launch('daily-first', dailyOptions, 'enter'), launch('dev-first', devOptions, 'ctrl_enter'),
    launch('acceptance-first', acceptanceOptions, 'enter'), launch('autotest-first', autoOptions, 'ctrl_enter'),
  ]);
  for (const { result } of active) {
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.equal(result.paths.userData, result.environment.userDataDirectory);
    assert.equal(result.paths.sessionData, result.environment.userDataDirectory);
    assert.equal(result.paths.temp, result.environment.temporaryDirectory);
    assert.equal(result.browserStorage, result.environment.userDataDirectory);
  }
  assert.equal(new Set(active.map(e => e.result.paths.userData)).size, 4);
  const duplicate = await launch('dev-duplicate', devOptions, 'enter');
  assert.equal(duplicate.result.status, 'duplicate'); await stop(duplicate.entry);
  const alias = path.join(worker, 'daily-junction'); links.push(alias);
  await symlink(active[0].result.paths.userData, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await launch('linked-dev', { profile: 'dev', userData: alias });
  assert.equal(linked.result.status, 'error'); assert.match(linked.result.error, /ASTERIUM_PROFILE_LINKED_DIRECTORY/);
  await waitFor(() => linked.entry.exited, 'rejected process exit');
  await rm(alias, { recursive: true }); links.splice(links.indexOf(alias), 1);
  await Promise.all(active.map(e => stop(e.entry)));
  const restarted = await Promise.all([launch('daily-restart', dailyOptions), launch('dev-restart', devOptions)]);
  assert.equal(restarted[0].result.settings.sendShortcut, 'enter');
  assert.equal(restarted[1].result.settings.sendShortcut, 'ctrl_enter');
  await Promise.all(restarted.map(e => stop(e.entry)));
  const report = { status: 'passed', scope: 'production startup function, real Electron processes and settings; not full packaged UI acceptance',
    profiles: active.map(e => ({ profile: e.result.environment.profile, paths: e.result.paths, shortcut: e.result.settings.sendShortcut })),
    distinctDirectories: true, duplicateBlocked: true, junctionBlocked: true, restartPersistence: true };
  await writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  passed = true;
} finally {
  // Never remove an active process's directory. Failed attempts retain their evidence.
  const cleanup = await Promise.allSettled(children.filter(e => !e.exited).map(e => stop(e)));
  const allStopped = children.every(e => e.exited) && cleanup.every(e => e.status === 'fulfilled');
  for (const entry of children) await writeFile(path.join(path.dirname(entry.config.report), 'process.log'), entry.output);
  if (passed && allStopped && links.length === 0) {
    assert.equal(path.dirname(await realpath(run)), await realpath(base));
    assert.equal(JSON.parse(await readFile(path.join(run, 'test-owner.json'), 'utf8')).token, token);
    await rejectLinks(run);
    await rm(run, { recursive: true });
    console.log('Profile isolation fixture directory cleaned after all Electron processes exited.');
  } else console.error(`Evidence retained: ${run}`);
}
