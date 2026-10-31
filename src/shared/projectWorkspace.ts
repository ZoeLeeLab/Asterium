import type { PartnerWorkspaceState } from './agentProtocol';
import type { StudioRoomMetadata, StudioRoomSnapshot } from './studioRuntime';
import type { ProjectRecord } from './projectDomain';

export const PROJECT_TEMPLATE_FILES = [
  { key: 'plan', name: 'project-plan.md', label: '项目方案计划' },
  { key: 'progress', name: 'progress.md', label: '项目进度' },
  { key: 'design', name: 'design-guide.md', label: '界面风格设计' },
] as const;

export interface ProjectWorkspaceFile {
  name: string;
  label: string;
  relativePath: string;
}

export interface ProjectWorkspaceSnapshot {
  version: 1;
  projectId: string;
  name: string;
  rootPath: string;
  deliverablesPath: string;
  templateFiles: ProjectWorkspaceFile[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWorkspaceCreateRequest {
  projectId: string;
  name: string;
  description?: string;
  locationSelectionId?: string;
}

export interface ProjectLocationSelection {
  selectionId: string;
  path: string;
}

export interface ProjectDeliveryResult {
  fileId: string;
  absolutePath: string;
  relativePath: string;
  revision: number;
  contentHash: string;
  sizeBytes: number;
  savedAt: string;
  sourcePartnerId?: string;
  sourcePartnerName?: string;
}

export interface ProjectMembershipRoomChange {
  room: StudioRoomMetadata;
  announcements?: string[];
}

export interface ProjectMembershipChangeRequest {
  projectId: string;
  projectMemberIds: string[];
  rooms: ProjectMembershipRoomChange[];
}

export interface ProjectMembershipChangeResult {
  projectId: string;
  projectMemberIds: string[];
  project: ProjectRecord;
  rooms: StudioRoomSnapshot[];
  workspaceStates: PartnerWorkspaceState[];
}

export interface ProjectWorkspaceFileEntry {
  fileId: string;
  name: string;
  relativePath: string;
  revision: number;
  category: 'template' | 'delivery';
  availability: 'available' | 'missing';
  sizeBytes: number;
  modifiedAt: string;
  artifactId?: string;
  contentHash?: string;
  savedAt?: string;
  sourcePartnerId?: string;
  sourcePartnerName?: string;
}

export interface ProjectFileVersionRef {
  fileId: string;
  relativePath: string;
  revision: number;
  contentHash: string;
  sizeBytes: number;
}

export interface ProjectFileRecordSnapshot {
  version: 1;
  fileId: string;
  projectId: string;
  relativePath: string;
  category: 'template' | 'delivery';
  revision: number;
  contentHash: string;
  sizeBytes: number;
  modifiedAt: string;
  createdAt: string;
  updatedAt: string;
  removedAt?: string;
  artifactId?: string;
  sourcePartnerId?: string;
  sourcePartnerName?: string;
}

export type FileDeletionTarget =
  | { kind: 'project_file'; projectId: string; fileId: string }
  | { kind: 'artifact'; artifactId: string };

export type FileDeletionReferenceKind = 'task';

export interface FileDeletionReference {
  kind: FileDeletionReferenceKind;
  label: string;
  projectId?: string;
  taskId?: string;
  attemptId?: string;
  fileId?: string;
  relativePath?: string;
}

export interface FileDeletionInspection {
  target: FileDeletionTarget;
  name: string;
  absolutePath?: string;
  sourceState: 'available' | 'missing' | 'unavailable';
  action: 'trash_and_remove' | 'remove_record';
  requiresConfirmation: boolean;
  canDelete: boolean;
  references: FileDeletionReference[];
}

export interface FileDeletionResult {
  target: FileDeletionTarget;
  removedAt: string;
  projectSnapshots: ProjectFilesSnapshot[];
}

export interface ProjectFilesSnapshot {
  projectId: string;
  files: ProjectWorkspaceFileEntry[];
}
