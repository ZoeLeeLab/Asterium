import { withHandoffContext } from '../../shared/contextHandoff';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AUTOMATION_TOOL_DESCRIPTION, automationToolJsonSchema } from '../../shared/automationTool';
import type { AsteriumRuntimeToolController, AttachmentPathResolver, PartnerAdapter } from './PartnerAdapter';
import { memoryToolDescription } from '../runtime/MemoryToolGuidance';
import {
  parseAsteriumTaskToolInput,
  parseCommentMemoryInput,
  formatAsteriumMemoryBriefing,
  parseHoldMemoryInput,
  parseProjectNotebookToolInput,
  parseReadMemorySourceInput,
  parseSearchMemoryInput,
  parseUpdateMemoryInput,
  parseWorkflowDraftToolInput,
  type AsteriumStatusKey,
  type AsteriumWorkspaceAction,
} from '../runtime/AsteriumRuntimeTools';
import {
  CodexAppServerClient,
  CodexEventMapper,
  approvalResponse,
  mapCodexApprovalRequest,
  type CodexAppServerTransport,
  type CodexApprovalRequest,
  type CodexMappedEvent,
  type CodexRpcMessage,
} from './codexAppServerProtocol';
import { planExecutionQuestions, planExecutionDecision } from './planExecutionDecision';
import type { SessionCompactResult } from '../../shared/sessionCompaction';
import { abortable } from '../api/abortable';
import { assertUserInputResolution, userInputOwner, type UserInputOwner } from '../runtime/UserInputResolution';
import type { SessionBootstrapDocument, UserInputQuestion, UserInputResponse } from '../../shared/agentProtocol';
import { DELIVERY_TOOL_DESCRIPTION } from './deliveryInstructions';
import { pathsOverlap, textReferencesProtectedRoot } from '../security/ProtectedPathPolicy';
import {
  AGENT_PROTOCOL_VERSION,
  CODEX_NATIVE_TOOL_PROTOCOL_VERSION,
  type CancelRunCommand,
  type CodexDetectionResult,
  type CodexRuntimeInfo,
  type CodexThreadSummary,
  type NativeThreadLifecycleAction,
  type NativeThreadLifecycleResult,
  type PartnerEvent,
  type ResolveAuthorizationCommand,
  type ResolveUserInputCommand,
  type ResumeSessionCommand,
  type SendMessageCommand,
  type SendGuidanceCommand,
  type SendGuidanceResult,
} from '../../shared/agentProtocol';
import { MEMORY_STATUSES, MEMORY_TYPES } from '../../shared/memoryArchive';

const execFileAsync = promisify(execFile);

export type CodexRuntimeInstallation = CodexRuntimeInfo;

export interface CodexInstallation extends CodexDetectionResult {
  runtimes: CodexRuntimeInstallation[];
}

export type CreateCodexTransport = (executablePath: string, workingDirectory: string) => CodexAppServerTransport;

const defaultCreateTransport: CreateCodexTransport = (executablePath, workingDirectory) => new CodexAppServerClient(executablePath, workingDirectory);
const CODEX_THREAD_SOURCE_KINDS = ['cli', 'vscode', 'appServer', 'unknown'];

