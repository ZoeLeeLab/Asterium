import { withHandoffContext } from '../../shared/contextHandoff';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { app } from 'electron';
import type { PermissionResult, Query } from './ClaudeCliTransport';
import { z } from 'zod';
import { AUTOMATION_TOOL_DESCRIPTION, automationToolSchema } from '../../shared/automationTool';
import type { AsteriumRuntimeToolController, AttachmentPathResolver, PartnerAdapter } from './PartnerAdapter';
import { memoryToolDescription } from '../runtime/MemoryToolGuidance';
import {
  formatAsteriumBootstrapContext,
  parseCommentMemoryInput,
  parseHoldMemoryInput,
  parseProjectNotebookToolInput,
  parseReadMemorySourceInput,
  parseSearchMemoryInput,
  parseUpdateMemoryInput,
  parseWorkflowDraftToolInput,
  runtimeToolInstructions,
  type AsteriumStatusKey,
  type AsteriumWorkspaceAction,
} from '../runtime/AsteriumRuntimeTools';
import { ClaudeStreamParser, type ClaudeMappedEvent } from './ClaudeStreamParser';
import { planExecutionQuestions, planExecutionDecision } from './planExecutionDecision';
import type { SessionCompactResult } from '../../shared/sessionCompaction';
import type { SessionBootstrapDocument } from '../../shared/agentProtocol';
import { abortable } from '../api/abortable';
import { assertUserInputResolution, userInputOwner, type UserInputOwner } from '../runtime/UserInputResolution';
import type { UserInputQuestion, UserInputResponse } from '../../shared/agentProtocol';
import { DELIVERY_INSTRUCTION, DELIVERY_TOOL_DESCRIPTION } from './deliveryInstructions';
import { assertCanonicalPathOutsideProtectedRoots, pathsOverlap, textReferencesProtectedRoot } from '../security/ProtectedPathPolicy';
import {
  AGENT_PROTOCOL_VERSION,
  type CancelRunCommand,
  type ClaudeDetectionResult,
  type PartnerEvent,
  type ResolveAuthorizationCommand,
  type ResolveUserInputCommand,
  type ResumeSessionCommand,
  type SendGuidanceCommand,
  type SendGuidanceResult,
  type SendMessageCommand,
} from '../../shared/agentProtocol';

const execFileAsync = promisify(execFile);
let claudeCliPromise: Promise<typeof import('./ClaudeCliTransport')> | undefined;

export function loadClaudeCliRuntime() {
  claudeCliPromise ??= import('./ClaudeCliTransport');
  return claudeCliPromise;
}

export interface ClaudeInstallation extends ClaudeDetectionResult {
  executablePath?: string;
}

export type SpawnClaude = (executable: string, args: string[], options: {
  cwd: string;
  windowsHide: boolean;
  shell: false;
  stdio: ['pipe', 'pipe', 'pipe'];
}) => ChildProcessWithoutNullStreams;

const defaultSpawnClaude: SpawnClaude = (executable, args, options) => spawn(executable, args, options);

export type StopClaude = (child: ChildProcessWithoutNullStreams) => Promise<void>;

const defaultStopClaude: StopClaude = async (child) => {
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
};

function cleanVersion(stdout: string) {
  return stdout.replace(/\s*\(Claude Code\)\s*/i, '').trim();
}

async function candidateExecutables() {
  const candidates: string[] = [];
  if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  try {
    const { stdout } = await execFileAsync('where.exe', ['claude'], { windowsHide: true, timeout: 4000 });
    candidates.push(...stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
  } catch {
    // The fixed native install path remains available as a fallback.
  }
  return [...new Set(candidates)];
}

export async function detectClaudeCode(): Promise<ClaudeInstallation> {
  const candidates = await candidateExecutables();
  let executablePath: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      executablePath = candidate;
      break;
    } catch {
      // Try the next candidate.
    }
  }
  if (!executablePath) return {
    installed: false,
    loggedIn: false,
    error: { code: 'CLAUDE_NOT_FOUND', message: '没有找到本机 Claude Code。', stage: 'discovery', retryable: true },
  };

  try {
    const [{ stdout: versionOutput }, { stdout: authOutput }] = await Promise.all([
      execFileAsync(executablePath, ['--version'], { windowsHide: true, timeout: 6000 }),
      execFileAsync(executablePath, ['auth', 'status', '--json'], { windowsHide: true, timeout: 6000 }),
    ]);
    const auth = JSON.parse(authOutput) as { loggedIn?: unknown; authMethod?: unknown };
    return {
      installed: true,
      loggedIn: auth.loggedIn === true,
      version: cleanVersion(versionOutput),
      authMethod: typeof auth.authMethod === 'string' ? auth.authMethod : undefined,
      executableLabel: path.basename(executablePath),
      executablePath,
    };
  } catch (error) {
    return {
      installed: true,
      loggedIn: false,
      executableLabel: path.basename(executablePath),
      executablePath,
      error: {
        code: 'CLAUDE_DETECTION_FAILED',
        message: 'Claude Code 已安装，但无法确认登录状态。',
        stage: 'discovery',
        retryable: true,
        technicalDetail: error instanceof Error ? error.message.slice(0, 500) : undefined,
      },
    };
  }
}

