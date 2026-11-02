import fileSystem from 'node:fs';
import fileSystemPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn as nativeSpawn } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUN_MARKER = '.asterium-autotest-run.v1.json';
// Keep the harness independent from filesystem spies installed by individual test files.
const fs = { ...fileSystem }, fsp = { ...fileSystemPromises };
let context;
let failureProbe = () => false;
const pathString = value => value instanceof URL ? fileURLToPath(value) : String(value);
const contains = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };

function canonical(directory) {
  let cursor = path.resolve(directory); const missing = [];
  while (!fs.existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) throw Error('AUTOTEST_PATH_MISSING'); missing.unshift(path.basename(cursor)); cursor = parent; }
  for (let entry = cursor;; entry = path.dirname(entry)) {
    if (fs.lstatSync(entry).isSymbolicLink()) throw Error('AUTOTEST_DIRECTORY_LINK_REJECTED');
    if (path.dirname(entry) === entry) break;
  }
  return path.join(fs.realpathSync.native(cursor), ...missing);
}

export function createAutoTestRun() {
  const systemTemp = canonical(process.env.ASTERIUM_AUTOTEST_SYSTEM_TEMP || os.tmpdir());
  const base = canonical(path.join(systemTemp, 'Asterium-AutoTest')); fs.mkdirSync(base, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'run-')));
  const run = { version: 1, root, systemTemp, token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, RUN_MARKER), JSON.stringify(run), { flag: 'wx' });
  return run;
}

function validateRun(run) {
  const root = canonical(run.root), owner = JSON.parse(fs.readFileSync(path.join(root, RUN_MARKER), 'utf8'));
  if (owner.version !== 1 || owner.token !== run.token || canonical(owner.root) !== root
    || path.dirname(root) !== canonical(path.join(owner.systemTemp, 'Asterium-AutoTest'))) throw Error('AUTOTEST_RUN_OWNER_MISMATCH');
  return owner;
}

export function beginAutoTestWorker(run, label = 'node', vitest = false) {
  if (context) return context;
  failureProbe = () => false;
  run = validateRun(run);
  const worker = fs.mkdtempSync(path.join(run.root, `worker-${String(label).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50)}-`));
  fs.mkdirSync(path.join(worker, 'evidence'));
  context = { run, worker, evidence: path.join(worker, 'evidence'), vitest, failed: false, resources: [], children: new Set(), pending: new Set() };
  fs.writeFileSync(path.join(worker, '.worker.json'), JSON.stringify({ token: run.token, pid: process.pid }));
  Object.assign(process.env, { ASTERIUM_AUTOTEST_RUN_ROOT: run.root, ASTERIUM_AUTOTEST_RUN_TOKEN: run.token,
    ASTERIUM_AUTOTEST_SYSTEM_TEMP: run.systemTemp, TEMP: worker, TMP: worker });
  return context;
}

export function beginAutoTestCase() {
  if (!context) throw Error('AUTOTEST_CONTEXT_REQUIRED');
  const directory = fs.mkdtempSync(path.join(context.worker, 'case-'));
  process.env.TEMP = directory; process.env.TMP = directory;
  return directory;
}
export function endAutoTestCase() { process.env.TEMP = context.worker; process.env.TMP = context.worker; }
export function setAutoTestFailureProbe(probe) { failureProbe = probe; }
export function markAutoTestFailure(reason = 'test_failed') {
  context.failed = true;
  fs.writeFileSync(path.join(context.worker, 'failure.json'), JSON.stringify({ reason }));
}

function owned(target) {
  if (!context) throw Error('AUTOTEST_CONTEXT_REQUIRED');
  const absolute = path.resolve(pathString(target));
  // A link itself can be unlinked, but its target must never be traversed for deletion.
  const parent = canonical(path.dirname(absolute));
  if (!contains(context.worker, path.join(parent, path.basename(absolute)))) throw Error('AUTOTEST_CLEANUP_OUTSIDE_WORKER');
  return absolute;
}

