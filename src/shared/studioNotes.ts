export type StudioNoteStatus = 'open' | 'completed' | 'archived';

export interface StudioNote {
  id: string;
  projectId: string;
  content: string;
  status: StudioNoteStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  archivedAt?: string;
}

export interface SaveStudioNoteRequest {
  id?: string;
  projectId: string;
  content: string;
}

