import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { homedir } from 'node:os';
import { StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import type { ExtensionConfiguration } from '../../../shared/apiExtensions';
import type { ExecutionContext } from '../../execution/ExecutionContext';
import type { NativeCommandApproval } from '../../execution/NativeCommandApproval';

export type McpConfiguration = Exclude<ExtensionConfiguration, { type: 'skill' }>;
export interface SandboxLaunchPolicy { allowNetwork: boolean; policyKey: string; }
export interface McpLaunchRequest {
  beforeStart?: () => Promise<void>;
  sandboxPolicy?: SandboxLaunchPolicy;
  context?: ExecutionContext;
  configuration: McpConfiguration;
  secrets: Record<string, string>;
  signal: AbortSignal;
}
export interface SkillScriptLaunchRequest {
  beforeStart?: () => Promise<void>;
  sandboxPolicy?: SandboxLaunchPolicy;
  context?: ExecutionContext;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
}
export interface ScriptProcess {
  readonly stdout: Readable | null; readonly stderr: Readable | null;
  readonly pid?: number; readonly exitCode: number | null; readonly signalCode: NodeJS.Signals | null;
  once(event: 'close', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'close', listener: (code: number | null) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
}
export interface LaunchedSkillScript {
  process: ScriptProcess;
  close(): Promise<void>;
  execution?: { backend: 'native' | 'sandbox'; sandboxed: boolean };
}
export type ExecutionTransport = Transport & { execution?: { backend: 'native' | 'sandbox'; sandboxed: boolean; policyKey: string } };
export interface CommandLaunchRequest { command: string; cwd: string; signal: AbortSignal; context?: ExecutionContext; nativeApproval?: NativeCommandApproval; sandboxPolicy?: SandboxLaunchPolicy; beforeStart?: () => Promise<void>; onStarted?: (execution: { backend: 'native' | 'sandbox'; sandboxed: boolean }) => void; }

/** The selected backend owns every transport/process creation. Failure must never select another backend. */
export interface ExtensionLaunchBackend {
  readonly id: 'native' | 'sandbox';
  readonly sandboxed: boolean;
  createMcpTransport(request: McpLaunchRequest): Transport | Promise<Transport>;
  launchSkillScript(request: SkillScriptLaunchRequest): Promise<LaunchedSkillScript>;
  /** Optional only for pre-command extension backend implementations; absence never falls back. */
  runCommand?(request: CommandLaunchRequest): Promise<string>;
}

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export class NativeExtensionLaunchBackend implements ExtensionLaunchBackend {
  readonly id = 'native' as const;
  readonly sandboxed = false;

  runCommand({ command, cwd, signal, onStarted }: CommandLaunchRequest) {
    return runPowerShell(command, cwd, signal, () => onStarted?.({ backend: 'native', sandboxed: false }));
  }

  createMcpTransport({ configuration, secrets, signal }: McpLaunchRequest): Transport {
    signal.throwIfAborted();
    if (configuration.type === 'mcp_http') {
      if (Object.keys(secrets).some((name) => ['mcp-session-id', 'mcp-protocol-version'].includes(name.toLowerCase()))) throw new Error('MCP_HTTP_MANAGED_HEADER');
      const url = new URL(configuration.url);
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: secrets, redirect: 'error', credentials: 'omit' },
        fetch: boundedMcpFetch(url, signal),
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
      });
      const close = transport.close.bind(transport);
      let closing: Promise<void> | undefined;
      transport.close = () => closing ??= Promise.resolve().then(async () => {
        try { if (transport.sessionId) await transport.terminateSession(); }
        catch { /* A server may not support DELETE. Local transport still closes. */ }
        finally { await close(); }
      });
      return transport;
    }
    const transport = new StdioClientTransport({
      command: configuration.command, args: configuration.args,
      // Never inherit Asterium's working directory or its complete environment.
      cwd: configuration.cwd ?? homedir(),
      env: { ...getDefaultEnvironment(), ...secrets }, stderr: 'ignore', maxBufferSize: MAX_MESSAGE_BYTES,
    });
    const close = transport.close.bind(transport);
    transport.close = async () => {
      // On Windows launchers such as npx can own descendants. Kill the live tree before SDK close clears its pid.
      const pid = transport.pid;
      if (pid && process.platform === 'win32') await killWindowsTree(pid);
      await close();
    };
    return transport;
  }

  async launchSkillScript(request: SkillScriptLaunchRequest): Promise<LaunchedSkillScript> {
    request.signal.throwIfAborted();
    const child = spawn(request.command, request.args, {
      cwd: request.cwd, env: { ...getDefaultEnvironment(), ...request.env },
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
    });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') await killWindowsTree(child.pid);
        else child.kill('SIGKILL');
        if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => {
          const finished = () => { clearTimeout(timer); child.removeListener('exit', finished); resolve(); };
          const timer = setTimeout(finished, 5_000); child.once('exit', finished);
          if (child.exitCode !== null || child.signalCode !== null) finished();
        });
      }
    })();
    const abort = () => { void close().catch(() => undefined); };
    request.signal.addEventListener('abort', abort, { once: true });
    child.once('exit', () => request.signal.removeEventListener('abort', abort));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => { request.signal.removeEventListener('abort', abort); reject(new Error('EXTENSION_SCRIPT_START_FAILED')); });
    });
    if (request.signal.aborted) { await close(); request.signal.throwIfAborted(); }
    return { process: child, close };
  }
}

