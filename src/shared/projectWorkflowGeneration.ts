import type { ProjectTaskCompletionRule } from './projectDomain';

export type ProjectWorkflowGenerationStatus = 'running' | 'submitted' | 'failed' | 'cancelled' | 'interrupted';

export interface ProjectWorkflowGenerationSourceMessage {
  messageId: string;
  seq: number;
  authorType: 'user' | 'partner' | 'system';
  authorId: string;
  content: string;
  contentHash: string;
  createdAt: string;
  status: 'completed' | 'interrupted';
}

export interface ProjectWorkflowGenerationMember {
  partnerId: string;
  displayName: string;
  expertise: string;
}

export interface ProjectWorkflowDraftProposalNode {
  clientKey: string;
  title: string;
  description: string;
  assigneePartnerId?: string;
  dependencyKeys: string[];
  acceptanceCriteria: string[];
  note?: string;
  workRoleId?: string;
  reviewRoleId?: string;
  methodTemplateId?: string;
  completionRule: ProjectTaskCompletionRule;
  sourceMessageIds: string[];
  basisSummary?: string;
}

export interface ProjectWorkflowDraftProposal {
  name: string;
  description: string;
  generationSummary: string;
  nodes: ProjectWorkflowDraftProposalNode[];
}

export interface ProjectWorkflowGenerationProvenance {
  generationId: string;
  roomId: string;
  plannerPartnerId: string;
  sourceDigest: string;
  messageRefs: Array<{ messageId: string; seq: number; contentHash: string }>;
  generationSummary: string;
  nodeBasis: Array<{ draftNodeId: string; sourceMessageIds: string[]; summary?: string }>;
  generatedAt: string;
}

export interface ProjectWorkflowGenerationError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ProjectWorkflowGeneration {
  version: 1;
  id: string;
  requestId: string;
  requestFingerprint: string;
  projectId: string;
  roomId: string;
  plannerPartnerId: string;
  sourceDigest: string;
  sourceMessages: ProjectWorkflowGenerationSourceMessage[];
  status: ProjectWorkflowGenerationStatus;
  validationFailures: number;
  retryOfGenerationId?: string;
  workflowId?: string;
  conversationId?: string;
  bindingId?: string;
  runId?: string;
  sessionId?: string;
  error?: ProjectWorkflowGenerationError;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  cancelledAt?: string;
}

export interface ProjectWorkflowGenerationStartRequest {
  requestId: string;
  projectId: string;
  roomId: string;
  plannerPartnerId: string;
  messageIds: string[];
  retryOfGenerationId?: string;
}

export interface ProjectWorkflowGenerationCancelRequest {
  projectId: string;
  generationId: string;
}

export interface ProjectWorkflowGenerationRetryRequest {
  projectId: string;
  generationId: string;
  requestId: string;
}

export type ProjectWorkflowGenerationChange =
  | { type: 'changed'; generation: ProjectWorkflowGeneration }
  | { type: 'project_removed'; projectId: string };
