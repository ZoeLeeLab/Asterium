import { randomUUID } from 'node:crypto';
import type { ProjectTask, ProjectTaskExecutionConfig } from '../../shared/projectDomain';
import type {
  ProjectWorkflow,
  ProjectWorkflowChange,
  ProjectWorkflowDraftNode,
  ProjectWorkflowUpdateRequest,
} from '../../shared/projectWorkflows';
import type { ProjectWorkflowGenerationProvenance } from '../../shared/projectWorkflowGeneration';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';

interface ProjectWorkflowFile {
  version: 1;
  workflows: ProjectWorkflow[];
}

export class ProjectWorkflowStore {
  private readonly storage: AtomicJsonStore<ProjectWorkflowFile>;
  private readonly listeners = new Set<(change: ProjectWorkflowChange) => void>();

  constructor(filePath: AtomicJsonStorePath) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 1, workflows: [] }),
      decode: decodeFile,
      encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
    });
  }

  subscribe(listener: (change: ProjectWorkflowChange) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listProject(projectId: string) {
    validateId(projectId, 'INVALID_PROJECT_ID');
    return structuredClone((await this.storage.read()).workflows.filter((item) => item.projectId === projectId));
  }

  async get(projectId: string, workflowId: string) {
    validateId(projectId, 'INVALID_PROJECT_ID');
    validateId(workflowId, 'PROJECT_WORKFLOW_ID_INVALID');
    const workflow = (await this.storage.read()).workflows.find((item) => item.projectId === projectId && item.id === workflowId);
    return workflow ? structuredClone(workflow) : undefined;
  }

  createDraft(input: {
    projectId: string;
    name: string;
    description?: string;
    sourceTemplate?: ProjectWorkflow['sourceTemplate'];
    generationProvenance?: ProjectWorkflowGenerationProvenance;
    templateWarnings?: string[];
    generationWarnings?: string[];
    nodes: ProjectWorkflowDraftNode[];
  }) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      validateId(input.projectId, 'INVALID_PROJECT_ID');
      if (input.generationProvenance) {
        const repeated = current.workflows.find((item) => item.generationProvenance?.generationId === input.generationProvenance?.generationId);
        if (repeated) return structuredClone(repeated);
      }
      const now = new Date().toISOString();
      const workflow = cleanWorkflow({
        version: 1, id: randomUUID(), projectId: input.projectId,
        name: input.name, description: input.description ?? '', status: 'draft',
        ...(input.sourceTemplate ? { sourceTemplate: input.sourceTemplate } : {}),
        ...(input.generationProvenance ? { generationProvenance: input.generationProvenance } : {}),
        ...(input.templateWarnings?.length ? { templateWarnings: input.templateWarnings } : {}),
        ...(input.generationWarnings?.length ? { generationWarnings: input.generationWarnings } : {}),
        nodes: input.nodes, revision: 1, createdAt: now, updatedAt: now,
      });
      const next = { version: 1 as const, workflows: [...current.workflows, workflow] };
      await this.storage.writeNow(next);
      this.notify({ type: 'changed', projectId: input.projectId });
      return structuredClone(workflow);
    });
  }

  updateDraft(request: ProjectWorkflowUpdateRequest) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = requireWorkflow(current, request.projectId, request.workflowId);
      if (existing.status !== 'draft') throw new Error('PROJECT_WORKFLOW_NOT_EDITABLE');
      if (existing.revision !== request.expectedRevision) throw new Error('PROJECT_WORKFLOW_REVISION_CONFLICT');
      const nodeIds = new Set(request.nodes.map((node) => node.id));
      const generationProvenance = existing.generationProvenance ? {
        ...existing.generationProvenance,
        nodeBasis: existing.generationProvenance.nodeBasis.filter((item) => nodeIds.has(item.draftNodeId)),
      } : undefined;
      const updated = cleanWorkflow({
        ...existing, name: request.name, description: request.description ?? '', nodes: request.nodes, templateWarnings: undefined, generationWarnings: undefined,
        ...(generationProvenance ? { generationProvenance } : {}),
        revision: existing.revision + 1, updatedAt: new Date().toISOString(),
      });
      await this.storage.writeNow({ version: 1, workflows: current.workflows.map((item) => item.id === updated.id ? updated : item) });
      this.notify({ type: 'changed', projectId: request.projectId });
      return structuredClone(updated);
    });
  }

  async getByGenerationId(generationId: string) {
    validateId(generationId, 'PROJECT_WORKFLOW_GENERATION_ID_INVALID');
    const workflow = (await this.storage.read()).workflows.find((item) => item.generationProvenance?.generationId === generationId);
    return workflow ? structuredClone(workflow) : undefined;
  }

  remove(projectId: string, workflowId: string, expectedRevision: number) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = requireWorkflow(current, projectId, workflowId);
      if (existing.status === 'active' || existing.status === 'activating') throw new Error('PROJECT_WORKFLOW_ACTIVE');
      if (existing.revision !== expectedRevision) throw new Error('PROJECT_WORKFLOW_REVISION_CONFLICT');
      await this.storage.writeNow({ version: 1, workflows: current.workflows.filter((item) => item.id !== workflowId) });
      this.notify({ type: 'changed', projectId });
    });
  }

  async assertTaskRemovable(projectId: string, taskId: string) {
    validateId(projectId, 'INVALID_PROJECT_ID');
    validateId(taskId, 'INVALID_TASK_ID');
    const workflow = (await this.storage.read()).workflows.find((item) => item.projectId === projectId
      && item.status === 'active'
      && item.activatedTasks?.some((mapping) => mapping.taskId === taskId));
    if (workflow) throw new Error('PROJECT_TASK_BELONGS_TO_ACTIVE_WORKFLOW');
  }

  markActivating(projectId: string, workflowId: string, expectedRevision: number, activationId: string) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = requireWorkflow(current, projectId, workflowId);
      if ((existing.status === 'active' || existing.status === 'completed') && existing.activationId === activationId) return structuredClone(existing);
      if (existing.status !== 'draft') throw new Error('PROJECT_WORKFLOW_NOT_ACTIVATABLE');
      if (existing.revision !== expectedRevision) throw new Error('PROJECT_WORKFLOW_REVISION_CONFLICT');
      validateId(activationId, 'PROJECT_WORKFLOW_ACTIVATION_ID_INVALID');
      const updated = cleanWorkflow({
        ...existing, status: 'activating', activationId,
        revision: existing.revision + 1, updatedAt: new Date().toISOString(),
      });
      await this.storage.writeNow({ version: 1, workflows: current.workflows.map((item) => item.id === updated.id ? updated : item) });
      this.notify({ type: 'changed', projectId });
      return structuredClone(updated);
    });
  }

  markActive(projectId: string, workflowId: string, activationId: string, activatedTasks: Array<{ draftNodeId: string; taskId: string }>) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = requireWorkflow(current, projectId, workflowId);
      if ((existing.status === 'active' || existing.status === 'completed') && existing.activationId === activationId) return structuredClone(existing);
      if (existing.status !== 'activating' || existing.activationId !== activationId) throw new Error('PROJECT_WORKFLOW_ACTIVATION_CONFLICT');
      const now = new Date().toISOString();
      const updated = cleanWorkflow({
        ...existing, status: 'active', activatedTasks,
        revision: existing.revision + 1, updatedAt: now, activatedAt: now,
      });
      await this.storage.writeNow({ version: 1, workflows: current.workflows.map((item) => item.id === updated.id ? updated : item) });
      this.notify({ type: 'changed', projectId });
      return structuredClone(updated);
    });
  }

  restore(workflow: ProjectWorkflow) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const restored = cleanWorkflow(workflow);
      await this.storage.writeNow({ version: 1, workflows: [...current.workflows.filter((item) => item.id !== restored.id), restored] });
      this.notify({ type: 'changed', projectId: restored.projectId });
    });
  }

  reconcileProject(projectId: string, tasks: ProjectTask[]) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const taskIds = new Set(tasks.map((task) => task.id));
      const completedIds = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.id));
      const cancelledIds = new Set(tasks.filter((task) => task.status === 'cancelled').map((task) => task.id));
      let changed = false;
      const now = new Date().toISOString();
      const workflows = current.workflows.map((workflow) => {
        if (workflow.projectId !== projectId || workflow.status !== 'active' || !workflow.activatedTasks?.length) return workflow;
        if (workflow.activatedTasks.some((item) => !taskIds.has(item.taskId))) {
          changed = true;
          return cleanWorkflow({
            ...workflow,
            status: 'cancelled',
            cancellationReason: 'referenced_task_missing',
            revision: workflow.revision + 1,
            updatedAt: now,
            cancelledAt: now,
          });
        }
        if (workflow.activatedTasks.some((item) => cancelledIds.has(item.taskId))) {
          changed = true;
          return cleanWorkflow({
            ...workflow,
            status: 'cancelled',
            cancellationReason: 'task_cancelled',
            revision: workflow.revision + 1,
            updatedAt: now,
            cancelledAt: now,
          });
        }
        if (!workflow.activatedTasks.every((item) => completedIds.has(item.taskId))) return workflow;
        changed = true;
        return cleanWorkflow({ ...workflow, status: 'completed', revision: workflow.revision + 1, updatedAt: now, completedAt: now });
      });
      if (changed) {
        await this.storage.writeNow({ version: 1, workflows });
        this.notify({ type: 'changed', projectId });
      }
    });
  }

  removeProject(projectId: string) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const removed = current.workflows.filter((item) => item.projectId === projectId);
      if (!removed.length) return [];
      await this.storage.writeNow({ version: 1, workflows: current.workflows.filter((item) => item.projectId !== projectId) });
      this.notify({ type: 'project_removed', projectId });
      return structuredClone(removed);
    });
  }

  restoreProject(projectId: string, workflows: ProjectWorkflow[]) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const restored = workflows.map(cleanWorkflow);
      if (restored.some((item) => item.projectId !== projectId)) throw new Error('PROJECT_WORKFLOW_PROJECT_INVALID');
      await this.storage.writeNow({ version: 1, workflows: [...current.workflows.filter((item) => item.projectId !== projectId), ...restored] });
      this.notify({ type: 'changed', projectId });
    });
  }

  private notify(change: ProjectWorkflowChange) {
    for (const listener of this.listeners) listener(structuredClone(change));
  }
}

