import { randomUUID } from 'node:crypto';
import type { ProjectWorkflowChange, ProjectWorkflowDraftNode, ProjectWorkflowTemplate } from '../../shared/projectWorkflows';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';
import { normalizeProjectWorkflowDraftNodes } from './ProjectWorkflowStore';

interface ProjectWorkflowTemplateFile {
  version: 1;
  templates: ProjectWorkflowTemplate[];
}

export class ProjectWorkflowTemplateStore {
  private readonly storage: AtomicJsonStore<ProjectWorkflowTemplateFile>;
  private readonly listeners = new Set<(change: ProjectWorkflowChange) => void>();

  constructor(filePath: AtomicJsonStorePath) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 1, templates: [] }),
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
    return structuredClone((await this.storage.read()).templates.filter((item) => item.projectId === projectId));
  }

  async get(projectId: string, templateId: string) {
    validateId(projectId, 'INVALID_PROJECT_ID');
    validateId(templateId, 'PROJECT_WORKFLOW_TEMPLATE_ID_INVALID');
    const template = (await this.storage.read()).templates.find((item) => item.projectId === projectId && item.id === templateId);
    return template ? structuredClone(template) : undefined;
  }

  create(input: { projectId: string; name: string; description?: string; nodes: ProjectWorkflowDraftNode[] }) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const now = new Date().toISOString();
      const template = cleanTemplate({
        version: 1,
        id: randomUUID(),
        projectId: input.projectId,
        name: input.name,
        description: input.description ?? '',
        nodes: input.nodes,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      await this.storage.writeNow({ version: 1, templates: [...current.templates, template] });
      this.notify({ type: 'changed', projectId: input.projectId });
      return structuredClone(template);
    });
  }

  update(input: {
    projectId: string;
    templateId: string;
    expectedRevision: number;
    name: string;
    description?: string;
    nodes: ProjectWorkflowDraftNode[];
  }) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = requireTemplate(current, input.projectId, input.templateId);
      if (existing.revision !== input.expectedRevision) throw new Error('PROJECT_WORKFLOW_TEMPLATE_REVISION_CONFLICT');
      const updated = cleanTemplate({
        ...existing,
        name: input.name,
        description: input.description ?? '',
        nodes: input.nodes,
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await this.storage.writeNow({ version: 1, templates: current.templates.map((item) => item.id === updated.id ? updated : item) });
      this.notify({ type: 'changed', projectId: input.projectId });
      return structuredClone(updated);
    });
  }

  remove(projectId: string, templateId: string, expectedRevision: number) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = requireTemplate(current, projectId, templateId);
      if (existing.revision !== expectedRevision) throw new Error('PROJECT_WORKFLOW_TEMPLATE_REVISION_CONFLICT');
      await this.storage.writeNow({ version: 1, templates: current.templates.filter((item) => item.id !== templateId) });
      this.notify({ type: 'changed', projectId });
    });
  }

  removeProject(projectId: string) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const removed = current.templates.filter((item) => item.projectId === projectId);
      if (!removed.length) return [];
      await this.storage.writeNow({ version: 1, templates: current.templates.filter((item) => item.projectId !== projectId) });
      this.notify({ type: 'project_removed', projectId });
      return structuredClone(removed);
    });
  }

  restoreProject(projectId: string, templates: ProjectWorkflowTemplate[]) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const restored = templates.map(cleanTemplate);
      if (restored.some((item) => item.projectId !== projectId)) throw new Error('PROJECT_WORKFLOW_TEMPLATE_PROJECT_INVALID');
      await this.storage.writeNow({ version: 1, templates: [...current.templates.filter((item) => item.projectId !== projectId), ...restored] });
      this.notify({ type: 'changed', projectId });
    });
  }

  private notify(change: ProjectWorkflowChange) {
    for (const listener of this.listeners) listener(structuredClone(change));
  }
}

function decodeFile(value: unknown): ProjectWorkflowTemplateFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.templates)) throw new Error('PROJECT_WORKFLOW_TEMPLATE_STORE_INVALID');
  const templates = value.templates.map(cleanTemplate);
  if (new Set(templates.map((item) => item.id)).size !== templates.length) throw new Error('PROJECT_WORKFLOW_TEMPLATE_STORE_INVALID');
  return { version: 1, templates };
}

function cleanTemplate(value: unknown): ProjectWorkflowTemplate {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.projectId !== 'string'
    || !positiveRevision(value.revision) || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new Error('PROJECT_WORKFLOW_TEMPLATE_STORE_INVALID');
  }
  validateId(value.id, 'PROJECT_WORKFLOW_TEMPLATE_ID_INVALID');
  validateId(value.projectId, 'INVALID_PROJECT_ID');
  return {
    version: 1,
    id: value.id,
    projectId: value.projectId,
    name: cleanRequired(value.name, 120, 'PROJECT_WORKFLOW_TEMPLATE_NAME_INVALID'),
    description: cleanOptional(value.description, 4_000),
    nodes: normalizeProjectWorkflowDraftNodes(value.nodes),
    revision: value.revision,
    createdAt: validDate(value.createdAt),
    updatedAt: validDate(value.updatedAt),
  };
}

function requireTemplate(file: ProjectWorkflowTemplateFile, projectId: string, templateId: string) {
  validateId(projectId, 'INVALID_PROJECT_ID');
  validateId(templateId, 'PROJECT_WORKFLOW_TEMPLATE_ID_INVALID');
  const template = file.templates.find((item) => item.projectId === projectId && item.id === templateId);
  if (!template) throw new Error('PROJECT_WORKFLOW_TEMPLATE_NOT_FOUND');
  return template;
}

function cleanRequired(value: unknown, max: number, code: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(code);
  return value.trim();
}

function cleanOptional(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validateId(value: string, code: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(value)) throw new Error(code);
}

function positiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validDate(value: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error('PROJECT_WORKFLOW_TEMPLATE_STORE_INVALID');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
