export type ProjectPreviewKind = 'markdown' | 'text' | 'html' | 'pdf' | 'image' | 'word' | 'sheet' | 'slides' | 'unsupported';
export interface ProjectDirectoryEntry { path: string; name: string; directory: boolean }
export interface ProjectGitChange { path: string; oldPath?: string; status: string; group?: 'staged' | 'unstaged' | 'untracked' }
export interface ProjectGitCommit { sha: string; shortSha: string; author: string; date: string; subject: string; body: string }
export interface ProjectPreviewContent { name: string; path: string; info: { previewKind: ProjectPreviewKind }; text?: string; dataUrl?: string; diff?: string; binary?: boolean }
export type ProjectBrowseRequest = { projectId: string } & (
  | { action: 'directory'; path?: string }
  | { action: 'file'; path?: string; fileId?: string; revision?: string }
  | { action: 'status' }
  | { action: 'history'; offset?: number }
  | { action: 'changes'; revision?: string }
  | { action: 'diff'; path: string; revision?: string; group?: 'staged' | 'unstaged' | 'untracked' }
);
export interface ProjectBrowseResult {
  entries?: ProjectDirectoryEntry[];
  changes?: ProjectGitChange[];
  commits?: ProjectGitCommit[];
  more?: boolean;
  content?: ProjectPreviewContent;
  git?: 'ready' | 'unavailable' | 'empty';
  head?: string;
}
