import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import type { ProtocolError } from '../../shared/agentProtocol';
import { CODEX_THREAD_IN_USE } from '../../shared/codexThreadInUse';
import { MarkdownArtifactParser } from './markdownArtifactParser';

const execFileAsync = promisify(execFile);

type JsonObject = Record<string, unknown>;
export type JsonRpcId = string | number;

export interface CodexRpcMessage extends JsonObject {
  id?: JsonRpcId;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

export type CodexMappedEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'work.status'; state: 'thinking' | 'working' | 'waiting_authorization' | 'waiting_user_input' | 'idle'; summary: string; detail?: string }
  | { type: 'tool.started'; toolCallId: string; toolName: string; summary: string; mutatesExternalState: boolean; detail?: string }
  | { type: 'tool.progress'; toolCallId: string; summary: string; detail?: string }
  | { type: 'tool.completed'; toolCallId: string; outcome: 'success' | 'failure'; summary: string; detail?: string }
  | { type: 'file.produced'; artifactId: string; toolCallId?: string; name: string; artifactRef: string; source?: import('../../shared/agentProtocol').ArtifactSourceClaim; registrationMethod?: 'automatic' | 'deliver_tool' | 'message_image'; changeKind?: 'create' | 'modify' }
  | { type: 'authorization.requested'; authorizationId: string; toolCallId?: string; action: 'read_file' | 'write_file' | 'delete_file' | 'run_command' | 'computer_control' | 'external_side_effect'; risk: 'low' | 'medium' | 'high'; summary: string; targets: string[]; purpose?: import('../../shared/agentProtocol').AuthorizationPurpose }
  | { type: 'authorization.resolved'; authorizationId: string; decision: 'allow_once' | 'deny' }
  | { type: 'user_input.requested'; requestId: string; questions: import('../../shared/agentProtocol').UserInputQuestion[] }
  | { type: 'user_input.resolved'; requestId: string; answers: Record<string, string[]>; customAnswers?: Record<string, string> }
  | { type: 'plan.updated'; status: 'planning' | 'waiting_user' | 'ready' | 'executing' | 'completed'; planMode?: 'default' | 'plan'; explanation?: string; steps?: Array<{ id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }> }
  | { type: 'run.completed'; finishReason: 'completed' | 'end_turn' }
  | { type: 'run.failed'; error: ProtocolError }
  | { type: 'run.cancelled'; reason: string };

export interface CodexApprovalRequest {
  authorizationId: string;
  requestId: JsonRpcId;
  method: string;
  params: JsonObject;
  event: Extract<CodexMappedEvent, { type: 'authorization.requested' }>;
}

export interface CodexAppServerTransport {
  readonly connected: boolean;
  start(): Promise<void>;
  request<T = unknown>(method: string, params?: JsonObject): Promise<T>;
  respond(id: JsonRpcId, result: unknown): void;
  onMessage(listener: (message: CodexRpcMessage) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export type SpawnCodex = (executable: string, args: string[], options: {
  cwd: string;
  windowsHide: boolean;
  shell: false;
  stdio: ['pipe', 'pipe', 'pipe'];
}) => ChildProcessWithoutNullStreams;

const defaultSpawnCodex: SpawnCodex = (executable, args, options) => spawn(executable, args, options);

async function stopChild(child: ChildProcessWithoutNullStreams) {
  // Let Codex finish persisting its rollout before falling back to process termination.
  const exited = await new Promise<boolean>(resolve => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), 1500);
    child.once('exit', onExit);
    if (!child.stdin.destroyed) child.stdin.end();
  });
  if (exited) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      return;
    } catch {
      child.kill();
      return;
    }
  }
  child.kill('SIGTERM');
}

