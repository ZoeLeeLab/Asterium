import type { Message } from './conversation';

export interface GroupChat {
  id: string;
  projectId: string;
  name: string;
  avatarDataUrl?: string;
  memberIds: string[];
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  unreadCompletedAt?: string;
  archivedAt?: string;
  projectDeletedAt?: string;
}
