export type MemorySourceNavigationTarget =
  | { kind: 'single_chat'; conversationId: string; messageId: string }
  | { kind: 'studio'; roomId: string; projectId: string; messageId: string };

export interface MemorySourceNavigationState {
  from?: string;
  memorySourceTarget?: MemorySourceNavigationTarget;
}
