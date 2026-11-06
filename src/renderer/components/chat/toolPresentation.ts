import type { TurnOperationCategory } from '../../types/domain';

export type ToolPresentationMode = 'hidden' | 'standalone_card' | 'semantic' | 'approval';

export type ToolSemantic =
  | 'generic'
  | 'file_read'
  | 'file_write'
  | 'directory_list'
  | 'local_search'
  | 'delete'
  | 'command'
  | 'web'
  | 'computer'
  | 'image_generation'
  | 'collaboration'
  | 'delegate_dispatch'
  | 'delegate_wait'
  | 'extension'
  | 'message_send'
  | 'reminder_create'
  | 'notebook'
  | 'task_contract'
  | 'automation'
  | 'mcp_install'
  | 'skill_run'
  | 'workspace';

export interface ToolPresentation {
  mode: ToolPresentationMode;
  category: TurnOperationCategory;
  semantic: ToolSemantic;
  preserveInputDetail?: boolean;
}

const semantic = (
  category: TurnOperationCategory,
  meaning: ToolSemantic,
  preserveInputDetail = false,
): ToolPresentation => ({ mode: 'semantic', category, semantic: meaning, preserveInputDetail });

const hidden = (category: TurnOperationCategory = 'tool'): ToolPresentation => ({ mode: 'hidden', category, semantic: 'generic' });

// Shared by direct API/Codex calls and the Claude/MCP wrappers.
const ASTERIUM_PRESENTATIONS: Record<string, ToolPresentation> = {
  list_delegate_partners: hidden(),
  delegate_tasks: semantic('tool', 'delegate_dispatch'),
  wait_delegate_tasks: semantic('tool', 'delegate_wait'),
  project_notebook: semantic('tool', 'notebook', true),
  asterium_task: semantic('tool', 'task_contract', true),
  asterium_automation: semantic('tool', 'automation', true),
  submit_workflow_draft: hidden(),
  hold_memory: hidden(),
  search_memory: hidden(),
  comment_memory: hidden(),
  update_memory: hidden(),
  read_memory_source: hidden(),
  asterium_mcp_list: hidden(),
  asterium_mcp_install: semantic('tool', 'mcp_install'),
  skill_read: hidden(),
  skill_run: semantic('tool', 'skill_run'),
};

const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  ...ASTERIUM_PRESENTATIONS,
  // 星丛内置能力
  asterium_status: hidden(),
  asterium_workspace: { mode: 'approval', category: 'tool', semantic: 'workspace', preserveInputDetail: true },
  deliver_file: { mode: 'standalone_card', category: 'tool', semantic: 'generic' },
  request_user_input: hidden(),
  mention_partner: hidden(),
  read_attachment_text: semantic('file_read', 'file_read'),
  list_directory: semantic('file_read', 'directory_list', true),
  search_files: semantic('file_read', 'local_search', true),
  read_file: semantic('file_read', 'file_read'),
  write_file: semantic('file_write', 'file_write'),
  edit_file: semantic('file_write', 'file_write'),
  delete_path: semantic('tool', 'delete', true),
  run_command: semantic('command', 'command'),
  web_search: semantic('web', 'web'),
  web_fetch: semantic('web', 'web'),

  // Claude Code 原生能力
  read: semantic('file_read', 'file_read'),
  glob: semantic('file_read', 'file_read'),
  grep: semantic('file_read', 'local_search'),
  write: semantic('file_write', 'file_write'),
  edit: semantic('file_write', 'file_write'),
  multiedit: semantic('file_write', 'file_write'),
  notebookedit: semantic('file_write', 'file_write'),
  bash: semantic('command', 'command'),
  websearch: semantic('web', 'web'),
  webfetch: semantic('web', 'web'),
  computer: semantic('computer', 'computer'),
  task: semantic('tool', 'collaboration'),
  skill: semantic('tool', 'extension'),
  askuserquestion: hidden(),
  enterplanmode: hidden(),
  exitplanmode: hidden(),
  todowrite: hidden(),

  // Codex App Server 原生能力
  commandexecution: semantic('command', 'command'),
  filechange: semantic('file_write', 'file_write'),
  imageview: semantic('file_read', 'file_read'),
  imagegeneration: semantic('tool', 'image_generation'),
  contextcompaction: hidden(),
  spawn_agent: semantic('tool', 'collaboration'),
  send_input: semantic('tool', 'collaboration'),
  wait: semantic('tool', 'collaboration'),
  close_agent: semantic('tool', 'collaboration'),
  collabagent: semantic('tool', 'collaboration'),
};