export class ClaudeCodeAdapter implements PartnerAdapter {
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
    guidance: 'deferred' as const,
    compaction: true,
    extensions: [] as const,
  };
  private readonly active = new Map<string, { kind: 'legacy'; child: ChildProcessWithoutNullStreams; cancelled: boolean } | { kind: 'cli'; query: Query; abortController: AbortController; cancelled: boolean }>();
  private readonly pendingApprovals = new Map<string, { runId: string; owner: UserInputOwner; input: Record<string, unknown>; resolve: (result: PermissionResult) => void; emit: (event: ClaudeMappedEvent) => void }>();
  private readonly pendingUserInputs = new Map<string, { runId: string; owner: UserInputOwner; questions: UserInputQuestion[]; kind: 'question' | 'plan_execution'; resolve: (response: UserInputResponse) => void; emit: (event: ClaudeMappedEvent) => void }>();
  private readonly journal = new Map<string, PartnerEvent[]>();
  private eventCounter = 0;

  constructor(
    private readonly executablePath: string,
    private readonly workingDirectory: string,
    private readonly spawnClaude: SpawnClaude = defaultSpawnClaude,
    private readonly stopClaude: StopClaude = defaultStopClaude,
    private readonly additionalDirectories: string[] = [],
    private readonly resolveAttachment?: AttachmentPathResolver,
    private runtimeTools?: AsteriumRuntimeToolController,
    private readonly protectedRoots: readonly string[] = [],
  ) {}

  replaceRuntimeTools(runtimeTools: AsteriumRuntimeToolController) {
    this.runtimeTools = runtimeTools;
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
    if (this.spawnClaude === defaultSpawnClaude) {
      yield* this.sendMessageCli(command);
      return;
    }
    yield* this.sendMessageLegacy(command);
  }

  private async *sendMessageLegacy(command: SendMessageCommand): AsyncIterable<PartnerEvent> {
    const sessionId = command.sessionId ?? randomUUID();
    const routeKey = journalKey(command.partnerId, command.conversationId, sessionId);
    const runId = randomUUID();
    let sequence = this.journal.get(routeKey)?.at(-1)?.sequence ?? 0;
    let terminal = false;
    let accepted = false;
    let stderr = '';
    const parser = new ClaudeStreamParser();
    const wrap = (event: ClaudeMappedEvent | { type: 'session.bound'; isNew: boolean } | { type: 'run.cancelled'; reason: string }): PartnerEvent => ({
      ...event,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      eventId: `claude-${runId}-${++this.eventCounter}`,
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
      this.journal.set(routeKey, events);
      return event;
    };

    const resolvedAttachments = await resolveCommandAttachments(command, this.resolveAttachment);
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
    const mcpConfigPath = path.join(os.tmpdir(), `asterium-delivery-${randomUUID()}.json`);
    const deliveryToken = randomBytes(24).toString('hex');
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { asterium_delivery: {
      command: process.execPath,
      args: [app?.isPackaged ? path.join(process.resourcesPath, 'deliverFileMcp.cjs') : path.join(process.cwd(), 'src', 'main', 'adapters', 'deliverFileMcp.cjs')],
      env: { ELECTRON_RUN_AS_NODE: '1', ASTERIUM_DELIVERY_TOKEN: deliveryToken },
    } } }), { encoding: 'utf8', mode: 0o600 });
    args.push('--mcp-config', mcpConfigPath, '--allowedTools', 'mcp__asterium_delivery__deliver_file');
    const readableDirectories = [...new Set([...this.additionalDirectories, ...resolvedAttachments.map((item) => path.dirname(item.path))])];
    if (readableDirectories.length) args.push('--add-dir', ...readableDirectories);
    if (command.sessionId) args.push('--resume', command.sessionId);
    else args.push('--session-id', sessionId);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnClaude(this.executablePath, args, {
        cwd: this.workingDirectory,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`CLAUDE_SPAWN_FAILED: ${error instanceof Error ? error.message : 'unknown error'}`, { cause: error });
    }

    this.active.set(runId, { kind: 'legacy', child, cancelled: false });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.stdin.end(`${withHandoffContext(command.content.text, command.contextHandoff)}${attachmentPrompt(resolvedAttachments)}\n\n${DELIVERY_INSTRUCTION}`, 'utf8');
    yield remember(wrap({ type: 'session.bound', isNew: !command.sessionId }));

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        for (const mapped of parser.parseLine(line)) {
          if (mapped.type === 'message.accepted') accepted = true;
          if (mapped.type === 'run.completed' || mapped.type === 'run.failed') terminal = true;
          yield remember(wrap(mapped));
        }
      }
      const exitCode = await new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) resolve(child.exitCode);
        else child.once('close', resolve);
      });
      const active = this.active.get(runId);
      if (!terminal && active?.cancelled) {
        terminal = true;
        yield remember(wrap({ type: 'run.cancelled', reason: '已由用户停止' }));
      } else if (!terminal && exitCode !== 0) {
        terminal = true;
        yield remember(wrap({
          type: 'run.failed',
          error: {
            code: accepted ? 'CLAUDE_PROCESS_EXITED' : 'CLAUDE_NOT_ACCEPTED',
            message: accepted ? 'Claude Code 意外结束了这次任务。' : 'Claude Code 没有接收这条消息。',
            stage: 'adapter',
            retryable: true,
            technicalDetail: stderr.replace(/[\r\n]+/g, ' ').trim().slice(0, 500) || `exit ${exitCode}`,
          },
        }));
      } else if (!terminal) {
        yield remember(wrap({
          type: 'run.failed',
          error: { code: 'CLAUDE_RESULT_MISSING', message: 'Claude Code 已结束，但没有返回完成结果。', stage: 'adapter', retryable: true },
        }));
      }
    } finally {
      lines.close();
      this.active.delete(runId);
      await unlink(mcpConfigPath).catch(() => undefined);
    }
  }

  private async *sendMessageCli(command: SendMessageCommand): AsyncIterable<PartnerEvent> {
    const { createClaudeToolSet, query, tool } = await loadClaudeCliRuntime();
    const sessionId = command.sessionId ?? randomUUID();
    const routeKey = journalKey(command.partnerId, command.conversationId, sessionId);
    const runId = randomUUID();
    let sequence = this.journal.get(routeKey)?.at(-1)?.sequence ?? 0;
    let terminal = false;
    const parser = new ClaudeStreamParser();
    const queue = new ClaudeEventQueue<ClaudeMappedEvent>();
    let planDeclined = false;
    const wrap = (event: ClaudeMappedEvent | { type: 'session.bound'; isNew: boolean } | { type: 'run.cancelled'; reason: string }): PartnerEvent => ({
      ...event,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      eventId: `claude-${runId}-${++this.eventCounter}`,
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

    const resolvedAttachments = await resolveCommandAttachments(command, this.resolveAttachment);
    const permissionMode = command.execution?.planMode === 'plan' ? 'plan' : command.execution?.permissionMode ?? 'manual';
    const abortController = new AbortController();
    const externalReadableFiles = new Set<string>();
    const runtimeRoots = await Promise.all([
      this.workingDirectory,
      ...this.additionalDirectories,
      ...resolvedAttachments.map((item) => path.dirname(item.path)),
    ].map(canonicalPath));
    const bootstrapContext = claudeBootstrapContext(command);
    // Keep this query on the controller it started with. Retrying the same
    // workspace thread replaces the adapter controller only for the new query.
    const runtimeTools = this.runtimeTools;
    const memorySourceSchema = z.object({
      kind: z.enum(['single_chat', 'studio']), conversation_id: z.string().optional(), room_id: z.string().optional(), message_id: z.string(),
    });
    const memoryReadTools = runtimeTools?.memory ? [
      tool('search_memory', memoryToolDescription('search_memory', Boolean(runtimeTools.workflowDraft)), {
        text: z.string().optional(), tags: z.array(z.string()).optional(), types: z.array(z.enum(['self_summary', 'relationship_with_user', 'stable_fact', 'long_term_project', 'recurring_behavior_pattern', 'preference_and_collaboration', 'open_question_and_follow_up'])).optional(),
        statuses: z.array(z.enum(['active', 'completed', 'obsolete', 'superseded'])).optional(), from: z.string().optional(), to: z.string().optional(), limit: z.number().int().min(1).max(100).optional(),
      }, async (input) => runtimeMemoryResult(() => runtimeTools.memory!.search(parseSearchMemoryInput(input as Record<string, unknown>)))),
      tool('read_memory_source', memoryToolDescription('read_memory_source', Boolean(runtimeTools.workflowDraft)), {
        memory_id: z.string(), source_index: z.number().int().min(0).optional(),
      }, async (input) => runtimeMemoryResult(() => runtimeTools.memory!.readSource(parseReadMemorySourceInput(input as Record<string, unknown>)))),
    ] : [];
    const memoryWriteTools = runtimeTools?.memory?.access === 'write' ? [
      tool('hold_memory', memoryToolDescription('hold_memory'), {
        type: z.enum(['self_summary', 'relationship_with_user', 'stable_fact', 'long_term_project', 'recurring_behavior_pattern', 'preference_and_collaboration', 'open_question_and_follow_up']), body: z.string(), tags: z.array(z.string()).optional(), weight: z.number().int().min(1).max(5).optional(), occurred_at: z.string().optional(), sources: z.array(memorySourceSchema).optional(),
      }, async (input) => runtimeMemoryResult(() => runtimeTools.memory!.hold!(parseHoldMemoryInput(input as Record<string, unknown>)))),
      tool('comment_memory', memoryToolDescription('comment_memory'), {
        memory_id: z.string(), content: z.string(), sources: z.array(memorySourceSchema).optional(),
      }, async (input) => runtimeMemoryResult(() => runtimeTools.memory!.comment!(parseCommentMemoryInput(input as Record<string, unknown>)))),
      tool('update_memory', memoryToolDescription('update_memory'), {
        memory_id: z.string(), type: z.enum(['self_summary', 'relationship_with_user', 'stable_fact', 'long_term_project', 'recurring_behavior_pattern', 'preference_and_collaboration', 'open_question_and_follow_up']).optional(), status: z.enum(['active', 'completed', 'obsolete', 'superseded']).optional(), body: z.string().optional(), tags: z.array(z.string()).optional(), weight: z.number().int().min(1).max(5).optional(), occurred_at: z.string().nullable().optional(), superseded_by_memory_id: z.string().nullable().optional(),
      }, async (input) => runtimeMemoryResult(() => runtimeTools.memory!.update!(parseUpdateMemoryInput(input as Record<string, unknown>)))),
    ] : [];
    const asteriumServer = runtimeTools ? createClaudeToolSet({
      name: 'asterium',
      version: '1.0.0',
      instructions: command.sessionBootstrapVersion ? undefined : runtimeToolInstructions(Boolean(runtimeTools.mentionPartner), Boolean(runtimeTools.task), Boolean(runtimeTools.workflowDraft), runtimeTools.memory?.access ?? 'none', Boolean(runtimeTools.projectNotebook)),
      tools: runtimeTools.workflowDraft ? [tool('submit_workflow_draft', 'Submit one complete editable workflow DAG proposal for this dedicated planning run. Main validates and saves a draft only; this cannot activate a workflow or create tasks.', {
        name: z.string(),
        description: z.string(),
        generation_summary: z.string(),
        nodes: z.array(z.object({
          client_key: z.string(), title: z.string(), description: z.string(), assignee_partner_id: z.string().optional(),
          dependency_keys: z.array(z.string()), acceptance_criteria: z.array(z.string()), note: z.string().optional(), work_role_id: z.string().optional(), review_role_id: z.string().optional(), method_template_id: z.string().optional(),
          completion_rule: z.object({ type: z.enum(['executor_submit', 'partner_review', 'user_confirm']), reviewer_partner_id: z.string().optional(), auto_rework_limit: z.number().int().optional() }),
          source_message_ids: z.array(z.string()), basis_summary: z.string().optional(),
        })),
      }, async (input) => {
        try {
          return { content: [{ type: 'text', text: await runtimeTools.workflowDraft!(parseWorkflowDraftToolInput(input as Record<string, unknown>)) }] };
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: runtimeToolError(error) }] };
        }
      }), ...memoryReadTools] : [
        ...(runtimeTools.automation ? [tool('asterium_automation', AUTOMATION_TOOL_DESCRIPTION, automationToolSchema.shape, async input => runtimeMemoryResult(() => runtimeTools.automation!(input, abortController.signal)))] : []),
        ...(runtimeTools.delegation ? [
          tool(delegationTools[0].name, delegationTools[0].description, {}, input => runtimeMemoryResult(() => runtimeTools.delegation!(delegationTools[0].name, input, abortController.signal))),
          tool(delegationTools[1].name, delegationTools[1].description, delegationInput.shape, input => runtimeMemoryResult(() => runtimeTools.delegation!(delegationTools[1].name, input, abortController.signal))),
          tool(delegationTools[2].name, delegationTools[2].description, delegationWaitInput.shape, input => runtimeMemoryResult(() => runtimeTools.delegation!(delegationTools[2].name, input, abortController.signal))),
        ] : []),
        tool('asterium_status', 'Read authoritative Asterium state by key. In group chat, conversation reports the speaking mode, whether PASS is allowed, the queue, and whether partner mentions are available. Use workspace to confirm the current cwd and workspaceFolders instead of guessing from earlier messages. This tool never changes state.', {
          key: z.enum(['time', 'partner', 'partners', 'user', 'runtime', 'permissions', 'conversation', 'conversation_files', 'workspace']),
        }, async ({ key }) => ({ content: [{ type: 'text', text: await runtimeTools.status(key as AsteriumStatusKey) }] })),
        tool('asterium_workspace', 'Query, add, or remove additional workspaces shared by this partner. Use list to inspect cwd and workspaceFolders. A user-approved one-time outside-workspace file write stays temporary; during the same run, reread only that exact file if verification is needed. Only add or remove a directory when repeated or directory-level access is required; cwd can only be changed by the user in Asterium. Changes apply from the next turn and removing access never deletes files.', {
          action: z.enum(['list', 'add', 'remove']),
          path: z.string().optional(),
        }, async ({ action, path: targetPath }) => {
          try {
            return { content: [{ type: 'text', text: await runtimeTools.workspace(action as AsteriumWorkspaceAction, targetPath) }] };
          } catch (error) {
            return { isError: true, content: [{ type: 'text', text: runtimeToolError(error) }] };
          }
        }),
        ...(runtimeTools.mentionPartner ? [tool('mention_partner', 'Invite one member to speak next in this public group-discussion round. First check asterium_status(key=conversation): this is available only when mentionPartnerAvailable=true. Pass a unique display name, mention name, or exact partnerId; duplicate names require the partnerId from asterium_status(key=partners). Only this tool creates a real mention.', {
          partner_id: z.string(),
        }, async ({ partner_id: partnerId }) => {
          try {
            return { content: [{ type: 'text', text: await runtimeTools.mentionPartner!(partnerId) }] };
          } catch (error) {
            return { isError: true, content: [{ type: 'text', text: runtimeToolError(error) }] };
          }
        })] : []),
        ...(runtimeTools.task ? [tool('asterium_task', 'Read the current frozen workspace-task contract, submit an execution/rework handoff, or submit an independent review. This never changes files or bypasses permissions.', {
          action: z.enum(['context', 'submit_handoff', 'submit_review']),
          disposition: z.enum(['submitted', 'needs_user_decision', 'blocked']).optional(),
          summary: z.string().optional(),
          criterion_evidence: z.array(z.object({ criterion_id: z.string(), result: z.enum(['satisfied', 'not_satisfied', 'unverified']), evidence: z.array(z.string()) })).optional(),
          changed_paths: z.array(z.string()).optional(),
          verification: z.array(z.object({ command_or_check: z.string(), result: z.enum(['passed', 'failed', 'not_run']), evidence: z.string().optional() })).optional(),
          delivery_refs: z.array(z.string()).optional(),
          unresolved_issues: z.array(z.string()).optional(),
          user_decision: z.object({ question: z.string(), reason: z.string(), affected_criteria: z.array(z.string()) }).optional(),
          decision: z.enum(['pass', 'changes_required', 'needs_user_decision']).optional(),
          criterion_reviews: z.array(z.object({ criterion_id: z.string(), verdict: z.enum(['pass', 'fail', 'unverified']), evidence: z.array(z.string()), feedback: z.string().optional() })).optional(),
        }, async (input) => {
          try {
            const normalized = input.action === 'context' ? { action: 'context' as const } : input.action === 'submit_review' ? {
              action: 'submit_review' as const,
              decision: input.decision!,
              summary: input.summary!,
              criteria: (input.criterion_reviews ?? []).map((item) => ({ criterionId: item.criterion_id, verdict: item.verdict, evidence: item.evidence, ...(item.feedback ? { feedback: item.feedback } : {}) })),
              ...(input.user_decision ? { userDecisionRequest: { question: input.user_decision.question, reason: input.user_decision.reason, affectedCriteria: input.user_decision.affected_criteria } } : {}),
            } : {
              action: 'submit_handoff' as const,
              disposition: input.disposition!,
              summary: input.summary!,
              criterionEvidence: (input.criterion_evidence ?? []).map((item) => ({ criterionId: item.criterion_id, result: item.result, evidence: item.evidence })),
              changedPaths: input.changed_paths ?? [],
              verification: (input.verification ?? []).map((item) => ({ commandOrCheck: item.command_or_check, result: item.result, ...(item.evidence ? { evidence: item.evidence } : {}) })),
              deliveryRefs: input.delivery_refs ?? [],
              unresolvedIssues: input.unresolved_issues ?? [],
              ...(input.user_decision ? { userDecisionRequest: { question: input.user_decision.question, reason: input.user_decision.reason, affectedCriteria: input.user_decision.affected_criteria } } : {}),
            };
            return { content: [{ type: 'text', text: await runtimeTools.task!(normalized) }] };
          } catch (error) {
            return { isError: true, content: [{ type: 'text', text: runtimeToolError(error) }] };
          }
        })] : []),
        ...memoryReadTools,
        ...memoryWriteTools,
        ...(runtimeTools.projectNotebook ? [tool('project_notebook', 'List this partner’s active projects or read, append to, and revision-safely replace this partner’s private project work notebook. This is not long-term memory. Single chat read/write requires project_id; Studio fixes the current project. replace requires expected_revision from the latest result.', {
          action: z.enum(['list', 'read', 'append', 'replace']),
          project_id: z.string().optional(),
          content: z.string().optional(),
          expected_revision: z.number().int().min(0).optional(),
        }, async (input) => {
          try {
            return { content: [{ type: 'text', text: await runtimeTools.projectNotebook!(parseProjectNotebookToolInput(input as Record<string, unknown>)) }] };
          } catch (error) {
            return { isError: true, content: [{ type: 'text', text: runtimeToolError(error) }] };
          }
        })] : []),
        tool('deliver_file', DELIVERY_TOOL_DESCRIPTION, {
          path: z.string(),
          name: z.string().optional(),
        }, async ({ path: filePath, name }) => {
          const target = path.resolve(this.workingDirectory, filePath);
          const info = await stat(target).catch(() => undefined);
          if (!info?.isFile()) return { isError: true, content: [{ type: 'text', text: '文件不存在或不是普通文件，未登记到交付区。' }] };
          return { content: [{ type: 'text', text: `已登记交付：${name || path.basename(target)}` }] };
        }),
      ],
      alwaysLoad: true,
    }) : undefined;
    const cliQuery = query({
      prompt: `${withHandoffContext(command.content.text, command.contextHandoff)}${attachmentPrompt(resolvedAttachments)}`,
      options: {
        abortController,
        cwd: this.workingDirectory,
        pathToClaudeCodeExecutable: this.executablePath,
        settingSources: ['user', 'project', 'local'],
        additionalDirectories: [...new Set([...this.additionalDirectories, ...resolvedAttachments.map((item) => path.dirname(item.path))])],
        ...(command.sessionId ? { resume: command.sessionId } : { sessionId }),
        permissionMode: claudePermissionMode(permissionMode),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: `${command.sessionBootstrapVersion ? '' : runtimeToolInstructions(Boolean(runtimeTools?.mentionPartner), Boolean(runtimeTools?.task), Boolean(runtimeTools?.workflowDraft), runtimeTools?.memory?.access ?? 'none', Boolean(runtimeTools?.projectNotebook))}${bootstrapContext ? `\n\n${bootstrapContext}` : ''}\n\n[当前会话工作区]\ncwd: ${this.workingDirectory}${runtimeTools?.workflowDraft ? '' : `\n如需确认全部 workspaceFolders，请查询 asterium_status(key=workspace)。${command.sessionBootstrapVersion ? '' : `\n\n${DELIVERY_INSTRUCTION}`}`}`,
          snapshot: true,
        },
        includePartialMessages: true,
        // The stdio permission host applies Asterium's policy to explicit asks.
        allowedTools: asteriumServer
          ? claudeAsteriumAllowedTools(runtimeTools!)
          : ['mcp__asterium_delivery__deliver_file'],
        ...(asteriumServer ? { mcpServers: { asterium: asteriumServer } } : { mcpServers: { asterium_delivery: {
          command: process.execPath,
          args: [app?.isPackaged ? path.join(process.resourcesPath, 'deliverFileMcp.cjs') : path.join(process.cwd(), 'src', 'main', 'adapters', 'deliverFileMcp.cjs')],
          env: { ELECTRON_RUN_AS_NODE: '1', ASTERIUM_DELIVERY_TOKEN: randomBytes(24).toString('hex') },
        } } }),
        hooks: {
          PreToolUse: [{ hooks: [async (input) => {
            if (input.hook_event_name !== 'PreToolUse') return { continue: true };
            if (claudeInputReferencesProtected(input.tool_input, this.workingDirectory, this.protectedRoots)) return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: '这是星丛受保护的资料目录，只能通过星丛的受限资料服务访问。',
              },
            };
            if (permissionMode !== 'read_only' || !isReadOnlyMutation(input.tool_name, input.tool_input)) return { continue: true };
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: '当前会话处于只读模式，本次操作未执行，没有产生任何修改。',
              },
            };
          }] }],
          PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [async (input) => {
            if (input.hook_event_name === 'PostToolUse' && isRecord(input.tool_input)) {
              const target = await claudeCanonicalFileTarget(input.tool_name, input.tool_input, this.workingDirectory);
              if (target && !runtimeRoots.some((root) => containsLocalPath(root, target))) externalReadableFiles.add(pathKey(target));
            }
            return { continue: true };
          }] }],
        },
        canUseTool: async (toolName, input, options) => {
          if (claudeInputReferencesProtected(input, this.workingDirectory, this.protectedRoots)
            || (options.blockedPath && claudeInputReferencesProtected(options.blockedPath, this.workingDirectory, this.protectedRoots))) {
            return { behavior: 'deny', message: '这是星丛受保护的资料目录，只能通过星丛的受限资料服务访问。' };
          }
          for (const key of ['file_path', 'path', 'notebook_path']) {
            const value = input[key];
            if (typeof value !== 'string' || !value.trim()) continue;
            try { await assertCanonicalPathOutsideProtectedRoots(path.resolve(this.workingDirectory, value), this.protectedRoots); }
            catch { return { behavior: 'deny', message: '这是星丛受保护的资料目录，只能通过星丛的受限资料服务访问。' }; }
          }
          if (toolName === 'mcp__asterium__asterium_status') return claudeApprovalAllow(input);
          if (toolName === 'mcp__asterium__asterium_automation') return claudeApprovalAllow(input); // Main separately confirms every mutation.
          if (toolName === 'mcp__asterium__mention_partner') return claudeApprovalAllow(input);
          if (toolName === 'mcp__asterium__asterium_task') return claudeApprovalAllow(input);
          if (toolName === 'mcp__asterium__submit_workflow_draft') return claudeApprovalAllow(input);
          if (/^mcp__asterium__(?:hold_memory|search_memory|comment_memory|update_memory|read_memory_source)$/u.test(toolName)) return claudeApprovalAllow(input);
          if (toolName === 'mcp__asterium__asterium_workspace' && input.action === 'list') return claudeApprovalAllow(input);
          if (permissionMode === 'read_only' && isReadOnlyMutation(toolName, input)) return { behavior: 'deny', message: '当前会话处于只读模式，本次操作未执行，没有产生任何修改。' };
          if (/^Read$/i.test(toolName)) {
            const target = await claudeCanonicalFileTarget(toolName, input, this.workingDirectory);
            if (target && (externalReadableFiles.has(pathKey(target)) || runtimeRoots.some(root => containsLocalPath(root, target)))) return claudeApprovalAllow(input);
          }
          if (/^(Glob|Grep)$/i.test(toolName)) {
            const target = await canonicalPath(path.resolve(this.workingDirectory, typeof input.path === 'string' ? input.path : '.'));
            if (runtimeRoots.some(root => containsLocalPath(root, target))) return claudeApprovalAllow(input);
          }
          if (toolName === 'AskUserQuestion') {
            const questions = claudeQuestions(input);
            if (!questions.length) return { behavior: 'deny', message: '无法显示这个澄清问题。' };
            const requestId = `claude-input-${options.toolUseID}`;
            queue.push({ type: 'work.status', state: 'waiting_user_input', summary: 'Claude Code 需要你补充信息' });
            queue.push({ type: 'user_input.requested', requestId, questions });
            const response = await new Promise<UserInputResponse>((resolve) => this.pendingUserInputs.set(requestId, { runId, owner: userInputOwner(command, runId, sessionId), questions, kind: 'question', resolve, emit: (event) => queue.push(event) }));
            if (abortController.signal.aborted) return { behavior: 'deny', message: '用户停止了当前任务。', interrupt: true };
            return { behavior: 'allow', updatedInput: { ...input, answers: claudeNativeAnswers(questions, response.answers) } };
          }
          if (toolName === 'ExitPlanMode') {
            const questions = planExecutionQuestions();
            const requestId = `claude-plan-${options.toolUseID}`;
            queue.push({ type: 'plan.updated', status: 'ready', explanation: '计划已就绪，等待你确认是否开始执行。' });
            queue.push({ type: 'work.status', state: 'waiting_user_input', summary: 'Claude Code 等待你确认是否执行计划' });
            queue.push({ type: 'user_input.requested', requestId, questions });
            const response = await new Promise<UserInputResponse>((resolve) => this.pendingUserInputs.set(requestId, { runId, owner: userInputOwner(command, runId, sessionId), questions, kind: 'plan_execution', resolve, emit: (event) => queue.push(event) }));
            if (abortController.signal.aborted) return { behavior: 'deny', message: '用户停止了当前任务。', interrupt: true };
            const decision = planExecutionDecision(response);
            if (decision.action === 'revise') {
              queue.push({ type: 'plan.updated', status: 'planning', planMode: 'plan', explanation: '已收到修改意见，Claude Code 继续完善计划。' });
              queue.push({ type: 'work.status', state: 'working', summary: 'Claude Code 正在调整计划…' });
              return { behavior: 'deny', message: `用户对计划的修改意见：\n${decision.feedback}\n请保持 Plan 模式完善计划，并再次等待用户确认；尚未获准执行。`, interrupt: false };
            }
            if (decision.action === 'execute') {
              queue.push({ type: 'plan.updated', status: 'executing', planMode: 'default', explanation: '已确认开始执行，Claude Code 正在退出计划模式。' });
              return claudeApprovalAllow(input);
            }
            planDeclined = true;
            const active = this.active.get(runId);
            if (active) active.cancelled = true;
            queue.push({ type: 'plan.updated', status: 'ready', explanation: '计划已保留，本次任务已停止。' });
            queue.push({ type: 'run.cancelled', reason: '你选择暂不执行计划，计划已保留。' });
            queueMicrotask(() => abortController.abort());
            return { behavior: 'deny', message: '用户选择暂不执行计划。', interrupt: true };
          }
          // Selecting Full authorizes ordinary native operations as this Windows
          // user. Keep the bridge for questions and explicit path checks; these
          // checks do not sandbox arbitrary commands or their filesystem access.
          if (permissionMode === 'full') return claudeApprovalAllow(input);
          const authorizationId = `claude-auth-${options.toolUseID}`;
          queue.push({ type: 'work.status', state: 'waiting_authorization', summary: options.title ?? 'Claude Code 等待你的确认' });
          queue.push({
            type: 'authorization.requested', authorizationId, toolCallId: options.toolUseID,
            action: claudeAuthorizationAction(toolName), risk: claudeAuthorizationRisk(toolName),
            summary: options.title ?? options.description ?? `Claude Code 请求使用 ${toolName}`,
            targets: claudeAuthorizationTargets(input, options.blockedPath), resolution: 'interactive',
            ...(/(?:^|__)asterium_workspace$/i.test(toolName) && (input.action === 'add' || input.action === 'remove')
              ? { purpose: input.action === 'add' ? 'workspace_add' as const : 'workspace_remove' as const }
              : {}),
          });
          return new Promise<PermissionResult>((resolve) => this.pendingApprovals.set(authorizationId, { runId, owner: userInputOwner(command, runId, sessionId), input, resolve, emit: (event) => queue.push(event) }));
        },
      },
    });
    this.active.set(runId, { kind: 'cli', query: cliQuery, abortController, cancelled: false });
    yield remember(wrap({ type: 'session.bound', isNew: !command.sessionId }));
    if (command.execution?.planMode === 'plan') yield remember(wrap({ type: 'plan.updated', status: 'planning', explanation: 'Claude Code 原生 Plan 模式已开启；规划期间不会修改文件。' }));

    void (async () => {
      try {
        for await (const message of cliQuery) {
          if (planDeclined) continue;
          for (const event of parser.parseLine(JSON.stringify(message))) queue.push(event);
        }
        queue.close();
      } catch (error) {
        queue.fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    try {
      for await (const mapped of queue) {
        if (mapped.type === 'run.completed' || mapped.type === 'run.failed' || mapped.type === 'run.cancelled') terminal = true;
        yield remember(wrap(mapped));
      }
      const active = this.active.get(runId);
      if (!terminal && active?.cancelled) yield remember(wrap({ type: 'run.cancelled', reason: '已由用户停止' }));
      else if (!terminal) yield remember(wrap({ type: 'run.failed', error: { code: 'CLAUDE_RESULT_MISSING', message: 'Claude Code 已结束，但没有返回完成结果。', stage: 'adapter', retryable: true } }));
    } catch (error) {
      if (!terminal) yield remember(wrap({ type: 'run.failed', error: { code: 'CLAUDE_CLI_FAILED', message: 'Claude Code 连接中断。', stage: 'transport', retryable: true, technicalDetail: error instanceof Error ? error.message.slice(0, 500) : undefined } }));
    } finally {
      this.active.delete(runId);
      for (const [id, pending] of this.pendingApprovals) if (pending.runId === runId) this.pendingApprovals.delete(id);
      for (const [id, pending] of this.pendingUserInputs) if (pending.runId === runId) this.pendingUserInputs.delete(id);
      cliQuery.close();
    }
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
    if (!pending || this.active.get(pending.runId)?.cancelled) throw new Error('CLAUDE_AUTHORIZATION_NOT_FOUND');
    try { assertUserInputResolution({ ...command, type: 'user_input.resolve', requestId: command.authorizationId, answers: {} }, pending.owner, []); }
    catch { throw new Error('CLAUDE_AUTHORIZATION_ROUTE_MISMATCH'); }
    this.pendingApprovals.delete(command.authorizationId);
    pending.emit({ type: 'authorization.resolved', authorizationId: command.authorizationId, decision: command.decision });
    pending.emit({ type: 'work.status', state: 'working', summary: command.decision === 'allow_once' ? '授权已确认，Claude Code 继续工作…' : '已拒绝授权，Claude Code 正在调整…' });
    pending.resolve(command.decision === 'allow_once'
      ? claudeApprovalAllow(pending.input)
      : { behavior: 'deny', message: command.message?.trim() || '用户拒绝了这次操作。' });
  }

  async resolveUserInput(command: ResolveUserInputCommand) {
    const pending = this.pendingUserInputs.get(command.requestId);
    if (!pending || this.active.get(pending.runId)?.cancelled) throw new Error('CLAUDE_USER_INPUT_NOT_FOUND');
    assertUserInputResolution(command, pending.owner, pending.questions);
    if (pending.kind === 'plan_execution') planExecutionDecision(command);
    this.pendingUserInputs.delete(command.requestId);
    pending.emit({ type: 'user_input.resolved', requestId: command.requestId, answers: command.answers, ...(command.customAnswers ? { customAnswers: command.customAnswers } : {}) });
    if (pending.kind === 'question') pending.emit({ type: 'work.status', state: 'working', summary: '已收到回答，Claude Code 继续调整计划…' });
    pending.resolve({ answers: structuredClone(command.answers), ...(command.customAnswers ? { customAnswers: structuredClone(command.customAnswers) } : {}) });
  }

  async sendGuidance(command: SendGuidanceCommand): Promise<SendGuidanceResult> {
    void command;
    return { disposition: 'deferred' };
  }

  async cancel(command: CancelRunCommand) {
    const active = this.active.get(command.runId);
    if (!active || active.cancelled) return;
    active.cancelled = true;
    if (active.kind === 'cli') active.abortController.abort();
    else await this.stopClaude(active.child);
    for (const [id, pending] of this.pendingApprovals) if (pending.runId === command.runId) {
      this.pendingApprovals.delete(id);
      pending.resolve({ behavior: 'deny', message: '用户停止了当前任务。', interrupt: true });
    }
    for (const [id, pending] of this.pendingUserInputs) if (pending.runId === command.runId) {
      this.pendingUserInputs.delete(id);
      pending.resolve({ answers: {} });
    }
  }

  async reloadProfiles(sessionId: string, prompt: string, bootstrap: SessionBootstrapDocument, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.active.size) throw new Error('SESSION_COMMAND_BUSY');
    const { query } = await loadClaudeCliRuntime();
    const controller = new AbortController();
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    let stream: Query | undefined, message = '', completed = false;
    try {
      stream = query({ prompt, options: {
        cwd: this.workingDirectory, pathToClaudeCodeExecutable: this.executablePath, resume: sessionId,
        abortController: controller, settingSources: ['user', 'project', 'local'],
        settings: { disableAllHooks: true }, strictMcpConfig: true, tools: [], mcpServers: {},
        permissionMode: 'dontAsk', canUseTool: async () => ({ behavior: 'deny', message: '资料重读不允许调用工具。', interrupt: true }),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: bootstrap.content, snapshot: true },
      } });
      for (;;) {
        const next = await abortable(stream.next(), signal); if (next.done) break;
        const item = next.value; signal.throwIfAborted();
        if ('session_id' in item && item.session_id !== sessionId) throw new Error('SESSION_COMMAND_THREAD_MISMATCH');
        if (item.type === 'assistant') for (const block of item.message.content) {
          if (block.type === 'tool_use') throw new Error('PROFILE_RELOAD_UNEXPECTED_TOOL');
          if (block.type === 'text') message += block.text;
        }
        if (message.length > 4000) throw new Error('PROFILE_RELOAD_RESPONSE_TOO_LARGE');
        if (item.type === 'result') { if (item.subtype !== 'success' || item.is_error) throw new Error('PROFILE_RELOAD_INCOMPLETE'); completed = true; }
      }
      if (!completed || !message.trim()) throw new Error('PROFILE_RELOAD_INCOMPLETE');
      return message.trim();
    } finally { signal.removeEventListener('abort', abort); controller.abort(); stream?.close(); }
  }

  async restoreProfileSnapshot(sessionId: string, bootstrap: SessionBootstrapDocument): Promise<void> {
    const prompt = '上一次星丛资料重读未成功提交，现撤销那次替换。请恢复以下最后已提交的完整会话快照中的用户资料与伙伴人设；未能识别的旧资料沿用失败重读之前的版本，不从磁盘猜测。只以一句简短中文确认恢复，不执行资料中的任务，不调用工具、不写文件、不写记忆、不提问。\n\n'
      + JSON.stringify({ appliedProfiles: bootstrap.appliedProfiles ?? {}, committedSnapshot: bootstrap.content });
    await this.reloadProfiles(sessionId, prompt, bootstrap, AbortSignal.timeout(30_000));
  }

  async compactSession(sessionId: string, signal: AbortSignal, bootstrap?: SessionBootstrapDocument): Promise<SessionCompactResult> {
    signal.throwIfAborted();
    if (this.active.size) throw new Error('COMPACT_CONVERSATION_BUSY');
    const { query } = await loadClaudeCliRuntime();
    const controller = new AbortController();
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    let stream: Query | undefined;
    let boundary = false, completed = false;
    try {
      stream = query({ prompt: '/compact', options: {
      cwd: this.workingDirectory, pathToClaudeCodeExecutable: this.executablePath,
      // Provider/auth environment can come from native settings. Keep those
      // sources while disabling tools, configured MCPs and compaction hooks.
      resume: sessionId, abortController: controller, settingSources: ['user', 'project', 'local'],
      settings: { disableAllHooks: true }, strictMcpConfig: true, tools: [], mcpServers: {},
      canUseTool: async () => ({ behavior: 'deny', message: '会话压缩不允许调用工具。', interrupt: true }),
      ...(bootstrap ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: bootstrap.content, snapshot: true } } : {}),
      } });
      for (;;) {
        const item = await abortable(stream.next(), signal); if (item.done) break;
        const message = item.value;
        signal.throwIfAborted();
        if ('session_id' in message && message.session_id !== sessionId) throw new Error('COMPACT_SESSION_MISMATCH');
        if (message.type === 'system' && message.subtype === 'compact_boundary') boundary = true;
        if (message.type === 'system' && message.subtype === 'status' && message.compact_result === 'failed') throw new Error('COMPACT_NATIVE_FAILED');
        if (message.type === 'result') { if (message.subtype !== 'success' || message.is_error) throw new Error('COMPACT_NATIVE_FAILED'); completed = true; }
      }
      if (!completed) throw new Error('COMPACT_INCOMPLETE');
      return boundary ? { status: 'compacted', message: 'Claude Code 已压缩当前会话上下文，聊天记录保留。' }
        : { status: 'unchanged', message: 'Claude Code 未产生压缩结果，可能没有足够的历史；当前上下文保持不变。' };
    } finally { signal.removeEventListener('abort', abort); stream?.close(); }
  }

  async dispose() {
    await Promise.all([...this.active.keys()].map(async (runId) => this.cancel({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      type: 'run.cancel',
      commandId: `dispose-${runId}`,
      partnerId: 'system',
      conversationId: 'system',
      connectionSource: 'local_cli',
      clientMessageId: 'system',
      sessionId: 'system',
      runId,
      reason: '应用关闭',
    })));
  }
}

