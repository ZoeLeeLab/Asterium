import { extensionUpsertSchema, type ApiExtensionSummary, type ExtensionUpsertRequest } from '../../../shared/apiExtensions';

export interface McpDraft {
  id?: string; expectedVersion: number; name: string; enabled: boolean;
  transport: 'mcp_stdio' | 'mcp_http'; command: string; args: string; cwd: string; url: string;
  workspaceGrantId?: string;
  secretMode: 'keep' | 'replace' | 'clear'; secrets: { name: string; value: string }[];
}
export function mcpDraft(version: number, entry?: ApiExtensionSummary): McpDraft {
  const configuration = entry?.configuration;
  return { id: entry?.id, expectedVersion: version, name: entry?.name ?? '', enabled: entry?.enabled ?? true,
    transport: configuration?.type === 'mcp_http' ? 'mcp_http' : 'mcp_stdio',
    command: configuration?.type === 'mcp_stdio' ? configuration.command : '',
    args: configuration?.type === 'mcp_stdio' ? JSON.stringify(configuration.args, null, 2) : '[]',
    cwd: configuration?.type === 'mcp_stdio' ? configuration.cwd ?? '' : '',
    workspaceGrantId: configuration?.type === 'mcp_stdio' ? configuration.workspaceGrantId : undefined,
    url: configuration?.type === 'mcp_http' ? configuration.url : '', secretMode: 'keep', secrets: [] };
}
export function mcpRequest(draft: McpDraft): ExtensionUpsertRequest {
  let args: unknown;
  try { args = draft.transport === 'mcp_stdio' ? JSON.parse(draft.args) : []; } catch { throw new Error('MCP_FORM_ARGS'); }
  if (draft.secretMode === 'replace' && (!draft.secrets.length || draft.secrets.some((secret) => !secret.name.trim() || !secret.value))) throw new Error('MCP_FORM_SECRETS');
  const names = draft.secrets.map((secret) => draft.transport === 'mcp_http' ? secret.name.trim().toLowerCase() : secret.name.trim());
  if (new Set(names).size !== names.length) throw new Error('MCP_FORM_SECRETS');
  const result = extensionUpsertSchema.safeParse({ expectedVersion: draft.expectedVersion, ...(draft.id ? { id: draft.id } : {}), name: draft.name, enabled: draft.enabled,
    configuration: draft.transport === 'mcp_http' ? { type: 'mcp_http', url: draft.url.trim() }
      : { type: 'mcp_stdio', command: draft.command.trim(), args, ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}), ...(draft.workspaceGrantId ? { workspaceGrantId: draft.workspaceGrantId } : {}) },
    ...(draft.secretMode === 'clear' ? { secrets: null } : draft.secretMode === 'replace' ? { secrets: Object.fromEntries(draft.secrets.map((secret) => [secret.name.trim(), secret.value])) } : {}),
  });
  if (!result.success) throw new Error('MCP_FORM_INVALID');
  return result.data;
}
export function mcpSettingsError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code.includes('PROFILE_DATA_ACCESS_DENIED')) return '不能将星丛内部数据目录授权给 MCP，请选择独立的工作区。';
  if (code.includes('MCP_AUTHORIZED_WORKSPACE') || code.includes('MCP_CWD_OUTSIDE_AUTHORIZED_WORKSPACE')) return '请先编辑此 MCP，选择并授权它的工作区；工作目录必须位于该授权目录内。未启动服务。';
  if (code.includes('SANDBOX_ELEVATED_HOST_REFUSED') || code.includes('SANDBOX_HOST_IDENTITY_REFUSED')) return '当前星丛运行身份不支持沙箱。请使用普通权限的 Windows 账户运行；本次未切换到 Native。';
  if (code.includes('SANDBOX_LAUNCHER_NOT_SUPPORTED')) return '此沙箱暂不支持该启动器，请使用已安装解释器或程序的 exe 路径。本次未启动替代程序。';
  if (code.includes('SANDBOX_')) return '沙箱连接未能完成，请检查运行环境和已授权工作区。本次未切换到 Native，也未重放操作。';
  if (code.includes('API_EXTENSIONS_VERSION_CONFLICT') || code.includes('MCP_STALE_CONFIGURATION')) return '配置或信任状态刚刚发生变化，已刷新列表。请核对当前状态后重新操作；编辑内容已保留。';
  if (code.includes('MCP_FORM_ARGS')) return '启动参数必须是 JSON 字符串数组，例如 ["server.mjs", "--flag"]。';
  if (code.includes('MCP_FORM_SECRETS')) return '请完整填写凭据名称和值，名称不能重复；不需要凭据时请选择保留或清除。';
  if (code.includes('MCP_FORM_INVALID')) return '请检查必填项、参数数组、绝对工作目录及 HTTP 地址；HTTP 请求头不能重复或使用 MCP 会话/协议头。';
  if (code.includes('API_EXTENSION_PARTNER_INELIGIBLE')) return '该伙伴当前不可用，无法更新绑定。请先检查 API 伙伴的连接设置。';
  if (code.includes('MCP_CONNECTION_TIMEOUT')) return '连接或工具发现超时，请检查服务后手动重试。';
  if (code.includes('MCP_CLOSE_FAILED')) return '连接资源未能完整释放。请检查服务进程，暂不重复启动该连接。';
  if (code.includes('MCP_')) return 'MCP 操作未完成，请检查服务程序、地址、认证和启用状态后重试。';
  return '暂时无法完成 MCP 操作，请刷新并检查配置后重试。';
}
