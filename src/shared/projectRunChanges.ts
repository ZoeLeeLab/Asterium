import type { ProjectGitCommit, ProjectPreviewContent } from './projectBrowser';
export interface ProjectRunChangedFile { path: string; status: 'A' | 'M' | 'D'; before?: string; after?: string; diff?: string; unavailable?: boolean }
export interface ProjectRunVerification { command: string; result: 'passed' | 'failed'; toolCallId: string }
export interface ProjectRunChange {
  version: 1; id: string; projectId: string; attemptId?: string; taskId?: string; roomId?: string; messageId?: string;
  partnerId: string; title: string; runIds: string[]; status: 'recording' | 'completed' | 'paused' | 'cancelled' | 'failed';
  startedAt: string; finishedAt?: string; files: ProjectRunChangedFile[]; commits: ProjectGitCommit[];
  verification: ProjectRunVerification[]; complete: boolean; warnings: string[];
  observedChanges?: boolean;
  testCommandObserved?: boolean;
  reportedTests?: boolean;
}
export interface ProjectRunChangeRead { projectId: string; id: string; path: string }
export interface ProjectRunChangeContent extends ProjectPreviewContent { diff?: string }
export function runTestLabel(change: Pick<ProjectRunChange, 'verification' | 'testCommandObserved' | 'reportedTests'>) {
  const latest = [...new Map(change.verification.map((item) => [item.command, item])).values()];
  if (latest.some((item) => item.result === 'failed')) return '测试失败';
  return latest.length ? '测试通过' : change.testCommandObserved || change.reportedTests ? '测试结果未确认' : '测试未运行';
}
