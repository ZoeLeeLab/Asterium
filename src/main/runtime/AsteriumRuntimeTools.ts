import type { AgentExecutionRoute, AsteriumRuntimeContextInput, PermissionMode } from '../../shared/agentProtocol';
import type { ArtifactRegistry } from '../security/ArtifactRegistry';
import type { ConversationAttachmentStore } from '../security/ConversationAttachmentStore';
import type { PartnerWorkspaceStore } from '../security/PartnerWorkspaceStore';
import type { TaskHandoffSubmission, TaskReviewSubmission } from '../../shared/projectTaskExecution';
import type { ProjectWorkflowDraftProposal } from '../../shared/projectWorkflowGeneration';
import type {
  CommentMemoryInput,
  HoldMemoryInput,
  ReadMemorySourceInput,
  SearchMemoryInput,
  UpdateMemoryInput,
} from '../memory/PartnerMemoryToolService';
import { MEMORY_STATUSES, MEMORY_TYPES, type MemorySourceAnchor } from '../../shared/memoryArchive';
import { MANAGED_MEMORY_RULES, WORKFLOW_MEMORY_RULES } from './MemoryToolGuidance';

export type AsteriumStatusKey = 'time' | 'partner' | 'partners' | 'user' | 'runtime' | 'permissions' | 'conversation' | 'conversation_files' | 'workspace';
export type AsteriumWorkspaceAction = 'list' | 'add' | 'remove';
export type AsteriumTaskToolInput = { action: 'context' }
  | ({ action: 'submit_handoff' } & TaskHandoffSubmission)
  | ({ action: 'submit_review' } & TaskReviewSubmission);
export type ProjectNotebookToolInput = { action: 'list' }
  | { action: 'read'; projectId?: string }
  | { action: 'append'; projectId?: string; content: string }
  | { action: 'replace'; projectId?: string; content: string; expectedRevision: number };

export interface AsteriumMemoryToolController {
  access: 'read' | 'write';
  search(input: SearchMemoryInput): Promise<string>;
  readSource(input: ReadMemorySourceInput): Promise<string>;
  hold?(input: HoldMemoryInput): Promise<string>;
  comment?(input: CommentMemoryInput): Promise<string>;
  update?(input: UpdateMemoryInput): Promise<string>;
}

export interface AsteriumRuntimeToolController {
  automation?: (input: unknown, signal?: AbortSignal) => Promise<string>;
  status(key: AsteriumStatusKey): Promise<string>;
  workspace(action: AsteriumWorkspaceAction, targetPath?: string): Promise<string>;
  mentionPartner?(targetPartnerId: string): Promise<string>;
  task?(input: AsteriumTaskToolInput): Promise<string>;
  workflowDraft?(input: ProjectWorkflowDraftProposal): Promise<string>;
  memory?: AsteriumMemoryToolController;
  projectNotebook?: (input: ProjectNotebookToolInput) => Promise<string>;
  delegation?: (tool: string, input: Record<string, unknown>, signal: AbortSignal, toolCallId?: string) => Promise<string>;
  update(input: Pick<RuntimeToolsOptions, 'permissionMode' | 'planMode' | 'context' | 'route'>): void;
}

interface RuntimeToolsOptions {
  automation?: (input: unknown, signal?: AbortSignal) => Promise<string>;
  workspaceChangesAllowed?: boolean;
  partnerId: string;
  conversationId: string;
  permissionMode: PermissionMode;
  planMode: 'default' | 'plan';
  context?: AsteriumRuntimeContextInput;
  route?: AgentExecutionRoute;
  mentionPartner?: (input: { route: Extract<AgentExecutionRoute, { scope: 'group' }>; partnerId: string; targetPartnerId: string; label: string }) => Promise<void>;
  task?: (input: AsteriumTaskToolInput) => Promise<string>;
  workflowDraft?: (input: ProjectWorkflowDraftProposal) => Promise<string>;
  memory?: AsteriumMemoryToolController;
  projectNotebook?: (input: ProjectNotebookToolInput) => Promise<string>;
  delegation?: AsteriumRuntimeToolController['delegation'];
  workspaceBoundary?: { projectId: string; projectRoot: string };
  workspaces: PartnerWorkspaceStore;
  artifacts: ArtifactRegistry;
  attachments: ConversationAttachmentStore;
}

