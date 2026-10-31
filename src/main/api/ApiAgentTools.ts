import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MessageAttachment, SendMessageCommand } from '../../shared/agentProtocol';
import type { ApiToolDefinition } from './ApiProviderAdapter';
import { ApiToolRegistry, type ApiToolRegistration, type ApiToolExecutionAuthorization, type ApiToolResult, type ToolAuthorizationDescriptor } from './ApiToolRegistry';
export type { ApiToolResult, ToolAuthorizationDescriptor } from './ApiToolRegistry';
import {
  parseAsteriumTaskToolInput,
  parseCommentMemoryInput,
  parseHoldMemoryInput,
  parseProjectNotebookToolInput,
  parseReadMemorySourceInput,
  parseSearchMemoryInput,
  parseUpdateMemoryInput,
  parseWorkflowDraftToolInput,
  type AsteriumRuntimeToolController,
  type AsteriumStatusKey,
  type AsteriumWorkspaceAction,
} from '../runtime/AsteriumRuntimeTools';
import { DELIVERY_TOOL_DESCRIPTION } from '../adapters/deliveryInstructions';
import { memoryToolDescription, type MemoryToolName } from '../runtime/MemoryToolGuidance';
import { ApiWebTools } from './ApiWebTools';
import { AUTOMATION_TOOL_DESCRIPTION, automationToolJsonSchema, automationToolSchema } from '../../shared/automationTool';
import { nativeExecutionGateway } from '../execution/ExecutionGateway';
import type { ExecutionGateway } from '../execution/ExecutionGateway';
import { executionPermissions, type ExecutionCapabilities } from '../execution/ExecutionPermissions';
import { issueNativeCommandApproval } from '../execution/NativeCommandApproval';
import type { ExecutionContext } from '../execution/ExecutionContext';

const RESULT_LIMIT = 64 * 1024;
const READ_LIMIT = 2 * 1024 * 1024;
const WRITE_LIMIT = 4 * 1024 * 1024;

export interface ApiAttachmentReader {
  conversationId: string;
  pathFor: (attachmentId: string, conversationId: string) => Promise<string>;
  inspect: (attachmentId: string, conversationId: string) => Promise<MessageAttachment>;
}