async function executableCandidates() {
  const candidates: string[] = [];
  const add = (value?: string) => { if (value?.trim()) candidates.push(path.resolve(value.trim())); };
  add(process.env.CODEX_CLI_PATH);
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(command, [process.platform === 'win32' ? 'codex.exe' : 'codex'], { windowsHide: true, timeout: 4000 });
    for (const value of stdout.split(/\r?\n/)) add(value);
  } catch {
    // Continue with standard installation locations.
  }

  if (process.platform === 'win32') {
    const userHome = os.homedir();
    const roaming = process.env.APPDATA || path.join(userHome, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local');
    const architecture = process.arch === 'arm64'
      ? { packageName: 'codex-win32-arm64', vendor: 'aarch64-pc-windows-msvc' }
      : { packageName: 'codex-win32-x64', vendor: 'x86_64-pc-windows-msvc' };
    add(path.join(roaming, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', architecture.packageName, 'vendor', architecture.vendor, 'bin', 'codex.exe'));

    const desktopBin = path.join(local, 'OpenAI', 'Codex', 'bin');
    try {
      for (const entry of await readdir(desktopBin, { withFileTypes: true })) if (entry.isDirectory()) add(path.join(desktopBin, entry.name, 'codex.exe'));
    } catch {
      // The Codex desktop app is optional.
    }

    const extensions = path.join(userHome, '.vscode', 'extensions');
    try {
      for (const entry of await readdir(extensions, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('openai.chatgpt-')) continue;
        add(path.join(extensions, entry.name, 'bin', process.arch === 'arm64' ? 'windows-aarch64' : 'windows-x86_64', 'codex.exe'));
      }
    } catch {
      // VS Code is optional.
    }
  }

  return [...new Map(candidates.map((candidate) => [candidate.toLowerCase(), candidate])).values()];
}

export function runtimeEnvironment(executablePath: string): Pick<CodexRuntimeInfo, 'environment' | 'environmentLabel'> {
  const normalized = executablePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/appdata/roaming/npm/node_modules/@openai/codex/')) return { environment: 'global_cli', environmentLabel: '全局 npm CLI' };
  if (normalized.includes('/appdata/local/openai/codex/bin/')) return { environment: 'desktop_app', environmentLabel: 'Codex 桌面应用' };
  if (normalized.includes('/.vscode/extensions/openai.chatgpt-')) return { environment: 'vscode_extension', environmentLabel: 'VS Code 扩展' };
  return { environment: 'path', environmentLabel: 'PATH 中的 CLI' };
}

export function rankCodexRuntimes(runtimes: CodexRuntimeInstallation[]) {
  const priority = { global_cli: 0, desktop_app: 1, vscode_extension: 2, path: 3 } as const;
  return [...runtimes].sort((left, right) => priority[left.environment] - priority[right.environment]
    || (right.version ?? '').localeCompare(left.version ?? '', undefined, { numeric: true }));
}

export function recommendedCodexRuntime(runtimes: CodexRuntimeInstallation[]) {
  return runtimes.find((runtime) => runtime.environment === 'global_cli')
    || runtimes.find((runtime) => runtime.loggedIn)
    || runtimes[0];
}

export function parseCodexLoginStatus(stdout: string, stderr: string) {
  const status = `${stdout}\n${stderr}`.trim();
  const loggedIn = /^logged in\b/i.test(status);
  return {
    checked: loggedIn || /^not logged in\b/i.test(status) || /^logged out\b/i.test(status),
    loggedIn,
    authMethod: loggedIn ? status.replace(/^logged in\s*/i, '').trim() || '现有 Codex 登录' : undefined,
  };
}

function outputFromExecError(error: unknown) {
  if (!isRecord(error)) return { stdout: '', stderr: '' };
  return {
    stdout: typeof error.stdout === 'string' ? error.stdout : '',
    stderr: typeof error.stderr === 'string' ? error.stderr : '',
  };
}

function runtimeId(executablePath: string) {
  return `codex-runtime-${createHash('sha256').update(executablePath.toLowerCase()).digest('hex').slice(0, 16)}`;
}

async function probeRuntime(executablePath: string, codexHome: string): Promise<CodexRuntimeInstallation | null> {
  try {
    await access(executablePath);
    const { stdout: versionOutput } = await execFileAsync(executablePath, ['--version'], { windowsHide: true, timeout: 6000 });
    const version = versionOutput.replace(/^codex-cli\s*/i, '').trim();
    if (!version) return null;
    let loggedIn = false;
    let authMethod: string | undefined;
    let error: CodexRuntimeInstallation['error'];
    try {
      const { stdout: authStdout, stderr: authStderr } = await execFileAsync(executablePath, ['login', 'status'], { windowsHide: true, timeout: 6000 });
      ({ loggedIn, authMethod } = parseCodexLoginStatus(authStdout, authStderr));
      if (!loggedIn) error = { code: 'CODEX_NOT_LOGGED_IN', message: '这个 Codex 运行时尚未登录。', stage: 'authorization', retryable: true };
    } catch (authError) {
      const output = outputFromExecError(authError);
      const parsed = parseCodexLoginStatus(output.stdout, output.stderr);
      loggedIn = parsed.loggedIn;
      authMethod = parsed.authMethod;
      error = parsed.checked
        ? { code: 'CODEX_NOT_LOGGED_IN', message: '这个 Codex 运行时尚未登录。', stage: 'authorization', retryable: true }
        : { code: 'CODEX_AUTH_STATUS_FAILED', message: '无法确认这个 Codex 运行时的登录状态。', stage: 'discovery', retryable: true };
    }
    return {
      runtimeId: runtimeId(executablePath),
      executablePath,
      executableLabel: path.basename(executablePath),
      ...runtimeEnvironment(executablePath),
      codexHome,
      installed: true,
      loggedIn,
      version,
      authMethod,
      error,
    };
  } catch {
    return null;
  }
}

export async function detectCodexCli(): Promise<CodexInstallation> {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  const runtimes = rankCodexRuntimes((await Promise.all((await executableCandidates()).map((candidate) => probeRuntime(candidate, codexHome))))
    .filter((runtime): runtime is CodexRuntimeInstallation => runtime !== null));
  const recommended = recommendedCodexRuntime(runtimes);
  if (!recommended) return {
    installed: false,
    loggedIn: false,
    runtimes: [],
    error: { code: 'CODEX_NOT_FOUND', message: '没有找到可用的本机 Codex CLI。', stage: 'discovery', retryable: true },
  };
  return {
    installed: true,
    loggedIn: recommended.loggedIn,
    version: recommended.version,
    authMethod: recommended.authMethod,
    executableLabel: recommended.executableLabel,
    runtimes,
    recommendedRuntimeId: recommended.runtimeId,
    ...(!recommended.loggedIn ? { error: recommended.error } : {}),
  };
}

export async function listCodexThreads(executablePath: string, workingDirectory: string, createTransport: CreateCodexTransport = defaultCreateTransport): Promise<CodexThreadSummary[]> {
  const client = createTransport(executablePath, workingDirectory);
  try {
    await client.start();
    const result = await client.request<{ data?: unknown }>('thread/list', {
      cwd: workingDirectory,
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      sourceKinds: CODEX_THREAD_SOURCE_KINDS,
      archived: false,
    });
    return parseCodexThreads(result, workingDirectory);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function getCodexThreadLastTurnId(executablePath: string, workingDirectory: string, threadId: string, createTransport: CreateCodexTransport = defaultCreateTransport) {
  const client = createTransport(executablePath, workingDirectory);
  try {
    await client.start();
    const result = await client.request<{ thread?: unknown }>('thread/read', { threadId, includeTurns: true });
    const thread = isRecord(result.thread) ? result.thread : {};
    const turns = Array.isArray(thread.turns) ? thread.turns.filter(isRecord) : [];
    return text(turns.at(-1)?.id) || undefined;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function getCodexThreadLifecycles(
  executablePath: string,
  workingDirectory: string,
  threadIds: string[],
  createTransport: CreateCodexTransport = defaultCreateTransport,
): Promise<NativeThreadLifecycleResult[]> {
  const client = createTransport(executablePath, workingDirectory);
  const checkedAt = new Date().toISOString();
  try {
    await client.start();
    const [active, archived] = await Promise.all([
      listAllCodexThreadIds(client, workingDirectory, false),
      listAllCodexThreadIds(client, workingDirectory, true),
    ]);
    return Promise.all([...new Set(threadIds.filter(Boolean))].map(async (threadId): Promise<NativeThreadLifecycleResult> => {
      if (active.has(threadId)) return { threadId, state: 'active', checkedAt };
      if (archived.has(threadId)) return { threadId, state: 'archived', checkedAt };
      try {
        await client.request('thread/read', { threadId, includeTurns: false });
        return { threadId, state: 'unavailable', checkedAt, message: '原生线程仍存在，但不属于当前选择的工作区或线程列表。', reason: 'outside_workspace' };
      } catch (error) {
        return isCodexThreadMissingError(error)
          ? { threadId, state: 'deleted', checkedAt, message: '原生线程已被删除。' }
          : { threadId, state: 'unavailable', checkedAt, message: '暂时无法确认这个原生线程的状态；星丛没有改动本地记录。' };
      }
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function getCodexThreadLifecyclesSafely(
  executablePath: string,
  workingDirectory: string,
  threadIds: string[],
  options: { createTransport?: CreateCodexTransport; retryDelayMs?: number } = {},
): Promise<NativeThreadLifecycleResult[]> {
  const uniqueThreadIds = [...new Set(threadIds.filter(Boolean))];
  const createTransport = options.createTransport ?? defaultCreateTransport;
  try {
    return await getCodexThreadLifecycles(executablePath, workingDirectory, uniqueThreadIds, createTransport);
  } catch (error) {
    if (isCodexStateRuntimeInitializationError(error)) {
      await delay(options.retryDelayMs ?? 150);
      try {
        return await getCodexThreadLifecycles(executablePath, workingDirectory, uniqueThreadIds, createTransport);
      } catch {
        return lifecycleUnavailable(uniqueThreadIds, 'Codex 状态运行时暂时无法初始化；星丛没有改动本地记录，稍后会自动重试。');
      }
    }
    return lifecycleUnavailable(uniqueThreadIds, '暂时无法连接所选 Codex 运行时；星丛没有改动本地记录。');
  }
}

export async function changeCodexThreadLifecycle(
  executablePath: string,
  workingDirectory: string,
  threadId: string,
  action: NativeThreadLifecycleAction,
  createTransport: CreateCodexTransport = defaultCreateTransport,
): Promise<NativeThreadLifecycleResult> {
  const client = createTransport(executablePath, workingDirectory);
  try {
    await client.start();
    const method = action === 'archive' ? 'thread/archive' : action === 'restore' ? 'thread/unarchive' : 'thread/delete';
    try {
      await client.request(method, { threadId });
    } catch (error) {
      if (action !== 'delete') throw error;
      if (isCodexThreadMissingError(error)) {
        return {
          threadId,
          state: 'deleted',
          checkedAt: new Date().toISOString(),
          message: '原生线程已不存在，星丛已清理本地记录。',
        };
      }
      if (!isCodexArchivedThreadDeleteError(error)) throw error;

      try {
        await client.request('thread/unarchive', { threadId });
      } catch (unarchiveError) {
        if (isCodexThreadMissingError(unarchiveError)) {
          return {
            threadId,
            state: 'deleted',
            checkedAt: new Date().toISOString(),
            message: '原生线程已不存在，星丛已清理本地记录。',
          };
        }
        throw unarchiveError;
      }

      try {
        await client.request('thread/delete', { threadId });
      } catch (deleteError) {
        if (isCodexThreadMissingError(deleteError)) {
          return {
            threadId,
            state: 'deleted',
            checkedAt: new Date().toISOString(),
            message: '原生线程已删除，星丛已清理本地记录。',
          };
        }
        await client.request('thread/archive', { threadId }).catch(() => undefined);
        throw deleteError;
      }
    }
    return {
      threadId,
      state: action === 'archive' ? 'archived' : action === 'restore' ? 'active' : 'deleted',
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function isCodexThreadMissingError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return /not[ _-]?found|does not exist|unknown thread|no such thread|404/i.test(detail);
}

function isCodexArchivedThreadDeleteError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return /archiv|归档/i.test(detail);
}

async function listAllCodexThreadIds(client: CodexAppServerTransport, workingDirectory: string, archived: boolean) {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await client.request<{ data?: unknown; nextCursor?: unknown }>('thread/list', {
      cwd: workingDirectory,
      limit: 100,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      sourceKinds: CODEX_THREAD_SOURCE_KINDS,
      archived,
      ...(cursor ? { cursor } : {}),
    });
    const value = isRecord(result) ? result : {};
    for (const thread of Array.isArray(value.data) ? value.data : []) if (isRecord(thread) && text(thread.id)) ids.add(text(thread.id));
    cursor = text(value.nextCursor) || undefined;
  } while (cursor);
  return ids;
}

export function parseCodexThreads(result: unknown, workingDirectory: string): CodexThreadSummary[] {
  const value = isRecord(result) ? result : {};
  const data = Array.isArray(value.data) ? value.data : [];
  return data.filter(isRecord).map((thread) => {
    const updatedAt = typeof thread.updatedAt === 'number' && Number.isFinite(thread.updatedAt)
      ? new Date(thread.updatedAt * 1000).toISOString()
      : undefined;
    return {
      threadId: text(thread.id),
      title: text(thread.name) || text(thread.preview) || '未命名 Codex 线程',
      cwd: text(thread.cwd) || workingDirectory,
      updatedAt,
    };
  }).filter((thread) => Boolean(thread.threadId) && path.resolve(thread.cwd).toLowerCase() === path.resolve(workingDirectory).toLowerCase());
}

type StreamInput = { kind: 'raw'; message: CodexRpcMessage } | { kind: 'mapped'; event: CodexMappedEvent };

interface ActiveRun {
  client: CodexAppServerTransport;
  threadId: string;
  turnId: string;
  cancelReason: string;
  cancelled?: boolean;
  owner: UserInputOwner;
  continuingPlan?: boolean;
  emit: (event: CodexMappedEvent) => void;
}

interface NativePendingApproval {
  kind: 'native';
  client: CodexAppServerTransport;
  runId: string;
  request: CodexApprovalRequest;
  emit: (event: CodexMappedEvent) => void;
}

interface AsteriumPendingApproval {
  kind: 'asterium';
  runId: string;
  resolve: (decision: 'allow_once' | 'deny') => void;
  emit: (event: CodexMappedEvent) => void;
}

type PendingApproval = NativePendingApproval | AsteriumPendingApproval;

interface NativePendingUserInput {
  kind: 'native';
  client: CodexAppServerTransport;
  runId: string;
  requestId: string | number;
  emit: (event: CodexMappedEvent) => void;
}

interface PlanPendingUserInput {
  kind: 'plan_execution';
  runId: string;
  emit: (event: CodexMappedEvent) => void;
  resolve: (response: UserInputResponse) => Promise<void>;
}

type PendingUserInput = (NativePendingUserInput | PlanPendingUserInput) & { owner: UserInputOwner; questions: UserInputQuestion[] };

export class CodexCliAdapter implements PartnerAdapter {
  readonly connectionSource = 'local_cli' as const;
  readonly capabilities = {
    streamingText: true,
    cancellation: true,
    sessionResume: true,
    toolEvents: true,
    fileEvents: true,
    authorizationBridge: true,
    userInputBridge: true,
    nativePlan: true,
    guidance: 'native' as const,
    compaction: true,
    extensions: [] as const,
  };
  private client?: CodexAppServerTransport;
  private readonly loadedThreads = new Set<string>();
  private readonly threadModels = new Map<string, string>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();
  private readonly runPermissionModes = new Map<string, 'read_only' | 'manual' | 'automatic' | 'full'>();
  private collaborationModes?: Array<{ mode?: string | null; model?: string | null; reasoning_effort?: string | null }>;
  private readonly journal = new Map<string, PartnerEvent[]>();
  private eventCounter = 0;

  constructor(
    private readonly executablePath: string,
    private readonly workingDirectory: string,
    private readonly createTransport: CreateCodexTransport = defaultCreateTransport,
    private additionalDirectories: string[] = [],
    private readonly resolveAttachment?: AttachmentPathResolver,
    private runtimeTools?: AsteriumRuntimeToolController,
    private readonly protectedRoots: readonly string[] = [],
  ) {}

  replaceRuntimeTools(runtimeTools: AsteriumRuntimeToolController) {
    this.runtimeTools = runtimeTools;
  }

  replaceRuntimeWorkspaceRoots(additionalDirectories: string[]) {
    this.additionalDirectories = [...additionalDirectories];
  }

  updateRuntimeContext(command: SendMessageCommand) {
    this.runtimeTools?.update({
      permissionMode: command.execution?.permissionMode ?? 'manual',
      planMode: command.execution?.planMode ?? 'default',
      context: command.runtimeContext,
      route: command.route,
    });
  }

  async *sendMessage(command: SendMessageCommand): AsyncIterable<PartnerEvent> {
    this.updateRuntimeContext(command);
    // Pin tools to this turn. A later retry may replace the adapter-level
    // controller, but late events from this turn must never target that retry.
    const runtimeTools = this.runtimeTools;
    const toolLifetime = new AbortController();
    const runtimeWorkspaceDirectories = [...this.additionalDirectories];
    const client = await this.ensureClient();
    const resolvedAttachments = await resolveCommandAttachments(command, this.resolveAttachment);
    const thread = command.sessionId && command.forkFromTurnId
      ? await this.forkThread(client, command.sessionId, command.forkFromTurnId, runtimeWorkspaceDirectories)
      : await this.bindThread(client, command.sessionId, runtimeTools, runtimeWorkspaceDirectories,
        command.sessionBootstrap?.developerContent ?? command.sessionBootstrap?.content ?? formatAsteriumMemoryBriefing(command.runtimeContext));
    const sessionId = thread.id;
    const routeKey = journalKey(command.partnerId, command.conversationId, sessionId);
    const mapper = new CodexEventMapper();
    const queue = new AsyncEventQueue<StreamInput>();
    let sequence = this.journal.get(routeKey)?.at(-1)?.sequence ?? 0;
    let terminal = false;
    let runId = '';
    let nativeTurnId: string;
    let planDecisionShown = false;
    const wrap = (event: CodexMappedEvent | { type: 'session.bound'; isNew: boolean; toolProtocolVersion?: number; model?: string; modelSource?: 'native_thread' } | { type: 'message.accepted' }): PartnerEvent => ({
      ...event,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      eventId: `codex-${sessionId}-${++this.eventCounter}`,
      partnerId: command.partnerId,
      conversationId: command.conversationId,
      connectionSource: command.connectionSource,
      clientMessageId: command.clientMessageId,
      sessionId,
      runId,
      sequence: ++sequence,
      occurredAt: new Date().toISOString(),
    } as PartnerEvent);
    const remember = (event: PartnerEvent) => {
      const events = this.journal.get(routeKey) ?? [];
      events.push(structuredClone(event));
      if (events.length > 1000) events.splice(0, events.length - 1000);
      this.journal.set(routeKey, events);
      return event;
    };

    const disposeMessage = client.onMessage((message) => {
      if (messageBelongsToThread(message, sessionId)) queue.push({ kind: 'raw', message });
    });
    const disposeClose = client.onClose((error) => queue.fail(error));

    try {
      if (command.managedPersonaUpdate) await client.request('thread/inject_items', {
        threadId: sessionId,
        items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: command.managedPersonaUpdate.content }] }],
      });
      const turnParams = {
        threadId: sessionId,
        input: [{ type: 'text', text: codexTurnText(command, attachmentPrompt(resolvedAttachments)) }],
        clientUserMessageId: command.clientMessageId,
        ...(await this.turnExecutionSettings(client, command, thread.model, runtimeWorkspaceDirectories)),
        ...this.runtimeWorkspaceRoots(runtimeWorkspaceDirectories, resolvedAttachments.map((item) => path.dirname(item.path))),
      };
      const result = await client.request<{ turn?: { id?: unknown } }>('turn/start', turnParams);
      runId = text(result?.turn?.id);
      if (!runId) throw new Error('CODEX_TURN_ID_MISSING');
      nativeTurnId = runId;
      this.active.set(runId, { client, threadId: sessionId, turnId: runId, cancelReason: '已由用户停止', owner: userInputOwner(command, runId, sessionId), emit: (event) => queue.push({ kind: 'mapped', event }) });
      this.runPermissionModes.set(runId, command.execution?.permissionMode ?? 'manual');
      yield remember(wrap({
        type: 'session.bound',
        isNew: !command.sessionId || Boolean(command.forkFromTurnId),
        ...(thread.toolProtocolVersion ? { toolProtocolVersion: thread.toolProtocolVersion } : {}),
        ...(thread.model ? { model: thread.model, modelSource: 'native_thread' as const } : {}),
      }));
      yield remember(wrap({ type: 'message.accepted' }));

      for await (const input of queue) {
        let mapped: CodexMappedEvent[];
        if (input.kind === 'raw' && command.execution?.planMode === 'plan' && !planDecisionShown && isSuccessfulTurnCompletion(input.message, nativeTurnId)) {
          planDecisionShown = true;
          const requestId = `codex-plan-${nativeTurnId}`;
          const questions = planExecutionQuestions();
          this.pendingUserInputs.set(requestId, {
            kind: 'plan_execution',
            owner: this.active.get(runId)!.owner,
            questions,
            runId,
            emit: (event) => queue.push({ kind: 'mapped', event }),
            resolve: async (response) => {
              const decision = planExecutionDecision(response);
              if (decision.action === 'stop') {
                queue.push({ kind: 'mapped', event: { type: 'plan.updated', status: 'ready', explanation: '计划已保留，本次任务已停止。' } });
                queue.push({ kind: 'mapped', event: { type: 'run.cancelled', reason: '你选择暂不执行计划，计划已保留。' } });
                return;
              }
              const revising = decision.action === 'revise';
              if (revising) planDecisionShown = false;
              queue.push({ kind: 'mapped', event: { type: 'plan.updated', status: revising ? 'planning' : 'executing', planMode: revising ? 'plan' : 'default', explanation: revising ? '已收到修改意见，Codex 继续完善计划。' : '已确认开始执行，Codex 正在退出计划模式。' } });
              queue.push({ kind: 'mapped', event: { type: 'work.status', state: 'working', summary: revising ? 'Codex 正在调整计划…' : 'Codex 正在按计划开始执行…' } });
              const continuationCommand: SendMessageCommand = {
                ...command,
                execution: { permissionMode: command.execution?.permissionMode ?? 'manual', planMode: revising ? 'plan' : 'default' },
              };
              this.updateRuntimeContext(continuationCommand);
              const continuing = this.active.get(runId);
              if (continuing) continuing.continuingPlan = true;
              try {
                const settings = await this.turnExecutionSettings(client, continuationCommand, thread.model, runtimeWorkspaceDirectories);
                if (!this.active.has(runId) || this.active.get(runId)?.cancelled) return;
                const execution = await client.request<{ turn?: { id?: unknown } }>('turn/start', {
                  threadId: sessionId,
                  input: [{ type: 'text', text: decision.action === 'revise' ? `用户对计划的修改意见：\n${decision.feedback}\n请保持 Plan 模式继续完善计划，完成后等待用户再次确认；尚未获准执行。` : '请按照刚才已经确认的计划开始执行。' }],
                  clientUserMessageId: `${command.clientMessageId}-${requestId}-${revising ? 'revision' : 'execution'}`,
                  ...settings,
                  ...this.runtimeWorkspaceRoots(runtimeWorkspaceDirectories, resolvedAttachments.map((item) => path.dirname(item.path))),
                });
                const nextTurnId = text(execution?.turn?.id);
                if (!nextTurnId) throw new Error('CODEX_PLAN_EXECUTION_TURN_ID_MISSING');
                nativeTurnId = nextTurnId;
                const active = this.active.get(runId);
                if (active) active.turnId = nextTurnId;
                if (!active || active.cancelled) await client.request('turn/interrupt', { threadId: sessionId, turnId: nextTurnId });
              } catch (error) {
                if (continuing?.cancelled) return;
                queue.push({ kind: 'mapped', event: { type: 'run.failed', error: {
                  code: revising ? 'CODEX_PLAN_REVISION_FAILED' : 'CODEX_PLAN_EXECUTION_FAILED',
                  message: revising ? '计划已经保留，但 Codex 未能继续修改计划。' : '计划已经保留，但 Codex 未能开始执行。',
                  stage: 'adapter',
                  retryable: true,
                  technicalDetail: error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 500) : undefined,
                } } });
              } finally { if (continuing) continuing.continuingPlan = false; }
            },
          });
          mapped = [
            { type: 'plan.updated', status: 'ready', explanation: '计划已就绪，等待你确认是否开始执行。' },
            { type: 'work.status', state: 'waiting_user_input', summary: 'Codex 等待你确认是否执行计划' },
            { type: 'user_input.requested', requestId, questions },
          ];
        } else {
          mapped = input.kind === 'mapped' ? [input.event] : this.mapInput(input.message, mapper, runId, nativeTurnId, queue, runtimeTools, toolLifetime.signal);
        }
        for (const event of mapped) {
          if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') terminal = true;
          yield remember(wrap(event));
        }
        if (terminal) break;
      }
    } catch (error) {
      if (!terminal && runId) {
        yield remember(wrap({
          type: 'run.failed',
          error: {
            code: 'CODEX_STREAM_INTERRUPTED',
            message: 'Codex 连接中断；下次发送时会重连并续接原会话。',
            stage: 'transport',
            retryable: true,
            technicalDetail: error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 500) : undefined,
          },
        }));
      } else {
        throw error;
      }
    } finally {
      disposeMessage();
      disposeClose();
      queue.close();
      if (runId) {
        toolLifetime.abort();
        this.active.delete(runId);
        this.runPermissionModes.delete(runId);
        for (const [authorizationId, pending] of this.pendingApprovals) {
          if (pending.runId === runId) this.pendingApprovals.delete(authorizationId);
        }
        for (const [requestId, pending] of this.pendingUserInputs) if (pending.runId === runId) this.pendingUserInputs.delete(requestId);
      }
    }
  }

  private mapInput(message: CodexRpcMessage, mapper: CodexEventMapper, runId: string, nativeTurnId: string, queue: AsyncEventQueue<StreamInput>, runtimeTools: AsteriumRuntimeToolController | undefined, signal: AbortSignal): CodexMappedEvent[] {
    if (!messageBelongsToTurn(message, nativeTurnId)) return [];
    if (message.method === 'item/tool/requestUserInput' && message.id !== undefined) {
      const params = isRecord(message.params) ? message.params : {};
      const questions = Array.isArray(params.questions) ? params.questions.filter(isRecord).map((question, index) => ({
        id: text(question.id) || `question-${index + 1}`,
        header: text(question.header) || undefined,
        prompt: text(question.question) || '请补充信息',
        options: Array.isArray(question.options) ? question.options.filter(isRecord).map((option) => ({ label: text(option.label), description: text(option.description) || undefined })).filter((option) => Boolean(option.label)) : undefined,
      })) : [];
      if (questions.length) {
        const requestId = `codex-input-${String(message.id)}`;
        this.pendingUserInputs.set(requestId, { kind: 'native', client: this.client!, runId, owner: this.active.get(runId)!.owner, questions, requestId: message.id, emit: (event) => queue.push({ kind: 'mapped', event }) });
        return [{ type: 'work.status', state: 'waiting_user_input', summary: 'Codex 需要你补充信息' }, { type: 'user_input.requested', requestId, questions }];
      }
    }
    if (message.method === 'item/tool/call' && message.id !== undefined) {
      const params = isRecord(message.params) ? message.params : {};
      const toolName = text(params.tool) || text(params.name);
      if (toolName === 'deliver_file') {
        const args = isRecord(params.arguments) ? params.arguments : isRecord(params.input) ? params.input : {};
        const filePath = text(args.path);
        const target = path.resolve(this.workingDirectory, filePath);
        const name = text(args.name) || path.basename(target);
        if (!filePath) {
          this.client?.respond(message.id, { success: false, contentItems: [{ type: 'inputText', text: 'path 是必填项。' }] });
          return [];
        }
        try {
          if (!statSync(target).isFile()) throw new Error('not-file');
        } catch {
          this.client?.respond(message.id, { success: false, contentItems: [{ type: 'inputText', text: '文件不存在或不是普通文件，未登记到交付区。' }] });
          return [];
        }
        this.client?.respond(message.id, { success: true, contentItems: [{ type: 'inputText', text: `已登记交付：${name}` }] });
        return [{ type: 'file.produced', artifactId: `codex-delivery-${String(params.callId ?? message.id)}`, toolCallId: text(params.callId) || undefined, name, artifactRef: target, source: { kind: 'local_path', path: target }, registrationMethod: 'deliver_tool' }];
      }
      if (delegationTools.some(tool => tool.name === toolName) || toolName === 'asterium_automation' || toolName === 'asterium_status' || toolName === 'asterium_workspace' || toolName === 'mention_partner' || toolName === 'asterium_task' || toolName === 'submit_workflow_draft' || toolName === 'project_notebook'
        || toolName === 'hold_memory' || toolName === 'search_memory' || toolName === 'comment_memory' || toolName === 'update_memory' || toolName === 'read_memory_source') {
        const args = isRecord(params.arguments) ? params.arguments : isRecord(params.input) ? params.input : {};
        const action = text(args.action);
        const mutates = toolName === 'asterium_workspace' && (action === 'add' || action === 'remove');
        const execute = async () => {
          try {
            if (!runtimeTools) throw new Error('ASTERIUM_RUNTIME_TOOLS_NOT_CONFIGURED');
            let content: string;
            if (toolName === 'asterium_status') content = await runtimeTools.status(text(args.key) as AsteriumStatusKey);
            else if (toolName === 'asterium_automation') {
              if (!runtimeTools.automation) throw new Error('AUTOMATION_TOOL_UNAVAILABLE');
              content = await runtimeTools.automation(args);
            }
            else if (delegationTools.some(tool => tool.name === toolName)) {
              if (!runtimeTools.delegation) throw new Error('DELEGATION_TOOL_FORBIDDEN');
              content = await runtimeTools.delegation(toolName, args, signal, text(params.callId) || String(message.id));
            }
            else if (toolName === 'project_notebook') {
              if (!runtimeTools.projectNotebook) throw new Error('ASTERIUM_PROJECT_NOTEBOOK_NOT_AVAILABLE');
              content = await runtimeTools.projectNotebook(parseProjectNotebookToolInput(args));
            }
            else if (toolName === 'search_memory') {
              if (!runtimeTools.memory) throw new Error('ASTERIUM_MEMORY_NOT_AVAILABLE');
              content = await runtimeTools.memory.search(parseSearchMemoryInput(args));
            }
            else if (toolName === 'read_memory_source') {
              if (!runtimeTools.memory) throw new Error('ASTERIUM_MEMORY_NOT_AVAILABLE');
              content = await runtimeTools.memory.readSource(parseReadMemorySourceInput(args));
            }
            else if (toolName === 'hold_memory') {
              if (runtimeTools.memory?.access !== 'write' || !runtimeTools.memory.hold) throw new Error('ASTERIUM_MEMORY_WRITE_NOT_AVAILABLE');
              content = await runtimeTools.memory.hold(parseHoldMemoryInput(args));
            }
            else if (toolName === 'comment_memory') {
              if (runtimeTools.memory?.access !== 'write' || !runtimeTools.memory.comment) throw new Error('ASTERIUM_MEMORY_WRITE_NOT_AVAILABLE');
              content = await runtimeTools.memory.comment(parseCommentMemoryInput(args));
            }
            else if (toolName === 'update_memory') {
              if (runtimeTools.memory?.access !== 'write' || !runtimeTools.memory.update) throw new Error('ASTERIUM_MEMORY_WRITE_NOT_AVAILABLE');
              content = await runtimeTools.memory.update(parseUpdateMemoryInput(args));
            }
            else if (toolName === 'submit_workflow_draft') {
              if (!runtimeTools.workflowDraft) throw new Error('ASTERIUM_WORKFLOW_DRAFT_NOT_AVAILABLE');
              content = await runtimeTools.workflowDraft(parseWorkflowDraftToolInput(args));
            }
            else if (toolName === 'asterium_task') {
              if (!runtimeTools.task) throw new Error('ASTERIUM_TASK_NOT_AVAILABLE');
              content = await runtimeTools.task(parseAsteriumTaskToolInput(args));
            }
            else if (toolName === 'mention_partner') {
              if (!runtimeTools.mentionPartner) throw new Error('STUDIO_MENTION_NOT_AVAILABLE');
              content = await runtimeTools.mentionPartner(text(args.partner_id));
            } else content = await runtimeTools.workspace(action as AsteriumWorkspaceAction, text(args.path) || undefined);
            this.client?.respond(message.id!, { success: true, contentItems: [{ type: 'inputText', text: content }] });
          } catch (error) {
            this.client?.respond(message.id!, { success: false, contentItems: [{ type: 'inputText', text: codexRuntimeToolError(error) }] });
          }
        };
        const permissionMode = this.runPermissionModes.get(runId) ?? 'manual';
        if (!mutates || permissionMode === 'full') {
          void execute();
          return [];
        }
        if (permissionMode === 'read_only') {
          this.client?.respond(message.id, { success: false, contentItems: [{ type: 'inputText', text: '当前会话处于只读模式，本次操作未执行，没有产生任何修改。' }] });
          return [];
        }
        const authorizationId = `codex-asterium-${String(params.callId ?? message.id)}`;
        this.pendingApprovals.set(authorizationId, {
          kind: 'asterium', runId,
          resolve: (decision) => {
            if (decision === 'allow_once') void execute();
            else this.client?.respond(message.id!, { success: false, contentItems: [{ type: 'inputText', text: '用户拒绝了这次工作区变更，没有产生任何修改。' }] });
          },
          emit: (event) => queue.push({ kind: 'mapped', event }),
        });
        return [{ type: 'work.status', state: 'waiting_authorization', summary: 'Codex 请求变更当前对话的工作区' }, {
          type: 'authorization.requested', authorizationId, toolCallId: text(params.callId) || undefined,
          action: 'external_side_effect', risk: 'medium', summary: `Codex 请求${action === 'add' ? '增加' : '移除'}额外工作区。`, targets: [text(args.path)],
          purpose: action === 'add' ? 'workspace_add' : 'workspace_remove',
        }];
      }
    }
    const approval = mapCodexApprovalRequest(message);
    if (approval) {
      if (approval.event.targets.some((target) => codexTargetReferencesProtected(target, this.workingDirectory, this.protectedRoots))
        || codexTargetReferencesProtected(approval.event.summary, this.workingDirectory, this.protectedRoots)
        || codexCommandReferencesProtected(approval.params.command, this.protectedRoots)) {
        this.client!.respond(approval.requestId, approvalResponse(approval, 'deny'));
        return [{ type: 'work.status', state: 'working', summary: '星丛资料目录受保护，本次操作未执行。' } as CodexMappedEvent];
      }
      if ((this.runPermissionModes.get(runId) ?? 'manual') === 'full') {
        this.client!.respond(approval.requestId, approvalResponse(approval, 'allow_once'));
        return [];
      }
      this.pendingApprovals.set(approval.authorizationId, {
        kind: 'native',
        client: this.client!,
        runId,
        request: approval,
        emit: (event) => queue.push({ kind: 'mapped', event }),
      });
      return [
        { type: 'work.status', state: 'waiting_authorization', summary: approval.event.summary } as CodexMappedEvent,
        approval.event,
      ];
    }
    const active = this.active.get(runId);
    return mapper.map(message, active?.cancelReason ?? '已由用户停止');
  }

  private async bindThread(client: CodexAppServerTransport, requestedSessionId: string | undefined, runtimeTools: AsteriumRuntimeToolController | undefined, runtimeWorkspaceDirectories: string[], developerInstructions?: string): Promise<{ id: string; model: string; toolProtocolVersion?: number }> {
    if (requestedSessionId) {
      if (!this.loadedThreads.has(requestedSessionId)) {
        const result = await client.request<{ thread?: { id?: unknown }; model?: unknown }>('thread/resume', {
          threadId: requestedSessionId,
          cwd: this.workingDirectory,
          ...this.runtimeWorkspaceRoots(runtimeWorkspaceDirectories),
        });
        const id = text(result?.thread?.id) || requestedSessionId;
        const model = text(result?.model);
        this.loadedThreads.add(id);
        if (model) this.threadModels.set(id, model);
        return { id, model };
      }
      return { id: requestedSessionId, model: this.threadModels.get(requestedSessionId) ?? '' };
    }
    const result = await client.request<{ thread?: { id?: unknown }; model?: unknown }>('thread/start', {
      cwd: this.workingDirectory,
      ...this.runtimeWorkspaceRoots(runtimeWorkspaceDirectories),
      dynamicTools: runtimeTools ? asteriumDynamicTools(runtimeTools) : [deliverFileDynamicTool()],
      ...(developerInstructions?.trim() ? { developerInstructions } : {}),
    });
    const id = text(result?.thread?.id);
    if (!id) throw new Error('CODEX_THREAD_ID_MISSING');
    const model = text(result?.model);
    this.loadedThreads.add(id);
    if (model) this.threadModels.set(id, model);
    return { id, model, toolProtocolVersion: CODEX_NATIVE_TOOL_PROTOCOL_VERSION };
  }

  private async forkThread(client: CodexAppServerTransport, threadId: string, lastTurnId: string, runtimeWorkspaceDirectories: string[]): Promise<{ id: string; model: string; toolProtocolVersion?: number }> {
    const result = await client.request<{ thread?: { id?: unknown }; model?: unknown }>('thread/fork', {
      threadId,
      lastTurnId,
      cwd: this.workingDirectory,
      excludeTurns: true,
      ...this.runtimeWorkspaceRoots(runtimeWorkspaceDirectories),
    });
    const id = text(result?.thread?.id);
    if (!id) throw new Error('CODEX_FORK_THREAD_ID_MISSING');
    const model = text(result?.model);
    this.loadedThreads.add(id);
    if (model) this.threadModels.set(id, model);
    return { id, model };
  }

  private runtimeWorkspaceRoots(additionalDirectories: string[], temporaryDirectories: string[] = []) {
    return { runtimeWorkspaceRoots: [...new Set([this.workingDirectory, ...additionalDirectories, ...temporaryDirectories])] };
  }

  private async turnExecutionSettings(client: CodexAppServerTransport, command: SendMessageCommand, threadModel: string, runtimeWorkspaceDirectories: string[]) {
    if (!command.execution) return {};
    const selected = command.execution?.permissionMode ?? 'manual';
    const plan = command.execution?.planMode === 'plan';
    const permissionMode = plan ? 'read_only' : selected;
    const writableRoots = [this.workingDirectory, ...runtimeWorkspaceDirectories];
    const permissions = permissionMode === 'read_only'
        ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
        : { approvalPolicy: 'on-request', approvalsReviewer: permissionMode === 'automatic' ? 'auto_review' : 'user', sandboxPolicy: { type: 'workspaceWrite', writableRoots, networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } };
    if (!this.collaborationModes) {
      const result = await client.request<{ data?: Array<{ mode?: string | null; model?: string | null; reasoning_effort?: string | null }> }>('collaborationMode/list', {});
      this.collaborationModes = result.data ?? [];
    }
    const wantedMode = plan ? 'plan' : 'default';
    const preset = this.collaborationModes.find((item) => item.mode === wantedMode);
    const model = text(preset?.model) || threadModel;
    if (plan && (!preset || !model)) throw new Error('CODEX_NATIVE_PLAN_UNAVAILABLE');
    return {
      ...permissions,
      ...(preset && model ? { collaborationMode: { mode: wantedMode, settings: { model, reasoning_effort: preset.reasoning_effort ?? null, developer_instructions: null } } } : {}),
    };
  }

  async restoreProfileSnapshot(sessionId: string, bootstrap: SessionBootstrapDocument): Promise<void> {
    const signal = AbortSignal.timeout(30_000);
    const client = await this.ensureClient(signal);
    try { await abortable(client.request('thread/resume', { threadId: sessionId, cwd: this.workingDirectory, developerInstructions: bootstrap.developerContent ?? bootstrap.content }), signal);
      await abortable(client.request('thread/inject_items', { threadId: sessionId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '[此前资料重读未提交，恢复以下星丛原会话版本；不改变其他规则]\n' + (bootstrap.developerContent ?? bootstrap.content) }] }] }), signal); }
    catch (error) { await client.close(); throw error; }
  }

  async reloadProfiles(sessionId: string, prompt: string, bootstrap: SessionBootstrapDocument, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted(); if (this.active.size) throw new Error('SESSION_COMMAND_BUSY');
    const client = await this.ensureClient(signal);
    try { await abortable(client.request('thread/resume', { threadId: sessionId, cwd: this.workingDirectory, developerInstructions: bootstrap.developerContent ?? bootstrap.content, ...this.runtimeWorkspaceRoots(this.additionalDirectories) }), signal); } catch (error) { await client.close(); throw error; }
    return new Promise<string>((resolve, reject) => {
      let turnId = '', message = '', settled = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; offMessage(); offClose(); signal.removeEventListener('abort', abort);
        if (error) { if (turnId) void client.request('turn/interrupt', { threadId: sessionId, turnId }).catch(() => undefined); void client.close().then(() => reject(error), () => reject(error)); }
        else resolve(message.trim());
      };
      const abort = () => finish(new Error('PROFILE_RELOAD_INTERRUPTED'));
      const offClose = client.onClose(() => finish(new Error('PROFILE_RELOAD_CONNECTION_CLOSED')));
      const offMessage = client.onMessage((event) => {
        const params = event.params; if (params?.threadId !== sessionId) return;
        if (event.id !== undefined && event.method) { finish(new Error('PROFILE_RELOAD_UNEXPECTED_TOOL')); return; }
        if (event.method === 'turn/started' && isRecord(params.turn)) { const id = text(params.turn.id); if (turnId && id !== turnId) { finish(new Error('SESSION_COMMAND_BUSY')); return; } turnId = id; }
        if (params.turnId && turnId && params.turnId !== turnId) return;
        if ((event.method === 'item/started' || event.method === 'item/completed') && isRecord(params.item) && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(text(params.item.type))) { finish(new Error('PROFILE_RELOAD_UNEXPECTED_TOOL')); return; }
        if (event.method === 'item/agentMessage/delta') { message += text(params.delta); if (message.length > 4000) finish(new Error('PROFILE_RELOAD_RESPONSE_TOO_LARGE')); }
        if (event.method === 'error' && params.willRetry !== true) finish(new Error('PROFILE_RELOAD_INCOMPLETE'));
        if (event.method === 'turn/completed' && isRecord(params.turn) && text(params.turn.id) === turnId) {
          if (params.turn.status !== 'completed' || !message.trim()) finish(new Error('PROFILE_RELOAD_INCOMPLETE')); else finish();
        }
      });
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); return; }
      void client.request<{ turn?: { id?: unknown } }>('turn/start', { threadId: sessionId, input: [{ type: 'text', text: prompt }], environments: [], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } }).then((result) => {
        const id = text(result.turn?.id); if (!id || turnId && turnId !== id) finish(new Error('PROFILE_RELOAD_INCOMPLETE')); else turnId = id;
      }, () => finish(new Error('PROFILE_RELOAD_INCOMPLETE')));
    });
  }

  async compactSession(sessionId: string, signal: AbortSignal): Promise<SessionCompactResult> {
    signal.throwIfAborted();
    if (this.active.size) throw new Error('COMPACT_CONVERSATION_BUSY');
    const client = await this.ensureClient(signal);
    try { await abortable(this.bindThread(client, sessionId, undefined, this.additionalDirectories), signal); }
    catch (error) { await client.close(); throw error; }
    signal.throwIfAborted();
    return new Promise<SessionCompactResult>((resolve, reject) => {
      let turnId = '', compacted = false, settled = false;
      const finish = (error?: Error, result?: SessionCompactResult) => {
        if (settled) return; settled = true;
        offMessage(); offClose(); signal.removeEventListener('abort', abort);
        if (error) void client.close().then(() => reject(error), () => reject(error)); else resolve(result!);
      };
      const abort = () => finish(new Error('COMPACT_INTERRUPTED'));
      const offClose = client.onClose(() => finish(new Error('COMPACT_CONNECTION_CLOSED')));
      const offMessage = client.onMessage((message) => {
        const params = message.params;
        if (params?.threadId !== sessionId) return;
        if (message.id !== undefined && message.method) { finish(new Error('COMPACT_UNEXPECTED_TOOL')); return; }
        if (message.method === 'turn/started' && isRecord(params.turn)) {
          const incoming = text(params.turn.id);
          if (turnId && incoming !== turnId) { finish(new Error('COMPACT_CONVERSATION_BUSY')); return; }
          turnId = incoming;
        }
        if (turnId && params.turnId && params.turnId !== turnId) return;
        if (message.method === 'item/completed' && isRecord(params.item) && params.item.type === 'contextCompaction') compacted = true;
        if (message.method === 'error' && params.willRetry !== true) finish(new Error('COMPACT_NATIVE_FAILED'));
        if (message.method === 'turn/completed' && isRecord(params.turn) && text(params.turn.id) === turnId) {
          if (params.turn.status !== 'completed') finish(new Error('COMPACT_NATIVE_FAILED'));
          else finish(undefined, compacted ? { status: 'compacted', message: 'Codex 已压缩当前线程上下文，聊天记录保留。' } : { status: 'unchanged', message: 'Codex 未产生压缩结果，当前上下文保持不变。' });
        }
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void client.request('thread/compact/start', { threadId: sessionId }).catch(() => finish(new Error('COMPACT_NATIVE_UNAVAILABLE')));
    });
  }

  private async ensureClient(signal?: AbortSignal) {
    if (this.client?.connected) return this.client;
    this.loadedThreads.clear();
    this.threadModels.clear();
    const client = this.createTransport(this.executablePath, this.workingDirectory);
    try {
      const started = client.start();
      await (signal ? abortable(started, signal) : started);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    this.client = client;
    client.onClose(() => {
      if (this.client === client) {
        this.client = undefined;
        this.loadedThreads.clear();
        this.threadModels.clear();
      }
    });
    return client;
  }

  async *resumeSession(command: ResumeSessionCommand): AsyncIterable<PartnerEvent> {
    const routeKey = journalKey(command.partnerId, command.conversationId, command.sessionId);
    for (const event of (this.journal.get(routeKey) ?? []).filter((item) => item.sequence > command.afterSequence
      && item.partnerId === command.partnerId && item.conversationId === command.conversationId && item.sessionId === command.sessionId)) {
      yield structuredClone(event);
    }
  }

  async resolveAuthorization(command: ResolveAuthorizationCommand) {
    const pending = this.pendingApprovals.get(command.authorizationId);
    if (!pending) throw new Error('CODEX_AUTHORIZATION_NOT_FOUND');
    this.pendingApprovals.delete(command.authorizationId);
    if (pending.kind === 'native') pending.client.respond(pending.request.requestId, approvalResponse(pending.request, command.decision));
    else pending.resolve(command.decision);
    pending.emit({ type: 'authorization.resolved', authorizationId: command.authorizationId, decision: command.decision });
    pending.emit({ type: 'work.status', state: 'working', summary: command.decision === 'allow_once' ? '授权已确认，Codex 继续工作…' : '已拒绝授权，Codex 正在调整方案…' });
  }

  async resolveUserInput(command: ResolveUserInputCommand) {
    const pending = this.pendingUserInputs.get(command.requestId);
    if (!pending || this.active.get(pending.runId)?.cancelled) throw new Error('CODEX_USER_INPUT_NOT_FOUND');
    assertUserInputResolution(command, pending.owner, pending.questions);
    if (pending.kind === 'plan_execution') planExecutionDecision(command);
    this.pendingUserInputs.delete(command.requestId);
    if (pending.kind === 'native') pending.client.respond(pending.requestId, { answers: Object.fromEntries(Object.entries(command.answers).map(([id, answers]) => [id, { answers }])) });
    pending.emit({ type: 'user_input.resolved', requestId: command.requestId, answers: command.answers, ...(command.customAnswers ? { customAnswers: command.customAnswers } : {}) });
    if (pending.kind === 'native') pending.emit({ type: 'work.status', state: 'working', summary: '已收到回答，Codex 继续调整计划…' });
    else await pending.resolve(command);
  }

  async sendGuidance(command: SendGuidanceCommand): Promise<SendGuidanceResult> {
    const active = this.active.get(command.runId);
    if (!active || active.threadId !== command.sessionId) throw new Error('CODEX_ACTIVE_TURN_NOT_FOUND');
    await active.client.request('turn/steer', {
      threadId: active.threadId,
      expectedTurnId: active.turnId,
      clientUserMessageId: command.clientMessageId,
      input: [{ type: 'text', text: command.content.text }],
    });
    return { disposition: 'accepted' };
  }

  async cancel(command: CancelRunCommand) {
    const active = this.active.get(command.runId);
    if (!active) return;
    active.cancelReason = command.reason?.trim() || '已由用户停止';
    active.cancelled = true;
    if (active.continuingPlan) { active.emit({ type: 'run.cancelled', reason: active.cancelReason }); return; }
    for (const [requestId, pending] of this.pendingUserInputs) {
      if (pending.runId === command.runId && pending.kind === 'plan_execution') {
        this.pendingUserInputs.delete(requestId);
        pending.emit({ type: 'run.cancelled', reason: active.cancelReason });
        return;
      }
    }
    await active.client.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId });
  }

  async dispose() {
    const client = this.client;
    this.client = undefined;
    this.loadedThreads.clear();
    this.threadModels.clear();
    this.active.clear();
    this.pendingApprovals.clear();
    this.runPermissionModes.clear();
    this.pendingUserInputs.clear();
    await client?.close();
  }
}

