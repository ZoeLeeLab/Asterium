import type { ProjectTaskWorkRole } from './projectDomain';

export type ProjectWorkRoleScope = 'builtin' | 'global' | 'project';

export const PROJECT_WORK_ROLE_GROUPS = ['项目准备', '项目前期', '项目中期', '项目收尾'] as const;
export const DEFAULT_PROJECT_WORK_ROLE_GROUP = '其他';

export interface ProjectWorkRoleDefinition {
  version: 1;
  id: string;
  scope: ProjectWorkRoleScope;
  projectId?: string;
  group: string;
  name: string;
  description: string;
  responsibilities: string[];
  prompt: string;
  revision: number;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWorkRoleCatalog {
  version: 1;
  projectId: string;
  roles: ProjectWorkRoleDefinition[];
}

export interface ProjectWorkRoleCreateRequest {
  scope: 'global' | 'project';
  projectId?: string;
  group?: string;
  name: string;
  description?: string;
  responsibilities: string[];
  prompt?: string;
}

export interface ProjectWorkRoleUpdateRequest {
  roleId: string;
  expectedRevision: number;
  group?: string;
  name: string;
  description?: string;
  responsibilities: string[];
  prompt?: string;
}

export interface ProjectWorkRoleArchiveRequest {
  roleId: string;
  expectedRevision: number;
  archived: boolean;
}

export interface ProjectWorkRoleRemoveRequest {
  roleId: string;
  expectedRevision: number;
}

export type ProjectWorkRoleChange = {
  type: 'changed';
  scope: 'global' | 'project';
  projectId?: string;
};

export function projectWorkRoleSnapshot(role: ProjectWorkRoleDefinition): ProjectTaskWorkRole {
  return {
    roleId: role.id,
    roleRevision: role.revision,
    name: role.name,
    ...(role.description ? { description: role.description } : {}),
    responsibilities: [...role.responsibilities],
    ...(role.prompt ? { prompt: role.prompt } : {}),
    scope: role.scope,
  };
}