function decodeFile(value: unknown): ProjectWorkflowFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.workflows)) throw new Error('PROJECT_WORKFLOW_STORE_INVALID');
  const workflows = value.workflows.map(cleanWorkflow);
  if (new Set(workflows.map((item) => item.id)).size !== workflows.length) throw new Error('PROJECT_WORKFLOW_STORE_INVALID');
  return { version: 1, workflows };
}

function cleanWorkflow(value: unknown): ProjectWorkflow {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.projectId !== 'string'
    || !['draft', 'activating', 'active', 'completed', 'cancelled'].includes(String(value.status))
    || !Array.isArray(value.nodes) || !positiveRevision(value.revision)
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') throw new Error('PROJECT_WORKFLOW_STORE_INVALID');
  validateId(value.id, 'PROJECT_WORKFLOW_ID_INVALID');
  validateId(value.projectId, 'INVALID_PROJECT_ID');
  const nodes = normalizeProjectWorkflowDraftNodes(value.nodes);
  const sourceTemplate = isRecord(value.sourceTemplate) && typeof value.sourceTemplate.templateId === 'string' && typeof value.sourceTemplate.templateVersion === 'string'
    ? { templateId: cleanId(value.sourceTemplate.templateId), templateVersion: cleanRequired(value.sourceTemplate.templateVersion, 80, 'PROJECT_WORKFLOW_STORE_INVALID') }
    : undefined;
  const generationProvenance = value.generationProvenance === undefined ? undefined : cleanGenerationProvenance(value.generationProvenance, nodes);
  const activatedTasks = Array.isArray(value.activatedTasks) ? value.activatedTasks.map((item) => {
    if (!isRecord(item) || typeof item.draftNodeId !== 'string' || typeof item.taskId !== 'string') throw new Error('PROJECT_WORKFLOW_STORE_INVALID');
    return { draftNodeId: cleanId(item.draftNodeId), taskId: cleanId(item.taskId) };
  }) : undefined;
  const workflow: ProjectWorkflow = {
    version: 1, id: value.id, projectId: value.projectId,
    name: cleanRequired(value.name, 120, 'PROJECT_WORKFLOW_NAME_INVALID'),
    description: cleanOptional(value.description, 4_000),
    status: value.status as ProjectWorkflow['status'],
    ...(sourceTemplate ? { sourceTemplate } : {}),
    ...(generationProvenance ? { generationProvenance } : {}), nodes,
    ...(Array.isArray(value.templateWarnings) ? { templateWarnings: cleanList(value.templateWarnings, 24, 1_000) } : {}),
    ...(Array.isArray(value.generationWarnings) ? { generationWarnings: cleanList(value.generationWarnings, 48, 1_000) } : {}),
    ...(activatedTasks ? { activatedTasks } : {}),
    ...(typeof value.activationId === 'string' ? { activationId: cleanId(value.activationId) } : {}),
    revision: value.revision,
    createdAt: validDate(value.createdAt), updatedAt: validDate(value.updatedAt),
    ...(typeof value.activatedAt === 'string' ? { activatedAt: validDate(value.activatedAt) } : {}),
    ...(typeof value.completedAt === 'string' ? { completedAt: validDate(value.completedAt) } : {}),
    ...(typeof value.cancelledAt === 'string' ? { cancelledAt: validDate(value.cancelledAt) } : {}),
    ...((value.cancellationReason === 'referenced_task_missing' || value.cancellationReason === 'task_cancelled') ? { cancellationReason: value.cancellationReason } : {}),
  };
  if ((workflow.status === 'active' || workflow.status === 'completed' || workflow.status === 'cancelled') && (!workflow.activationId || !workflow.activatedTasks || workflow.activatedTasks.length !== workflow.nodes.length)) {
    throw new Error('PROJECT_WORKFLOW_STORE_INVALID');
  }
  if (workflow.status === 'cancelled' && (!workflow.cancelledAt || !workflow.cancellationReason)) throw new Error('PROJECT_WORKFLOW_STORE_INVALID');
  return workflow;
}