export function claudeBootstrapContext(command: SendMessageCommand) {
  // Asterium owns and reuses the exact accepted system snapshot.
  if (command.sessionBootstrap) return command.sessionBootstrap.content;
  return command.sessionId ? '' : formatAsteriumBootstrapContext(command.runtimeContext);
}

async function resolveCommandAttachments(command: SendMessageCommand, resolver?: AttachmentPathResolver) {
  if (!command.attachments?.length || !resolver) return [];
  return Promise.all(command.attachments.map(async (attachment) => ({ ...attachment, path: await resolver(attachment.id, command.conversationId) })));
}

function attachmentPrompt(attachments: Awaited<ReturnType<typeof resolveCommandAttachments>>) {
  if (!attachments.length) return '';
  return `\n\n[用户附件 · 不可变历史快照]\n${attachments.map((item) => `- ${item.name} (${item.mediaType}, ${item.sizeBytes} bytes)\n  只读快照路径: ${item.path}`).join('\n')}\n请按任务需要自行读取；不要假设文件内容或格式，也不要修改这些历史输入快照。`;
}

export function claudeApprovalAllow(input: Record<string, unknown>): PermissionResult {
  return { behavior: 'allow', updatedInput: input };
}

export function claudePermissionMode(mode: 'read_only' | 'manual' | 'automatic' | 'full' | 'plan') {
  if (mode === 'plan') return 'plan' as const;
  if (mode === 'read_only') return 'dontAsk' as const;
  if (mode === 'automatic') return 'auto' as const;
  // Full access is approved by the host callback, preserving questions and
  // protected-root denies without enabling native permission bypass.
  if (mode === 'full') return 'default' as const;
  return 'default' as const;
}

