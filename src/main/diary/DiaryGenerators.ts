import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { ApiProviderAdapter } from '../api/ApiProviderAdapter';
import { DIARY_RULES } from './DiaryPrompt';
import { CyberBossBridgeClient } from '../adapters/CyberBossBridgeClient';
import type { ExistingThreadConnection } from '../../shared/agentProtocol';

export async function generateApiDiary(adapter: ApiProviderAdapter, source: string, bootstrap: string, signal: AbortSignal) {
  let content = ''; let finish = '';
  for await (const event of adapter.stream({ signal, tools: [], messages: [{ role: 'system', content: `${bootstrap}\n\n${DIARY_RULES}` }, { role: 'user', content: source }] })) {
    signal.throwIfAborted();
    if (event.type === 'tool.delta') throw new Error('DIARY_TOOL_NOT_ALLOWED');
    if (event.type === 'text.delta') content += event.text;
    if (content.length > 100_000) throw new Error('DIARY_OUTPUT_LIMIT');
    if (event.type === 'finish') finish = event.reason;
  }
  if (finish !== 'stop' || !content.trim()) throw new Error('DIARY_INCOMPLETE');
  return content;
}
export interface NativeDiaryInput { executablePath: string; cwd: string; source: string; bootstrap: string; signal: AbortSignal; model?: string; }
export async function generateClaudeDiary(input: NativeDiaryInput, query: typeof import('../adapters/ClaudeCliTransport').query) {
  return generateClaudeOneShot(input, query, DIARY_RULES, 100_000, 'DIARY');
}

export async function generateClaudeOneShot(input: NativeDiaryInput, query: typeof import('../adapters/ClaudeCliTransport').query, rules: string, outputLimit: number, operation: 'DIARY' | 'DELEGATION' = 'DELEGATION') {
  const controller = new AbortController(); const abort = () => controller.abort(); input.signal.addEventListener('abort', abort, { once: true });
  if (input.signal.aborted) controller.abort();
  const stream = query({ prompt: input.source, options: {
    cwd: input.cwd, pathToClaudeCodeExecutable: input.executablePath, abortController: controller,
    systemPrompt: `${input.bootstrap}\n\n${rules}`, settingSources: operation === 'DELEGATION' ? ['user'] : [], settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {},
    tools: [], allowedTools: [], permissionMode: 'dontAsk', persistSession: false, maxTurns: 1,
    ...(input.model ? { model: input.model } : {}),
  } });
  let result: string | undefined;
  try {
    for await (const message of stream) {
      input.signal.throwIfAborted();
      if (message.type === 'assistant' && message.message.content.some((block) => block.type === 'tool_use')) throw new Error(`${operation}_TOOL_NOT_ALLOWED`);
      if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error || typeof message.result !== 'string' || !message.result.trim()) {
          if (operation === 'DELEGATION') throw new Error(claudeDelegationFailure(message.result));
          throw new Error('DIARY_GENERATION_FAILED');
        }
        if (message.result.length > outputLimit) throw new Error(`${operation}_OUTPUT_LIMIT`);
        result = message.result;
      }
    }
    input.signal.throwIfAborted();
    if (!result) throw new Error(`${operation}_INCOMPLETE`);
    return result;
  } catch (error) {
    if (operation !== 'DELEGATION' || input.signal.aborted || (error instanceof Error && error.message.startsWith('DELEGATION_'))) throw error;
    throw new Error(claudeDelegationFailure(error instanceof Error ? error.message : undefined), { cause: error });
  } finally { input.signal.removeEventListener('abort', abort); controller.abort(); stream.close(); }
}

