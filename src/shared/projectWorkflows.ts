import type { ProjectTaskExecutionConfig, ProjectTaskMethodTemplate } from './projectDomain';
import type { ProjectWorkflowGenerationProvenance } from './projectWorkflowGeneration';

export type ProjectWorkflowStatus = 'draft' | 'activating' | 'active' | 'completed' | 'cancelled';

export interface ProjectWorkflowDraftNode {
  id: string;
  position: number;
  title: string;
  description: string;
  assigneeId?: string;
  dependencyNodeIds: string[];
  acceptanceCriteria: string[];
  note: string;
  execution?: ProjectTaskExecutionConfig;
}

export interface ProjectWorkflow {
  version: 1;
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: ProjectWorkflowStatus;
  sourceTemplate?: { templateId: string; templateVersion: string };
  generationProvenance?: ProjectWorkflowGenerationProvenance;
  templateWarnings?: string[];
  generationWarnings?: string[];
  nodes: ProjectWorkflowDraftNode[];
  activatedTasks?: Array<{ draftNodeId: string; taskId: string }>;
  activationId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  activatedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancellationReason?: 'referenced_task_missing' | 'task_cancelled';
}

export interface ProjectWorkflowTemplateSummary {
  id: string;
  version: string;
  name: string;
  description: string;
  nodeCount: number;
  kind: 'builtin' | 'project';
  projectId?: string;
  revision?: number;
  sourceAttribution?: string;
}

export interface ProjectWorkflowTemplate {
  version: 1;
  id: string;
  projectId: string;
  name: string;
  description: string;
  nodes: ProjectWorkflowDraftNode[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMethodTemplateDefinition extends ProjectTaskMethodTemplate {
  description: string;
}

export interface ProjectWorkflowCatalog {
  version: 1;
  templates: ProjectWorkflowTemplateSummary[];
  methods: ProjectMethodTemplateDefinition[];
}

export interface ProjectWorkflowCreateRequest {
  projectId: string;
  templateId: string;
  name?: string;
}

export interface ProjectWorkflowUpdateRequest {
  projectId: string;
  workflowId: string;
  expectedRevision: number;
  name: string;
  description?: string;
  nodes: ProjectWorkflowDraftNode[];
}

export interface ProjectWorkflowRemoveRequest {
  projectId: string;
  workflowId: string;
  expectedRevision: number;
}

export interface ProjectWorkflowTemplateSaveRequest {
  projectId: string;
  workflowId: string;
  expectedWorkflowRevision: number;
  name: string;
  description?: string;
}

export interface ProjectWorkflowTemplateUpdateRequest extends ProjectWorkflowTemplateSaveRequest {
  templateId: string;
  expectedTemplateRevision: number;
}

export interface ProjectWorkflowTemplateRemoveRequest {
  projectId: string;
  templateId: string;
  expectedRevision: number;
}

export interface ProjectWorkflowActivateRequest {
  projectId: string;
  workflowId: string;
  expectedRevision: number;
  activationId: string;
}

export interface ProjectWorkflowActivationResult {
  workflow: ProjectWorkflow;
  taskIds: string[];
  attemptIds: string[];
}

export type ProjectWorkflowChange =
  | { type: 'changed'; projectId: string }
  | { type: 'project_removed'; projectId: string };

export function projectMethodTemplateSnapshot(method: ProjectMethodTemplateDefinition): ProjectTaskMethodTemplate {
  return {
    templateId: method.templateId,
    name: method.name,
    version: method.version,
    instructions: method.instructions,
    ...(method.sourceAttribution ? { sourceAttribution: method.sourceAttribution } : {}),
  };
}