export function codexTurnText(command: SendMessageCommand, attachmentText = '') {
  return `${withHandoffContext(command.content.text, command.contextHandoff)}${attachmentText}`;
}

async function resolveCommandAttachments(command: SendMessageCommand, resolver?: AttachmentPathResolver) {
  if (!command.attachments?.length || !resolver) return [];
  return Promise.all(command.attachments.map(async (attachment) => ({ ...attachment, path: await resolver(attachment.id, command.conversationId) })));
}

function attachmentPrompt(attachments: Awaited<ReturnType<typeof resolveCommandAttachments>>) {
  if (!attachments.length) return '';
  return `\n\n[用户附件 · 不可变历史快照]\n${attachments.map((item) => `- ${item.name} (${item.mediaType}, ${item.sizeBytes} bytes)\n  只读快照路径: ${item.path}`).join('\n')}\n请按任务需要自行读取；不要假设文件内容或格式，也不要修改这些历史输入快照。`;
}

function deliverFileDynamicTool() {
  return {
    name: 'deliver_file',
    description: DELIVERY_TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute or current-working-directory-relative file path.' }, name: { type: 'string', description: 'Optional display file name.' } },
      required: ['path'],
      additionalProperties: false,
    },
  };
}

export function asteriumDynamicTools(runtimeTools: AsteriumRuntimeToolController) {
  const memoryReadTools = runtimeTools.memory ? memoryDynamicTools('read', Boolean(runtimeTools.workflowDraft)) : [];
  if (runtimeTools.workflowDraft) return [workflowDraftDynamicTool(), ...memoryReadTools];
  return [
    deliverFileDynamicTool(),
    ...(runtimeTools.automation ? [{ name: 'asterium_automation', description: AUTOMATION_TOOL_DESCRIPTION, inputSchema: automationToolJsonSchema }] : []),
    {
      name: 'asterium_status',
      description: 'Read authoritative Asterium state by key. In group chat, conversation reports the speaking mode, whether PASS is allowed, the queue, and whether partner mentions are available. Use workspace to confirm the current cwd and workspaceFolders instead of guessing from earlier messages. This tool never changes state.',
      inputSchema: { type: 'object', properties: { key: { type: 'string', enum: ['time', 'partner', 'partners', 'user', 'runtime', 'permissions', 'conversation', 'conversation_files', 'workspace'] } }, required: ['key'], additionalProperties: false },
    },
    {
      name: 'asterium_workspace',
      description: 'Query, add, or remove additional workspaces shared by this partner. Use list to inspect cwd and workspaceFolders. A user-approved one-time outside-workspace file write stays temporary: during the same turn, reread only that exact file if verification is needed; do not treat its parent as a workspace. A command that mentions an outside path does not add that directory. Request action=add only for repeated or directory-level access. Adding follows the current permission flow and changes apply from the next turn. cwd can only be changed by the user in Asterium, and removing access never deletes files.',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'add', 'remove'] }, path: { type: 'string' } }, required: ['action'], additionalProperties: false },
    },
    ...(runtimeTools.mentionPartner ? [{
      name: 'mention_partner',
      description: 'Invite one member to speak next in this public group-discussion round. First check asterium_status(key=conversation): this is available only when mentionPartnerAvailable=true. Pass a unique display name, mention name, or exact partnerId; duplicate names require the partnerId from asterium_status(key=partners).',
      inputSchema: { type: 'object', properties: { partner_id: { type: 'string', description: 'Unique display name, mention name, or exact partnerId.' } }, required: ['partner_id'], additionalProperties: false },
    }] : []),
    ...(runtimeTools.task ? [asteriumTaskDynamicTool()] : []),
    ...(runtimeTools.projectNotebook ? [projectNotebookDynamicTool()] : []),
    ...(runtimeTools.delegation ? delegationTools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) : []),
    ...memoryReadTools,
    ...(runtimeTools.memory?.access === 'write' ? memoryDynamicTools('write') : []),
  ];
}

