import type { PermissionMode, PlanMode, SendMessageCommand } from '../../shared/agentProtocol';

export interface ExecutionWorkspace {
  cwd?: string;
  workspaceFolders: readonly string[];
  workspaceVersion?: number;
  projectId?: string;
  fixedProjectBoundary?: boolean;
}

/** Main-owned metadata for the selected backend. This describes authority; it does
 * not grant access, persist grants, or imply that native enforces OS isolation.
 */
export type ExecutionContext = {
  kind: 'partner_runtime';
  partnerId: string;
  conversationId: string;
  route?: SendMessageCommand['route'];
  policy?: { permissionMode: PermissionMode; planMode: PlanMode };
  workspace?: ExecutionWorkspace;
  contextKey?: string;
  extension?: { id: string; generation: number; bindingRevision?: number; packageDigest?: string };
} | {
  kind: 'user_management';
  purpose: 'mcp_probe';
  workspace?: ExecutionWorkspace;
};
