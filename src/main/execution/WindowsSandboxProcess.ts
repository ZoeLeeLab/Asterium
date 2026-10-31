import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import type { ExecutionContext } from './ExecutionContext';

const hostSchema = z.object({ version: z.literal(2), elevated: z.boolean(), appContainer: z.boolean(), adminGroupsEnabled: z.boolean(), integrityRid: z.number(), hostAllowed: z.boolean() });
const identitySchema = z.object({ method: z.literal('access_check_controls'), verified: z.literal(true), observedProfile: z.literal('appcontainer'), packageMatches: z.literal(true), userMatches: z.literal(true), userOnlyDenied: z.literal(true), packageAllowed: z.literal(true), allApplicationPackagesAllowed: z.literal(true) });
const resultSchema = z.object({ type: z.literal('result'), reason: z.enum(['exited', 'cancelled', 'timeout', 'output_limit', 'owner_exited']), exitCode: z.number().int(), cleanup: z.literal('confirmed'), started: z.boolean(), profile: z.literal('appcontainer'), network: z.enum(['allowed', 'blocked']) });
export type SandboxResult = z.infer<typeof resultSchema>;
export interface SandboxProcessRequest {
  beforeStart?: () => Promise<void>;
  context: ExecutionContext; executable: string; args: string[]; cwd: string;
  readOnlyRoots: string[]; environment: Record<string, string>; allowNetwork: boolean;
  timeoutMs: number; outputLimitBytes: number; signal: AbortSignal;
}
export interface RunningSandboxProcess {
  readonly pid: number; stdout: PassThrough; stderr: PassThrough;
  completed: Promise<SandboxResult>; send(bytes: Uint8Array): Promise<void>; close(): Promise<void>;
}
const inside = (root: string, child: string) => { const relative = path.relative(root, child); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const codeOf = (error: unknown) => error instanceof Error && /^SANDBOX_[A-Z_]+$/.test(error.message) ? error.message : 'SANDBOX_HELPER_FAILED';

export class WindowsSandboxProcess {
  private recovery?: Promise<void>;
  constructor(readonly helperDirectory: string, readonly stateRoot: string, private readonly protectedRoots: readonly string[]) {}

  private async noLinks(candidate: string, systemPowerShellExecutable = false) {
    const absolute = path.resolve(candidate); let cursor = path.parse(absolute).root;
    // Windows services its fixed PowerShell executable through a WinSxS hardlink.
    // Only executing that exact leaf is allowed; no ACL is granted to it here.
    // Helpers, grant roots and every reparse component keep the strict checks.
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const allowSystemHardlink = systemPowerShellExecutable && absolute.toLowerCase() === powershell.toLowerCase();
    for (const component of path.relative(cursor, absolute).split(path.sep)) {
      cursor = path.join(cursor, component);
      const info = await lstat(cursor).catch(error => { if (missing(error)) return undefined; throw error; });
      if (info?.isSymbolicLink() || (info?.isFile() && info.nlink !== 1 && !(allowSystemHardlink && cursor === absolute && info.nlink > 1))) throw new Error('SANDBOX_REPARSE_OR_HARDLINK_PATH');
    }
  }
  private async executable() {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('SANDBOX_PLATFORM_UNSUPPORTED');
    const executable = path.join(this.helperDirectory, 'AsteriumSandboxHelper.exe');
    await this.noLinks(executable);
    await this.noLinks(path.join(this.helperDirectory, 'manifest.json'));
    const manifest = z.object({ version: z.literal(2), architecture: z.literal('x64'), executableSha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(JSON.parse(await readFile(path.join(this.helperDirectory, 'manifest.json'), 'utf8').catch(() => { throw new Error('SANDBOX_HELPER_MISSING'); })));
    const actual = createHash('sha256').update(await readFile(executable).catch(() => { throw new Error('SANDBOX_HELPER_MISSING'); })).digest('hex');
    if (actual !== manifest.executableSha256) throw new Error('SANDBOX_HELPER_INTEGRITY_FAILED');
    return executable;
  }
  private environment(): NodeJS.ProcessEnv {
    const windows = process.env.SystemRoot ?? 'C:\\Windows';
    return { SystemRoot: windows, WINDIR: windows, PATH: path.join(windows, 'System32') };
  }
  private capture(executable: string, args: string[]) {
    return new Promise<string>((resolve, reject) => execFile(executable, args, { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, env: this.environment() }, (error, stdout) => {
      if (error) { reject(new Error('SANDBOX_HELPER_CONTROL_FAILED')); return; } resolve(stdout);
    }));
  }
  async inspectHost() {
    const executable = await this.executable();
    return hostSchema.parse(JSON.parse(await this.capture(executable, ['--status'])));
  }
  private async preflight() {
    const executable = await this.executable();
    const host = hostSchema.parse(JSON.parse(await this.capture(executable, ['--status'])));
    // This occurs BEFORE mkdir, recovery, ACL/profile changes or target creation.
    if (host.elevated) throw new Error('SANDBOX_ELEVATED_HOST_REFUSED');
    if (!host.hostAllowed || host.appContainer || host.adminGroupsEnabled || host.integrityRid !== 8192) throw new Error('SANDBOX_HOST_IDENTITY_REFUSED');
    return executable;
  }
  private async roots(request: SandboxProcessRequest) {
    const scope = request.context.workspace;
    if (!scope?.workspaceFolders.length || scope.workspaceFolders.length > 16) throw new Error('SANDBOX_AUTHORIZED_WORKSPACE_REQUIRED');
    const roots = [...new Set(await Promise.all(scope.workspaceFolders.map(async root => {
      if (!path.isAbsolute(root)) throw new Error('SANDBOX_WORKSPACE_INVALID');
      await this.noLinks(root); const canonical = await realpath(root);
      if (canonical === path.parse(canonical).root || inside(canonical, os.homedir())) throw new Error('SANDBOX_WORKSPACE_TOO_BROAD');
      for (const protectedRoot of [...this.protectedRoots, this.stateRoot]) if (inside(canonical, path.resolve(protectedRoot)) || inside(path.resolve(protectedRoot), canonical)) throw new Error('SANDBOX_PROTECTED_WORKSPACE');
      return canonical;
    })))];
    await this.noLinks(request.cwd); const cwd = await realpath(request.cwd);
    if (!roots.some(root => inside(root, cwd))) throw new Error('SANDBOX_CWD_OUTSIDE_WORKSPACE');
    if (!path.isAbsolute(request.executable) || request.args.length > 128 || request.args.some(arg => arg.includes('\0'))) throw new Error('SANDBOX_EXECUTABLE_OR_ARGUMENT_INVALID');
    await this.noLinks(request.executable, true);
    const executable = await realpath(request.executable);
    const readOnlyRoots = await Promise.all(request.readOnlyRoots.map(async root => { await this.noLinks(root); return realpath(root); }));
    return { roots, cwd, executable, readOnlyRoots };
  }
  private async recover(executable: string) {
    await this.noLinks(this.stateRoot); await mkdir(path.join(this.stateRoot, 'runs'), { recursive: true });
    for (const id of await readdir(path.join(this.stateRoot, 'runs'))) {
      if (!/^[a-f0-9]{32}$/.test(id)) continue;
      const directory = path.join(this.stateRoot, 'runs', id); await this.noLinks(directory);
      const journal = await lstat(path.join(directory, 'request.json')).catch(error => { if (missing(error)) return undefined; throw error; });
      const cleaned = await lstat(path.join(directory, 'cleaned.json')).catch(error => { if (missing(error)) return undefined; throw error; });
      if (journal && !cleaned) await this.cleanup(executable, directory);
    }
  }
  private async cleanup(executable: string, directory: string) {
    try {
      const value = JSON.parse(await this.capture(executable, ['--state-root', this.stateRoot, '--cleanup', directory]));
      if (value.type !== 'cleaned') throw new Error();
      await writeFile(path.join(directory, 'cleaned.json'), JSON.stringify({ cleaned: true }));
    } catch { throw new Error('SANDBOX_CLEANUP_FAILED'); }
  }

  async launch(request: SandboxProcessRequest): Promise<RunningSandboxProcess> {
    request.signal.throwIfAborted();
    const helper = await this.preflight();
    const resources = await this.roots(request);
    request.signal.throwIfAborted();
    await (this.recovery ??= this.recover(helper));
    const id = randomUUID().replaceAll('-', '');
    const directory = path.join(this.stateRoot, 'runs', id);
    await mkdir(path.join(directory, 'temp'), { recursive: true });
    await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ id }), { flag: 'wx' });
    request.signal.throwIfAborted();
    const descriptor = { version: 2, ownerPid: process.pid, id, runDirectory: directory, executable: resources.executable, args: request.args, cwd: resources.cwd,
      readWriteRoots: resources.roots, readOnlyRoots: resources.readOnlyRoots, environment: request.environment, allowNetwork: request.allowNetwork, timeoutMs: request.timeoutMs, outputLimitBytes: request.outputLimitBytes };
    const child = spawn(helper, ['--state-root', this.stateRoot], { windowsHide: true, shell: false, env: this.environment(), stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = new PassThrough({ highWaterMark: 128 * 1024 }), stderr = new PassThrough({ highWaterMark: 128 * 1024 });
    let pid: number | undefined, preparedPid: number | undefined, result: SandboxResult | undefined, failure: Error | undefined;
    let readyResolve!: (value: RunningSandboxProcess) => void, readyReject!: (error: Error) => void;
    const ready = new Promise<RunningSandboxProcess>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let doneResolve!: (result: SandboxResult) => void, doneReject!: (error: Error) => void;
    const completed = new Promise<SandboxResult>((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
    // Ready may fail before callers have a completed handle.
    void completed.catch(() => undefined);
    const control = (value: unknown) => { if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(JSON.stringify(value) + '\n'); };
    const abort = () => control({ type: 'cancel' });
    const startup = setTimeout(() => { failure = new Error('SANDBOX_START_TIMEOUT'); abort(); child.kill(); }, 20_000);
    let cancelWatchdog: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      abort(); cancelWatchdog ??= setTimeout(() => { failure ??= new Error('SANDBOX_STOP_TIMEOUT'); child.kill(); }, 10_000);
    };
    request.signal.addEventListener('abort', cancel, { once: true });
    child.stdin.on('error', () => undefined); child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        if (line.length > 32 * 1024) throw new Error('SANDBOX_PROTOCOL_LIMIT');
        const event = JSON.parse(line);
        if (event.type === 'prepared' || event.type === 'ready') {
          if (pid || event.profileName !== `Asterium.Sandbox.${id}` || event.helperPid !== child.pid || event.appContainer !== true || event.elevated !== false || event.inJob !== true || !Number.isInteger(event.pid) || event.pid <= 0 || event.pid === child.pid || event.pid === process.pid) throw new Error('SANDBOX_IDENTITY_FAILED');
          identitySchema.parse(event.identity);
          if (event.network !== (request.allowNetwork ? 'allowed' : 'blocked')) throw new Error('SANDBOX_NETWORK_POLICY_FAILED');
          if (event.type === 'prepared') {
            if (preparedPid) throw new Error('SANDBOX_DUPLICATE_PREPARED'); preparedPid = event.pid;
            void (async () => {
              if (!request.beforeStart) throw new Error('SANDBOX_REVALIDATION_REQUIRED');
              await request.beforeStart(); request.signal.throwIfAborted();
              control({ type: 'start' });
            })().catch(() => { failure = new Error('SANDBOX_AUTHORITY_CHANGED'); cancel(); });
            return;
          }
          if (preparedPid !== event.pid) throw new Error('SANDBOX_UNPREPARED_START');
          pid = event.pid; clearTimeout(startup);
          readyResolve({ pid: event.pid, stdout, stderr, completed,
            send: async bytes => {
              if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('SANDBOX_INPUT_LIMIT');
              for (let offset = 0; offset < bytes.byteLength; offset += 32768) {
                if (child.stdin.destroyed || child.stdin.writableLength > 4 * 1024 * 1024) throw new Error('SANDBOX_INPUT_BACKPRESSURE');
                const value = JSON.stringify({ type: 'stdin', data: Buffer.from(bytes.subarray(offset, offset + 32768)).toString('base64') }) + '\n';
                await new Promise<void>((resolve, reject) => child.stdin.write(value, error => error ? reject(new Error('SANDBOX_INPUT_CLOSED')) : resolve()));
              }
            }, close: async () => { cancel(); await completed; } });
        } else if (event.type === 'stdout' || event.type === 'stderr') {
          if (typeof event.data !== 'string' || event.data.length > 8192) throw new Error('SANDBOX_PROTOCOL_LIMIT');
          const stream = event.type === 'stdout' ? stdout : stderr;
          if (!stream.write(Buffer.from(event.data, 'base64'))) { child.stdout.pause(); stream.once('drain', () => child.stdout.resume()); }
        } else if (event.type === 'result') {
          if (result) throw new Error('SANDBOX_DUPLICATE_RESULT'); result = resultSchema.parse(event);
          if (!result.started || result.network !== (request.allowNetwork ? 'allowed' : 'blocked')) throw new Error('SANDBOX_RESULT_POLICY_FAILED');
        }
        else if (event.type === 'error') { failure ??= new Error(typeof event.code === 'string' && /^SANDBOX_[A-Z_]+$/.test(event.code) ? event.code : 'SANDBOX_HELPER_FAILED'); }
        else throw new Error('SANDBOX_PROTOCOL_FAILED');
      } catch (error) { failure = new Error(codeOf(error)); cancel(); }
    });
    child.once('error', () => { failure ??= new Error('SANDBOX_HELPER_START_FAILED'); });
    child.once('close', code => {
      void (async () => {
        clearTimeout(startup); clearTimeout(cancelWatchdog); request.signal.removeEventListener('abort', cancel); lines.close(); child.stdin.destroy(); stdout.end(); stderr.end();
        if (!failure && result && code === 0 && pid) {
          try { await writeFile(path.join(directory, 'cleaned.json'), JSON.stringify({ cleaned: true })); }
          catch { failure = new Error('SANDBOX_CLEANUP_FAILED'); }
        } else {
          failure ??= new Error('SANDBOX_HELPER_FAILED');
          const journal = await lstat(path.join(directory, 'request.json')).catch(error => { if (missing(error)) return undefined; throw error; });
          if (journal) { try { await this.cleanup(helper, directory); } catch { failure = new Error('SANDBOX_CLEANUP_FAILED'); } }
        }
        if (failure) { readyReject(failure); doneReject(failure); } else if (result) doneResolve(result);
      })().catch(() => { const error = new Error('SANDBOX_CLEANUP_FAILED'); readyReject(error); doneReject(error); });
    });
    control(descriptor); if (request.signal.aborted) cancel();
    return ready;
  }
}