export class CodexAppServerClient implements CodexAppServerTransport {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: readline.Interface;
  private readonly pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    resumeThreadId?: string;
  }>();
  private readonly messageListeners = new Set<(message: CodexRpcMessage) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private nextRequestId = 0;
  private startPromise?: Promise<void>;
  private closing = false;
  private stderr = '';

  constructor(
    private readonly executablePath: string,
    private readonly workingDirectory: string,
    private readonly spawnCodex: SpawnCodex = defaultSpawnCodex,
  ) {}

  get connected() {
    return Boolean(this.child && this.child.exitCode === null && !this.closing);
  }

  start() {
    if (this.connected && this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal() {
    this.closing = false;
    this.stderr = '';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnCodex(this.executablePath, ['app-server', '--listen', 'stdio://'], {
        cwd: this.workingDirectory,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`CODEX_APP_SERVER_SPAWN_FAILED: ${safeErrorText(error)}`, { cause: error });
    }
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-2000); });
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => this.handleLine(line));
    child.stdin.on('error', (error) => {
      if (this.child === child) this.handleClose(error);
    });
    child.once('error', (error) => this.handleClose(error));
    child.once('close', (code) => this.handleClose(new Error(`Codex app-server exited (${code ?? 'unknown'}): ${singleLine(this.stderr)}`)));

    await this.request('initialize', {
      clientInfo: { name: 'asterium_desktop', title: 'Asterium Desktop', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
  }

  request<T = unknown>(method: string, params: JsonObject = {}) {
    if (!this.child || this.closing) return Promise.reject(new Error('CODEX_APP_SERVER_NOT_CONNECTED'));
    const id = ++this.nextRequestId;
    return new Promise<T>((resolve, reject) => {
      const resumeThreadId = method === 'thread/resume' && typeof params?.threadId === 'string' ? params.threadId : undefined;
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, resumeThreadId });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  respond(id: JsonRpcId, result: unknown) {
    this.write({ id, result });
  }

  onMessage(listener: (message: CodexRpcMessage) => void) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (error: Error) => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private notify(method: string, params: JsonObject) {
    this.write({ method, params });
  }

  private write(message: CodexRpcMessage) {
    if (!this.child || this.child.stdin.destroyed || this.closing) throw new Error('CODEX_APP_SERVER_NOT_CONNECTED');
    this.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  }

  private handleLine(line: string) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    const message = value as CodexRpcMessage;
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const detail = safeText(message.error.message, 'unknown error');
        const occupied = pending.resumeThreadId && message.error.code === -32600
          && detail === `thread ${pending.resumeThreadId} already has an active writer`;
        pending.reject(new Error(occupied ? CODEX_THREAD_IN_USE : `CODEX_RPC_ERROR: ${detail}`));
      } else pending.resolve(message.result);
      return;
    }
    for (const listener of this.messageListeners) listener(message);
  }

  private handleClose(error: Error) {
    if (!this.child) return;
    this.lines?.close();
    this.lines = undefined;
    this.child = undefined;
    this.startPromise = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.closing) for (const listener of this.closeListeners) listener(error);
  }

  async close() {
    const child = this.child;
    this.closing = true;
    this.lines?.close();
    this.lines = undefined;
    this.child = undefined;
    this.startPromise = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error('CODEX_APP_SERVER_CLOSED'));
    this.pending.clear();
    if (child && child.exitCode === null) await stopChild(child);
  }
}

export class CodexEventMapper {
  private readonly streamedAgentItems = new Set<string>();
  private readonly startedToolItems = new Set<string>();
  private readonly completedToolItems = new Set<string>();
  private readonly reasoningItems = new Set<string>();
  private terminalShown = false;
  private readonly markdownImages = new MarkdownArtifactParser();
  private imageCounter = 0;