function cleanGenerationProvenance(value: unknown, nodes: ProjectWorkflowDraftNode[]): ProjectWorkflowGenerationProvenance {
  if (!isRecord(value) || typeof value.generationId !== 'string' || typeof value.roomId !== 'string' || typeof value.plannerPartnerId !== 'string'
    || typeof value.sourceDigest !== 'string' || typeof value.generationSummary !== 'string' || typeof value.generatedAt !== 'string'
    || !Array.isArray(value.messageRefs) || !Array.isArray(value.nodeBasis)) throw new Error('PROJECT_WORKFLOW_STORE_INVALID');
  const nodeIds = new Set(nodes.map((node) => node.id));
  const messageRefs = value.messageRefs.map((item) => {
    if (!isRecord(item) || typeof item.messageId !== 'string' || !Number.isSafeInteger(item.seq) || Number(item.seq) < 1 || typeof item.contentHash !== 'string') throw new Error('PROJECT_WORKFLOW_STORE_INVALID');
    return { messageId: cleanId(item.messageId), seq: Number(item.seq), contentHash: cleanRequired(item.contentHash, 128, 'PROJECT_WORKFLOW_STORE_INVALID') };
  });
  const messageIds = new Set(messageRefs.map((item) => item.messageId));
  const nodeBasis = value.nodeBasis.map((item) => {
    if (!isRecord(item) || typeof item.draftNodeId !== 'string' || !Array.isArray(item.sourceMessageIds)) throw new Error('PROJECT_WORKFLOW_STORE_INVALID');
    const draftNodeId = cleanId(item.draftNodeId);
    const sourceMessageIds = cleanIds(item.sourceMessageIds);
    if (!nodeIds.has(draftNodeId) || sourceMessageIds.some((id) => !messageIds.has(id))) throw new Error('PROJECT_WORKFLOW_STORE_INVALID');
    const summary = cleanOptional(item.summary, 2_000);
    return { draftNodeId, sourceMessageIds, ...(summary ? { summary } : {}) };
  });
  return {
    generationId: cleanId(value.generationId), roomId: cleanId(value.roomId), plannerPartnerId: cleanId(value.plannerPartnerId),
    sourceDigest: cleanRequired(value.sourceDigest, 128, 'PROJECT_WORKFLOW_STORE_INVALID'), messageRefs,
    generationSummary: cleanOptional(value.generationSummary, 4_000), nodeBasis, generatedAt: validDate(value.generatedAt),
  };
}

