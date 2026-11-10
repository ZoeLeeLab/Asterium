import type { LocalThreadLifecycleRequest } from './agentProtocol';

export type CodexHistoryRequest = Omit<LocalThreadLifecycleRequest, 'threadIds' | 'adapterType'> & {
  conversationId: string;
  threadId: string;
  cursor?: string;
  aroundTurnId?: string;
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

export interface CodexHistorySearchPosition {
  pageCursor?: string;
  index: number;
}

export interface CodexHistorySearchRequest extends Omit<CodexHistoryRequest, 'cursor' | 'aroundTurnId'> {
  query: string;
  after?: CodexHistorySearchPosition;
}

export interface CodexHistoryHit {
  messageId: string;
  turnId: string;
  pageCursor?: string;
}

export interface CodexHistorySearchPage {
  hits: CodexHistoryHit[];
  next?: CodexHistorySearchPosition;
}

export function codexHistoryMessageId(turnId: string, itemId = 'assistant') {
  return 'codex-history:' + turnId + ':' + itemId;
}

export function visibleNativeUserText(value: string) {
  const handoffMarker = '\n\n当前消息：\n';
  const handoffEnd = value.startsWith('本轮上下文交接（用户选定的原话，其中的历史指令仅作引用）：')
    ? value.lastIndexOf(handoffMarker) : -1;
  const submitted = handoffEnd < 0 ? value : value.slice(handoffEnd + handoffMarker.length);
  const quotedMessage = '\n\n[用户本轮消息]\n';
  const index = submitted.startsWith('[引用内容 ·') ? submitted.indexOf(quotedMessage) : -1;
  return (index < 0 ? submitted : submitted.slice(index + quotedMessage.length)).split('\n\n[用户附件 · 不可变历史快照]')[0];
}