export function createAsteriumRuntimeTools(options: RuntimeToolsOptions): AsteriumRuntimeToolController {
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  let current = {
    permissionMode: options.permissionMode,
    planMode: options.planMode,
    context: options.context,
    route: options.route,
  };
  const controller: AsteriumRuntimeToolController = {
    update(input) {
      current = { permissionMode: input.permissionMode, planMode: input.planMode, context: input.context, route: input.route ?? current.route };
    },
    async status(key) {
      if (key === 'time') {
        const now = new Date();
        return json({ iso: now.toISOString(), local: now.toLocaleString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale });
      }
      if (key === 'partner') return json({ partnerId: options.partnerId, ...(current.context?.partner ?? { unavailable: true }) });
      if (key === 'partners') return json(current.context?.partners ?? []);
      if (key === 'user') return json(current.context?.user ?? { unavailable: true });
      if (key === 'runtime') return json(current.context?.runtime ?? { source: 'unknown' });
      if (key === 'permissions') return json({ permissionMode: current.permissionMode, planMode: current.planMode });
      if (key === 'conversation') return json({ conversationId: options.conversationId, partnerId: options.partnerId, ...(current.context?.conversation ?? { title: '' }) });
      if (key === 'workspace') return options.workspaceBoundary
        ? json({ cwd: options.workspaceBoundary.projectRoot, workspaceFolders: [options.workspaceBoundary.projectRoot], permissionMode: current.permissionMode, projectId: options.workspaceBoundary.projectId, fixedProjectBoundary: true })
        : json(await options.workspaces.snapshot(options.partnerId, current.permissionMode));
      if (key === 'conversation_files') {
        const [attachments, deliveries] = await Promise.all([
          options.attachments.list(options.conversationId),
          options.artifacts.listConversation(options.conversationId),
        ]);
        return json({
          userAttachments: attachments.map(({ id, name, mediaType, sizeBytes, availability, sentAt }) => ({ id, name, mediaType, sizeBytes, availability, sentAt })),
          partnerDeliveries: deliveries.map(({ id, name, mediaType, sizeBytes, availability, createdAt }) => ({ id, name, mediaType, sizeBytes, availability, createdAt })),
        });
      }
      throw new Error('ASTERIUM_STATUS_KEY_UNSUPPORTED');
    },
    async workspace(action, targetPath) {
      if (action === 'list') return options.workspaceBoundary
        ? json({ cwd: options.workspaceBoundary.projectRoot, workspaceFolders: [options.workspaceBoundary.projectRoot], permissionMode: current.permissionMode, projectId: options.workspaceBoundary.projectId, fixedProjectBoundary: true })
        : json(await options.workspaces.snapshot(options.partnerId, current.permissionMode));
      if (options.workspaceChangesAllowed === false) throw new Error('AUTOMATION_WORKSPACE_FIXED');
      if (options.workspaceBoundary) throw new Error('PROJECT_WORKSPACE_FIXED');
      if (!targetPath?.trim()) throw new Error('WORKSPACE_PATH_REQUIRED');
      if (action === 'add') return json({
        ...(await options.workspaces.add(options.partnerId, targetPath, current.permissionMode)),
        change: { action: 'add', committed: true, availableToFileTools: 'next_turn' },
      });
      if (action === 'remove') return json({
        ...(await options.workspaces.remove(options.partnerId, targetPath, current.permissionMode)),
        change: { action: 'remove', committed: true, availableToFileTools: 'next_turn' },
      });
      throw new Error('WORKSPACE_ACTION_UNSUPPORTED');
    },
  };
  if (options.task) controller.task = options.task;
  if (options.automation && !options.workflowDraft) controller.automation = options.automation;
  if (options.workflowDraft) controller.workflowDraft = options.workflowDraft;
  if (options.memory) controller.memory = options.memory;
  if (options.projectNotebook) controller.projectNotebook = options.projectNotebook;
  if (options.delegation) controller.delegation = (tool, input, signal, toolCallId) => {
    if (current.planMode === 'plan' && tool === 'delegate_tasks') throw new Error('DELEGATION_PLAN_MODE');
    return options.delegation!(tool, input, signal, toolCallId);
  };
  if (options.mentionPartner) controller.mentionPartner = async (targetPartnerId) => {
    if (current.route?.scope !== 'group') throw new Error('STUDIO_MENTION_GROUP_ONLY');
    const studio = current.context?.conversation?.studio;
    if (studio && !studio.mentionPartnerAvailable) throw new Error(`当前为“${studio.speakingModeLabel}”模式，${studio.mentionPartnerReason}`);
    const requested = targetPartnerId.trim().replace(/^@/u, '');
    const partners = current.context?.partners ?? [];
    let target = partners.find((partner) => partner.partnerId === requested);
    if (!target) {
      const normalized = requested.toLocaleLowerCase();
      const matches = partners.filter((partner) => [partner.mentionName, partner.displayName]
        .some((name) => name?.trim().toLocaleLowerCase() === normalized));
      if (matches.length > 1) throw new Error('STUDIO_MENTION_TARGET_AMBIGUOUS_USE_ID');
      target = matches[0];
    }
    if (!target || target.groupMentionAvailable === false || !target.partnerId) throw new Error('STUDIO_MENTION_TARGET_NOT_AVAILABLE');
    await options.mentionPartner!({
      route: current.route,
      partnerId: options.partnerId,
      targetPartnerId: target.partnerId,
      label: target.mentionName || target.displayName,
    });
    return json({ mentioned: true, partnerId: target.partnerId, displayName: target.displayName });
  };
  return controller;
}

