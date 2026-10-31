import type { ConnectionSource } from './agentProtocol';

export interface SessionCompactRequest {
  commandId: string;
  partnerId: string;
  conversationId: string;
  sessionId: string;
  source: ConnectionSource;
}
export interface SessionCompactResult {
  status: 'compacted' | 'unchanged';
  message: string;
}
export function assertSessionCompactRequest(value: unknown): asserts value is SessionCompactRequest {
  if (!value || typeof value !== 'object') throw new Error('INVALID_COMPACT_REQUEST');
  const item = value as Record<string, unknown>;
  if (!['local_cli', 'api_partner'].includes(String(item.source))
    || ['commandId', 'partnerId', 'conversationId', 'sessionId'].some((key) => typeof item[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/.test(item[key] as string))
    || Object.keys(item).some((key) => !['commandId', 'partnerId', 'conversationId', 'sessionId', 'source'].includes(key))) throw new Error('INVALID_COMPACT_REQUEST');
}
