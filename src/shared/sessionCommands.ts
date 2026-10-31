import type { ConnectionSource, PermissionMode, PlanMode } from './agentProtocol';

export type SessionCommandName = 'status' | 'compact' | 'reload-user' | 'reload-persona';
export interface SessionCommandTarget {
  partnerId: string;
  conversationId: string;
  source: ConnectionSource;
  sessionId?: string;
}
export interface SessionCommandRequest extends SessionCommandTarget {
  commandId: string;
  command: SessionCommandName;
}
export interface SessionStatus {
  conversationId: string;
  partnerId: string;
  source: ConnectionSource;
  sessionId?: string;
  model: string;
  modelStatus: 'recent' | 'configured' | 'unknown';
  state: 'idle' | 'running' | 'waiting_authorization' | 'waiting_user_input' | 'maintenance';
  permissionMode?: PermissionMode;
  planMode?: PlanMode;
  planStatus?: 'planning' | 'waiting_user' | 'ready' | 'executing' | 'completed';
  appliedProfiles?: { user: string; persona: string };
  profileRecoveryRequired?: boolean;
  capabilities: Record<SessionCommandName, { available: boolean; reason?: string }>;
  observedAt: string;
}
export interface SessionCommandResult {
  status: 'success' | 'info';
  message: string;
  session?: SessionStatus;
}
export function parseSessionCommand(text: string, hasAttachments = false, hasQuote = false): SessionCommandName | undefined {
  if (hasAttachments || hasQuote) return undefined;
  const match = /^\/(status|compact|reload-user|reload-persona)$/.exec(text.trim());
  return match?.[1] as SessionCommandName | undefined;
}
export function assertSessionCommandTarget(value: unknown, execute = false): asserts value is SessionCommandRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SESSION_COMMAND');
  const item = value as Record<string, unknown>;
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(v);
  if (!id(item.partnerId) || !id(item.conversationId) || (item.sessionId !== undefined && !id(item.sessionId))
    || !['api_partner', 'local_cli', 'existing_thread'].includes(String(item.source))
    || (execute && (!id(item.commandId) || !['status', 'compact', 'reload-user', 'reload-persona'].includes(String(item.command))))
    || Object.keys(item).some((key) => !['partnerId', 'conversationId', 'source', 'sessionId', ...(execute ? ['commandId', 'command'] : [])].includes(key))) throw new Error('INVALID_SESSION_COMMAND');
}
