export type ProjectStatus = 'active' | 'paused' | 'complete';

export type ProjectTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'review' | 'completed' | 'cancelled';

export interface ProjectTaskWorkRole {
  roleId?: string;
  roleRevision?: number;
  name: string;
  description?: string;
  responsibilities: string[];
  prompt?: string;
  scope: 'builtin' | 'global' | 'project' | 'inline';
}

export type ProjectTaskCompletionRule =
  | { type: 'executor_submit' }
  | { type: 'partner_review'; reviewerPartnerId: string; autoReworkLimit: number }
  | { type: 'user_confirm' };

export interface ProjectTaskMethodTemplate {
  templateId: string;
  name: string;
  version: string;
  instructions: string;
  sourceAttribution?: string;
}

/**
 * Optional until the workflow editor and role/template libraries are added.
 * Missing values deliberately mean a neutral task role, executor submission,
 * and no method template; they never imply MouseCrew or an automatic review.
 */
export interface ProjectTaskExecutionConfig {
  workRole?: ProjectTaskWorkRole;
  reviewWorkRole?: ProjectTaskWorkRole;
  completionRule?: ProjectTaskCompletionRule;
  methodTemplate?: ProjectTaskMethodTemplate;
}

export interface ProjectTask {
  version: 1;
  id: string;
  projectId: string;
  code: string;
  title: string;
  description: string;
  assigneeId?: string;
  status: ProjectTaskStatus;
  dependencyIds: string[];
  acceptanceCriteria: string[];
  note: string;
  execution?: ProjectTaskExecutionConfig;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  version: 1;
  id: string;
  name: string;
  avatarDataUrl?: string;
  description: string;
  status: ProjectStatus;
  progress: number;
  tags: string[];
  memberIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDomainSnapshot {
  version: 1;
  projects: ProjectRecord[];
  tasks: ProjectTask[];
}

export interface ProjectDomainMigrationTask {
  id: string;
  code?: string;
  title: string;
  description?: string;
  ownerId?: string;
  assigneeId?: string;
  status?: string;
  dependencyIds?: string[];
  acceptanceCriteria?: string[];
  note?: string;
  execution?: ProjectTaskExecutionConfig;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectDomainMigrationProject {
  id: string;
  name: string;
  avatarDataUrl?: string;
  description?: string;
  status?: string;
  progress?: number;
  tags?: string[];
  memberIds?: string[];
  tasks?: ProjectDomainMigrationTask[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectDomainInitializeRequest {
  legacyProjects: ProjectDomainMigrationProject[];
}

export interface ProjectCreateRequest {
  projectId: string;
  name: string;
  description?: string;
  avatarDataUrl?: string;
  tags?: string[];
  memberIds?: string[];
  locationSelectionId?: string;
}

export interface ProjectCreateResult {
  project: ProjectRecord;
  workspace: import('./projectWorkspace').ProjectWorkspaceSnapshot;
}

export interface ProjectUpdateRequest {
  projectId: string;
  expectedRevision: number;
  name: string;
  description: string;
  avatarDataUrl?: string;
  status: ProjectStatus;
  progress: number;
  tags: string[];
}

export interface ProjectTaskCreateRequest {
  projectId: string;
  title: string;
  code?: string;
  description?: string;
  assigneeId?: string;
  status?: ProjectTaskStatus;
  dependencyIds?: string[];
  acceptanceCriteria?: string[];
  note?: string;
  execution?: ProjectTaskExecutionConfig;
}

export interface ProjectTaskUpdateRequest extends Omit<ProjectTaskCreateRequest, 'projectId'> {
  projectId: string;
  taskId: string;
  expectedRevision: number;
  status: ProjectTaskStatus;
}

export interface ProjectTaskRemoveRequest {
  projectId: string;
  taskId: string;
  expectedRevision: number;
}

export type ProjectDomainChange =
  | { type: 'snapshot'; snapshot: ProjectDomainSnapshot }
  | { type: 'project_removed'; projectId: string };

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return value === 'active' || value === 'paused' || value === 'complete';
}

export function isProjectTaskStatus(value: unknown): value is ProjectTaskStatus {
  return value === 'todo' || value === 'in_progress' || value === 'blocked'
    || value === 'review' || value === 'completed' || value === 'cancelled';
}