  map(message: CodexRpcMessage, cancelReason = '已由用户停止'): CodexMappedEvent[] {
    const method = safeText(message.method);
    const params = isRecord(message.params) ? message.params : {};
    if (method === 'turn/started') return [];
    if (method === 'turn/plan/updated') {
      const steps = recordArray(params.plan).map((step, index) => ({
        id: safeText(step.id, `step-${index + 1}`),
        text: safeText(step.step),
        status: step.status === 'completed' ? 'completed' as const : step.status === 'inProgress' ? 'in_progress' as const : 'pending' as const,
      })).filter((step) => Boolean(step.text));
      const status = steps.length && steps.every((step) => step.status === 'completed') ? 'completed' as const
        : steps.some((step) => step.status === 'in_progress') ? 'executing' as const
          : 'planning' as const;
      return [{ type: 'plan.updated', status, explanation: safeTextPreserve(params.explanation) || undefined, steps }];
    }
    if (method === 'item/agentMessage/delta') {
      const text = safeTextPreserve(params.delta);
      const itemId = safeText(params.itemId);
      if (!text) return [];
      if (itemId) this.streamedAgentItems.add(itemId);
      return this.mapText(text);
    }
    if (method === 'item/reasoning/summaryTextDelta') {
      const itemId = safeText(params.itemId, `reasoning-${this.reasoningItems.size + 1}`);
      if (!this.reasoningItems.has(itemId)) this.reasoningItems.add(itemId);
      const detail = safeTextPreserve(params.delta);
      if (!detail) return [];
      const summaryIndex = typeof params.summaryIndex === 'number' && Number.isInteger(params.summaryIndex) ? params.summaryIndex : 0;
      return [{
        type: 'work.status',
        state: 'thinking',
        summary: summaryIndex > 0
          ? `Codex 思考摘要 ${summaryIndex + 1}`
          : this.reasoningItems.size === 1 ? 'Codex 正在思考…' : `Codex 进入第 ${this.reasoningItems.size} 段思考…`,
        detail,
      }];
    }
    if (method === 'item/reasoning/summaryPartAdded' || method === 'item/reasoning/textDelta') return [];
    if (method === 'item/started') return this.mapItem(params.item, false);
    if (method === 'item/completed') return this.mapItem(params.item, true);
    if (method === 'item/commandExecution/outputDelta') {
      return [{ type: 'tool.progress', toolCallId: safeText(params.itemId, 'command'), summary: '命令正在运行…', detail: safeDetail(params.delta) }];
    }
    if (method === 'item/fileChange/patchUpdated' || method === 'item/fileChange/outputDelta') {
      return [{ type: 'tool.progress', toolCallId: safeText(params.itemId, 'file-change'), summary: '正在处理文件变更…', detail: safeDetail(params.delta ?? params.patch) }];
    }
    if (method === 'item/mcpToolCall/progress') {
      return [{ type: 'tool.progress', toolCallId: safeText(params.itemId, 'mcp'), summary: safeText(params.message, 'MCP 工具正在运行…'), detail: safeDetail(params) }];
    }
    if (method === 'error') {
      const error = isRecord(params.error) ? params.error : {};
      const detail = safeText(error.message, 'Codex 连接出现波动。');
      if (params.willRetry === true) return [{ type: 'work.status', state: 'working', summary: `${detail} Codex 正在重试…` }];
      return [{ type: 'run.failed', error: { code: 'CODEX_TRANSPORT_ERROR', message: detail, stage: 'transport', retryable: true } }];
    }
    if (method === 'turn/completed') {
      if (this.terminalShown) return [];
      this.terminalShown = true;
      const turn = isRecord(params.turn) ? params.turn : {};
      const status = safeText(turn.status).toLowerCase();
      if (status === 'interrupted') return [{ type: 'run.cancelled', reason: cancelReason }];
      if (status === 'failed') {
        const detail = isRecord(turn.error) ? safeText(turn.error.message) : '';
        return [{ type: 'run.failed', error: { code: 'CODEX_TURN_FAILED', message: detail || 'Codex 未能完成这次任务。', stage: 'adapter', retryable: true } }];
      }
      return [{ type: 'run.completed', finishReason: 'end_turn' }];
    }
    return [];
  }