function projectNotebookDynamicTool() {
  return {
    name: 'project_notebook',
    description: 'List this partner\u2019s active projects or read, append to, and revision-safely replace this partner\u2019s private project work notebook. This is not long-term memory. Single chat read/write requires project_id; Studio fixes the current project. replace requires expected_revision from the latest result.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'append', 'replace'] },
        project_id: { type: 'string' },
        content: { type: 'string' },
        expected_revision: { type: 'integer', minimum: 0 },
      },
      required: ['action'],
      additionalProperties: false,
    },
  };
}

function memoryDynamicTools(access: 'read' | 'write', workflowPlanning = false) {
  const sourceSchema = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['single_chat', 'studio'] },
      conversation_id: { type: 'string' },
      room_id: { type: 'string' },
      message_id: { type: 'string' },
    },
    required: ['kind', 'message_id'],
    additionalProperties: false,
  };
  if (access === 'read') return [
    {
      name: 'search_memory',
      description: memoryToolDescription('search_memory', workflowPlanning),
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
          types: { type: 'array', items: { type: 'string', enum: MEMORY_TYPES } },
          statuses: { type: 'array', items: { type: 'string', enum: MEMORY_STATUSES } },
          from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'read_memory_source',
      description: memoryToolDescription('read_memory_source', workflowPlanning),
      inputSchema: {
        type: 'object', properties: { memory_id: { type: 'string' }, source_index: { type: 'integer', minimum: 0 } },
        required: ['memory_id'], additionalProperties: false,
      },
    },
  ];
  return [
    {
      name: 'hold_memory',
      description: memoryToolDescription('hold_memory'),
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: MEMORY_TYPES }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
          weight: { type: 'integer', minimum: 1, maximum: 5 }, occurred_at: { type: 'string' }, sources: { type: 'array', items: sourceSchema },
        },
        required: ['type', 'body'], additionalProperties: false,
      },
    },
    {
      name: 'comment_memory',
      description: memoryToolDescription('comment_memory'),
      inputSchema: {
        type: 'object', properties: { memory_id: { type: 'string' }, content: { type: 'string' }, sources: { type: 'array', items: sourceSchema } },
        required: ['memory_id', 'content'], additionalProperties: false,
      },
    },
    {
      name: 'update_memory',
      description: memoryToolDescription('update_memory'),
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'string' }, type: { type: 'string', enum: MEMORY_TYPES }, status: { type: 'string', enum: MEMORY_STATUSES },
          body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, weight: { type: 'integer', minimum: 1, maximum: 5 },
          occurred_at: { type: ['string', 'null'] }, superseded_by_memory_id: { type: ['string', 'null'] },
        },
        required: ['memory_id'], additionalProperties: false,
      },
    },
  ];
}