export function testRmSync(target, options = {}) {
  if (!options.recursive) return fs.rmSync(target, options);
  const absolute = owned(target);
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) return fs.unlinkSync(absolute);
  if (context.failed || failureProbe()) { markAutoTestFailure(); return; }
  if (!context.vitest) { context.pending.add(absolute); return; }
  return fs.rmSync(absolute, options);
}
export async function testRm(target, options = {}) {
  if (!options.recursive) return fsp.rm(target, options);
  return testRmSync(target, options);
}

export function autoTestEvidence(label = 'evidence', requested) {
  if (!context) throw Error('AUTOTEST_CONTEXT_REQUIRED');
  const directory = requested ? owned(requested) : path.join(context.evidence, String(label).replace(/[^a-zA-Z0-9_-]/g, '-'));
  fs.mkdirSync(directory, { recursive: true }); return directory;
}
export function autoTestOutput(requested) {
  const directory = requested ? owned(requested) : path.join(context.worker, `output-${randomUUID()}`);
  if (fs.existsSync(directory)) throw Error('AUTOTEST_FRESH_OUTPUT_REQUIRED');
  return directory;
}

function markApplicationData(args) {
  const flag = args.find(value => String(value).startsWith('--user-data-dir='));
  if (!flag) throw Error('AUTOTEST_EXPLICIT_USER_DATA_REQUIRED');
  const directory = owned(String(flag).slice('--user-data-dir='.length));
  if (canonical(directory) !== directory) throw Error('AUTOTEST_DIRECTORY_LINK_REJECTED');
  fs.mkdirSync(directory, { recursive: true });
  const marker = path.join(directory, '.asterium-profile.v1.json');
  if (fs.existsSync(marker)) {
    if (JSON.parse(fs.readFileSync(marker, 'utf8')).profile !== 'autotest') throw Error('AUTOTEST_DATA_OWNER_MISMATCH');
  } else fs.writeFileSync(marker, JSON.stringify({ version: 1, profile: 'autotest' }), { flag: 'wx' });
  return ['--asterium-profile=autotest', ...args.filter(value => !String(value).startsWith('--asterium-profile='))];
}
function supportedCandidate(executable) {
  const archive = path.join(path.dirname(path.resolve(executable)), 'resources', 'app.asar');
  if (!fs.readFileSync(archive).includes(Buffer.from('ASTERIUM_PROFILE_STARTUP_FAILED'))) throw Error('AUTOTEST_CANDIDATE_REQUIRES_PROFILE_ISOLATION');
}

function registerChild(child) {
  const worker = context;
  worker.children.add(child);
  child.once('close', () => worker.children.delete(child)); child.once('error', () => worker.children.delete(child));
  worker.resources.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    child.stdin?.end();
    const closed = new Promise(resolve => child.once('close', resolve));
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1500).unref())]);
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') await new Promise(resolve => {
      const killer = nativeSpawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('close', resolve); killer.once('error', resolve);
    }); else child.kill('SIGTERM');
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error('AUTOTEST_CHILD_NOT_STOPPED')), 5000).unref())]);
  });
  return child;
}
export function spawnTestProcess(command, args = [], options = {}) {
  if (/^asterium\.exe$/i.test(path.basename(String(command)))) { supportedCandidate(command); args = markApplicationData(args); }
  return registerChild(nativeSpawn(command, args, options));
}
export async function launchTestElectron(electron, options) {
  supportedCandidate(options.executablePath);
  const app = await electron.launch({ ...options, args: markApplicationData(options.args || []) });
  registerChild(app.process());
  context.resources.push(() => app.close().catch(() => undefined)); return app;
}
export async function launchTestBrowser(browserType, options) {
  const browser = await browserType.launch(options); context.resources.push(() => browser.close()); return browser;
}
function trackServer(server) {
  context.resources.push(async () => {
    if (!server.listening) return;
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }); return server;
}
export function createTestHttpServer(...args) { return trackServer(httpServer(...args)); }
export function createTestNetServer(...args) { return trackServer(netServer(...args)); }
export async function createTestViteServer(options = {}) {
  const { createServer } = await import('vite');
  const server = await createServer({ ...options, cacheDir: fs.mkdtempSync(path.join(context.worker, 'vite-cache-')) });
  context.resources.push(() => server.close()); return server;
}
export async function buildTestSdk(configFile, fileName) {
  const { build } = await import('vite');
  const output = autoTestOutput();
  await build({ configFile, logLevel: 'error', cacheDir: fs.mkdtempSync(path.join(context.worker, 'build-cache-')),
    build: { outDir: output, emptyOutDir: false } });
  return import(pathToFileURL(path.join(output, fileName)).href);
}

