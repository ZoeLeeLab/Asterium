import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import type { McpLaunchRequest } from '../api/extensions/ExtensionLaunchBackend';
import type { RunningSandboxProcess, WindowsSandboxProcess } from './WindowsSandboxProcess';

/** SDK transport over the sole helper-owned process. No SDK stdio launcher/probes. */
export class SandboxMcpTransport implements Transport {
  readonly execution: { backend: 'sandbox'; sandboxed: boolean; policyKey: string };
  onclose?: Transport['onclose']; onerror?: Transport['onerror']; onmessage?: Transport['onmessage'];
  private readonly buffer = new ReadBuffer({ maxBufferSize: 2 * 1024 * 1024 });
  private readonly abort = new AbortController();
  private running?: RunningSandboxProcess;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  constructor(private readonly processes: WindowsSandboxProcess, private readonly request: McpLaunchRequest) {
    this.execution = { backend: 'sandbox', sandboxed: false, policyKey: request.sandboxPolicy?.policyKey ?? 'unprepared' };
  }
  start(): Promise<void> {
    if (this.starting || this.closed) return Promise.reject(new Error('SANDBOX_MCP_ALREADY_STARTED_OR_CLOSED'));
    return this.starting = this.open();
  }
  private async open() {
    const request = this.request, configuration = request.configuration;
    if (configuration.type !== 'mcp_stdio' || !request.context?.workspace || !request.sandboxPolicy) throw new Error('SANDBOX_CONTEXT_REQUIRED');
    const cwd = configuration.cwd ?? request.context.workspace.cwd;
    if (!cwd) throw new Error('MCP_AUTHORIZED_WORKSPACE_REQUIRED');
    const executable = await resolveSandboxExecutable(configuration.command);
    const isNode = /^node(?:\.exe)?$/i.test(path.basename(executable)) || request.secrets.ELECTRON_RUN_AS_NODE === '1';
    // Only our known Electron image needs its NUL-dependent stdio initialization
    // skipped. The helper already supplies inherited pipes; no authority changes.
    const isBundledElectron = process.platform === 'win32' && Boolean(process.versions.electron)
      && request.secrets.ELECTRON_RUN_AS_NODE === '1'
      && executable.toLowerCase() === (await realpath(process.execPath)).toLowerCase();
    const signal = AbortSignal.any([request.signal, this.abort.signal]); signal.throwIfAborted();
    this.running = await this.processes.launch({ context: request.context, executable,
      args: [...(isBundledElectron ? ['--no-stdio-init'] : []), ...(isNode ? ['--preserve-symlinks-main'] : []), ...configuration.args], cwd,
      readOnlyRoots: [path.dirname(executable)], environment: request.secrets, allowNetwork: request.sandboxPolicy.allowNetwork,
      timeoutMs: 0, outputLimitBytes: 0, signal, beforeStart: request.beforeStart });
    this.execution.sandboxed = true;
    this.running.stderr.resume(); // Never expose credential-bearing server diagnostics.
    this.running.stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk); let message;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch { this.onerror?.(new Error('SANDBOX_MCP_INVALID_OR_OVERSIZE_MESSAGE')); void this.close().catch(() => undefined); }
    });
    void this.running.completed.then(() => this.notifyClosed(), () => { this.onerror?.(new Error('SANDBOX_MCP_PROCESS_FAILED')); this.notifyClosed(); });
    if (signal.aborted || this.closed) { await this.running.close(); throw new Error('SANDBOX_MCP_CANCELLED'); }
  }
  async send(message: JSONRPCMessage) {
    if (!this.running || this.closed || this.closing) throw new Error('SANDBOX_MCP_NOT_READY');
    const bytes = Buffer.from(serializeMessage(message));
    if (bytes.length > 2 * 1024 * 1024) throw new Error('SANDBOX_MCP_MESSAGE_LIMIT');
    try { await this.running.send(bytes); }
    catch { this.onerror?.(new Error('SANDBOX_MCP_SEND_FAILED')); await this.close(); throw new Error('SANDBOX_MCP_SEND_FAILED'); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.abort.abort();
    return this.closing = (async () => {
      try { await this.starting?.catch(() => undefined); await this.running?.close(); }
      finally { this.buffer.clear(); this.notifyClosed(); }
    })();
  }
  private notified = false;
  private notifyClosed() { this.closed = true; if (!this.notified) { this.notified = true; this.onclose?.(); } }
}

export async function resolveSandboxExecutable(command: string) {
  if (/\.(cmd|bat|ps1|mjs|cjs|js|py)$/i.test(command)) throw new Error('SANDBOX_LAUNCHER_NOT_SUPPORTED');
  const candidates = path.isAbsolute(command) ? [command] : /^[A-Za-z0-9_.-]+$/.test(command)
    ? (process.env.PATH ?? '').split(path.delimiter).filter(folder => path.isAbsolute(folder) && !/[\\/]Microsoft[\\/]WindowsApps(?:[\\/]|$)/i.test(folder)).slice(0, 128)
      .flatMap(folder => [path.join(folder, command.endsWith('.exe') ? command : `${command}.exe`)]) : [];
  for (const candidate of candidates) {
    const resolved = await realpath(candidate).catch(() => undefined);
    if (resolved && /\.exe$/i.test(resolved) && (await stat(resolved)).isFile()) return resolved;
  }
  throw new Error('SANDBOX_EXECUTABLE_UNAVAILABLE');
}
