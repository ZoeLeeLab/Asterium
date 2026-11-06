import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { app } from 'electron';
import { z } from 'zod';
import { abortable } from '../api/abortable';

export type PermissionResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string; interrupt?: boolean };
export interface PermissionContext { signal: AbortSignal; toolUseID: string; requestId: string; title?: string; description?: string; blockedPath?: string; }
interface TextResult { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: Record<string, unknown>; }
interface CliTool { name: string; description: string; inputSchema: Record<string, unknown>; invoke(input: unknown): Promise<TextResult>; }
interface ToolSet { name: string; version: string; instructions?: string; tools: CliTool[]; alwaysLoad?: boolean; }
interface HookInput extends Record<string, unknown> { hook_event_name: string; tool_name: string; tool_input: Record<string, unknown>; }
interface HookResult { continue?: boolean; hookSpecificOutput?: Record<string, unknown>; }
type Hook = { matcher?: string; hooks: Array<(input: HookInput) => Promise<HookResult>> };
export interface Options {
  cwd: string; pathToClaudeCodeExecutable: string; abortController?: AbortController;
  sessionId?: string; resume?: string; additionalDirectories?: string[];
  permissionMode?: 'default' | 'plan' | 'dontAsk' | 'auto';
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string; snapshot?: boolean };
  settingSources?: string[]; settings?: { disableAllHooks?: boolean }; strictMcpConfig?: boolean;
  mcpServers?: Record<string, ToolSet | { command: string; args: string[]; env?: Record<string, string> }>;
  tools?: string[]; allowedTools?: string[]; includePartialMessages?: boolean; persistSession?: boolean; maxTurns?: number; model?: string;
  canUseTool?: (name: string, input: Record<string, unknown>, context: PermissionContext) => Promise<PermissionResult>;
  hooks?: { PreToolUse?: Hook[]; PostToolUse?: Hook[] };
}
type ContentBlock = { type: string; text: string };
export type ClaudeCliMessage =
  | { type: 'assistant'; message: { content: ContentBlock[] }; session_id?: string }
  | { type: 'result'; subtype: string; is_error?: boolean; result: string; session_id?: string }
  | { type: 'system'; subtype: string; compact_result?: string; session_id?: string }
  | { type: 'user' | 'stream_event' | 'tool_progress' | 'rate_limit_event' | 'auth_status'; [key: string]: unknown };
export interface Query extends AsyncIterableIterator<ClaudeCliMessage> { close(): void; }

export function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, callback: (input: z.infer<z.ZodObject<S>>) => Promise<TextResult>): CliTool {
  const schema = z.object(shape);
  return { name, description, inputSchema: z.toJSONSchema(schema) as Record<string, unknown>, invoke: input => callback(schema.parse(input)) };
}
export function createClaudeToolSet(input: ToolSet): ToolSet { return input; }

const bridgeRoot = () => app?.isPackaged ? path.join(process.resourcesPath, 'claude-bridge') : path.join(process.cwd(), '.sandbox-build/claude-bridge');
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });
function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { if (child.exitCode === null) child.kill(); });
  else child.kill();
}

/** Official CLI subprocess with a stdio MCP permission host. No Anthropic SDK or login implementation. */
export function query(input: { prompt: string; options: Options }): Query {
  const controller = input.options.abortController ?? new AbortController();
  const children = new Set<ChildProcessWithoutNullStreams>();
  let closed = false;
  const stop = () => {
    if (closed) return; closed = true;
    controller.abort();
    for (const child of children) stopChild(child);
  };
  const stream = run(input.prompt, input.options, controller, children, () => closed);
  return { next: () => stream.next(), return: async () => { stop(); return stream.return(undefined); }, throw: error => stream.throw(error), close: stop, [Symbol.asyncIterator]() { return this; } };
}

