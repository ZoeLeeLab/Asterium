export type ProjectPermissionMode = 'read_only' | 'manual' | 'full';

export interface ProjectExecutionPolicy {
  version: 1;
  projectId: string;
  permissionMode: ProjectPermissionMode;
  updatedAt: string;
}

export interface ProjectExecutionPolicyUpdateRequest {
  projectId: string;
  permissionMode: ProjectPermissionMode;
}

export function isProjectPermissionMode(value: unknown): value is ProjectPermissionMode {
  return value === 'read_only' || value === 'manual' || value === 'full';
}