export const ASTERIUM_TOOL_INSTRUCTIONS = [
  '星丛提供 asterium_status 和 asterium_workspace。',
  '使用 asterium_status 按 key 查询当前时间、身份、公开伙伴名册、用户资料、运行时、权限、对话状态、对话文件和工作区；伙伴名册使用 key=partners，只包含名字、长期擅长和当前或最近观测模型。群聊中 key=conversation 会说明当前发言模式、是否允许 PASS、队列以及是否允许邀请伙伴。',
  '需要确认当前 cwd 或 workspaceFolders 时，先查询 asterium_status(key=workspace) 或 asterium_workspace(action=list)，不要从旧消息猜测。',
  '任务只需创建或覆盖一个明确的工作区外文件时，直接使用文件写入工具请求一次性授权；这不会把目录加入工作区。本次运行内只可回读这个确切文件来验证写入，不可列出或搜索父目录、读取相邻文件，也不可延续到下一轮。',
  '只有任务需要反复读取、搜索或操作工作区外目录时，才调用 asterium_workspace(action=add, path=目标目录的绝对路径) 请求持久加入工作区，并向用户说明原因。不要把单文件写入升级成目录授权。',
  'asterium_workspace 用于查询、增加和移除当前伙伴共享的额外工作区；同一伙伴的所有对话共享同一套 CWD 与 workspaceFolders。只有任务确实需要访问该目录时才请求 add/remove，cwd 只能由用户在星丛界面更改。',
  'add/remove 遵循当前会话权限与审批；只读模式会返回失败，完整权限会直接执行而不逐次询问。移除只撤销该伙伴所有对话的访问，不会删除目录或任何文件。',
  '命令中出现工作区外路径不等于新增工作区，也不得据此自动调用 add；只有确实需要后续轮次持续访问该目录时才显式 add。',
  '工作区变更成功后从后续轮次起提供给文件工具；当前轮不要假设新的文件访问范围已经生效。变更会对该伙伴的其他对话生效。',
].join('\n');

