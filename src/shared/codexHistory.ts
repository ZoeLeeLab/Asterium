import type { LocalThreadLifecycleRequest } from './agentProtocol';

export type CodexHistoryRequest = Omit<LocalThreadLifecycleRequest, 'threadIds' | 'adapterType'> & {
  conversationId: string;
  threadId: string;
  cursor?: string;
};

export type CodexHistoryItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'tool'; label: string; state: 'success' | 'failure' | 'running' };

export interface CodexHistoryTurn {
  id: string;
  state: 'completed' | 'failed' | 'interrupted' | 'inProgress';
  startedAt?: string;
  items: CodexHistoryItem[];
}

export interface CodexHistoryPage {
  turns: CodexHistoryTurn[];
  nextCursor?: string;
}