  private mapItem(value: unknown, completed: boolean): CodexMappedEvent[] {
    if (!isRecord(value)) return [];
    const id = safeText(value.id, 'codex-tool');
    const type = safeText(value.type);
    if (type === 'agentMessage') {
      if (!completed || this.streamedAgentItems.has(id)) return [];
      const text = safeTextPreserve(value.text);
      return text ? this.mapText(text) : [];
    }
    if (type === 'reasoning') {
      if (this.reasoningItems.has(id)) return [];
      this.reasoningItems.add(id);
      return [{ type: 'work.status', state: 'thinking', summary: this.reasoningItems.size === 1 ? 'Codex 正在思考…' : `Codex 进入第 ${this.reasoningItems.size} 段思考…` }];
    }

    const tool = toolDescription(type, value);
    if (!tool) return [];
    if (!completed) {
      if (this.startedToolItems.has(id)) return [];
      this.startedToolItems.add(id);
      return [{ type: 'tool.started', toolCallId: id, toolName: tool.name, summary: `${tool.label}…`, mutatesExternalState: tool.mutates, detail: safeDetail(value) }];
    }
    if (this.completedToolItems.has(id)) return [];
    this.completedToolItems.add(id);

    const outcome = itemFailed(value) ? 'failure' : 'success';
    const events: CodexMappedEvent[] = [{ type: 'tool.completed', toolCallId: id, outcome, summary: `${tool.label}${outcome === 'success' ? '完成' : '失败'}`, detail: safeDetail(value) }];
    if (outcome === 'success' && type === 'fileChange') {
      for (const change of recordArray(value.changes)) {
        const filePath = safeText(change.path);
        if (!filePath) continue;
        events.push({ type: 'file.produced', artifactId: `codex-file-${id}-${events.length}`, toolCallId: id, name: fileName(filePath), artifactRef: filePath, source: { kind: 'local_path', path: filePath }, registrationMethod: 'automatic', changeKind: safeText(change.kind).toLowerCase() === 'add' ? 'create' : 'modify' });
      }
    }
    if (outcome === 'success' && type === 'imageGeneration') {
      const filePath = safeText(value.savedPath);
      const url = safeText(value.url);
      const base64 = safeTextPreserve(value.base64 ?? value.b64Json);
      if (filePath) events.push({ type: 'file.produced', artifactId: `codex-image-${id}`, toolCallId: id, name: fileName(filePath), artifactRef: filePath, source: { kind: 'local_path', path: filePath }, registrationMethod: 'automatic' });
      else if (url.startsWith('https://')) events.push({ type: 'file.produced', artifactId: `codex-image-${id}`, toolCallId: id, name: fileName(url) || '生成图片.png', artifactRef: 'registry-pending', source: { kind: 'content', transport: 'https_url', value: url }, registrationMethod: 'automatic' });
      else if (base64) events.push({ type: 'file.produced', artifactId: `codex-image-${id}`, toolCallId: id, name: safeText(value.name, '生成图片.png'), artifactRef: 'registry-pending', source: { kind: 'content', transport: 'base64', value: base64 }, registrationMethod: 'automatic' });
    }
    return events;
  }

  private mapText(value: string): CodexMappedEvent[] {
    const parsed = this.markdownImages.push(value);
    return [
      ...(parsed.text ? [{ type: 'text.delta' as const, text: parsed.text }] : []),
      ...parsed.claims.map((claim) => ({ type: 'file.produced' as const, artifactId: `codex-message-image-${++this.imageCounter}`, name: claim.name, artifactRef: 'registry-pending', source: claim.source, registrationMethod: 'message_image' as const })),
    ];
  }
}

export function mapCodexApprovalRequest(message: CodexRpcMessage): CodexApprovalRequest | null {
  if (message.id === undefined) return null;
  const method = safeText(message.method);
  const params = isRecord(message.params) ? message.params : {};
  const supported = new Set([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
    'mcpServer/elicitation/request',
  ]);
  if (!supported.has(method)) return null;
  const authorizationId = `codex-auth-${String(message.id)}`;
  const isFile = method.includes('fileChange') || method === 'applyPatchApproval';
  const isMcp = method === 'mcpServer/elicitation/request';
  const isPermission = method === 'item/permissions/requestApproval';
  const command = Array.isArray(params.command) ? params.command.map(String).join(' ') : safeText(params.command);
  const targets = collectTargets(params);
  const summary = safeText(params.reason)
    || (isMcp ? safeText(params.message, 'MCP 服务请求输入或确认。') : isPermission ? 'Codex 请求临时扩展工作权限。' : isFile ? 'Codex 请求修改文件。' : command ? `Codex 请求运行：${command}` : 'Codex 请求执行命令。');
  return {
    authorizationId,
    requestId: message.id,
    method,
    params,
    event: {
      type: 'authorization.requested',
      authorizationId,
      toolCallId: safeText(params.itemId) || undefined,
      action: isMcp || isPermission ? 'external_side_effect' : isFile ? 'write_file' : 'run_command',
      risk: isPermission ? 'high' : isFile || isMcp ? 'medium' : 'high',
      summary,
      targets,
    },
  };
}

