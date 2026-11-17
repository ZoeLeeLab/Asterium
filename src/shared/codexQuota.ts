export interface CodexQuotaRequest {
  partnerId: string;
  importedConversationId?: string;
}

export interface CodexQuotaWindow {
  usedPercent: number;
  durationMinutes?: number;
  resetsAt?: number;
}

export type CodexQuotaResult =
  | { status: 'available'; windows: CodexQuotaWindow[]; checkedAt: number }
  | { status: 'login_required' | 'chatgpt_required' | 'runtime_unavailable' | 'unavailable' };