function workflowDraftDynamicTool() {
  const stringArray = { type: 'array', items: { type: 'string' } };
  return {
    name: 'submit_workflow_draft',
    description: 'Submit one complete editable workflow DAG proposal for this dedicated planning run. Main validates and saves a draft only; this cannot activate a workflow or create tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, description: { type: 'string' }, generation_summary: { type: 'string' },
        nodes: { type: 'array', items: { type: 'object', properties: {
          client_key: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, assignee_partner_id: { type: 'string' },
          dependency_keys: stringArray, acceptance_criteria: stringArray, note: { type: 'string' }, work_role_id: { type: 'string' }, review_role_id: { type: 'string' }, method_template_id: { type: 'string' },
          completion_rule: { type: 'object', properties: { type: { type: 'string', enum: ['executor_submit', 'partner_review', 'user_confirm'] }, reviewer_partner_id: { type: 'string' }, auto_rework_limit: { type: 'integer' } }, required: ['type'], additionalProperties: false },
          source_message_ids: stringArray, basis_summary: { type: 'string' },
        }, required: ['client_key', 'title', 'description', 'dependency_keys', 'acceptance_criteria', 'completion_rule', 'source_message_ids'], additionalProperties: false } },
      },
      required: ['name', 'description', 'generation_summary', 'nodes'],
      additionalProperties: false,
    },
  };
}

