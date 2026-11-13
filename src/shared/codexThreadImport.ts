export interface CodexThreadDirectoryRequest {
  runtimeId?: string;
  runtimeEnvironment?: import('./contracts/connections').CodexRuntimeInfo['environment'];
  codexHome?: string;
}

export interface CodexThreadDirectoryPreview {
  date: string;
  threads: CodexThreadImportPreview[];
  unavailableCount: number;
}

export interface CodexThreadImportPreview {
  selectionId: string;
  threadId: string;
  title: string;
  cwd: string;
  updatedAt?: string;
  directoryAvailable: boolean;
  currentRecord?: { date?: string };
}

export interface ImportedCodexWorkspace {
  originalCwd: string;
  directory: string;
  canonicalDirectory?: string;
  runtimeId: string;
  runtimeEnvironment: import('./contracts/connections').CodexRuntimeInfo['environment'];
  codexHome: string;
}

export type CodexThreadImportResult =
  | { kind: 'conversation'; conversation: import('../renderer/types/domain').Conversation }
  | { kind: 'bound_elsewhere'; scope: import('./agentProtocol').NativeThreadScope };

export interface CodexImportedWorkspaceStatus {
  directory: string;
  available: boolean;
}

export const CODEX_IMPORTED_DIRECTORY_UNAVAILABLE = 'CODEX_IMPORTED_DIRECTORY_UNAVAILABLE';