function cleanNode(value: unknown): ProjectWorkflowDraftNode {
  if (!isRecord(value) || typeof value.id !== 'string' || !Number.isSafeInteger(value.position) || Number(value.position) < 0
    || !Array.isArray(value.dependencyNodeIds) || !Array.isArray(value.acceptanceCriteria)) throw new Error('PROJECT_WORKFLOW_NODE_INVALID');
  const execution = cleanExecution(value.execution);
  return {
    id: cleanId(value.id), position: Number(value.position),
    title: cleanRequired(value.title, 160, 'PROJECT_WORKFLOW_NODE_TITLE_INVALID'),
    description: cleanOptional(value.description, 20_000),
    ...(typeof value.assigneeId === 'string' && value.assigneeId ? { assigneeId: cleanId(value.assigneeId) } : {}),
    dependencyNodeIds: cleanIds(value.dependencyNodeIds),
    acceptanceCriteria: cleanList(value.acceptanceCriteria, 24, 1_000),
    note: cleanOptional(value.note, 20_000),
    ...(execution ? { execution } : {}),
  };
}

export function normalizeProjectWorkflowDraftNodes(value: unknown): ProjectWorkflowDraftNode[] {
  if (!Array.isArray(value)) throw new Error('PROJECT_WORKFLOW_NODE_INVALID');
  const nodes = value.map(cleanNode).sort((left, right) => left.position - right.position);
  validateNodeGraph(nodes);
  return nodes;
}