export const API_AGENT_TOOL_DEFINITIONS: ApiToolDefinition[] = [
  { name: 'list_directory', description: 'List files and folders inside an authorized workspace directory.', parameters: objectSchema({ path: { type: 'string', description: 'Directory path, relative to the primary workspace by default.' } }) },
  { name: 'search_files', description: 'Search file names and UTF-8 text inside authorized workspace directories.', parameters: objectSchema({ query: { type: 'string' }, path: { type: 'string' } }, ['query']) },
  { name: 'read_file', description: 'Read a UTF-8 text file inside an authorized workspace directory.', parameters: objectSchema({ path: { type: 'string' } }, ['path']) },
  { name: 'write_file', description: 'Create or replace a UTF-8 text file inside an authorized workspace directory.', parameters: objectSchema({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
  { name: 'edit_file', description: 'Replace one exact text occurrence in a UTF-8 file. The old text must occur exactly once.', parameters: objectSchema({ path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['path', 'old_text', 'new_text']) },
  { name: 'delete_path', description: 'Delete one file or one empty directory inside an authorized workspace. Recursive deletion is not supported.', parameters: objectSchema({ path: { type: 'string' } }, ['path']) },
  { name: 'run_command', description: 'Run one PowerShell command. Full uses Native without approval; otherwise use_default follows sandbox settings. require_escalated with a justification requests explicit one-command Native approval, without changing session permissions or settings. Never automatically retry an operation that started or has an unknown outcome. A confirmed pre-start sandbox failure may be followed by a separate approval request. Sandbox $PWD.Path is a session alias; use (Get-Location).ProviderPath for a real Windows path.', parameters: objectSchema({ command: { type: 'string' }, cwd: { type: 'string' }, sandbox_permissions: { type: 'string', enum: ['use_default', 'require_escalated'] }, justification: { type: 'string', maxLength: 1000 } }, ['command']) },
  { name: 'deliver_file', description: DELIVERY_TOOL_DESCRIPTION, parameters: objectSchema({ path: { type: 'string' }, name: { type: 'string' } }, ['path']) },
];

const READ_ATTACHMENT_TOOL: ApiToolDefinition = {
  name: 'read_attachment_text',
  description: 'Read a UTF-8 text attachment in character chunks. Continue with nextOffset until eof is true. Binary, image, PDF, Office and archive parsing is not supported.',
  parameters: objectSchema({
    attachment_id: { type: 'string' },
    offset: { type: 'integer', minimum: 0 },
    max_characters: { type: 'integer', minimum: 1, maximum: 32768 },
  }, ['attachment_id']),
};

const ASTERIUM_STATUS_TOOL: ApiToolDefinition = {
  name: 'asterium_status',
  description: 'Read authoritative Asterium state by key. In group chat, conversation reports the speaking mode, whether PASS is allowed, the queue, and whether partner mentions are available. Use workspace for current cwd and workspaceFolders; use time for the current local time. This tool never changes state.',
  parameters: objectSchema({ key: { type: 'string', enum: ['time', 'partner', 'partners', 'user', 'runtime', 'permissions', 'conversation', 'conversation_files', 'workspace'] } }, ['key']),
};

const ASTERIUM_WORKSPACE_TOOL: ApiToolDefinition = {
  name: 'asterium_workspace',
  description: 'Query, add, or remove persistent workspace folders shared by this partner. Use action=add only when repeated or directory-level access is needed. A single outside-workspace write_file can instead request one-time approval without adding its directory; only that exact file may be reread for verification during the same run. Adding follows the current permission flow and becomes available to file tools on the next turn. cwd cannot be changed or removed. Removing a workspace never deletes files.',
  parameters: objectSchema({ action: { type: 'string', enum: ['list', 'add', 'remove'] }, path: { type: 'string' } }, ['action']),
};

const MENTION_PARTNER_TOOL: ApiToolDefinition = {
  name: 'mention_partner',
  description: 'Invite one group member to speak next in the current public group-discussion round. First check asterium_status(key=conversation): this is available only when mentionPartnerAvailable=true. Pass a unique display name, mention name, or exact partnerId; for duplicate names use the partnerId from asterium_status(key=partners). Only this structured call creates a real mention.',
  parameters: objectSchema({ partner_id: { type: 'string', description: 'A unique display name, mention name, or exact partnerId.' } }, ['partner_id']),
};

const ASTERIUM_TASK_TOOL: ApiToolDefinition = {
  name: 'asterium_task',
  description: 'Read the current frozen workspace-task contract, submit an execution/rework handoff, or submit an independent review. This never changes files or bypasses permissions.',
  parameters: objectSchema({
    action: { type: 'string', enum: ['context', 'submit_handoff', 'submit_review'] },
    disposition: { type: 'string', enum: ['submitted', 'needs_user_decision', 'blocked'] },
    summary: { type: 'string' },
    criterion_evidence: { type: 'array', items: objectSchema({ criterion_id: { type: 'string' }, result: { type: 'string', enum: ['satisfied', 'not_satisfied', 'unverified'] }, evidence: { type: 'array', items: { type: 'string' } } }, ['criterion_id', 'result', 'evidence']) },
    changed_paths: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: objectSchema({ command_or_check: { type: 'string' }, result: { type: 'string', enum: ['passed', 'failed', 'not_run'] }, evidence: { type: 'string' } }, ['command_or_check', 'result']) },
    delivery_refs: { type: 'array', items: { type: 'string' } },
    unresolved_issues: { type: 'array', items: { type: 'string' } },
    user_decision: objectSchema({ question: { type: 'string' }, reason: { type: 'string' }, affected_criteria: { type: 'array', items: { type: 'string' } } }, ['question', 'reason', 'affected_criteria']),
    decision: { type: 'string', enum: ['pass', 'changes_required', 'needs_user_decision'] },
    criterion_reviews: { type: 'array', items: objectSchema({ criterion_id: { type: 'string' }, verdict: { type: 'string', enum: ['pass', 'fail', 'unverified'] }, evidence: { type: 'array', items: { type: 'string' } }, feedback: { type: 'string' } }, ['criterion_id', 'verdict', 'evidence']) },
  }, ['action']),
};

const SUBMIT_WORKFLOW_DRAFT_TOOL: ApiToolDefinition = {
  name: 'submit_workflow_draft',
  description: 'Submit one complete editable workflow DAG proposal for this dedicated planning run. Main validates and saves a draft only; this cannot activate a workflow or create tasks.',
  parameters: workflowDraftSchema(),
};

const MEMORY_SOURCE_SCHEMA = objectSchema({
  kind: { type: 'string', enum: ['single_chat', 'studio'] },
  conversation_id: { type: 'string' },
  room_id: { type: 'string' },
  message_id: { type: 'string' },
}, ['kind', 'message_id']);
const MEMORY_SOURCES_SCHEMA = { type: 'array', items: MEMORY_SOURCE_SCHEMA };
const HOLD_MEMORY_TOOL: ApiToolDefinition = {
  name: 'hold_memory', description: memoryToolDescription('hold_memory'),
  parameters: objectSchema({ type: { type: 'string', enum: ['self_summary', 'relationship_with_user', 'stable_fact', 'long_term_project', 'recurring_behavior_pattern', 'preference_and_collaboration', 'open_question_and_follow_up'] }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, weight: { type: 'integer', minimum: 1, maximum: 5 }, occurred_at: { type: 'string' }, sources: MEMORY_SOURCES_SCHEMA }, ['type', 'body']),
};
const SEARCH_MEMORY_TOOL: ApiToolDefinition = {
  name: 'search_memory', description: memoryToolDescription('search_memory'),
  parameters: objectSchema({ text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, types: { type: 'array', items: { type: 'string' } }, statuses: { type: 'array', items: { type: 'string' } }, from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
};
const COMMENT_MEMORY_TOOL: ApiToolDefinition = {
  name: 'comment_memory', description: memoryToolDescription('comment_memory'),
  parameters: objectSchema({ memory_id: { type: 'string' }, content: { type: 'string' }, sources: MEMORY_SOURCES_SCHEMA }, ['memory_id', 'content']),
};
const UPDATE_MEMORY_TOOL: ApiToolDefinition = {
  name: 'update_memory', description: memoryToolDescription('update_memory'),
  parameters: objectSchema({ memory_id: { type: 'string' }, type: { type: 'string' }, status: { type: 'string', enum: ['active', 'completed', 'obsolete', 'superseded'] }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, weight: { type: 'integer', minimum: 1, maximum: 5 }, occurred_at: { type: ['string', 'null'] }, superseded_by_memory_id: { type: ['string', 'null'] } }, ['memory_id']),
};
const READ_MEMORY_SOURCE_TOOL: ApiToolDefinition = {
  name: 'read_memory_source', description: memoryToolDescription('read_memory_source'),
  parameters: objectSchema({ memory_id: { type: 'string' }, source_index: { type: 'integer', minimum: 0 } }, ['memory_id']),
};
const MEMORY_READ_TOOLS = [SEARCH_MEMORY_TOOL, READ_MEMORY_SOURCE_TOOL];
const MEMORY_WRITE_TOOLS = [HOLD_MEMORY_TOOL, COMMENT_MEMORY_TOOL, UPDATE_MEMORY_TOOL];
const PROJECT_NOTEBOOK_TOOL: ApiToolDefinition = {
  name: 'project_notebook',
  description: 'List this partner’s active projects or read, append to, and revision-safely replace this partner’s private project work notebook. This is not long-term memory. In single chat, project_id is required for read/write. In Studio, Asterium fixes the current project. replace requires expected_revision from the latest result.',
  parameters: objectSchema({
    action: { type: 'string', enum: ['list', 'read', 'append', 'replace'] },
    project_id: { type: 'string' },
    content: { type: 'string' },
    expected_revision: { type: 'integer', minimum: 0 },
  }, ['action']),
};

export class ApiAgentTools {
  private readonly roots: string[];
  private readonly registry = new ApiToolRegistry();
  private extensions = new ApiToolRegistry();
  private readonly nativeCommandCwds = new WeakMap<Record<string, unknown>, string>();

  constructor(readonly primaryDirectory: string | undefined, additionalDirectories: string[] = [], private readonly attachmentReader?: ApiAttachmentReader, private readonly runtimeTools?: AsteriumRuntimeToolController, private readonly webTools?: ApiWebTools, private readonly protectedRoots: readonly string[] = [], private readonly execution: Pick<ExecutionGateway, 'runCommand'> = nativeExecutionGateway, private readonly owner?: Pick<SendMessageCommand, 'partnerId' | 'conversationId' | 'route'>) {
    this.roots = primaryDirectory ? [...new Set([primaryDirectory, ...additionalDirectories].map((item) => path.resolve(item)))] : [];
    const memoryDefinitions = runtimeTools?.memory
      ? [...MEMORY_READ_TOOLS, ...(!runtimeTools.workflowDraft && runtimeTools.memory.access === 'write' ? MEMORY_WRITE_TOOLS : [])]
        .map((definition) => ({ ...definition, description: memoryToolDescription(definition.name as MemoryToolName, Boolean(runtimeTools.workflowDraft)) }))
      : [];
    const definitions = runtimeTools?.workflowDraft
      ? [SUBMIT_WORKFLOW_DRAFT_TOOL, ...memoryDefinitions]
      : [...(primaryDirectory ? API_AGENT_TOOL_DEFINITIONS : []), ...(attachmentReader ? [READ_ATTACHMENT_TOOL] : []), ...(runtimeTools ? [ASTERIUM_STATUS_TOOL, ASTERIUM_WORKSPACE_TOOL] : []), ...(runtimeTools?.mentionPartner ? [MENTION_PARTNER_TOOL] : []), ...(runtimeTools?.task ? [ASTERIUM_TASK_TOOL] : []), ...memoryDefinitions, ...(runtimeTools?.projectNotebook ? [PROJECT_NOTEBOOK_TOOL] : []), ...(webTools?.definitions ?? [])];
    if (runtimeTools?.automation && !runtimeTools.workflowDraft) definitions.push({ name: 'asterium_automation', description: AUTOMATION_TOOL_DESCRIPTION, parameters: automationToolJsonSchema });
    const handlers = this.toolHandlers();
    for (const definition of definitions) {
      if (!Object.hasOwn(handlers, definition.name)) throw new Error('API_TOOL_HANDLER_NOT_REGISTERED');
      this.registry.register({ definition, ...handlers[definition.name] });
    }
  }

  get definitions() { return [...this.registry.definitions, ...this.extensions.definitions]; }

  setExtensions(registrations: ApiToolRegistration[]) {
    const registry = new ApiToolRegistry();
    if (this.runtimeTools?.workflowDraft && registrations.length) throw new Error('ASTERIUM_WORKFLOW_PLANNING_TOOL_NOT_AVAILABLE');
    for (const registration of registrations) {
      if (this.registry.has(registration.definition.name)) throw new Error('API_TOOL_ALREADY_REGISTERED');
      registry.register(registration);
    }
    this.extensions = registry;
  }

  /** Structured MCP filesystem arguments retain the existing canonical workspace/protected-root boundary. */
  async assertMcpPaths(value: unknown, field = '', depth = 0): Promise<void> {
    return executionPermissions.assertStructuredPaths(this.accessScope, value, field, depth);
  }

  updateRuntimeContext(input: Parameters<AsteriumRuntimeToolController['update']>[0]) {
    this.runtimeTools?.update(input);
  }

  describe(name: string, args: Record<string, unknown>): ToolAuthorizationDescriptor {
    return this.prepare(name, args).descriptor;
  }

  prepare(name: string, args: Record<string, unknown>) {
    if (this.runtimeTools?.workflowDraft && !this.registry.has(name)) throw new Error('ASTERIUM_WORKFLOW_PLANNING_TOOL_NOT_AVAILABLE');
    return this.registry.has(name) ? this.registry.prepare(name, args) : this.extensions.prepare(name, args);
  }

  private fileTarget(args: Record<string, unknown>, command = false) {
    if (!this.primaryDirectory) throw new Error('API_WORKSPACE_NOT_CONFIGURED');
    const rawTarget = stringArg(args, command ? 'cwd' : 'path', command ? this.primaryDirectory : '.');
    return path.resolve(path.isAbsolute(rawTarget) ? rawTarget : path.join(this.primaryDirectory, rawTarget));
  }
  private get accessScope() { return { primaryDirectory: this.primaryDirectory, roots: this.roots, protectedRoots: this.protectedRoots }; }

  private toolHandlers(): Record<string, Omit<ApiToolRegistration, 'definition'>> {
    const readDescriptor = (summary: string, targets: string[] = []): ToolAuthorizationDescriptor => ({ mutates: false, action: 'read_file', risk: 'low', summary, targets });
    const fileCapability = (access: 'read' | 'write' | 'delete', args: Record<string, unknown>, scope: 'workspace' | 'exact_file' = 'workspace'): ExecutionCapabilities => ({ files: { access, scope, targets: [this.fileTarget(args)] } });
    const fileReadDescriptor = (name: string, args: Record<string, unknown>) => ({ ...readDescriptor(`API 伙伴请求调用 ${name}。`, [this.fileTarget(args)]), capabilities: fileCapability('read', args, name === 'deliver_file' ? 'exact_file' : 'workspace') });
    const memoryWriteDescriptor = (name: string): ToolAuthorizationDescriptor => ({ mutates: false, action: 'external_side_effect', risk: 'low', summary: `API 伙伴调用 ${name} 更新自己的星丛记忆。`, targets: [] });
    return {
      asterium_automation: { source: 'asterium', validate: args => { automationToolSchema.parse(args); }, describe: () => readDescriptor('按当前会话权限管理自己的自动化。'), execute: async (args, signal) => ({ content: await this.runtimeTools!.automation!(args, signal) }) },
      list_directory: { source: 'workspace', allowInPlan: true, describe: (args) => fileReadDescriptor('list_directory', args), execute: async (args) => ({ content: await this.listDirectory(stringArg(args, 'path', '.')) }) },
      search_files: { source: 'workspace', allowInPlan: true, validate: (args) => { stringArg(args, 'query'); }, describe: (args) => fileReadDescriptor('search_files', args), execute: async (args) => ({ content: await this.searchFiles(stringArg(args, 'query'), stringArg(args, 'path', '.')) }) },
      read_file: { source: 'workspace', allowInPlan: true, validate: (args) => { stringArg(args, 'path'); }, describe: (args) => fileReadDescriptor('read_file', args), execute: async (args, _signal, authorization) => ({ content: await this.readFile(stringArg(args, 'path'), authorization.externalReadPaths) }) },
      write_file: { source: 'workspace', validate: (args) => { stringArg(args, 'path'); stringArg(args, 'content'); }, describe: (args) => ({ mutates: true, action: 'write_file', risk: 'medium', summary: 'API 伙伴请求写入文件。', targets: [this.fileTarget(args)], capabilities: fileCapability('write', args) }), execute: (args, _signal, authorization) => this.writeFile(args, authorization) },
      edit_file: { source: 'workspace', validate: (args) => { stringArg(args, 'path'); stringArg(args, 'old_text'); stringArg(args, 'new_text'); }, describe: (args) => ({ mutates: true, action: 'write_file', risk: 'medium', summary: 'API 伙伴请求编辑文件。', targets: [this.fileTarget(args)], capabilities: fileCapability('write', args) }), execute: (args) => this.editFile(args) },
      delete_path: { source: 'workspace', validate: (args) => { stringArg(args, 'path'); }, describe: (args) => ({ mutates: true, action: 'delete_file', risk: 'high', summary: 'API 伙伴请求删除文件或空目录。', targets: [this.fileTarget(args)], capabilities: fileCapability('delete', args) }), execute: (args) => this.deletePath(args) },
      deliver_file: { source: 'workspace', validate: (args) => { stringArg(args, 'path'); }, describe: (args) => fileReadDescriptor('deliver_file', args), execute: (args) => this.deliverFile(args) },
      run_command: {
        source: 'workspace',
        validate: args => {
          stringArg(args, 'command');
          if (args.sandbox_permissions === 'require_escalated' && !stringArg(args, 'justification', '').trim()) throw new Error('NATIVE_COMMAND_JUSTIFICATION_REQUIRED');
        },
        guard: async args => {
          if (args.sandbox_permissions !== 'require_escalated') return;
          executionPermissions.assertCommandText(stringArg(args, 'command'), this.protectedRoots);
          const cwd = await this.resolveAuthorized(stringArg(args, 'cwd', this.primaryDirectory), true);
          if (!(await stat(cwd)).isDirectory()) throw new Error('TOOL_COMMAND_CWD_NOT_DIRECTORY');
          const previous = this.nativeCommandCwds.get(args);
          if (previous && previous !== cwd) throw new Error('NATIVE_COMMAND_CWD_CHANGED');
          this.nativeCommandCwds.set(args, cwd);
        },
        describe: (args) => ({ mutates: true, action: 'run_command', risk: 'high',
          summary: args.sandbox_permissions === 'require_escalated' ? 'API 伙伴请求仅本次使用 Native（无沙箱）运行命令。' : 'API 伙伴请求运行一条 PowerShell 命令，后端跟随权限与沙箱设置。',
          ...(args.sandbox_permissions === 'require_escalated' ? { purpose: 'command_native' as const } : {}),
          targets: [stringArg(args, 'command'), `cwd: ${this.fileTarget(args, true)}`, ...(args.sandbox_permissions === 'require_escalated' ? [`理由: ${stringArg(args, 'justification')}`] : [])], capabilities: { process: { kind: 'command', cwd: this.fileTarget(args, true) }, network: { kind: 'native_unrestricted' } } }),
        execute: (args, signal, authorization) => this.runCommand(args, signal, authorization),
      },
      read_attachment_text: { source: 'attachment', allowInPlan: true, describe: (args) => readDescriptor('API 伙伴请求读取用户上传的文本附件。', [stringArg(args, 'attachment_id')]), execute: async (args) => ({ content: await this.readAttachment(stringArg(args, 'attachment_id'), integerArg(args, 'offset', 0), integerArg(args, 'max_characters', 16_000)) }) },
      asterium_status: { source: 'asterium', allowInPlan: true, describe: (args) => readDescriptor('API 伙伴查询星丛当前状态。', [stringArg(args, 'key')]), execute: async (args) => ({ content: await this.runtimeTools!.status(stringArg(args, 'key') as AsteriumStatusKey) }) },
      asterium_workspace: {
        source: 'asterium', allowInPlan: true,
        describe: (args) => args.action === 'list'
          ? { ...readDescriptor('API 伙伴查询当前对话的工作区。'), capabilities: { workspace: { action: 'list' } } }
          : { mutates: true, action: 'external_side_effect', risk: 'medium', summary: `API 伙伴请求${args.action === 'add' ? '加入' : '移除'}持久工作区。`, targets: [stringArg(args, 'path')], purpose: args.action === 'add' ? 'workspace_add' : 'workspace_remove', capabilities: { workspace: { action: args.action as 'add' | 'remove', target: stringArg(args, 'path') } } },
        execute: async (args) => ({ content: await this.runtimeTools!.workspace(stringArg(args, 'action') as AsteriumWorkspaceAction, optionalStringArg(args, 'path')) }),
      },
      mention_partner: { source: 'asterium', allowInPlan: true, describe: (args) => readDescriptor('API 伙伴邀请另一位伙伴继续讨论。', [stringArg(args, 'partner_id')]), execute: async (args) => ({ content: await this.runtimeTools!.mentionPartner!(stringArg(args, 'partner_id')) }) },
      asterium_task: { source: 'asterium', validate: (args) => { parseAsteriumTaskToolInput(args); }, describe: (args) => readDescriptor(args.action === 'submit_handoff' ? 'API 伙伴提交结构化任务交付。' : 'API 伙伴查询冻结任务契约。'), execute: async (args) => ({ content: await this.runtimeTools!.task!(parseAsteriumTaskToolInput(args)) }) },
      submit_workflow_draft: { source: 'asterium', validate: (args) => { parseWorkflowDraftToolInput(args); }, describe: () => readDescriptor('规划伙伴提交结构化工作流草稿。'), execute: async (args) => ({ content: await this.runtimeTools!.workflowDraft!(parseWorkflowDraftToolInput(args)) }) },
      search_memory: { source: 'asterium', allowInPlan: true, validate: (args) => { parseSearchMemoryInput(args); }, describe: () => readDescriptor('API 伙伴检索自己的星丛记忆。'), execute: async (args) => ({ content: await this.runtimeTools!.memory!.search(parseSearchMemoryInput(args)) }) },
      read_memory_source: { source: 'asterium', allowInPlan: true, validate: (args) => { parseReadMemorySourceInput(args); }, describe: (args) => readDescriptor('API 伙伴读取自己记忆的来源上下文。', [stringArg(args, 'memory_id')]), execute: async (args) => ({ content: await this.runtimeTools!.memory!.readSource(parseReadMemorySourceInput(args)) }) },
      hold_memory: {
        source: 'asterium', allowInPlan: true, validate: (args) => { parseHoldMemoryInput(args); }, describe: () => memoryWriteDescriptor('hold_memory'),
        execute: async (args) => {
          if (!this.runtimeTools?.memory?.hold) throw new Error('ASTERIUM_MEMORY_WRITE_NOT_AVAILABLE');
          return { content: await this.runtimeTools.memory.hold(parseHoldMemoryInput(args)) };
        },
      },
      comment_memory: {
        source: 'asterium', allowInPlan: true, validate: (args) => { parseCommentMemoryInput(args); }, describe: () => memoryWriteDescriptor('comment_memory'),
        execute: async (args) => {
          if (!this.runtimeTools?.memory?.comment) throw new Error('ASTERIUM_MEMORY_WRITE_NOT_AVAILABLE');
          return { content: await this.runtimeTools.memory.comment(parseCommentMemoryInput(args)) };
        },
      },
      update_memory: {
        source: 'asterium', allowInPlan: true, validate: (args) => { parseUpdateMemoryInput(args); }, describe: () => memoryWriteDescriptor('update_memory'),
        execute: async (args) => {
          if (!this.runtimeTools?.memory?.update) throw new Error('ASTERIUM_MEMORY_WRITE_NOT_AVAILABLE');
          return { content: await this.runtimeTools.memory.update(parseUpdateMemoryInput(args)) };
        },
      },
      project_notebook: {
        source: 'asterium',
        validate: (args) => { parseProjectNotebookToolInput(args); },
        describe: (args) => ({ mutates: false, action: 'external_side_effect', risk: 'low', summary: `API 伙伴${args.action === 'list' || args.action === 'read' ? '读取' : '更新'}自己的项目工作笔记。`, targets: typeof args.project_id === 'string' ? [args.project_id] : [] }),
        execute: async (args) => ({ content: await this.runtimeTools!.projectNotebook!(parseProjectNotebookToolInput(args)) }),
      },
      web_search: { source: 'web', allowInPlan: true, describe: (args) => ({ ...readDescriptor('API 伙伴正在搜索公开网络资料。', [stringArg(args, 'query')]), capabilities: { network: { kind: 'public_https_read' } } }), execute: async (args, signal) => ({ content: await this.webTools!.execute('web_search', args, signal) }) },
      web_fetch: { source: 'web', allowInPlan: true, describe: (args) => ({ ...readDescriptor('API 伙伴正在读取公开网页。', [stringArg(args, 'url')]), capabilities: { network: { kind: 'public_https_read', target: stringArg(args, 'url') } } }), execute: async (args, signal) => ({ content: await this.webTools!.execute('web_fetch', args, signal) }) },
    };
  }

  async oneTimeExternalWriteTarget(name: string, args: Record<string, unknown>) {
    if (name !== 'write_file' || !this.primaryDirectory) return undefined;
    return executionPermissions.externalWriteTarget(this.accessScope, stringArg(args, 'path'));
  }

  async execute(name: string, args: Record<string, unknown>, signal: AbortSignal, authorization: ApiToolExecutionAuthorization = {}): Promise<ApiToolResult> {
    if (signal.aborted) throw abortError();
    return this.prepare(name, args).execute(signal, authorization);
  }

  private async writeFile(args: Record<string, unknown>, authorization: ApiToolExecutionAuthorization): Promise<ApiToolResult> {
    const approvedExternalTarget = authorization.externalWritePath;
    const target = approvedExternalTarget ?? await this.resolveAuthorized(stringArg(args, 'path'), false);
    if (approvedExternalTarget) {
      const requestedExternalTarget = await this.oneTimeExternalWriteTarget('write_file', args);
      if (!requestedExternalTarget || !samePath(requestedExternalTarget, approvedExternalTarget)) throw new Error('EXTERNAL_WRITE_AUTHORIZATION_MISMATCH');
    }
    const changeKind = await fileExists(target) ? 'modify' : 'create';
    const content = stringArg(args, 'content');
    if (Buffer.byteLength(content, 'utf8') > WRITE_LIMIT) throw new Error('TOOL_WRITE_TOO_LARGE');
    if (!approvedExternalTarget) await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    return { content: `已写入 ${target}`, artifact: { path: target, method: 'automatic', changeKind } };
  }

  private async editFile(args: Record<string, unknown>): Promise<ApiToolResult> {
    const target = await this.resolveAuthorized(stringArg(args, 'path'), true);
    const before = await readUtf8(target);
    const oldText = stringArg(args, 'old_text');
    const first = before.indexOf(oldText);
    if (first < 0) throw new Error('TOOL_EDIT_TEXT_NOT_FOUND');
    if (before.indexOf(oldText, first + oldText.length) >= 0) throw new Error('TOOL_EDIT_TEXT_NOT_UNIQUE');
    const after = `${before.slice(0, first)}${stringArg(args, 'new_text')}${before.slice(first + oldText.length)}`;
    if (Buffer.byteLength(after, 'utf8') > WRITE_LIMIT) throw new Error('TOOL_WRITE_TOO_LARGE');
    await writeFile(target, after, 'utf8');
    return { content: `已编辑 ${target}`, artifact: { path: target, method: 'automatic', changeKind: 'modify' } };
  }

  private async deletePath(args: Record<string, unknown>): Promise<ApiToolResult> {
    const target = await this.resolveAuthorized(stringArg(args, 'path'), true);
    const info = await stat(target);
    if (info.isDirectory() && (await readdir(target)).length) throw new Error('TOOL_DELETE_DIRECTORY_NOT_EMPTY');
    if (!info.isFile() && !info.isDirectory()) throw new Error('TOOL_DELETE_UNSUPPORTED_PATH');
    await rm(target, { recursive: false });
    return { content: `已删除 ${target}` };
  }

  private async deliverFile(args: Record<string, unknown>): Promise<ApiToolResult> {
    const target = await this.resolveDeliveryFile(stringArg(args, 'path'));
    const requestedName = optionalStringArg(args, 'name');
    return { content: `已登记交付 ${target}`, artifact: { path: target, ...(requestedName ? { name: requestedName } : {}), method: 'deliver_tool' } };
  }

  private async runCommand(args: Record<string, unknown>, signal: AbortSignal, authorization: ApiToolExecutionAuthorization): Promise<ApiToolResult> {
    executionPermissions.assertCommandText(stringArg(args, 'command'), this.protectedRoots);
    const cwd = await this.resolveAuthorized(stringArg(args, 'cwd', this.primaryDirectory), true);
    if (!(await stat(cwd)).isDirectory()) throw new Error('TOOL_COMMAND_CWD_NOT_DIRECTORY');
    let execution: ApiToolResult['execution'];
    const context: ExecutionContext | undefined = this.owner ? { kind: 'partner_runtime',
      partnerId: this.owner.partnerId, conversationId: this.owner.conversationId, route: this.owner.route, policy: authorization.policy,
      workspace: { cwd: this.primaryDirectory, workspaceFolders: this.roots } } : undefined;
    const nativeRequested = args.sandbox_permissions === 'require_escalated' && authorization.policy?.permissionMode !== 'full';
    if (nativeRequested && (!authorization.nativeCommandApproved || !context || this.nativeCommandCwds.get(args) !== cwd)) throw new Error('NATIVE_COMMAND_APPROVAL_REQUIRED');
    const binding = { command: stringArg(args, 'command'), cwd, context };
    const content = await this.execution.runCommand({ command: stringArg(args, 'command'), cwd, signal, onStarted: value => { execution = value; },
      ...(nativeRequested ? { nativeApproval: issueNativeCommandApproval(binding) } : {}),
      beforeStart: async () => {
        signal.throwIfAborted();
        if (!this.runtimeTools) throw new Error('SANDBOX_REVALIDATION_REQUIRED');
        const current = JSON.parse(await this.runtimeTools.status('workspace')) as { workspaceFolders?: string[] };
        const freshRoots = await Promise.all((current.workspaceFolders ?? []).map(root => realpath(root)));
        const expectedRoots = await Promise.all(this.roots.map(root => realpath(root)));
        if (!expectedRoots.every(root => freshRoots.some(fresh => fresh.toLowerCase() === root.toLowerCase()))) throw new Error('SANDBOX_WORKSPACE_CHANGED');
        const currentCwd = await this.resolveAuthorized(cwd, true);
        if (nativeRequested && currentCwd !== cwd) throw new Error('NATIVE_COMMAND_CWD_CHANGED');
      },
      ...(context ? { context } : {}),
    });
    return { content, ...(execution ? { execution } : {}) };
  }

  private async listDirectory(input: string) {
    const directory = await this.resolveAuthorized(input, true);
    if (!(await stat(directory)).isDirectory()) throw new Error('TOOL_PATH_NOT_DIRECTORY');
    const entries = (await readdir(directory, { withFileTypes: true })).slice(0, 500)
      .map((entry) => `${entry.isDirectory() ? '[dir]' : '[file]'} ${entry.name}`);
    return truncateResult(entries.join('\n') || '目录为空。');
  }

  private async readAttachment(attachmentId: string, offset: number, maxCharacters: number) {
    if (!this.attachmentReader) throw new Error('ATTACHMENT_READER_NOT_CONFIGURED');
    if (offset < 0 || maxCharacters < 1 || maxCharacters > 32_768) throw new Error('ATTACHMENT_READ_RANGE_INVALID');
    const metadata = await this.attachmentReader.inspect(attachmentId, this.attachmentReader.conversationId);
    if (!isTextAttachment(metadata.mediaType)) throw new Error('ATTACHMENT_TEXT_UNSUPPORTED_TYPE');
    const target = await this.attachmentReader.pathFor(attachmentId, this.attachmentReader.conversationId);
    const info = await stat(target);
    if (!info.isFile()) throw new Error('ATTACHMENT_MISSING');
    const buffer = await readFile(target);
    if (buffer.includes(0)) throw new Error('ATTACHMENT_BINARY_FILE');
    const text = buffer.toString('utf8');
    if (offset > text.length) throw new Error('ATTACHMENT_READ_OFFSET_OUT_OF_RANGE');
    const content = text.slice(offset, offset + maxCharacters);
    const nextOffset = offset + content.length;
    return JSON.stringify({
      id: metadata.id,
      name: metadata.name,
      mediaType: metadata.mediaType,
      offset,
      nextOffset,
      eof: nextOffset >= text.length,
      totalCharacters: text.length,
      content,
    });
  }

  private async readFile(input: string, externalReadPaths?: ReadonlySet<string>) {
    const target = await this.resolveReadableFile(input, externalReadPaths);
    const info = await stat(target);
    if (!info.isFile()) throw new Error('TOOL_PATH_NOT_FILE');
    if (info.size > READ_LIMIT) throw new Error('TOOL_READ_TOO_LARGE');
    return truncateResult(await readUtf8(target));
  }

  private async resolveReadableFile(input: string, externalReadPaths?: ReadonlySet<string>) {
    try {
      return await this.resolveAuthorized(input, true);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'TOOL_PATH_OUTSIDE_WORKSPACE' || !externalReadPaths?.size) throw error;
      const candidate = path.resolve(path.isAbsolute(input) ? input : path.join(this.primaryDirectory!, input));
      const target = await realpath(candidate).catch(() => { throw error; });
      if (![...externalReadPaths].some((approved) => samePath(approved, target))) throw error;
      return target;
    }
  }

  private async resolveDeliveryFile(input: string) {
    if (!input.trim()) throw new Error('TOOL_DELIVERY_PATH_REQUIRED');
    const candidate = path.resolve(path.isAbsolute(input) ? input : path.join(this.primaryDirectory ?? process.cwd(), input));
    let target: string;
    try {
      target = await realpath(candidate);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') throw new Error('TOOL_DELIVERY_FILE_NOT_FOUND', { cause: error });
      throw error;
    }
    if (!(await stat(target)).isFile()) throw new Error('TOOL_DELIVERY_NOT_FILE');
    return target;
  }

  private async searchFiles(query: string, input: string) {
    if (!query) throw new Error('TOOL_QUERY_REQUIRED');
    const root = await this.resolveAuthorized(input, true);
    if (!(await stat(root)).isDirectory()) throw new Error('TOOL_PATH_NOT_DIRECTORY');
    const needle = query.toLocaleLowerCase();
    const results: string[] = [];
    const visit = async (directory: string) => {
      if (results.length >= 200) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (results.length >= 200) break;
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) {
          const relative = path.relative(root, absolute);
          if (entry.name.toLocaleLowerCase().includes(needle)) results.push(`${relative}: 文件名匹配`);
          else {
            const info = await stat(absolute);
            if (info.size > READ_LIMIT) continue;
            try {
              const content = await readUtf8(absolute);
              const line = content.split(/\r?\n/).findIndex((item) => item.toLocaleLowerCase().includes(needle));
              if (line >= 0) results.push(`${relative}:${line + 1}`);
            } catch {
              // Ignore binary or unreadable files.
            }
          }
        }
      }
    };
    await visit(root);
    return truncateResult(results.join('\n') || '没有找到匹配项。');
  }

  private async resolveAuthorized(input: string, mustExist: boolean) {
    return executionPermissions.resolveWorkspacePath(this.accessScope, input, mustExist);
  }
}

function workflowDraftSchema() {
  const stringArraySchema = { type: 'array' as const, items: { type: 'string' as const } };
  return objectSchema({
    name: { type: 'string' },
    description: { type: 'string' },
    generation_summary: { type: 'string' },
    nodes: {
      type: 'array',
      items: objectSchema({
        client_key: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, assignee_partner_id: { type: 'string' },
        dependency_keys: stringArraySchema, acceptance_criteria: stringArraySchema, note: { type: 'string' }, work_role_id: { type: 'string' }, review_role_id: { type: 'string' }, method_template_id: { type: 'string' },
        completion_rule: objectSchema({ type: { type: 'string', enum: ['executor_submit', 'partner_review', 'user_confirm'] }, reviewer_partner_id: { type: 'string' }, auto_rework_limit: { type: 'integer' } }, ['type']),
        source_message_ids: stringArraySchema, basis_summary: { type: 'string' },
      }, ['client_key', 'title', 'description', 'dependency_keys', 'acceptance_criteria', 'completion_rule', 'source_message_ids']),
    },
  }, ['name', 'description', 'generation_summary', 'nodes']);
}

function samePath(left: string, right: string) {
  return process.platform === 'win32' ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right;
}

async function fileExists(filePath: string) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readUtf8(filePath: string) {
  const buffer = await readFile(filePath);
  if (buffer.includes(0)) throw new Error('TOOL_BINARY_FILE');
  return buffer.toString('utf8');
}

function truncateResult(value: string) {
  return value.length <= RESULT_LIMIT ? value : `${value.slice(0, RESULT_LIMIT)}\n[输出已截断]`;
}

function stringArg(args: Record<string, unknown>, key: string, fallback?: string) {
  const value = args[key];
  if (typeof value === 'string' && value.length) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`TOOL_ARGUMENT_REQUIRED:${key}`);
}

function optionalStringArg(args: Record<string, unknown>, key: string) {
  return typeof args[key] === 'string' && args[key] ? args[key] as string : undefined;
}

function integerArg(args: Record<string, unknown>, key: string, fallback: number) {
  const value = args[key];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) throw new Error(`TOOL_ARGUMENT_INVALID:${key}`);
  return value as number;
}

function isTextAttachment(mediaType: string) {
  return mediaType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mediaType);
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}


function abortError() {
  return Object.assign(new Error('ABORTED'), { name: 'AbortError' });
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
