export type ProjectNotebookState = 'active' | 'inactive' | 'archived';

export interface ProjectNotebook {
  partnerId: string;
  projectId: string;
  projectName: string;
  content: string;
  state: ProjectNotebookState;
  revision: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ProjectNotebookAppendInput {
  projectId: string;
  projectName: string;
  content: string;
}

export interface ProjectNotebookReplaceInput {
  projectId: string;
  projectName: string;
  content: string;
  expectedRevision: number;
}

export interface ProjectNotebookListOptions {
  includeInactive?: boolean;
  includeArchived?: boolean;
}

export interface ProjectNotebookTarget {
  partnerId: string;
  projectId: string;
}

export interface ProjectNotebookUserReplaceRequest extends ProjectNotebookTarget {
  content: string;
  expectedRevision: number;
}