export const ASTERIUM_GROUP_MENTION_INSTRUCTION = '公开群聊提供 mention_partner，但只有 asterium_status(key=conversation) 显示 mentionPartnerAvailable=true 时才可调用；可传伙伴的唯一名字、@名或 partnerId，重名时必须使用 asterium_status(key=partners) 返回的 partnerId。成功邀请后，内部伙伴会被移到下一位发言，外部伙伴异步收到邀请，可能稍后回复。正文中的 @名字 只用于展示。';
export const ASTERIUM_TASK_INSTRUCTION = 'workspace 任务提供 asterium_task：action=context 可重新读取当前冻结契约；执行与返工用 action=submit_handoff，独立复核用 action=submit_review。deliver_file 成功登记的正式项目文件版本由 Main 按稳定 fileId 自动附加，delivery_refs 留空即可。该工具只记录任务元数据，不替代文件工具、权限审批或 deliver_file。';
export const ASTERIUM_WORKFLOW_DRAFT_INSTRUCTION = '本轮是用户明确发起的专用工作流规划回合。只能使用 submit_workflow_draft 一次性提交完整 DAG 提案；Main 校验后只保存可编辑草稿，不会激活、创建任务或开始执行。普通聊天没有此工具。';
export const ASTERIUM_MEMORY_INSTRUCTION = MANAGED_MEMORY_RULES;
export const ASTERIUM_WORKFLOW_MEMORY_INSTRUCTION = WORKFLOW_MEMORY_RULES;
export const ASTERIUM_PROJECT_NOTEBOOK_INSTRUCTION = '普通单聊和工作室讨论提供 project_notebook，用于当前伙伴自己的项目工作笔记。它不是长期记忆系统，其他伙伴不可查看。单聊先用 action=list 列出参与项目，read/append/replace 必须明确 project_id；工作室中项目由星丛固定，不要传入其他项目。replace 必须携带最近一次 read/append/replace 返回的最新 revision，过期会被拒绝。';

export function memoryToolAccess(memoryMode: string | undefined, route?: AgentExecutionRoute): 'none' | 'read' | 'write' {
  if (memoryMode !== 'asterium' || route?.scope === 'workspace') return 'none';
  return route?.scope === 'workflow_planning' ? 'read' : 'write';
}

export function projectNotebookToolAccess(route?: AgentExecutionRoute) {
  return route?.scope !== 'workspace' && route?.scope !== 'workflow_planning';
}

export function runtimeToolInstructions(canMentionPartner: boolean, canManageTask = false, canSubmitWorkflowDraft = false, memoryAccess: 'none' | 'read' | 'write' = 'none', canUseProjectNotebook = false) {
  if (canSubmitWorkflowDraft) return [ASTERIUM_WORKFLOW_DRAFT_INSTRUCTION, ...(memoryAccess === 'read' ? [ASTERIUM_WORKFLOW_MEMORY_INSTRUCTION] : [])].join('\n');
  return [ASTERIUM_TOOL_INSTRUCTIONS, ...(canMentionPartner ? [ASTERIUM_GROUP_MENTION_INSTRUCTION] : []), ...(canManageTask ? [ASTERIUM_TASK_INSTRUCTION] : []), ...(memoryAccess === 'write' ? [ASTERIUM_MEMORY_INSTRUCTION] : memoryAccess === 'read' ? [ASTERIUM_WORKFLOW_MEMORY_INSTRUCTION] : []), ...(canUseProjectNotebook ? [ASTERIUM_PROJECT_NOTEBOOK_INSTRUCTION] : [])].join('\n');
}