function cleanExecution(value: unknown): ProjectTaskExecutionConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('PROJECT_WORKFLOW_NODE_EXECUTION_INVALID');
  const config: ProjectTaskExecutionConfig = {};
  if (value.workRole !== undefined) config.workRole = cleanRole(value.workRole);
  if (value.reviewWorkRole !== undefined) config.reviewWorkRole = cleanRole(value.reviewWorkRole);
  if (value.completionRule !== undefined) {
    if (!isRecord(value.completionRule)) throw new Error('PROJECT_WORKFLOW_NODE_EXECUTION_INVALID');
    if (value.completionRule.type === 'executor_submit' || value.completionRule.type === 'user_confirm') config.completionRule = { type: value.completionRule.type };
    else if (value.completionRule.type === 'partner_review' && typeof value.completionRule.reviewerPartnerId === 'string'
      && Number.isSafeInteger(value.completionRule.autoReworkLimit) && Number(value.completionRule.autoReworkLimit) >= 0 && Number(value.completionRule.autoReworkLimit) <= 10) {
      config.completionRule = { type: 'partner_review', reviewerPartnerId: cleanId(value.completionRule.reviewerPartnerId), autoReworkLimit: Number(value.completionRule.autoReworkLimit) };
    } else throw new Error('PROJECT_WORKFLOW_NODE_EXECUTION_INVALID');
  }
  if (value.methodTemplate !== undefined) {
    if (!isRecord(value.methodTemplate)) throw new Error('PROJECT_WORKFLOW_NODE_EXECUTION_INVALID');
    config.methodTemplate = {
      templateId: cleanId(value.methodTemplate.templateId),
      name: cleanRequired(value.methodTemplate.name, 120, 'PROJECT_WORKFLOW_NODE_EXECUTION_INVALID'),
      version: cleanRequired(value.methodTemplate.version, 80, 'PROJECT_WORKFLOW_NODE_EXECUTION_INVALID'),
      instructions: cleanRequired(value.methodTemplate.instructions, 40_000, 'PROJECT_WORKFLOW_NODE_EXECUTION_INVALID'),
      ...(cleanOptional(value.methodTemplate.sourceAttribution, 2_000) ? { sourceAttribution: cleanOptional(value.methodTemplate.sourceAttribution, 2_000) } : {}),
    };
  }
  return Object.keys(config).length ? config : undefined;
}