async function* run(prompt: string, options: Options, controller: AbortController, children: Set<ChildProcessWithoutNullStreams>, closed: () => boolean): AsyncGenerator<ClaudeCliMessage> {
  controller.signal.throwIfAborted();
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'asterium-claude-cli-'));
  const helper = path.join(bridgeRoot(), 'AsteriumClaudePipeHost.exe');
  const pipeName = `asterium-claude-${randomUUID()}`;
  let host: ChildProcessWithoutNullStreams | undefined;
  let cli: ChildProcessWithoutNullStreams | undefined;
  let hostLines: readline.Interface | undefined;
  let outputLines: readline.Interface | undefined;
  let transportFailed = false;
  const abort = () => { for (const child of children) stopChild(child); };
  controller.signal.addEventListener('abort', abort, { once: true });
  try {
    const sets = Object.values(options.mcpServers ?? {}).filter((value): value is ToolSet => 'tools' in value);
    const tools = sets.flatMap(set => set.tools);
    if (new Set(tools.map(t => t.name)).size !== tools.length) throw new Error('CLAUDE_DUPLICATE_RUNTIME_TOOL');
    if (tools.some(t => t.name === 'approve')) throw new Error('CLAUDE_RESERVED_RUNTIME_TOOL');
    const mcpServers: Record<string, unknown> = Object.fromEntries(Object.entries(options.mcpServers ?? {}).filter(([, value]) => !('tools' in value)));
    const settings: Record<string, unknown> = { ...options.settings };
    const needsBridge = tools.length > 0 || Boolean(options.canUseTool) || Boolean(options.hooks);
    if (needsBridge) {
      host = spawn(helper, [pipeName], { cwd: options.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(host);
      host.stderr.resume(); host.stdin.on('error', () => { transportFailed = true; cli?.kill(); });
      hostLines = readline.createInterface({ input: host.stdout, crlfDelay: Infinity });
      const writer = host;
      const alive = () => !closed() && !controller.signal.aborted && !writer.stdin.destroyed && writer.exitCode === null;
      const initializedConnections = new Set<string>();
      const pendingConnections = new Set<string>();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CLAUDE_IPC_START_TIMEOUT')), 5000);
        const fail = () => { clearTimeout(timer); reject(new Error('CLAUDE_IPC_START_FAILED')); };
        writer.once('error', fail); writer.once('exit', fail);
        hostLines!.on('line', line => {
          let message: Record<string, unknown>; try { message = record(JSON.parse(line)); } catch { fail(); return; }
          if (message.type === 'ready') { clearTimeout(timer); writer.removeListener('error', fail); writer.removeListener('exit', fail); resolve(); return; }
          if (message.type === 'error') { transportFailed = true; cli?.kill(); return; }
          if (message.type === 'disconnected') { const id = String(message.connectionId); initializedConnections.delete(id); if (pendingConnections.has(id)) { transportFailed = true; controller.abort(); } return; }
          const connectionId = String(message.connectionId ?? ''), payload = record(message.payload);
          if (!connectionId || payload.id === undefined) return;
          initializedConnections.add(connectionId);
          void (async () => {
            pendingConnections.add(connectionId);
            let result: unknown, error: string | undefined;
            try {
              if (!alive()) throw new Error('CLAUDE_RUN_CLOSED');
              if (payload.action === 'list') result = { tools: [
                ...tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
                { name: 'approve', description: 'Asterium host approval bridge. Do not call directly.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object', additionalProperties: true }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } },
              ] };
              else if (payload.action === 'hook') {
                const hookInput = record(payload.input) as HookInput;
                result = { continue: true };
                for (const entry of options.hooks?.[hookInput.hook_event_name as 'PreToolUse' | 'PostToolUse'] ?? []) {
                  if (entry.matcher && !new RegExp(`^(?:${entry.matcher})$`).test(hookInput.tool_name)) continue;
                  for (const callback of entry.hooks) { const answer = await callback(hookInput); if (answer.hookSpecificOutput || answer.continue === false) result = answer; }
                }
              } else if (payload.action === 'call' && payload.name === 'approve') {
                const args = record(payload.input), name = String(args.tool_name ?? ''), toolInput = record(args.input);
                let decision = options.canUseTool ? await abortable(options.canUseTool(name, toolInput, { signal: controller.signal, toolUseID: String(args.tool_use_id ?? payload.id), requestId: String(payload.id) }), controller.signal) : deny('当前操作不允许使用工具。');
                if (!alive() || !initializedConnections.has(connectionId)) decision = deny('当前运行或审批连接已经关闭。');
                result = { content: [{ type: 'text', text: JSON.stringify(decision) }] };
              } else if (payload.action === 'call') {
                const selected = tools.find(t => t.name === payload.name); if (!selected) throw new Error('CLAUDE_TOOL_NOT_AVAILABLE');
                result = await selected.invoke(payload.input);
              } else throw new Error('CLAUDE_IPC_METHOD_NOT_ALLOWED');
            } catch { error = 'ASTERIUM_CLAUDE_BRIDGE_FAILED'; }
            pendingConnections.delete(connectionId);
            if (alive() && initializedConnections.has(connectionId)) writer.stdin.write(`${JSON.stringify({ connectionId, payload: { id: payload.id, ...(error ? { error } : { result }) } })}\n`);
          })();
        });
      });
      host.on('error', () => { transportFailed = true; cli?.kill(); }); host.on('exit', () => { if (!controller.signal.aborted && !closed()) { transportFailed = true; cli?.kill(); } });
      mcpServers.asterium = { command: process.execPath, args: [path.join(bridgeRoot(), 'claudeStdioProxy.cjs')], env: { ELECTRON_RUN_AS_NODE: '1', ASTERIUM_CLAUDE_PIPE: pipeName } };
      if (!options.settings?.disableAllHooks && options.hooks) settings.hooks = Object.fromEntries(Object.entries(options.hooks).map(([name]) => [name, [{ hooks: [{ type: 'command', command: helper, args: ['--hook', pipeName], onFailure: 'block', timeout: 600 }] }]]));
    }
    // Explicit asks override native auto-allow rules. The Electron callback retains
    // the existing per-mode decisions. Hooks are not the primary permission gate.
    settings.permissions = { ask: ['*'] };
    if (options.settings?.disableAllHooks) settings.disableAllHooks = true;
    const settingsFile = path.join(temporary, 'settings.json'), mcpFile = path.join(temporary, 'mcp.json'), promptFile = path.join(temporary, 'system-prompt.txt');
    await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
    await writeFile(mcpFile, JSON.stringify({ mcpServers }), { mode: 0o600 });
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--settings', settingsFile, '--mcp-config', mcpFile];
    if (options.settingSources) args.push('--setting-sources', options.settingSources.join(','));
    if (options.strictMcpConfig) args.push('--strict-mcp-config');
    if (options.resume) args.push('--resume', options.resume); else if (options.sessionId) args.push('--session-id', options.sessionId);
    if (options.additionalDirectories?.length) args.push('--add-dir', ...options.additionalDirectories);
    if (options.model) args.push('--model', options.model);
    if (options.persistSession === false) args.push('--no-session-persistence');
    if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
    if (options.tools) args.push('--tools', options.tools.join(','));
    // Preserve native plan/auto selection. Explicit asks retain the host gate;
    // Asterium read-only/full policies never enable native permission bypass.
    args.push('--permission-mode', options.permissionMode === 'plan' ? 'plan' : options.permissionMode === 'auto' ? 'auto' : 'default');
    if (needsBridge) args.push('--permission-prompt-tool', 'mcp__asterium__approve');
    if (options.systemPrompt) {
      const text = typeof options.systemPrompt === 'string' ? options.systemPrompt : options.systemPrompt.append ?? '';
      await writeFile(promptFile, text, { mode: 0o600 });
      args.push(typeof options.systemPrompt === 'string' ? '--system-prompt-file' : '--append-system-prompt-file', promptFile, '--system-prompt-snapshot', 'off');
    }
    if (closed()) controller.abort(); controller.signal.throwIfAborted();
    // Pin background update behavior for this child only; never change the user's
    // CLI installation or global settings while running a partner turn.
    cli = spawn(options.pathToClaudeCodeExecutable, args, { cwd: options.cwd, env: { ...process.env, DISABLE_AUTOUPDATER: '1' }, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); children.add(cli);
    if (host && cli.pid) host.stdin.write(`${JSON.stringify({ type: 'bind', cliPid: cli.pid })}\n`);
    let spawnError: Error | undefined, stderr = '';
    cli.on('error', error => { spawnError = error; }); cli.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-2000); }); cli.stdin.on('error', () => {});
    const exited = new Promise<number | null>(resolve => cli!.once('close', resolve));
    outputLines = readline.createInterface({ input: cli.stdout, crlfDelay: Infinity });
    cli.stdin.end(prompt, 'utf8');
    for await (const line of outputLines) {
      if (line.length > 4_000_000) throw new Error('CLAUDE_CLI_MESSAGE_TOO_LARGE');
      if (!line.trim()) continue;
      let message: ClaudeCliMessage; try { message = JSON.parse(line) as ClaudeCliMessage; } catch { throw new Error('CLAUDE_CLI_INVALID_JSON'); }
      if (!message || typeof message.type !== 'string') throw new Error('CLAUDE_CLI_INVALID_MESSAGE');
      yield message;
    }
    const code = await exited;
    if (spawnError) throw new Error('CLAUDE_CLI_START_FAILED', { cause: spawnError });
    if (transportFailed) throw new Error('CLAUDE_IPC_INTERRUPTED');
    if (code !== 0 && !controller.signal.aborted) throw new Error(`CLAUDE_CLI_EXIT_${code}: ${stderr.replace(/[\r\n]+/g, ' ').slice(0, 500)}`);
  } finally {
    controller.signal.removeEventListener('abort', abort);
    outputLines?.close(); hostLines?.close();
    for (const child of children) { child.stdin.destroy(); stopChild(child); } children.clear();
    // Only the fresh per-query directory created above is removed.
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
}

export async function verifyClaudeBridgeResources() {
  await Promise.all(['AsteriumClaudePipeHost.exe', 'claudeStdioProxy.cjs'].map(name => readFile(path.join(bridgeRoot(), name))));
}