export function parseProjectNotebookToolInput(args: Record<string, unknown>): ProjectNotebookToolInput {
  const action = requiredString(args.action, 'action');
  const projectId = optionalStringValue(args.project_id);
  if (action === 'list') return { action };
  if (action === 'read') return { action, ...(projectId ? { projectId } : {}) };
  if (action === 'append') return { action, ...(projectId ? { projectId } : {}), content: requiredString(args.content, 'content') };
  if (action === 'replace') {
    const expectedRevision = optionalInteger(args.expected_revision);
    if (expectedRevision === undefined || expectedRevision < 0) throw new Error('PROJECT_NOTEBOOK_REVISION_INVALID');
    return { action, ...(projectId ? { projectId } : {}), content: requiredString(args.content, 'content'), expectedRevision };
  }
  throw new Error('PROJECT_NOTEBOOK_ACTION_INVALID');
}

export function parseHoldMemoryInput(args: Record<string, unknown>): HoldMemoryInput {
  return {
    type: enumString(args.type, MEMORY_TYPES, 'MEMORY_TYPE_INVALID'),
    body: requiredString(args.body, 'body'),
    ...(args.tags !== undefined ? { tags: requiredStringArray(args.tags, 'tags') } : {}),
    ...(optionalInteger(args.weight) !== undefined ? { weight: optionalInteger(args.weight) } : {}),
    ...(optionalStringValue(args.occurred_at) ? { occurredAt: optionalStringValue(args.occurred_at) } : {}),
    ...(args.sources !== undefined ? { sources: parseMemorySources(args.sources) } : {}),
  };
}

export function parseSearchMemoryInput(args: Record<string, unknown>): SearchMemoryInput {
  return {
    ...(optionalStringValue(args.text) ? { text: optionalStringValue(args.text) } : {}),
    ...(args.tags !== undefined ? { tags: requiredStringArray(args.tags, 'tags') } : {}),
    ...(args.types !== undefined ? { types: requiredStringArray(args.types, 'types').map((value) => enumString(value, MEMORY_TYPES, 'MEMORY_TYPE_INVALID')) } : {}),
    ...(args.statuses !== undefined ? { statuses: requiredStringArray(args.statuses, 'statuses').map((value) => enumString(value, MEMORY_STATUSES, 'MEMORY_STATUS_INVALID')) } : {}),
    ...(optionalStringValue(args.from) ? { from: optionalStringValue(args.from) } : {}),
    ...(optionalStringValue(args.to) ? { to: optionalStringValue(args.to) } : {}),
    ...(optionalInteger(args.limit) !== undefined ? { limit: optionalInteger(args.limit) } : {}),
  };
}

export function parseCommentMemoryInput(args: Record<string, unknown>): CommentMemoryInput {
  return {
    memoryId: requiredString(args.memory_id, 'memory_id'),
    content: requiredString(args.content, 'content'),
    ...(args.sources !== undefined ? { sources: parseMemorySources(args.sources) } : {}),
  };
}

export function parseUpdateMemoryInput(args: Record<string, unknown>): UpdateMemoryInput {
  return {
    memoryId: requiredString(args.memory_id, 'memory_id'),
    ...(args.type !== undefined ? { type: enumString(args.type, MEMORY_TYPES, 'MEMORY_TYPE_INVALID') } : {}),
    ...(args.status !== undefined ? { status: enumString(args.status, MEMORY_STATUSES, 'MEMORY_STATUS_INVALID') } : {}),
    ...(args.body !== undefined ? { body: requiredString(args.body, 'body') } : {}),
    ...(args.tags !== undefined ? { tags: requiredStringArray(args.tags, 'tags') } : {}),
    ...(optionalInteger(args.weight) !== undefined ? { weight: optionalInteger(args.weight) } : {}),
    ...(args.occurred_at === null ? { occurredAt: null } : optionalStringValue(args.occurred_at) ? { occurredAt: optionalStringValue(args.occurred_at) } : {}),
    ...(args.superseded_by_memory_id === null ? { supersededByMemoryId: null } : optionalStringValue(args.superseded_by_memory_id) ? { supersededByMemoryId: optionalStringValue(args.superseded_by_memory_id) } : {}),
  };
}