export function approvalResponse(request: CodexApprovalRequest, decision: 'allow_once' | 'deny') {
  if (request.method === 'mcpServer/elicitation/request') return { action: decision === 'allow_once' ? 'accept' : 'decline', ...(decision === 'allow_once' ? { content: {} } : {}) };
  if (request.method === 'item/permissions/requestApproval') return { permissions: decision === 'allow_once' ? grantedPermissions(request.params.permissions) : {}, scope: 'turn' };
  if (request.method === 'execCommandApproval' || request.method === 'applyPatchApproval') return { decision: decision === 'allow_once' ? 'approved' : 'denied' };
  return { decision: decision === 'allow_once' ? 'accept' : 'decline' };
}

function grantedPermissions(value: unknown) {
  if (!isRecord(value)) return {};
  return {
    ...(isRecord(value.network) ? { network: value.network } : {}),
    ...(isRecord(value.fileSystem) ? { fileSystem: value.fileSystem } : {}),
  };
}

function toolDescription(type: string, item: JsonObject) {
  if (type === 'userMessage') return null;
  if (type === 'commandExecution') return { name: 'commandExecution', label: safeText(item.command) ? `运行命令 ${safeText(item.command).slice(0, 100)}` : '运行命令', mutates: true };
  if (type === 'fileChange') return { name: 'fileChange', label: '修改文件', mutates: true };
  if (type === 'mcpToolCall') return { name: `mcp__${safeText(item.server, 'server')}__${safeText(item.tool, 'tool')}`, label: `调用 MCP ${safeText(item.server, '服务')} · ${safeText(item.tool, '工具')}`, mutates: true };
  if (type === 'dynamicToolCall') return { name: safeText(item.tool, 'dynamicTool'), label: `调用工具 ${safeText(item.tool, '工具')}`, mutates: true };
  if (type === 'collabAgentToolCall') return { name: safeText(item.tool, 'collabAgent'), label: '调用协作代理', mutates: false };
  if (type === 'webSearch') return { name: 'webSearch', label: '搜索网络', mutates: false };
  if (type === 'imageView') return { name: 'imageView', label: `查看图片 ${fileName(safeText(item.path))}`, mutates: false };
  if (type === 'imageGeneration') return { name: 'imageGeneration', label: '生成图片', mutates: true };
  if (/computer|desktop|browser.*control/i.test(type)) return { name: type, label: '操作电脑', mutates: true };
  if (type === 'contextCompaction') return { name: 'contextCompaction', label: '压缩会话上下文', mutates: false };
  return type ? { name: type, label: `执行 ${type}`, mutates: false } : null;
}

function itemFailed(item: JsonObject) {
  const status = safeText(item.status).toLowerCase();
  return status === 'failed' || status === 'declined' || item.success === false;
}

function collectTargets(params: JsonObject) {
  const targets = new Set<string>();
  for (const key of ['cwd', 'grantRoot', 'path', 'filePath']) {
    const value = safeText(params[key]);
    if (value) targets.add(value);
  }
  for (const action of recordArray(params.commandActions)) {
    const value = safeText(action.path);
    if (value) targets.add(value);
  }
  const permissions = isRecord(params.permissions) ? params.permissions : {};
  const fileSystem = isRecord(permissions.fileSystem) ? permissions.fileSystem : {};
  for (const key of ['read', 'write']) {
    if (Array.isArray(fileSystem[key])) for (const value of fileSystem[key]) if (typeof value === 'string' && value.trim()) targets.add(value.trim());
  }
  for (const entry of recordArray(fileSystem.entries)) {
    const entryPath = isRecord(entry.path) ? entry.path : {};
    const value = safeText(entryPath.path) || safeText(entryPath.pattern);
    if (value) targets.add(value);
  }
  return [...targets].slice(0, 20);
}

function recordArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function fileName(value: string) {
  return value.replace(/\\/g, '/').split('/').at(-1) || '文件';
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, 500) : fallback;
}

function safeTextPreserve(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function safeDetail(value: unknown) {
  if (value === undefined || value === '') return undefined;
  try {
    return (typeof value === 'string' ? value : JSON.stringify(redact(value), null, 2)).slice(0, 32_768);
  } catch {
    return undefined;
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|cookie|authorization|api.?key/i.test(key) ? '[已隐藏]' : redact(item)]));
}

function singleLine(value: string) {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
}

function safeErrorText(error: unknown) {
  return error instanceof Error ? singleLine(error.message) : 'unknown error';
}