function asteriumTaskDynamicTool() {
  return {
    name: 'asterium_task',
    description: 'Read the current frozen workspace-task contract, submit an execution/rework handoff, or submit an independent review. This never changes files or bypasses permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['context', 'submit_handoff', 'submit_review'] },
        disposition: { type: 'string', enum: ['submitted', 'needs_user_decision', 'blocked'] },
        summary: { type: 'string' },
        criterion_evidence: { type: 'array', items: { type: 'object', properties: { criterion_id: { type: 'string' }, result: { type: 'string', enum: ['satisfied', 'not_satisfied', 'unverified'] }, evidence: { type: 'array', items: { type: 'string' } } }, required: ['criterion_id', 'result', 'evidence'], additionalProperties: false } },
        changed_paths: { type: 'array', items: { type: 'string' } },
        verification: { type: 'array', items: { type: 'object', properties: { command_or_check: { type: 'string' }, result: { type: 'string', enum: ['passed', 'failed', 'not_run'] }, evidence: { type: 'string' } }, required: ['command_or_check', 'result'], additionalProperties: false } },
        delivery_refs: { type: 'array', items: { type: 'string' } },
        unresolved_issues: { type: 'array', items: { type: 'string' } },
        user_decision: { type: 'object', properties: { question: { type: 'string' }, reason: { type: 'string' }, affected_criteria: { type: 'array', items: { type: 'string' } } }, required: ['question', 'reason', 'affected_criteria'], additionalProperties: false },
        decision: { type: 'string', enum: ['pass', 'changes_required', 'needs_user_decision'] },
        criterion_reviews: { type: 'array', items: { type: 'object', properties: { criterion_id: { type: 'string' }, verdict: { type: 'string', enum: ['pass', 'fail', 'unverified'] }, evidence: { type: 'array', items: { type: 'string' } }, feedback: { type: 'string' } }, required: ['criterion_id', 'verdict', 'evidence'], additionalProperties: false } },
      },
      required: ['action'],
      additionalProperties: false,
    },
  };
}