function claudeQuestions(input: Record<string, unknown>) {
  const values = Array.isArray(input.questions) ? input.questions.filter(isRecord) : [];
  return values.map((question, index) => ({
    id: typeof question.id === 'string' && question.id ? question.id : `question-${index + 1}`,
    header: typeof question.header === 'string' ? question.header : undefined,
    prompt: typeof question.question === 'string' ? question.question : '请补充信息',
    options: Array.isArray(question.options) ? question.options.filter(isRecord).map((option) => ({
      label: typeof option.label === 'string' ? option.label : '',
      description: typeof option.description === 'string' ? option.description : undefined,
    })).filter((option) => Boolean(option.label)) : undefined,
    multiple: question.multiSelect === true,
  }));
}

export function claudeNativeAnswers(
  questions: ReturnType<typeof claudeQuestions>,
  answers: Record<string, string[]>,
) {
  return Object.fromEntries(questions.flatMap((question) => {
    const values = answers[question.id]?.filter((value) => value.trim()) ?? [];
    return values.length ? [[question.prompt, values.join(', ')]] : [];
  }));
}

function claudeAuthorizationAction(toolName: string) {
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(toolName)) return 'write_file' as const;
  if (/delete/i.test(toolName)) return 'delete_file' as const;
  if (/^(Bash|PowerShell|Shell|Terminal)/i.test(toolName)) return 'run_command' as const;
  if (/computer|desktop|browser/i.test(toolName)) return 'computer_control' as const;
  if (/^(Read|Glob|Grep)$/i.test(toolName)) return 'read_file' as const;
  return 'external_side_effect' as const;
}

