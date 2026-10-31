import type { ProjectRecord, ProjectTask } from '../../../shared/projectDomain';

export interface ProjectFile {
  id: string;
  fileId?: string;
  name: string;
  meta: string;
  kind: 'document' | 'sheet' | 'image' | 'archive';
  artifactId?: string;
  contentHash?: string;
  savedAt?: string;
  relativePath?: string;
  sizeBytes?: number;
  availability?: 'available' | 'missing';
  revision?: number;
  category?: 'template' | 'delivery';
  sourcePartnerId?: string;
  sourcePartnerName?: string;
}

export interface ProjectWorkspaceInfo {
  status: 'ready' | 'unavailable';
  rootPath?: string;
  deliverablesPath?: string;
  initializedAt?: string;
}

export type TaskItem = ProjectTask;

export interface Project extends ProjectRecord {
  files: ProjectFile[];
  tasks: TaskItem[];
  workspace?: ProjectWorkspaceInfo;
}
