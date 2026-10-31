import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { Transport } from '@modelcontextprotocol/client';
import type { CommandLaunchRequest, ExtensionLaunchBackend, LaunchedSkillScript, McpLaunchRequest, ScriptProcess, SkillScriptLaunchRequest } from '../api/extensions/ExtensionLaunchBackend';
import { WindowsSandboxProcess } from './WindowsSandboxProcess';
import { SandboxMcpTransport } from './SandboxMcpTransport';
import { sandboxSkillPowerShellArgs } from './sandboxSkillPowerShell';

const powerShellLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const workspaceDrive = 'AsteriumWorkspace';

function commandLocation(request: CommandLaunchRequest) {
  const paths = path.win32.isAbsolute(request.cwd) ? path.win32 : path.posix;
  const cwd = paths.resolve(request.cwd);
  const roots = request.context?.workspace?.workspaceFolders;
  if (!roots?.length) throw new Error('SANDBOX_AUTHORIZED_WORKSPACE_REQUIRED');
  // This selects a shell namespace, not authority: the process service/helper
  // still independently validate real paths, grants and the final start guard.
  const root = roots.filter(root => paths.isAbsolute(root)).map(root => paths.resolve(root)).filter(root => {
    const relative = paths.relative(root, cwd);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
  }).sort((a, b) => a.length - b.length)[0];
  if (!root) throw new Error('SANDBOX_CWD_OUTSIDE_WORKSPACE');
  const relative = paths.relative(root, cwd).split(paths.sep).join('\\');
  return { root, cwd, location: `${workspaceDrive}:\\${relative}` };
}

/** Only local sandbox execution. No Native executor is reachable from this class. */
export class SandboxExtensionLaunchBackend implements ExtensionLaunchBackend {
  readonly id = 'sandbox' as const;
  readonly sandboxed = true;
  constructor(readonly processes: WindowsSandboxProcess) {}
  async runCommand(request: CommandLaunchRequest) {
    if (!request.context || !request.sandboxPolicy) throw new Error('SANDBOX_CONTEXT_REQUIRED');
    const location = commandLocation(request);
    // Root the session-only drive at an already authorized directory: absolute
    // Set-Location may inspect private ancestors even when the target is granted.
    // Never grant those ancestors or fall back to a different execution backend.
    // Dot invocation otherwise masks a final non-terminating PowerShell error.
    const body = `${request.command}\nif (-not $?) { exit 1 }`;
    const setup = [
      `Microsoft.PowerShell.Management\\New-PSDrive -Name ${workspaceDrive} -PSProvider FileSystem -Root ${powerShellLiteral(location.root)} -Scope Local -ErrorAction Stop | Out-Null`,
      `Microsoft.PowerShell.Management\\Set-Location -LiteralPath ${powerShellLiteral(location.location)} -ErrorAction Stop`,
      `if (-not [string]::Equals((Get-Location).ProviderPath.TrimEnd('\\'), ${powerShellLiteral(location.cwd)}.TrimEnd('\\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'SANDBOX_COMMAND_CWD_MISMATCH' }`,
    ].join('; ');
    const command = `try { ${setup} } catch { [Console]::Error.WriteLine('SANDBOX_COMMAND_CWD_UNAVAILABLE'); exit 1 }\n. ([scriptblock]::Create(${powerShellLiteral(body)}))`;
    const running = await this.processes.launch({ context: request.context,
      executable: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-NonInteractive', '-Command', command], cwd: request.cwd,
      readOnlyRoots: [], environment: {}, allowNetwork: request.sandboxPolicy.allowNetwork, timeoutMs: 120_000, outputLimitBytes: 65536, signal: request.signal, beforeStart: request.beforeStart });
    request.onStarted?.({ backend: 'sandbox', sandboxed: true });
    let output = '';
    const append = (bytes: Buffer) => { if (output.length < 65536 + 1024) output += bytes.toString('utf8'); };
    running.stdout.on('data', append); running.stderr.on('data', append);
    const result = await running.completed;
    if (request.signal.aborted) throw Object.assign(new Error('ABORTED'), { name: 'AbortError' });
    if (result.reason === 'timeout') throw new Error('TOOL_COMMAND_TIMEOUT');
    if (result.reason === 'output_limit') throw new Error('TOOL_COMMAND_OUTPUT_LIMIT');
    const text = output || `(exit ${result.exitCode})`;
    if (result.reason !== 'exited' || result.exitCode !== 0) throw new Error(`TOOL_COMMAND_FAILED:${result.exitCode}:${text}`);
    return text;
  }
  createMcpTransport(request: McpLaunchRequest): Transport { return new SandboxMcpTransport(this.processes, request); }
  async launchSkillScript(request: SkillScriptLaunchRequest): Promise<LaunchedSkillScript> {
    if (!request.context || !request.sandboxPolicy || !request.env.ASTERIUM_SKILL_DIRECTORY) throw new Error('SANDBOX_CONTEXT_REQUIRED');
    const snapshot = await realpath(request.env.ASTERIUM_SKILL_DIRECTORY);
    if (!path.basename(snapshot).startsWith('asterium-skill-run-')) throw new Error('SANDBOX_SKILL_SNAPSHOT_INVALID');
    const command = await realpath(request.command);
    const fixedPowerShell = path.resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const systemPowerShell = process.platform === 'win32'
      && path.resolve(request.command).toLowerCase() === fixedPowerShell.toLowerCase()
      && command.toLowerCase() === fixedPowerShell.toLowerCase();
    // Like command, execute the fixed system image using Windows' existing
    // AppContainer access. Do not grant or scan the serviced system directory.
    // Snapshot and all other runtime/workspace link checks remain unchanged.
    const readOnlyRoots = systemPowerShell ? [snapshot] : [...new Set([path.dirname(command), snapshot])];
    const args = systemPowerShell ? sandboxSkillPowerShellArgs(request.args)
      : request.env.ELECTRON_RUN_AS_NODE === '1' ? ['--preserve-symlinks-main', ...request.args] : request.args;
    const running = await this.processes.launch({ context: request.context, executable: command, args, cwd: request.cwd,
      readOnlyRoots, environment: request.env, allowNetwork: request.sandboxPolicy.allowNetwork,
      timeoutMs: 30_000, outputLimitBytes: 65536, signal: request.signal, beforeStart: request.beforeStart });
    const scriptProcess = Object.assign(new EventEmitter(), { pid: running.pid, stdout: running.stdout, stderr: running.stderr, exitCode: null as number | null, signalCode: null });
    void running.completed.then(result => { scriptProcess.exitCode = result.exitCode; scriptProcess.emit('close', result.exitCode); }, error => {
      scriptProcess.exitCode = 1; if (scriptProcess.listenerCount('error')) scriptProcess.emit('error', error); scriptProcess.emit('close', 1);
    });
    return { process: scriptProcess as ScriptProcess, execution: { backend: 'sandbox', sandboxed: true }, close: async () => {
      await running.close(); const result = await running.completed;
      if (result.reason === 'output_limit') throw new Error('SKILL_SCRIPT_OUTPUT_LIMIT');
      if (result.reason === 'timeout') throw new Error('SKILL_SCRIPT_TIMEOUT');
    } };
  }
}