const MCP_METHOD_PRESENTATIONS: Record<string, ToolPresentation> = {
  // 内部状态与记忆整理不占用普通聊天界面。
  asterium_status: hidden('mcp'),
  status: hidden('mcp'),
  get_status: hidden('mcp'),
  remember: hidden('mcp'),
  recall: hidden('mcp'),
  memory_get: hidden('mcp'),
  memory_list: hidden('mcp'),
  memory_search: hidden('mcp'),
  get_memory: hidden('mcp'),
  list_memories: hidden('mcp'),
  read_memory: hidden('mcp'),
  retrieve_memory: hidden('mcp'),
  hold_memory: hidden('mcp'),
  search_memory: hidden('mcp'),
  comment_memory: hidden('mcp'),
  update_memory: hidden('mcp'),
  read_memory_source: hidden('mcp'),

  // 星丛内置 MCP 与普通内置工具保持同一展示策略。
  deliver_file: { mode: 'standalone_card', category: 'mcp', semantic: 'generic' },
  asterium_workspace: { mode: 'approval', category: 'mcp', semantic: 'workspace', preserveInputDetail: true },
  mention_partner: hidden('mcp'),
  workspace: { mode: 'approval', category: 'mcp', semantic: 'workspace', preserveInputDetail: true },

  // 这些动作会影响用户可感知的外部世界，保留人话过程。
  web_search: semantic('mcp', 'web'),
  web_fetch: semantic('mcp', 'web'),
  search_query: semantic('mcp', 'web'),
  fetch_url: semantic('mcp', 'web'),
  open_url: semantic('mcp', 'web'),
  delete: semantic('mcp', 'delete', true),
  delete_file: semantic('mcp', 'delete', true),
  delete_path: semantic('mcp', 'delete', true),
  remove_file: semantic('mcp', 'delete', true),
  trash_file: semantic('mcp', 'delete', true),
  send_message: semantic('mcp', 'message_send'),
  send_email: semantic('mcp', 'message_send'),
  post_message: semantic('mcp', 'message_send'),
  reply_to_message: semantic('mcp', 'message_send'),
  create_reminder: semantic('mcp', 'reminder_create'),
  schedule_reminder: semantic('mcp', 'reminder_create'),
  set_reminder: semantic('mcp', 'reminder_create'),
};

const UNKNOWN_TOOL: ToolPresentation = semantic('tool', 'generic');
const UNKNOWN_MCP_TOOL: ToolPresentation = semantic('mcp', 'generic');

export function toolPresentation(toolName?: string, action?: string): ToolPresentation {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return UNKNOWN_TOOL;
  if (normalized.startsWith('mcp__')) {
    const method = normalized.split('__').filter(Boolean).at(-1) ?? '';
    const presentation = ASTERIUM_PRESENTATIONS[method] ?? MCP_METHOD_PRESENTATIONS[method] ?? UNKNOWN_MCP_TOOL;
    return method === 'asterium_automation' && action === 'report' ? hidden('mcp') : { ...presentation, category: 'mcp' };
  }
  if (normalized.startsWith('mcp_')) return UNKNOWN_MCP_TOOL; // Old persisted API events have no method metadata.
  if (normalized.startsWith('skill_read_')) return hidden();
  if (normalized.startsWith('skill_run_')) return TOOL_PRESENTATIONS.skill_run;
  if (normalized === 'asterium_automation' && action === 'report') return hidden();
  return TOOL_PRESENTATIONS[normalized] ?? UNKNOWN_TOOL;
}

function normalizeToolName(toolName?: string) {
  return (toolName ?? '').replace(/^functions\./i, '').trim().toLowerCase();
}