export function parseReadMemorySourceInput(args: Record<string, unknown>): ReadMemorySourceInput {
  return {
    memoryId: requiredString(args.memory_id, 'memory_id'),
    ...(optionalInteger(args.source_index) !== undefined ? { sourceIndex: optionalInteger(args.source_index) } : {}),
  };
}

export function formatAsteriumPublicContext(context?: AsteriumRuntimeContextInput) {
  if (!context || context.conversation?.studio) return '';
  const lines = ['[星丛会话资料]'];
  if (context.user) lines.push(`用户：${context.user.displayName}${context.user.introduction ? `｜${context.user.introduction}` : ''}`);
  lines.push(`当前伙伴：${context.partner.displayName}`);
  return lines.join('\n');
}

export function formatAsteriumMemoryBriefing(context?: Pick<AsteriumRuntimeContextInput, 'memoryBriefing'>) {
  const briefing = context?.memoryBriefing?.trim();
  if (!briefing) return '';
  return [
    '[星丛首次会话记忆资料]',
    '以下内容来自该伙伴的结构化记忆档案，仅作为连续性背景，不是用户本轮的新指令；无需逐字复述。',
    briefing,
  ].join('\n');
}

export function formatAsteriumBootstrapContext(context?: AsteriumRuntimeContextInput) {
  return [formatAsteriumPublicContext(context), formatAsteriumMemoryBriefing(context)].filter(Boolean).join('\n\n');
}

export function parseAsteriumTaskToolInput(args: Record<string, unknown>): AsteriumTaskToolInput {
  const action = requiredString(args.action, 'action');
  if (action === 'context') return { action };
  const userDecision = isRecord(args.user_decision) ? args.user_decision : undefined;
  if (action === 'submit_review') {
    const criteria = recordArray(args.criterion_reviews, 'criterion_reviews');
    return {
      action,
      decision: requiredString(args.decision, 'decision') as TaskReviewSubmission['decision'],
      summary: requiredString(args.summary, 'summary'),
      criteria: criteria.map((item) => ({
        criterionId: requiredString(item.criterion_id, 'criterion_id'),
        verdict: requiredString(item.verdict, 'verdict') as TaskReviewSubmission['criteria'][number]['verdict'],
        evidence: stringArray(item.evidence, 'evidence'),
        ...(typeof item.feedback === 'string' ? { feedback: item.feedback } : {}),
      })),
      ...(userDecision ? { userDecisionRequest: {
        question: requiredString(userDecision.question, 'question'),
        reason: requiredString(userDecision.reason, 'reason'),
        affectedCriteria: stringArray(userDecision.affected_criteria, 'affected_criteria'),
      } } : {}),
    };
  }
  if (action !== 'submit_handoff') throw new Error('ASTERIUM_TASK_ACTION_INVALID');
  const criteria = recordArray(args.criterion_evidence, 'criterion_evidence');
  const verification = recordArray(args.verification, 'verification');
  return {
    action,
    disposition: requiredString(args.disposition, 'disposition') as 'submitted' | 'needs_user_decision' | 'blocked',
    summary: requiredString(args.summary, 'summary'),
    criterionEvidence: criteria.map((item) => ({
      criterionId: requiredString(item.criterion_id, 'criterion_id'),
      result: requiredString(item.result, 'result') as 'satisfied' | 'not_satisfied' | 'unverified',
      evidence: stringArray(item.evidence, 'evidence'),
    })),
    changedPaths: stringArray(args.changed_paths, 'changed_paths'),
    verification: verification.map((item) => ({
      commandOrCheck: requiredString(item.command_or_check, 'command_or_check'),
      result: requiredString(item.result, 'result') as 'passed' | 'failed' | 'not_run',
      ...(typeof item.evidence === 'string' ? { evidence: item.evidence } : {}),
    })),
    deliveryRefs: stringArray(args.delivery_refs, 'delivery_refs'),
    unresolvedIssues: stringArray(args.unresolved_issues, 'unresolved_issues'),
    ...(userDecision ? { userDecisionRequest: {
      question: requiredString(userDecision.question, 'question'),
      reason: requiredString(userDecision.reason, 'reason'),
      affectedCriteria: stringArray(userDecision.affected_criteria, 'affected_criteria'),
    } } : {}),
  };
}