function claudeAuthorizationRisk(toolName: string) {
  return /delete|bypass|computer/i.test(toolName) ? 'high' as const : /^(Read|Glob|Grep)$/i.test(toolName) ? 'low' as const : 'medium' as const;
}

function claudeAuthorizationTargets(input: Record<string, unknown>, blockedPath?: string) {
  const targets = new Set<string>();
  if (blockedPath) targets.add(blockedPath);
  for (const key of ['file_path', 'path', 'notebook_path', 'command']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) targets.add(value.trim().slice(0, 1000));
  }
  return [...targets].slice(0, 20);
}

export async function claudeCanonicalFileTarget(toolName: string, input: Record<string, unknown>, cwd: string) {
  if (!/^(?:Read|Write|Edit|MultiEdit|NotebookEdit)$/i.test(toolName)) return undefined;
  const raw = ['file_path', 'path', 'notebook_path']
    .map((key) => input[key])
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  if (!raw) return undefined;
  try {
    const target = await realpath(path.resolve(cwd, raw));
    return (await stat(target)).isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

async function canonicalPath(input: string) {
  try {
    return await realpath(input);
  } catch {
    return path.resolve(input);
  }
}

function containsLocalPath(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathKey(input: string) {
  const resolved = path.resolve(input);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

export function claudeInputReferencesProtected(input: unknown, cwd: string, protectedRoots: readonly string[]): boolean {
  if (!protectedRoots.length) return false;
  if (typeof input === 'string') {
    if (textReferencesProtectedRoot(input, protectedRoots)) return true;
    if (path.isAbsolute(input)) return protectedRoots.some((root) => pathsOverlap(input, root));
    if (/^[.]{0,2}[\\/]/.test(input)) return protectedRoots.some((root) => pathsOverlap(path.resolve(cwd, input), root));
    return false;
  }
  if (Array.isArray(input)) return input.some((value) => claudeInputReferencesProtected(value, cwd, protectedRoots));
  if (isRecord(input)) return Object.values(input).some((value) => claudeInputReferencesProtected(value, cwd, protectedRoots));
  return false;
}

function isReadOnlyMutation(toolName: string, input: unknown) {
  if (/^(Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Shell|Terminal|Computer)$/i.test(toolName)) return true;
  if (/(?:^|__)deliver_file$/i.test(toolName)) return true;
  if (/(?:^|__)asterium_workspace$/i.test(toolName) && isRecord(input)) return input.action === 'add' || input.action === 'remove';
  return false;
}

export function claudeAsteriumAllowedTools(runtimeTools: AsteriumRuntimeToolController) {
  const memoryRead = runtimeTools.memory ? ['mcp__asterium__search_memory', 'mcp__asterium__read_memory_source'] : [];
  const memoryWrite = runtimeTools.memory?.access === 'write'
    ? ['mcp__asterium__hold_memory', 'mcp__asterium__comment_memory', 'mcp__asterium__update_memory']
    : [];
  if (runtimeTools.workflowDraft) return ['mcp__asterium__submit_workflow_draft', ...memoryRead];
  return [
    'mcp__asterium__asterium_status',
    ...(runtimeTools.automation ? ['mcp__asterium__asterium_automation'] : []),
    ...(runtimeTools.mentionPartner ? ['mcp__asterium__mention_partner'] : []),
    ...(runtimeTools.task ? ['mcp__asterium__asterium_task'] : []),
    ...memoryRead,
    ...memoryWrite,
    ...(runtimeTools.projectNotebook ? ['mcp__asterium__project_notebook'] : []),
    ...(runtimeTools.delegation ? delegationTools.map(tool => `mcp__asterium__${tool.name}`) : []),
    'mcp__asterium__deliver_file',
  ];
}

async function runtimeMemoryResult(operation: () => Promise<string>) {
  try {
    return { content: [{ type: 'text' as const, text: await operation() }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: runtimeToolError(error) }] };
  }
}

function runtimeToolError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'ASTERIUM_READ_ONLY') return '当前会话处于只读模式，本次操作未执行，没有产生任何修改。';
  if (code === 'WORKSPACE_CWD_IMMUTABLE') return 'cwd 只能由用户在星丛界面更改，不能通过工作区工具移除。';
  if (code === 'WORKSPACE_NOT_ATTACHED') return '这个目录不在当前对话的额外工作区中。';
  return `工作区操作失败：${code}`;
}

function journalKey(partnerId: string, conversationId: string, sessionId: string) {
  return JSON.stringify([partnerId, conversationId, sessionId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class ClaudeEventQueue<T> implements AsyncIterable<T> {
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
    return { next: () => {
      const value = this.values.shift();
      if (value !== undefined) return Promise.resolve({ done: false, value });
      if (this.error) return Promise.reject(this.error);
      if (this.ended) return Promise.resolve({ done: true, value: undefined });
      return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
    } };
  }
}
import { delegationTools, delegationInput, delegationWaitInput } from '../runtime/PartnerDelegation';