function claudeDelegationFailure(detail: unknown) {
  const message = typeof detail === 'string' ? detail : '';
  if (/CLAUDE_CLI_START_FAILED/.test(message)) return 'DELEGATION_CLAUDE_START_FAILED';
  if (/not logged in|please run \/login|authentication|API Error:\s*(401|403)\b/i.test(message)) return 'DELEGATION_CLAUDE_AUTH_FAILED';
  if (/model.{0,80}(not found|not available|not supported|does not exist)|invalid model|API Error:\s*404\b/i.test(message)) return 'DELEGATION_CLAUDE_MODEL_UNAVAILABLE';
  if (/rate limit|API Error:\s*429\b/i.test(message)) return 'DELEGATION_CLAUDE_RATE_LIMITED';
  return 'DELEGATION_CLAUDE_REQUEST_FAILED';
}
export function codexDiaryArgs() {
  return ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-c', 'mcp_servers={}', '-c', 'features.shell_tool=false', '-c', 'features.apps=false', '-c', 'features.multi_agent=false',
    '-c', 'features.js_repl=false', '-c', 'features.apply_patch_freeform=false', '-c', 'features.image_generation=false',
    '-c', 'features.memories=false', '-c', 'features.hooks=false', '-c', 'features.plugins=false', '-c', 'features.goals=false',
    '-c', 'features.browser_use=false', '-c', 'features.in_app_browser=false', '-c', 'features.computer_use=false',
    '-c', 'features.code_mode_host=false', '-c', 'features.tool_search=false', '-c', 'features.tool_suggest=false',
    '-c', 'features.skill_mcp_dependency_install=false', '-c', 'features.workspace_dependencies=false',
    '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-'];
}
type SpawnDiary = (executable: string, args: string[], options: { cwd: string; windowsHide: boolean; shell: false; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams;
export function generateCodexDiary(input: NativeDiaryInput, launch: SpawnDiary = spawn) {
  return runCodexOneShot(input, codexDiaryArgs(), `${DIARY_RULES}\n\n[当天单聊资料]`, 100_000, launch);
}

export function generateCodexDelegation(input: NativeDiaryInput, rules: string, images: readonly string[], launch: SpawnDiary = spawn) {
  const args = ['--ask-for-approval', 'never', ...codexDiaryArgs().slice(0, -1), '-c', 'agents.enabled=false',
    ...(input.model ? ['--model', input.model] : []),
    ...images.map(image => `--image=${image}`), '--', '-'];
  return runCodexOneShot(input, args, rules, 20_000, launch);
}

function runCodexOneShot(input: NativeDiaryInput, args: string[], rules: string, limit: number, launch: SpawnDiary) {
  input.signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = launch(input.executablePath, args, { cwd: input.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: child.stdout }); let content = ''; let completed = false; let settled = false; let size = 0;
    const stop = () => {
      if (process.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => child.kill());
      else child.kill();
    };
    const finish = (error?: Error) => {
      if (settled) return; settled = true; input.signal.removeEventListener('abort', abort); lines.close();
      if (error) { stop(); reject(error); } else resolve(content);
    };
    const abort = () => finish(new Error('DIARY_CANCELLED'));
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) { abort(); return; }
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1_000_000) finish(new Error('DIARY_OUTPUT_LIMIT')); });
    child.stderr.resume(); // Drain without logging user/source text or native credentials.
    child.stdin.on('error', () => finish(new Error('DIARY_RUNTIME_UNAVAILABLE')));
    child.once('error', () => finish(new Error('DIARY_RUNTIME_UNAVAILABLE')));
    lines.on('line', (line) => {
      if (settled || !line.trim()) return;
      try {
        const event = JSON.parse(line) as { type: string; item?: { type: string; text?: string } };
        if (event.type === 'error' || event.type === 'turn.failed') { finish(new Error('DIARY_GENERATION_FAILED')); return; }
        if (event.type === 'item.started' && event.item && !['reasoning', 'agent_message'].includes(event.item.type)) { finish(new Error('DIARY_TOOL_NOT_ALLOWED')); return; }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') content = event.item.text ?? '';
        if (event.type === 'turn.completed') completed = true;
      } catch { finish(new Error('DIARY_NATIVE_OUTPUT_INVALID')); }
    });
    child.once('close', (code) => finish(code === 0 && completed && content.trim() && content.length <= limit ? undefined : new Error('DIARY_INCOMPLETE')));
    child.stdin.end(`${input.bootstrap}\n\n${rules}\n${input.source}`);
  });
}
export async function generateExistingDiary(connection: ExistingThreadConnection, secret: string, expectedThreadId: string, generationId: string, source: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  let requests = 0; let sends = 0; let streams = 0;
  const boundedFetch: typeof fetch = async (url, init = {}) => {
    signal.throwIfAborted();
    if (++requests > 8) throw new Error('DIARY_BRIDGE_REQUEST_LIMIT');
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/api/messages' && ++sends > 1) throw new Error('DIARY_BRIDGE_SEND_LIMIT');
    if (pathname === '/api/events' && ++streams > 1) throw new Error('DIARY_BRIDGE_STREAM_LIMIT');
    return fetcher(url, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
  };
  const controller = new AbortController(); const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
  const client = new CyberBossBridgeClient({ ...connection, secret, fetcher: boundedFetch, reconnectDelay: async () => { throw new Error('DIARY_BRIDGE_INTERRUPTED'); } });
  const session = await client.checkSession().catch((error: unknown) => { controller.abort(); signal.removeEventListener('abort', abort); throw error; });
  if (session.threadId !== expectedThreadId || connection.threadId !== expectedThreadId) { signal.removeEventListener('abort', abort); throw new Error('DIARY_UPSTREAM_THREAD_MISMATCH'); }
  const stream = client.events(controller.signal)[Symbol.asyncIterator]();
  const nextEvent = () => { const work = stream.next(); void work.catch(() => undefined); return work; };
  let pending = nextEvent(); let ownMessageSeen = false;
  const clientMessageId = `asterium-diary-${generationId}`;
  try {
    await client.sendMessage(`${DIARY_RULES}\n\n[当天指定单聊资料]\n${source}`, clientMessageId);
    for (;;) {
      signal.throwIfAborted(); const next = await pending; if (next.done) throw new Error('DIARY_INCOMPLETE'); pending = nextEvent();
      const event = next.value;
      if (event.event === 'thread_changed') throw new Error('DIARY_UPSTREAM_THREAD_MISMATCH');
      if (event.role === 'user') {
        if (event.clientMessageId === clientMessageId) ownMessageSeen = true;
        else if (ownMessageSeen) throw new Error('DIARY_SOURCE_BUSY');
      }
      if (!ownMessageSeen) continue;
      if (event.role === 'error') throw new Error('DIARY_GENERATION_FAILED');
      if (event.role === 'assistant' && event.text.trim()) {
        if (event.clientMessageId && event.clientMessageId !== clientMessageId) throw new Error('DIARY_SOURCE_BUSY');
        if (event.text.length > 100_000) throw new Error('DIARY_OUTPUT_LIMIT'); return event.text;
      }
    }
  } finally { controller.abort(); signal.removeEventListener('abort', abort); await pending.catch(() => undefined); await stream.return?.(); }
}