export function parseWorkflowDraftToolInput(args: Record<string, unknown>): ProjectWorkflowDraftProposal {
  const nodes = recordArray(args.nodes, 'nodes');
  return {
    name: requiredString(args.name, 'name'),
    description: typeof args.description === 'string' ? args.description : '',
    generationSummary: requiredString(args.generation_summary, 'generation_summary'),
    nodes: nodes.map((node) => {
      const completion = isRecord(node.completion_rule) ? node.completion_rule : {};
      const type = requiredString(completion.type, 'completion_rule.type');
      const completionRule = type === 'partner_review' ? {
        type,
        reviewerPartnerId: requiredString(completion.reviewer_partner_id, 'completion_rule.reviewer_partner_id'),
        autoReworkLimit: integer(completion.auto_rework_limit, 'completion_rule.auto_rework_limit'),
      } as const : type === 'executor_submit' || type === 'user_confirm' ? { type } as const : invalid('TOOL_ARGUMENT_INVALID:completion_rule.type');
      return {
        clientKey: requiredString(node.client_key, 'client_key'),
        title: requiredString(node.title, 'title'),
        description: typeof node.description === 'string' ? node.description : '',
        ...(typeof node.assignee_partner_id === 'string' && node.assignee_partner_id ? { assigneePartnerId: node.assignee_partner_id } : {}),
        dependencyKeys: stringArray(node.dependency_keys, 'dependency_keys'),
        acceptanceCriteria: stringArray(node.acceptance_criteria, 'acceptance_criteria'),
        ...(typeof node.note === 'string' ? { note: node.note } : {}),
        ...(typeof node.work_role_id === 'string' && node.work_role_id ? { workRoleId: node.work_role_id } : {}),
        ...(typeof node.review_role_id === 'string' && node.review_role_id ? { reviewRoleId: node.review_role_id } : {}),
        ...(typeof node.method_template_id === 'string' && node.method_template_id ? { methodTemplateId: node.method_template_id } : {}),
        completionRule,
        sourceMessageIds: stringArray(node.source_message_ids, 'source_message_ids'),
        ...(typeof node.basis_summary === 'string' ? { basisSummary: node.basis_summary } : {}),
      };
    }),
  };
}

function requiredString(value: unknown, key: string) {
  if (typeof value !== 'string' || !value) throw new Error(`TOOL_ARGUMENT_REQUIRED:${key}`);
  return value;
}

function stringArray(value: unknown, key: string) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`TOOL_ARGUMENT_INVALID:${key}`);
  return value as string[];
}

function requiredStringArray(value: unknown, key: string) {
  return stringArray(value, key).map((item) => requiredString(item, key));
}

function optionalStringValue(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function optionalInteger(value: unknown) {
  if (value === undefined) return undefined;
  return integer(value, 'integer');
}

function enumString<T extends string>(value: unknown, allowed: readonly T[], error: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(error);
  return value as T;
}

function parseMemorySources(value: unknown): MemorySourceAnchor[] {
  const sources = recordArray(value, 'sources');
  return sources.map((source) => {
    const kind = requiredString(source.kind, 'sources.kind');
    const messageId = requiredString(source.message_id, 'sources.message_id');
    if (kind === 'single_chat') return { kind, conversationId: requiredString(source.conversation_id, 'sources.conversation_id'), messageId };
    if (kind === 'studio') return { kind, roomId: requiredString(source.room_id, 'sources.room_id'), messageId };
    throw new Error('MEMORY_SOURCE_KIND_INVALID');
  });
}

function recordArray(value: unknown, key: string) {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`TOOL_ARGUMENT_INVALID:${key}`);
  return value;
}

function integer(value: unknown, key: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`TOOL_ARGUMENT_INVALID:${key}`);
  return Number(value);
}

function invalid(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