export async function finishAutoTestWorker() {
  let cleanupError;
  for (const dispose of context.resources.reverse()) try { await dispose(); } catch (error) { cleanupError ??= error; }
  if (cleanupError || [...context.children].some(child => child.exitCode === null && child.signalCode === null)) {
    markAutoTestFailure('child_or_resource_cleanup_failed'); throw cleanupError || Error('AUTOTEST_CHILD_NOT_STOPPED');
  }
  fs.writeFileSync(path.join(context.worker, '.complete'), context.failed ? 'failed' : 'passed');
  context = undefined;
}

function inspectTree(root) {
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, item.name), stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw Error('AUTOTEST_CLEANUP_LINK_REJECTED');
    if (stat.isDirectory()) inspectTree(target);
  }
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error('AUTOTEST_PROCESS_OWNER_INVALID');
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
export function cleanupAutoTestRun(run, { allowFailed = false } = {}) {
  run = validateRun(run); inspectTree(run.root);
  const external = run.pid !== process.pid;
  if (external && processAlive(run.pid)) throw Error('AUTOTEST_RUN_STILL_ACTIVE');
  for (const name of fs.readdirSync(run.root).filter(value => value.startsWith('worker-'))) {
    const worker = path.join(run.root, name);
    const owner = JSON.parse(fs.readFileSync(path.join(worker, '.worker.json'), 'utf8'));
    if (owner.token !== run.token) throw Error('AUTOTEST_WORKER_OWNER_MISMATCH');
    if (external && processAlive(owner.pid)) throw Error('AUTOTEST_WORKER_STILL_ACTIVE');
    if (!fs.existsSync(path.join(worker, '.complete')) && !(allowFailed && !processAlive(owner.pid))) throw Error('AUTOTEST_WORKER_STILL_ACTIVE');
    if (!allowFailed && fs.existsSync(path.join(worker, 'failure.json'))) return false;
  }
  fs.rmSync(run.root, { recursive: true, maxRetries: 8, retryDelay: 100 }); return true;
}

export async function runAutoTest(body) {
  const inherited = process.env.ASTERIUM_AUTOTEST_RUN_ROOT;
  const run = inherited ? { root: inherited, token: process.env.ASTERIUM_AUTOTEST_RUN_TOKEN } : createAutoTestRun();
  const worker = beginAutoTestWorker(run, path.basename(process.argv[1] || 'node', '.mjs'));
  const errors = [];
  let result;
  try { result = await body(); }
  catch (error) {
    errors.push(error);
    try { markAutoTestFailure(); } catch (recordingError) { errors.push(recordingError); }
  }
  try { await finishAutoTestWorker(); } catch (error) { errors.push(error); }
  if (errors.length) {
    console.error(`AUTOTEST_EVIDENCE_RETAINED ${worker.run.root}`);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, 'AUTOTEST_EXECUTION_AND_CLEANUP_FAILED');
  }
  if (!inherited && process.env.ASTERIUM_AUTOTEST_KEEP !== '1') cleanupAutoTestRun(worker.run);
  else if (process.env.ASTERIUM_AUTOTEST_KEEP === '1') console.error(`AUTOTEST_EVIDENCE_RETAINED ${worker.run.root}`);
  return result;
}