function boundedMcpFetch(endpoint: URL, lifetime: AbortSignal): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== endpoint.origin) throw new Error('MCP_HTTP_ORIGIN_BLOCKED');
    // Session teardown remains possible after the operation was cancelled, with its own short deadline.
    const scope = request.method === 'DELETE' ? AbortSignal.timeout(2_000) : lifetime;
    const response = await fetch(request, { redirect: 'error', credentials: 'omit', signal: AbortSignal.any([request.signal, scope]) });
    if (!response.body) return response;
    const sse = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream');
    if (!sse && Number(response.headers.get('content-length')) > MAX_MESSAGE_BYTES) {
      await response.body.cancel(); throw new Error('MCP_HTTP_RESPONSE_TOO_LARGE');
    }
    let received = 0; let lineBytes = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (sse) {
          // Bound each SSE frame, retaining long-lived notification streams across many small frames.
          for (const byte of chunk) {
            if (++received > MAX_MESSAGE_BYTES) throw new Error('MCP_HTTP_RESPONSE_TOO_LARGE');
            if (byte === 10) { if (lineBytes === 0) received = 0; lineBytes = 0; }
            else if (byte !== 13) lineBytes++;
          }
        } else {
          received += chunk.byteLength;
          if (received > MAX_MESSAGE_BYTES) throw new Error('MCP_HTTP_RESPONSE_TOO_LARGE');
        }
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function killWindowsTree(pid: number) {
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.once('exit', () => resolve()); killer.once('error', () => resolve());
  });
}

const COMMAND_RESULT_LIMIT = 64 * 1024;
function runPowerShell(command: string, cwd: string, signal: AbortSignal, onStarted: () => void) {
  return new Promise<string>((resolve, reject) => {
    // CWD validation can suspend after the registry's initial cancellation check.
    if (signal.aborted) return reject(Object.assign(new Error('ABORTED'), { name: 'AbortError' }));
    const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, windowsHide: true });
    child.once('spawn', onStarted);
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer) => { if (output.length < COMMAND_RESULT_LIMIT + 1024) output += chunk.toString('utf8'); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const stop = () => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 120_000);
    const onAbort = () => stop();
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return reject(Object.assign(new Error('ABORTED'), { name: 'AbortError' }));
      if (timedOut) return reject(new Error('TOOL_COMMAND_TIMEOUT'));
      const result = truncateCommandResult(output || `(exit ${code ?? -1})`);
      if (code !== 0) return reject(new Error(`TOOL_COMMAND_FAILED:${code ?? -1}:${result}`));
      resolve(result);
    });
  });
}

function truncateCommandResult(value: string) {
  return value.length <= COMMAND_RESULT_LIMIT ? value : `${value.slice(0, COMMAND_RESULT_LIMIT)}\n[输出已截断]`;
}