function codexRuntimeToolError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'ASTERIUM_READ_ONLY') return '当前会话处于只读模式，本次操作未执行，没有产生任何修改。';
  if (code === 'WORKSPACE_CWD_IMMUTABLE') return 'cwd 只能由用户在星丛界面更改，不能通过工作区工具移除。';
  return `星丛工具执行失败：${code}`;
}

function codexTargetReferencesProtected(target: string, cwd: string, protectedRoots: readonly string[]) {
  if (!protectedRoots.length) return false;
  if (textReferencesProtectedRoot(target, protectedRoots)) return true;
  if (path.isAbsolute(target)) return protectedRoots.some((root) => pathsOverlap(target, root));
  if (/^[.]{0,2}[\\/]/.test(target)) return protectedRoots.some((root) => pathsOverlap(path.resolve(cwd, target), root));
  return false;
}

function codexCommandReferencesProtected(command: unknown, protectedRoots: readonly string[]) {
  if (!protectedRoots.length) return false;
  const textValue = Array.isArray(command) ? command.map(String).join(' ') : typeof command === 'string' ? command : '';
  return Boolean(textValue) && textReferencesProtectedRoot(textValue, protectedRoots);
}

function messageBelongsToThread(message: CodexRpcMessage, threadId: string) {
  const params = message.params ?? {};
  const thread = isRecord(params.thread) ? params.thread : {};
  const candidate = text(params.threadId) || text(thread.id);
  if (candidate) return candidate === threadId;
  return message.method === 'error' || message.method === 'warning';
}