function cleanRole(value: unknown): NonNullable<ProjectTaskExecutionConfig['workRole']> {
  if (!isRecord(value) || !['builtin', 'global', 'project', 'inline'].includes(String(value.scope)) || !Array.isArray(value.responsibilities)) {
    throw new Error('PROJECT_WORKFLOW_NODE_EXECUTION_INVALID');
  }
  const roleId = typeof value.roleId === 'string' && value.roleId ? cleanId(value.roleId) : undefined;
  const roleRevision = value.roleRevision === undefined ? undefined : positiveRevision(value.roleRevision) ? value.roleRevision : invalid('PROJECT_WORKFLOW_NODE_EXECUTION_INVALID');
  if (!roleId && roleRevision) throw new Error('PROJECT_WORKFLOW_NODE_EXECUTION_INVALID');
  const description = cleanOptional(value.description, 2_000);
  const prompt = cleanOptional(value.prompt, 20_000);
  return {
    ...(roleId ? { roleId, ...(roleRevision ? { roleRevision } : {}) } : {}),
    name: cleanRequired(value.name, 80, 'PROJECT_WORKFLOW_NODE_EXECUTION_INVALID'),
    ...(description ? { description } : {}), responsibilities: cleanList(value.responsibilities, 24, 1_000),
    ...(prompt ? { prompt } : {}), scope: value.scope as NonNullable<ProjectTaskExecutionConfig['workRole']>['scope'],
  };
}

function validateNodeGraph(nodes: ProjectWorkflowDraftNode[]) {
  const ids = new Set(nodes.map((item) => item.id));
  if (ids.size !== nodes.length || new Set(nodes.map((item) => item.position)).size !== nodes.length) throw new Error('PROJECT_WORKFLOW_NODE_DUPLICATE');
  const byId = new Map(nodes.map((item) => [item.id, item]));
  for (const node of nodes) if (node.dependencyNodeIds.some((id) => id === node.id || !ids.has(id))) throw new Error('PROJECT_WORKFLOW_DEPENDENCY_INVALID');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('PROJECT_WORKFLOW_DEPENDENCY_CYCLE');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependencyId of byId.get(id)?.dependencyNodeIds ?? []) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function requireWorkflow(file: ProjectWorkflowFile, projectId: string, workflowId: string) {
  validateId(projectId, 'INVALID_PROJECT_ID');
  validateId(workflowId, 'PROJECT_WORKFLOW_ID_INVALID');
  const workflow = file.workflows.find((item) => item.projectId === projectId && item.id === workflowId);
  if (!workflow) throw new Error('PROJECT_WORKFLOW_NOT_FOUND');
  return workflow;
}

function cleanRequired(value: unknown, max: number, code: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(code);
  return value.trim();
}

function cleanOptional(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanList(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).map((item) => item.slice(0, maxLength)))].slice(0, maxItems);
}

function cleanIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item)).map(cleanId))];
}

function cleanId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(value)) throw new Error('PROJECT_REFERENCE_ID_INVALID');
  return value;
}

function validateId(value: string, code: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(value)) throw new Error(code);
}

function positiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validDate(value: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error('PROJECT_WORKFLOW_STORE_INVALID');
  return value;
}

function invalid(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
