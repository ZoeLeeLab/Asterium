// Developer-only S1 experiment. Nothing under src/ imports this module.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const evidenceDirectory = path.join(repository, '.qa', 'sandbox-s1');
export const helperSource = path.join(repository, 'tools', 'sandbox-s1', 'SandboxHelper.cs');
export const helperExecutable = path.join(evidenceDirectory, 'SandboxHelper.exe');
export const launcherExecutable = path.join(evidenceDirectory, 'TestLauncher.exe');
const identitySource = path.join(repository, 'tools', 'sandbox-s1', 'TestTokenIdentity.cs');
const launcherSource = path.join(repository, 'tools', 'sandbox-s1', 'TestLauncher.cs');
const appIdentitySource = path.join(repository, 'tools', 'sandbox-s1', 'AppContainerIdentity.cs');
const modes = new Set(['manual', 'automatic', 'full', 'read_only']);

export function selectPocPolicy({ enabled = false, allowNetwork = false, permissionMode = 'manual', planMode = 'default' } = {}) {
  if (typeof enabled !== 'boolean' || typeof allowNetwork !== 'boolean' || !modes.has(permissionMode) || !['default', 'plan'].includes(planMode)) throw new Error('S1_INVALID_POLICY');
  // Selection only: the PoC NEVER executes a native operation, including Full.
  if (permissionMode === 'full') return { backend: 'native', launchPoc: false, network: 'native_unchanged', reason: 'full' };
  if (!enabled) return { backend: 'native', launchPoc: false, network: 'native_unchanged', reason: 'disabled' };
  if (permissionMode === 'read_only' || planMode === 'plan') return { backend: 'sandbox', launchPoc: false, network: allowNetwork ? 'allowed' : 'blocked', reason: 'existing_mode_blocks_execution' };
  return { backend: 'sandbox', launchPoc: true, network: allowNetwork ? 'allowed' : 'blocked', reason: 'explicit_poc_opt_in' };
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

// Fail before creating artifacts if an existing path component is a link.
export async function assertOwnedPath(candidate) {
  const root = await realpath(repository);
  const absolute = path.resolve(candidate);
  if (!inside(path.join(root, '.qa', 'sandbox-s1'), absolute) && absolute !== path.join(root, '.qa', 'sandbox-s1')) throw new Error('S1_PATH_OUTSIDE_EVIDENCE');
  let cursor = root;
  for (const component of path.relative(root, absolute).split(path.sep)) {
    cursor = path.join(cursor, component);
    const info = await lstat(cursor).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (info?.isSymbolicLink()) throw new Error('S1_REPARSE_PATH');
  }
  return absolute;
}

function captureProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    const collect = chunk => { if (output.length < 128 * 1024) output += chunk.toString(); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

export async function buildHelper() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('S1_REQUIRES_WINDOWS_X64');
  await assertOwnedPath(evidenceDirectory);
  await mkdir(evidenceDirectory, { recursive: true });
  await assertOwnedPath(helperExecutable);
  const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  for (const [main, source, executable] of [['SandboxHelper', helperSource, helperExecutable], ['S1TestLauncher', launcherSource, launcherExecutable]]) {
    await assertOwnedPath(executable);
    const result = await captureProcess(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/warnaserror+', '/reference:System.Web.Extensions.dll', `/main:${main}`, `/out:${executable}`, source, identitySource, ...(main === 'SandboxHelper' ? [appIdentitySource] : [])]);
    if (result.code !== 0) throw new Error(`S1_BUILD_FAILED:${result.output}`);
  }
  const sourceHash = await sourcesHash();
  const binaryHash = createHash('sha256').update(await readFile(helperExecutable)).digest('hex');
  const launcherBinaryHash = createHash('sha256').update(await readFile(launcherExecutable)).digest('hex');
  await writeFile(path.join(evidenceDirectory, 'build.json'), JSON.stringify({ version: 3, sourceHash, binaryHash, launcherBinaryHash }, null, 2));
  return { helperExecutable, launcherExecutable, sourceHash, binaryHash, launcherBinaryHash };
}

async function sourcesHash() {
  const hash = createHash('sha256');
  for (const source of [helperSource, identitySource, launcherSource, appIdentitySource]) {
    const bytes = await readFile(source); hash.update(`${path.basename(source)}:${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}

async function verifyBuild() {
  await assertOwnedPath(helperExecutable);
  await assertOwnedPath(launcherExecutable);
  const record = JSON.parse(await readFile(path.join(evidenceDirectory, 'build.json'), 'utf8').catch(() => { throw new Error('S1_BUILD_REQUIRED'); }));
  const sourceHash = await sourcesHash();
  const binaryHash = createHash('sha256').update(await readFile(helperExecutable)).digest('hex');
  const launcherBinaryHash = createHash('sha256').update(await readFile(launcherExecutable)).digest('hex');
  if (record.version !== 3 || record.sourceHash !== sourceHash || record.binaryHash !== binaryHash || record.launcherBinaryHash !== launcherBinaryHash) throw new Error('S1_BUILD_STALE');
}

export async function inspectHost({ testLauncher = false } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('S1_REQUIRES_WINDOWS_X64');
  if (typeof testLauncher !== 'boolean') throw new Error('S1_INVALID_TEST_LAUNCHER');
  await verifyBuild();
  const result = await captureProcess(testLauncher ? launcherExecutable : helperExecutable, ['--status']);
  if (result.code !== 0) throw new Error(`S1_STATUS_FAILED:${result.output}`);
  const status = JSON.parse(result.output);
  if (testLauncher && (status.elevated !== false || status.testIdentity?.verified !== true)) throw new Error('S1_TEST_IDENTITY_NOT_RESTRICTED');
  return status;
}

export async function createFixture() {
  await assertOwnedPath(evidenceDirectory);
  const id = randomUUID().replaceAll('-', '');
  const runDirectory = await assertOwnedPath(path.join(evidenceDirectory, 'runs', id));
  await mkdir(runDirectory, { recursive: true });
  for (const name of ['workspace', 'runtime', 'temp']) await mkdir(path.join(runDirectory, name));
  // Existing local runtime only; no download, installation or workspace copy.
  await copyFile(process.execPath, path.join(runDirectory, 'runtime', 'node.exe'));
  await writeFile(path.join(runDirectory, 's1-owner.json'), JSON.stringify({ id }));
  return { id, runDirectory, workspace: path.join(runDirectory, 'workspace'), node: path.join(runDirectory, 'runtime', 'node.exe') };
}

export async function cleanupFixture(fixture, { testLauncher = false } = {}) {
  if (typeof testLauncher !== 'boolean') throw new Error('S1_INVALID_TEST_LAUNCHER');
  await assertOwnedPath(fixture.runDirectory);
  await verifyBuild();
  const result = await captureProcess(testLauncher ? launcherExecutable : helperExecutable, ['--cleanup', fixture.runDirectory]);
  let event;
  try { event = JSON.parse(result.output.trim()); } catch { throw new Error('S1_CLEANUP_PROTOCOL_FAILED'); }
  if (result.code !== 0 || event.type !== 'cleaned') throw new Error(`S1_CLEANUP_FAILED:${event.code ?? result.code}`);
  return event;
}

export function assertIdentityEvidence(identity, profile) {
  if (!['lpac', 'appcontainer'].includes(profile) || identity?.method !== 'access_check_controls' || identity.verified !== true || identity.observedProfile !== profile
    || identity.packageMatches !== true || identity.userMatches !== true || identity.userOnlyDenied !== true || identity.packageAllowed !== true
    || identity.allApplicationPackagesAllowed !== (profile === 'appcontainer')) throw new Error('S1_SANDBOX_IDENTITY_UNVERIFIED');
}

/** No default native executor, retries, SDK transport or production imports. */
export async function runPoc(options = {}, dependencies = {}) {
  const policy = selectPocPolicy(options);
  if (!policy.launchPoc) return { type: 'not_started', policy };
  if (options.testLauncher !== undefined && typeof options.testLauncher !== 'boolean') throw new Error('S1_INVALID_TEST_LAUNCHER');
  if (options.expectedIdentityProfile !== undefined && !['lpac', 'appcontainer'].includes(options.expectedIdentityProfile)) throw new Error('S1_INVALID_IDENTITY_EXPECTATION');
  if (options.probeLegacyQuery !== undefined && typeof options.probeLegacyQuery !== 'boolean') throw new Error('S1_INVALID_IDENTITY_PROBE');
  if (options.identityOnly !== undefined && typeof options.identityOnly !== 'boolean') throw new Error('S1_INVALID_IDENTITY_ONLY');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('S1_REQUIRES_WINDOWS_X64');
  options.signal?.throwIfAborted();
  const { fixture, executable, args = [], profile = 'appcontainer', runtimeKind = 'node', timeoutMs = 30_000 } = options;
  if (profile !== 'appcontainer') throw new Error('S1_PROFILE_NOT_SUPPORTED');
  if (!['node', 'python', 'electron'].includes(runtimeKind)) throw new Error('S1_INVALID_RUNTIME_KIND');
  if (!fixture || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('S1_INVALID_REQUEST');
  await assertOwnedPath(fixture.runDirectory);
  const owner = JSON.parse(await readFile(path.join(fixture.runDirectory, 's1-owner.json'), 'utf8'));
  if (owner.id !== fixture.id || !/^[a-f0-9]{32}$/.test(fixture.id) || path.basename(fixture.runDirectory) !== fixture.id) throw new Error('S1_INVALID_OWNER');
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw new Error('S1_ABSOLUTE_EXECUTABLE_REQUIRED');
  const ownRuntime = inside(path.join(fixture.runDirectory, 'runtime'), executable);
  const powerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!ownRuntime && executable.toLowerCase() !== powerShell.toLowerCase()) throw new Error('S1_EXECUTABLE_NOT_ALLOWED');
  await verifyBuild();
  options.signal?.throwIfAborted();
  // One fixture, one launch. A duplicate must not recover/revoke a live run.
  await writeFile(path.join(fixture.runDirectory, 'launch.claim'), fixture.id, { flag: 'wx' });
  const request = { version: 1, id: fixture.id, ownerPid: process.pid, runDirectory: fixture.runDirectory, executable, args, profile, runtimeKind, expectedIdentityProfile: options.expectedIdentityProfile ?? profile, probeLegacyQuery: options.probeLegacyQuery ?? false, identityOnly: options.identityOnly ?? false, allowNetwork: policy.network === 'allowed', timeoutMs };
  const spawnHelper = dependencies.spawnHelper ?? spawn;
  const child = spawnHelper(options.testLauncher ? launcherExecutable : helperExecutable, options.testLauncher ? ['--fixture', fixture.runDirectory] : [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let result;
  let helperError;
  let protocolError;
  let started = false;
  let stderr = '';
  const events = [];
  const control = event => { if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify(event)}\n`); };
  child.stdin.on('error', () => undefined); // A failed/closed helper is handled by close/error below.
  const abort = () => control({ type: 'cancel' });
  options.signal?.addEventListener('abort', abort, { once: true });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      if (line.length > 128 * 1024) throw new Error('S1_PROTOCOL_LIMIT');
      const event = JSON.parse(line);
      if (event.type === 'ready') {
        if (started) throw new Error('S1_DUPLICATE_READY');
        if (options.testLauncher && (event.testIdentity?.verified !== true || event.elevated !== false)) throw new Error('S1_TEST_IDENTITY_NOT_RESTRICTED');
        if (options.identityOnly) throw new Error('S1_IDENTITY_ONLY_RESUMED');
        assertIdentityEvidence(event.identity, profile);
        started = true; events.push(event);
        options.onReady?.(event, data => control({ type: 'stdin', data: Buffer.from(data).toString('base64') }));
      } else if (event.type === 'stdout' || event.type === 'stderr') {
        options.onOutput?.(event.type, Buffer.from(event.data, 'base64'));
      } else if (event.type === 'identity_result') {
        if (!options.identityOnly || event.started !== false || started) throw new Error('S1_INVALID_IDENTITY_RESULT');
        if (options.testLauncher && event.testIdentity?.verified !== true) throw new Error('S1_TEST_IDENTITY_NOT_RESTRICTED');
        assertIdentityEvidence(event.identity, profile); result = event;
      } else if (event.type === 'result') {
        if (options.identityOnly) throw new Error('S1_INVALID_IDENTITY_RESULT'); result = event;
      }
      else if (event.type === 'error') helperError ??= event;
      else throw new Error('S1_INVALID_EVENT');
    } catch (error) { protocolError = error; abort(); }
  });
  child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString(); });
  const watchdog = setTimeout(() => { protocolError = new Error('S1_HELPER_UNRESPONSIVE'); child.kill(); }, timeoutMs + 5_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
      control(request);
      if (options.signal?.aborted) abort();
    });
  } finally {
    clearTimeout(watchdog); options.signal?.removeEventListener('abort', abort); lines.close(); child.stdin.destroy();
  }
  if (protocolError || helperError || !result || code !== 0) {
    // A dead helper's Job closes automatically. Recover only ACL/profile state,
    // never execute the request again. Elevated refusals created no OS state.
    let cleanup;
    if (helperError?.code !== 'S1_ELEVATED_HELPER_REFUSED' && helperError?.code !== 'S1_RUN_ALREADY_USED') {
      const journal = await lstat(path.join(fixture.runDirectory, 'request.json')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!journal) cleanup = { type: 'not_needed' }; // Validation failed before any OS mutation.
      else {
        try { cleanup = await cleanupFixture(fixture, options); } catch (error) { cleanup = { type: 'cleanup_failed', message: error.message }; }
      }
    }
    const error = new Error(helperError?.code ?? protocolError?.message ?? `S1_HELPER_FAILED:${code}:${stderr}`);
    Object.assign(error, { started, events, cleanup, helperError });
    throw error;
  }
  return { ...result, policy, events };
}

