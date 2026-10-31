import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ApiToolResult } from '../ApiToolRegistry';
import type { ExtensionLaunchBackend, LaunchedSkillScript } from './ExtensionLaunchBackend';
import type { SkillPackage } from './SkillPackageLoader';
import { executionGatewayFor, type ExecutionGateway } from '../../execution/ExecutionGateway';
import type { ExecutionContext } from '../../execution/ExecutionContext';

export function runnableSkillScripts(loaded: SkillPackage) {
  return [...loaded.files.keys()].filter((name) => name.startsWith('scripts/') && /\.(?:mjs|cjs|js|py|ps1)$/i.test(name));
}

/** Executes an immutable copy of the approved package, exclusively through the configured backend. */
export class SkillScriptRunner {
  readonly backend: ExecutionGateway;
  constructor(backend: ExtensionLaunchBackend, private readonly timeoutMs = 30_000, private readonly outputLimit = 64 * 1024) { this.backend = executionGatewayFor(backend); }
  async run(loaded: SkillPackage, script: string, args: string[], cwd: string, signal: AbortSignal, beforeLaunch: (launch: () => Promise<ApiToolResult>) => Promise<ApiToolResult>, context?: ExecutionContext, beforeStart?: () => Promise<void>): Promise<ApiToolResult> {
    signal.throwIfAborted();
    if (!runnableSkillScripts(loaded).includes(script)) throw new Error('SKILL_SCRIPT_UNAVAILABLE');
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'asterium-skill-run-'));
    const directory = await realpath(temporary);
    let launched: LaunchedSkillScript | undefined;
    const deadline = new AbortController(), outputAbort = new AbortController();
    const lifetime = AbortSignal.any([signal, deadline.signal, outputAbort.signal]);
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    try {
      for (const [relative, bytes] of loaded.files) {
        lifetime.throwIfAborted();
        const destination = path.join(directory, relative);
        const normalized = path.relative(directory, destination);
        if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) throw new Error('SKILL_PACKAGE_ESCAPE');
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o400 });
      }
      const filename = path.join(directory, script), extension = path.extname(script).toLowerCase();
      // Interpreter and flags are Main-owned. Model arguments never become shell code or interpreter flags.
      const invocation: { command: string; args: string[]; env: Record<string, string> } = extension === '.py' ? { command: await pythonExecutable(), args: ['-E', '-s', filename, ...args], env: {} }
        : extension === '.ps1' ? { command: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', filename, ...args], env: {} }
          : { command: process.execPath, args: [filename, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } };
      return await beforeLaunch(async () => {
        lifetime.throwIfAborted();
        launched = await this.backend.launchSkillScript({ ...invocation, cwd, env: { ...invocation.env, ASTERIUM_SKILL_DIRECTORY: directory }, signal: lifetime, beforeStart, ...(context ? { context } : {}) });
        const child = launched.process;
        let bytes = 0, output = '';
        const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
        const capture = (decoder: StringDecoder) => (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.outputLimit) { outputAbort.abort(); return; }
          output += decoder.write(chunk);
        };
        child.stdout?.on('data', capture(stdout)); child.stderr?.on('data', capture(stderr));
        const code = await new Promise<number | null>((resolve, reject) => {
          const failed = () => { cleanup(); reject(new Error('SKILL_SCRIPT_FAILED')); };
          const aborted = () => { cleanup(); reject(new Error(signal.aborted ? 'SKILL_SCRIPT_CANCELLED' : deadline.signal.aborted ? 'SKILL_SCRIPT_TIMEOUT' : 'SKILL_SCRIPT_OUTPUT_LIMIT')); };
          const closed = (value: number | null) => { cleanup(); resolve(value); };
          const cleanup = () => { child.removeListener('close', closed); child.removeListener('error', failed); lifetime.removeEventListener('abort', aborted); };
          child.once('close', closed); child.once('error', failed); lifetime.addEventListener('abort', aborted, { once: true });
          if (lifetime.aborted) aborted();
          else if (child.exitCode !== null || child.signalCode !== null) closed(child.exitCode);
        });
        output += stdout.end() + stderr.end();
        const execution = launched.execution ?? { backend: this.backend.id, sandboxed: this.backend.sandboxed };
        return { content: JSON.stringify({ exitCode: code, output, ...execution }), execution, isError: code !== 0 };
      });
    } finally {
      clearTimeout(timer);
      try { await launched?.close(); } finally { await removeSnapshot(directory); }
    }
  }
}

async function removeSnapshot(directory: string) {
  const resolved = await realpath(directory);
  if (resolved.toLowerCase() !== directory.toLowerCase() || path.dirname(resolved).toLowerCase() !== (await realpath(os.tmpdir())).toLowerCase()
    || !path.basename(resolved).startsWith('asterium-skill-run-')) throw new Error('SKILL_CLEANUP_PATH_INVALID');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function pythonExecutable() {
  // Resolve only absolute PATH entries. Windows Store aliases can open UI instead of running a script.
  for (const folder of (process.env.PATH ?? '').split(path.delimiter).slice(0, 128)) {
    if (!path.isAbsolute(folder)) continue;
    const candidate = await realpath(path.join(folder, process.platform === 'win32' ? 'python.exe' : 'python3')).catch(() => undefined);
    if (!candidate || /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(candidate)) continue;
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isFile() && info.size > 0) return candidate;
  }
  throw new Error('SKILL_PYTHON_UNAVAILABLE');
}