function messageBelongsToTurn(message: CodexRpcMessage, turnId: string) {
  const params = message.params ?? {};
  const turn = isRecord(params.turn) ? params.turn : {};
  const candidate = text(params.turnId) || text(turn.id);
  if (candidate) return candidate === turnId;
  return message.method === 'error' || message.method === 'warning';
}

function isSuccessfulTurnCompletion(message: CodexRpcMessage, turnId: string) {
  if (message.method !== 'turn/completed' || !messageBelongsToTurn(message, turnId)) return false;
  const params = message.params ?? {};
  const turn = isRecord(params.turn) ? params.turn : {};
  return text(turn.status).toLowerCase() === 'completed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function lifecycleUnavailable(threadIds: string[], message: string): NativeThreadLifecycleResult[] {
  const checkedAt = new Date().toISOString();
  return threadIds.map((threadId) => ({ threadId, state: 'unavailable', checkedAt, message, reason: 'runtime_unavailable' }));
}

function isCodexStateRuntimeInitializationError(error: unknown) {
  return /failed to initialize (?:sqlite )?state runtime/i.test(error instanceof Error ? error.message : String(error));
}

function delay(milliseconds: number) {
  return milliseconds > 0 ? new Promise<void>((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

function journalKey(partnerId: string, conversationId: string, sessionId: string) {
  return JSON.stringify([partnerId, conversationId, sessionId]);
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void }> = [];
  private ended = false;
  private error?: Error;

  push(value: T) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  fail(error: Error) {
    if (this.ended) return;
    this.error = error;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  close() {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.error) return Promise.reject(this.error);
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
import { delegationTools } from '../runtime/PartnerDelegation';