export function parseOptions(argv) {
  const options = { enabled: false, allowNetwork: false, testLauncher: false, permissionMode: 'manual', profile: 'appcontainer', planMode: 'default' };
  const flags = new Map([['--enabled', 'enabled'], ['--allow-network', 'allowNetwork'], ['--test-launcher', 'testLauncher']]);
  const values = new Map([['--mode', 'permissionMode'], ['--profile', 'profile'], ['--plan-mode', 'planMode'], ['--network-url', 'networkUrl'], ['--python-runtime', 'pythonRuntime'], ['--electron-runtime', 'electronRuntime']]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error('S1_DUPLICATE_OPTION');
    seen.add(flag);
    if (flags.has(flag)) options[flags.get(flag)] = true;
    else if (values.has(flag) && argv[index + 1] && !argv[index + 1].startsWith('--')) options[values.get(flag)] = argv[++index];
    else throw new Error(`S1_UNKNOWN_OPTION:${flag}`);
  }
  selectPocPolicy(options);
  if (options.profile !== 'appcontainer') throw new Error('S1_PROFILE_NOT_SUPPORTED');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--build') console.log(JSON.stringify(await buildHelper(), null, 2));
    else if (process.argv[2] === '--status' && (process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--test-launcher'))) console.log(JSON.stringify(await inspectHost({ testLauncher: process.argv.length === 4 }), null, 2));
    else {
      const options = parseOptions(process.argv.slice(2));
      const policy = selectPocPolicy(options);
      if (!policy.launchPoc) console.log(JSON.stringify({ type: 'not_started', policy, production: 'unchanged' }, null, 2));
      else {
        const host = await inspectHost(options);
        if (host.elevated) throw new Error('S1_ELEVATED_HELPER_REFUSED: use a non-administrator terminal');
        const fixture = await createFixture();
        const result = await runPoc({ ...options, fixture, executable: fixture.node, args: ['-e', "require('node:fs').writeFileSync('s1-result.txt','S1 direct workspace write'); console.log('S1_OK')"], onOutput: (type, bytes) => process[type].write(bytes) });
        console.log(JSON.stringify({ ...result, runDirectory: fixture.runDirectory }, null, 2));
        if (!result.succeeded) process.exitCode = 1;
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
