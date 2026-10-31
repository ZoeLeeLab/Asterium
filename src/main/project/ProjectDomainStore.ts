import { randomUUID } from 'node:crypto';
import {
  isProjectStatus,
  isProjectTaskStatus,
  type ProjectDomainMigrationProject,
  type ProjectDomainSnapshot,
  type ProjectRecord,
  type ProjectTask,
  type ProjectTaskCreateRequest,
  type ProjectTaskExecutionConfig,
  type ProjectTaskUpdateRequest,
  type ProjectUpdateRequest,
} from '../../shared/projectDomain';
import { AtomicJsonStore, type AtomicJsonStorePath } from '../storage/AtomicJsonStore';

type ProjectDomainFile = ProjectDomainSnapshot;

export class ProjectDomainStore {
  private readonly storage: AtomicJsonStore<ProjectDomainFile>;
  private readonly listeners = new Set<(snapshot: ProjectDomainSnapshot) => void>();

  constructor(filePath: AtomicJsonStorePath) {
    this.storage = new AtomicJsonStore({
      filePath,
      empty: () => ({ version: 1, projects: [], tasks: [] }),
      decode: decodeProjectDomain,
      encode: (value) => `${JSON.stringify(value, null, 2)}\n`,
    });
  }

  subscribe(listener: (snapshot: ProjectDomainSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async snapshot() {
    return clone(await this.storage.read());
  }

  initialize(legacyProjects: ProjectDomainMigrationProject[], deletedProjectIds: readonly string[] = []) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      if (current.projects.length || current.tasks.length || !legacyProjects.length) return clone(current);
      const deleted = new Set(deletedProjectIds);
      const migrated = migrateLegacyProjects(legacyProjects.filter((project) => !deleted.has(project.id)));
      await this.storage.writeNow(migrated);
      this.notify(migrated);
      return clone(migrated);
    });
  }

  async getProject(projectId: string) {
    validateId(projectId, 'INVALID_PROJECT_ID');
    const current = await this.storage.read();
    const project = current.projects.find((item) => item.id === projectId);
    return project ? clone(project) : undefined;
  }

  async projectSnapshot(projectId: string) {
    validateId(projectId, 'INVALID_PROJECT_ID');
    const current = await this.storage.read();
    const project = current.projects.find((item) => item.id === projectId);
    if (!project) return undefined;
    return { project: clone(project), tasks: clone(current.tasks.filter((task) => task.projectId === projectId)) };
  }

  createProject(input: {
    id: string;
    name: string;
    description?: string;
    avatarDataUrl?: string;
    tags?: string[];
    memberIds?: string[];
  }) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      validateId(input.id, 'INVALID_PROJECT_ID');
      if (current.projects.some((project) => project.id === input.id)) throw new Error('PROJECT_ALREADY_EXISTS');
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        version: 1,
        id: input.id,
        name: cleanText(input.name, 80, 'PROJECT_NAME_INVALID'),
        ...(cleanOptional(input.avatarDataUrl, 8_000_000) ? { avatarDataUrl: cleanOptional(input.avatarDataUrl, 8_000_000) } : {}),
        description: cleanOptional(input.description, 20_000),
        status: 'active',
        progress: 0,
        tags: cleanList(input.tags, 12, 48),
        memberIds: cleanIds(input.memberIds),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const next = { ...current, projects: [project, ...current.projects] };
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(project);
    });
  }

  updateProject(input: ProjectUpdateRequest) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = requireProject(current, input.projectId);
      if (existing.revision !== input.expectedRevision) throw new Error('PROJECT_REVISION_CONFLICT');
      const updated: ProjectRecord = {
        ...existing,
        name: cleanText(input.name, 80, 'PROJECT_NAME_INVALID'),
        description: cleanOptional(input.description, 20_000),
        ...(cleanOptional(input.avatarDataUrl, 8_000_000) ? { avatarDataUrl: cleanOptional(input.avatarDataUrl, 8_000_000) } : { avatarDataUrl: undefined }),
        status: isProjectStatus(input.status) ? input.status : invalid('PROJECT_STATUS_INVALID'),
        progress: cleanProgress(input.progress),
        tags: cleanList(input.tags, 12, 48),
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const next = { ...current, projects: current.projects.map((project) => project.id === updated.id ? updated : project) };
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(updated);
    });
  }

  updateMembers(projectId: string, memberIds: string[]) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const existing = requireProject(current, projectId);
      const cleaned = cleanIds(memberIds);
      const updated: ProjectRecord = {
        ...existing,
        memberIds: cleaned,
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const tasks = current.tasks.map((task) => {
        if (task.projectId !== projectId) return task;
        const assigneeRemoved = Boolean(task.assigneeId && !cleaned.includes(task.assigneeId));
        const reviewerRemoved = task.execution?.completionRule?.type === 'partner_review'
          && !cleaned.includes(task.execution.completionRule.reviewerPartnerId);
        if (!assigneeRemoved && !reviewerRemoved) return task;
        return {
          ...task,
          ...(assigneeRemoved ? { assigneeId: undefined } : {}),
          ...(reviewerRemoved ? { execution: { ...task.execution, reviewWorkRole: undefined, completionRule: { type: 'user_confirm' as const } } } : {}),
          revision: task.revision + 1,
          updatedAt: updated.updatedAt,
        };
      });
      const next = { ...current, projects: current.projects.map((project) => project.id === projectId ? updated : project), tasks };
      validateTaskSet(projectId, cleaned, tasks.filter((task) => task.projectId === projectId));
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(updated);
    });
  }

  removeProject(projectId: string) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const project = current.projects.find((item) => item.id === projectId);
      if (!project) return undefined;
      const removed = { project: clone(project), tasks: clone(current.tasks.filter((task) => task.projectId === projectId)) };
      const next = {
        ...current,
        projects: current.projects.filter((item) => item.id !== projectId),
        tasks: current.tasks.filter((task) => task.projectId !== projectId),
      };
      await this.storage.writeNow(next);
      this.notify(next);
      return removed;
    });
  }

  restoreProject(project: ProjectRecord, tasks: ProjectTask[]) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const restored = decodeProject(project);
      const restoredTasks = tasks.map(decodeTask);
      validateTaskSet(restored.id, restored.memberIds, restoredTasks);
      const next = {
        version: 1 as const,
        projects: [restored, ...current.projects.filter((item) => item.id !== restored.id)],
        tasks: [...current.tasks.filter((task) => task.projectId !== restored.id), ...restoredTasks],
      };
      await this.storage.writeNow(next);
      this.notify(next);
    });
  }

  createTask(input: ProjectTaskCreateRequest) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const project = requireProject(current, input.projectId);
      const now = new Date().toISOString();
      const projectTasks = current.tasks.filter((task) => task.projectId === project.id);
      const task = normalizeTaskInput({
        ...input,
        id: randomUUID(),
        code: input.code || nextTaskCode(projectTasks),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }, project, projectTasks.map((task) => task.id));
      const next = { ...current, tasks: [...current.tasks, task] };
      validateTaskSet(project.id, project.memberIds, next.tasks.filter((item) => item.projectId === project.id));
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(task);
    });
  }

  createTaskBatch(projectId: string, inputs: Array<ProjectTaskCreateRequest & { taskId: string }>) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const project = requireProject(current, projectId);
      if (!inputs.length) throw new Error('PROJECT_WORKFLOW_EMPTY');
      if (inputs.some((input) => input.projectId !== projectId)) throw new Error('PROJECT_TASK_PROJECT_INVALID');
      const projectTasks = current.tasks.filter((task) => task.projectId === projectId);
      const taskIds = inputs.map((input) => {
        validateId(input.taskId, 'PROJECT_TASK_ID_INVALID');
        return input.taskId;
      });
      const allIds = [...projectTasks.map((task) => task.id), ...taskIds];
      if (new Set(allIds).size !== allIds.length) throw new Error('PROJECT_TASK_DUPLICATE');
      const now = new Date().toISOString();
      const accumulated = [...projectTasks];
      const created = inputs.map((input) => {
        const task = normalizeTaskInput({
          ...input,
          id: input.taskId,
          code: input.code || nextTaskCode(accumulated),
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }, project, allIds.filter((id) => id !== input.taskId));
        accumulated.push(task);
        return task;
      });
      const tasks = [...current.tasks, ...created];
      validateTaskSet(projectId, project.memberIds, tasks.filter((task) => task.projectId === projectId));
      const next = { ...current, tasks };
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(created);
    });
  }

  updateTask(input: ProjectTaskUpdateRequest) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      const project = requireProject(current, input.projectId);
      const existing = current.tasks.find((task) => task.projectId === input.projectId && task.id === input.taskId);
      if (!existing) throw new Error('PROJECT_TASK_NOT_FOUND');
      if (existing.revision !== input.expectedRevision) throw new Error('PROJECT_TASK_REVISION_CONFLICT');
      const projectTasks = current.tasks.filter((task) => task.projectId === project.id);
      const task = normalizeTaskInput({
        ...input,
        execution: input.execution ?? existing.execution,
        id: existing.id,
        code: input.code || existing.code,
        revision: existing.revision + 1,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      }, project, projectTasks.filter((item) => item.id !== existing.id).map((task) => task.id));
      const next = { ...current, tasks: current.tasks.map((item) => item.id === task.id ? task : item) };
      validateTaskSet(project.id, project.memberIds, next.tasks.filter((item) => item.projectId === project.id));
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(task);
    });
  }

  setTaskStatusForExecution(projectId: string, taskId: string, status: ProjectTask['status']) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      requireProject(current, projectId);
      const existing = current.tasks.find((task) => task.projectId === projectId && task.id === taskId);
      if (!existing) throw new Error('PROJECT_TASK_NOT_FOUND');
      if (!isProjectTaskStatus(status)) throw new Error('PROJECT_TASK_STATUS_INVALID');
      if (existing.status === status) return clone(existing);
      const task: ProjectTask = {
        ...existing,
        status,
        revision: existing.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const next = { ...current, tasks: current.tasks.map((item) => item.id === task.id ? task : item) };
      await this.storage.writeNow(next);
      this.notify(next);
      return clone(task);
    });
  }

  removeTask(projectId: string, taskId: string, expectedRevision: number) {
    return this.storage.runExclusive(async () => {
      const current = await this.storage.readNow();
      requireProject(current, projectId);
      const task = current.tasks.find((item) => item.projectId === projectId && item.id === taskId);
      if (!task) throw new Error('PROJECT_TASK_NOT_FOUND');
      if (task.revision !== expectedRevision) throw new Error('PROJECT_TASK_REVISION_CONFLICT');
      if (current.tasks.some((item) => item.projectId === projectId && item.dependencyIds.includes(taskId))) throw new Error('PROJECT_TASK_HAS_DEPENDENTS');
      const next = { ...current, tasks: current.tasks.filter((item) => item.id !== taskId) };
      await this.storage.writeNow(next);
      this.notify(next);
    });
  }

  private notify(snapshot: ProjectDomainSnapshot) {
    const value = clone(snapshot);
    for (const listener of this.listeners) listener(value);
  }
}

function migrateLegacyProjects(values: ProjectDomainMigrationProject[]): ProjectDomainFile {
  const projects: ProjectRecord[] = [];
  const tasks: ProjectTask[] = [];
  const seenProjects = new Set<string>();
  const now = new Date().toISOString();
  for (const value of values) {
    if (!value || seenProjects.has(value.id)) continue;
    validateId(value.id, 'INVALID_PROJECT_ID');
    seenProjects.add(value.id);
    const memberIds = cleanIds(value.memberIds);
    const createdAt = validDate(value.createdAt) ? value.createdAt! : now;
    const updatedAt = validDate(value.updatedAt) ? value.updatedAt! : createdAt;
    const project: ProjectRecord = {
      version: 1,
      id: value.id,
      name: cleanText(value.name, 80, 'PROJECT_NAME_INVALID'),
      ...(cleanOptional(value.avatarDataUrl, 8_000_000) ? { avatarDataUrl: cleanOptional(value.avatarDataUrl, 8_000_000) } : {}),
      description: cleanOptional(value.description, 20_000),
      status: isProjectStatus(value.status) ? value.status : 'active',
      progress: cleanProgress(value.progress ?? 0),
      tags: cleanList(value.tags, 12, 48),
      memberIds,
      revision: 1,
      createdAt,
      updatedAt,
    };
    projects.push(project);
    const seenTasks = new Set<string>();
    for (const legacy of value.tasks ?? []) {
      if (!legacy?.id || seenTasks.has(legacy.id)) continue;
      validateId(legacy.id, 'PROJECT_TASK_ID_INVALID');
      seenTasks.add(legacy.id);
      const taskCreatedAt = validDate(legacy.createdAt) ? legacy.createdAt! : createdAt;
      tasks.push({
        version: 1,
        id: legacy.id,
        projectId: project.id,
        code: cleanOptional(legacy.code, 32) || nextTaskCode(tasks.filter((task) => task.projectId === project.id)),
        title: cleanText(legacy.title, 160, 'PROJECT_TASK_TITLE_INVALID'),
        description: cleanOptional(legacy.description, 20_000),
        ...((legacy.assigneeId ?? legacy.ownerId) && memberIds.includes((legacy.assigneeId ?? legacy.ownerId)!) ? { assigneeId: legacy.assigneeId ?? legacy.ownerId } : {}),
        status: migrateTaskStatus(legacy.status),
        dependencyIds: cleanIds(legacy.dependencyIds).filter((id) => id !== legacy.id),
        acceptanceCriteria: cleanList(legacy.acceptanceCriteria, 24, 1_000),
        note: cleanOptional(legacy.note, 20_000),
        ...(cleanExecutionConfig(legacy.execution) ? { execution: cleanExecutionConfig(legacy.execution) } : {}),
        revision: 1,
        createdAt: taskCreatedAt,
        updatedAt: validDate(legacy.updatedAt) ? legacy.updatedAt! : taskCreatedAt,
      });
    }
  }
  for (const project of projects) {
    const projectTasks = tasks.filter((task) => task.projectId === project.id);
    const ids = new Set(projectTasks.map((task) => task.id));
    for (const task of projectTasks) task.dependencyIds = task.dependencyIds.filter((id) => ids.has(id));
    validateTaskSet(project.id, project.memberIds, projectTasks);
  }
  return { version: 1, projects, tasks };
}

function decodeProjectDomain(value: unknown): ProjectDomainFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projects) || !Array.isArray(value.tasks)) throw new Error('PROJECT_DOMAIN_STORE_INVALID');
  const projects = value.projects.map(decodeProject);
  const tasks = value.tasks.map(decodeTask);
  if (new Set(projects.map((project) => project.id)).size !== projects.length || new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error('PROJECT_DOMAIN_STORE_INVALID');
  for (const project of projects) validateTaskSet(project.id, project.memberIds, tasks.filter((task) => task.projectId === project.id));
  if (tasks.some((task) => !projects.some((project) => project.id === task.projectId))) throw new Error('PROJECT_DOMAIN_STORE_INVALID');
  return { version: 1, projects, tasks };
}

function decodeProject(value: unknown): ProjectRecord {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.name !== 'string'
    || typeof value.description !== 'string' || !isProjectStatus(value.status) || typeof value.progress !== 'number'
    || !Array.isArray(value.tags) || !Array.isArray(value.memberIds) || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') throw new Error('PROJECT_DOMAIN_STORE_INVALID');
  validateId(value.id, 'PROJECT_DOMAIN_STORE_INVALID');
  return {
    version: 1,
    id: value.id,
    name: cleanText(value.name, 80, 'PROJECT_DOMAIN_STORE_INVALID'),
    ...(typeof value.avatarDataUrl === 'string' && value.avatarDataUrl ? { avatarDataUrl: cleanOptional(value.avatarDataUrl, 8_000_000) } : {}),
    description: cleanOptional(value.description, 20_000),
    status: value.status,
    progress: cleanProgress(value.progress),
    tags: cleanList(value.tags, 12, 48),
    memberIds: cleanIds(value.memberIds),
    revision: positiveRevision(value.revision),
    createdAt: validDate(value.createdAt) ? value.createdAt : invalid('PROJECT_DOMAIN_STORE_INVALID'),
    updatedAt: validDate(value.updatedAt) ? value.updatedAt : invalid('PROJECT_DOMAIN_STORE_INVALID'),
  };
}

function decodeTask(value: unknown): ProjectTask {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || typeof value.projectId !== 'string'
    || typeof value.code !== 'string' || typeof value.title !== 'string' || typeof value.description !== 'string'
    || !isProjectTaskStatus(value.status) || !Array.isArray(value.dependencyIds) || !Array.isArray(value.acceptanceCriteria)
    || typeof value.note !== 'string' || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision)
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') throw new Error('PROJECT_DOMAIN_STORE_INVALID');
  validateId(value.id, 'PROJECT_DOMAIN_STORE_INVALID');
  validateId(value.projectId, 'PROJECT_DOMAIN_STORE_INVALID');
  return {
    version: 1,
    id: value.id,
    projectId: value.projectId,
    code: cleanText(value.code, 32, 'PROJECT_DOMAIN_STORE_INVALID'),
    title: cleanText(value.title, 160, 'PROJECT_DOMAIN_STORE_INVALID'),
    description: cleanOptional(value.description, 20_000),
    ...(typeof value.assigneeId === 'string' && value.assigneeId ? { assigneeId: cleanId(value.assigneeId) } : {}),
    status: value.status,
    dependencyIds: cleanIds(value.dependencyIds),
    acceptanceCriteria: cleanList(value.acceptanceCriteria, 24, 1_000),
    note: cleanOptional(value.note, 20_000),
    ...(cleanExecutionConfig(value.execution) ? { execution: cleanExecutionConfig(value.execution) } : {}),
    revision: positiveRevision(value.revision),
    createdAt: validDate(value.createdAt) ? value.createdAt : invalid('PROJECT_DOMAIN_STORE_INVALID'),
    updatedAt: validDate(value.updatedAt) ? value.updatedAt : invalid('PROJECT_DOMAIN_STORE_INVALID'),
  };
}

function normalizeTaskInput(value: ProjectTaskCreateRequest & { id: string; code: string; revision: number; createdAt: string; updatedAt: string }, project: ProjectRecord, otherTaskIds: string[]): ProjectTask {
  validateId(value.id, 'PROJECT_TASK_ID_INVALID');
  const assigneeId = value.assigneeId ? cleanId(value.assigneeId) : undefined;
  if (assigneeId && !project.memberIds.includes(assigneeId)) throw new Error('PROJECT_TASK_ASSIGNEE_NOT_MEMBER');
  const otherIds = new Set(otherTaskIds);
  const dependencyIds = cleanIds(value.dependencyIds);
  if (dependencyIds.some((id) => id === value.id || !otherIds.has(id))) throw new Error('PROJECT_TASK_DEPENDENCY_INVALID');
  return {
    version: 1,
    id: value.id,
    projectId: project.id,
    code: cleanText(value.code, 32, 'PROJECT_TASK_CODE_INVALID'),
    title: cleanText(value.title, 160, 'PROJECT_TASK_TITLE_INVALID'),
    description: cleanOptional(value.description, 20_000),
    ...(assigneeId ? { assigneeId } : {}),
    status: value.status === undefined ? 'todo' : isProjectTaskStatus(value.status) ? value.status : invalid('PROJECT_TASK_STATUS_INVALID'),
    dependencyIds,
    acceptanceCriteria: cleanList(value.acceptanceCriteria, 24, 1_000),
    note: cleanOptional(value.note, 20_000),
    ...(cleanExecutionConfig(value.execution) ? { execution: cleanExecutionConfig(value.execution) } : {}),
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function validateTaskSet(projectId: string, memberIds: string[], tasks: ProjectTask[]) {
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error('PROJECT_TASK_DUPLICATE');
  for (const task of tasks) {
    if (task.projectId !== projectId || task.dependencyIds.some((id) => !ids.has(id) || id === task.id)) throw new Error('PROJECT_TASK_DEPENDENCY_INVALID');
    if (task.assigneeId && !memberIds.includes(task.assigneeId)) throw new Error('PROJECT_TASK_ASSIGNEE_NOT_MEMBER');
    if (task.execution?.completionRule?.type === 'partner_review' && !memberIds.includes(task.execution.completionRule.reviewerPartnerId)) {
      throw new Error('PROJECT_TASK_REVIEWER_NOT_MEMBER');
    }
    if (task.execution?.completionRule?.type === 'partner_review' && task.execution.completionRule.reviewerPartnerId === task.assigneeId) {
      throw new Error('PROJECT_TASK_REVIEWER_MUST_BE_INDEPENDENT');
    }
    if (task.execution?.completionRule?.type === 'partner_review' && task.acceptanceCriteria.length === 0) {
      throw new Error('PROJECT_TASK_REVIEW_CRITERIA_REQUIRED');
    }
    if (task.execution?.reviewWorkRole && task.execution.completionRule?.type !== 'partner_review') {
      throw new Error('PROJECT_TASK_REVIEW_ROLE_WITHOUT_REVIEWER');
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('PROJECT_TASK_DEPENDENCY_CYCLE');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependencyId of byId.get(id)?.dependencyIds ?? []) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function requireProject(value: ProjectDomainFile, projectId: string) {
  validateId(projectId, 'INVALID_PROJECT_ID');
  const project = value.projects.find((item) => item.id === projectId);
  if (!project) throw new Error('PROJECT_NOT_FOUND');
  return project;
}

function nextTaskCode(tasks: ProjectTask[]) {
  const used = new Set(tasks.map((task) => task.code.toLocaleUpperCase()));
  let index = tasks.length + 1;
  while (used.has(`TSK-${String(index).padStart(3, '0')}`)) index += 1;
  return `TSK-${String(index).padStart(3, '0')}`;
}

function migrateTaskStatus(value: unknown): ProjectTask['status'] {
  if (isProjectTaskStatus(value)) return value;
  if (value === 'review') return 'review';
  if (value === 'approved' || value === 'delivered') return 'completed';
  return 'todo';
}

function cleanText(value: unknown, max: number, code: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(code);
  return value.trim();
}

function cleanOptional(value: unknown, max: number) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function cleanList(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).map((item) => item.slice(0, maxLength)))].slice(0, maxItems);
}

function cleanIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item)).map(cleanId))];
}

function cleanExecutionConfig(value: unknown): ProjectTaskExecutionConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('PROJECT_TASK_EXECUTION_CONFIG_INVALID');
  const config: ProjectTaskExecutionConfig = {};
  if (value.workRole !== undefined) {
    config.workRole = cleanWorkRole(value.workRole);
  }
  if (value.reviewWorkRole !== undefined) {
    config.reviewWorkRole = cleanWorkRole(value.reviewWorkRole);
  }
  if (value.completionRule !== undefined) {
    if (!isRecord(value.completionRule)) throw new Error('PROJECT_TASK_EXECUTION_CONFIG_INVALID');
    if (value.completionRule.type === 'executor_submit' || value.completionRule.type === 'user_confirm') {
      config.completionRule = { type: value.completionRule.type };
    } else if (value.completionRule.type === 'partner_review'
      && typeof value.completionRule.reviewerPartnerId === 'string'
      && Number.isSafeInteger(value.completionRule.autoReworkLimit)
      && Number(value.completionRule.autoReworkLimit) >= 0
      && Number(value.completionRule.autoReworkLimit) <= 10) {
      config.completionRule = {
        type: 'partner_review',
        reviewerPartnerId: cleanId(value.completionRule.reviewerPartnerId),
        autoReworkLimit: Number(value.completionRule.autoReworkLimit),
      };
    } else throw new Error('PROJECT_TASK_EXECUTION_CONFIG_INVALID');
  }
  if (value.methodTemplate !== undefined) {
    if (!isRecord(value.methodTemplate)) throw new Error('PROJECT_TASK_EXECUTION_CONFIG_INVALID');
    config.methodTemplate = {
      templateId: cleanId(cleanText(value.methodTemplate.templateId, 192, 'PROJECT_TASK_EXECUTION_CONFIG_INVALID')),
      name: cleanText(value.methodTemplate.name, 120, 'PROJECT_TASK_EXECUTION_CONFIG_INVALID'),
      version: cleanText(value.methodTemplate.version, 80, 'PROJECT_TASK_EXECUTION_CONFIG_INVALID'),
      instructions: cleanText(value.methodTemplate.instructions, 40_000, 'PROJECT_TASK_EXECUTION_CONFIG_INVALID'),
      ...(cleanOptional(value.methodTemplate.sourceAttribution, 2_000) ? { sourceAttribution: cleanOptional(value.methodTemplate.sourceAttribution, 2_000) } : {}),
    };
  }
  return Object.keys(config).length ? config : undefined;
}

function cleanWorkRole(value: unknown): NonNullable<ProjectTaskExecutionConfig['workRole']> {
  if (!isRecord(value) || !['builtin', 'global', 'project', 'inline'].includes(String(value.scope))) throw new Error('PROJECT_TASK_EXECUTION_CONFIG_INVALID');
  const roleId = typeof value.roleId === 'string' && value.roleId ? cleanId(value.roleId) : undefined;
  const roleRevision = value.roleRevision === undefined
    ? undefined
    : typeof value.roleRevision === 'number' && Number.isSafeInteger(value.roleRevision) && value.roleRevision > 0
      ? value.roleRevision
      : invalid('PROJECT_TASK_EXECUTION_CONFIG_INVALID');
  if (!roleId && roleRevision) throw new Error('PROJECT_TASK_EXECUTION_CONFIG_INVALID');
  const prompt = cleanOptional(value.prompt, 20_000);
  const description = cleanOptional(value.description, 2_000);
  return {
    ...(roleId ? { roleId, ...(roleRevision ? { roleRevision } : {}) } : {}),
    name: cleanText(value.name, 80, 'PROJECT_TASK_EXECUTION_CONFIG_INVALID'),
    ...(description ? { description } : {}),
    responsibilities: cleanList(value.responsibilities, 24, 1_000),
    ...(prompt ? { prompt } : {}),
    scope: value.scope as NonNullable<ProjectTaskExecutionConfig['workRole']>['scope'],
  };
}

function cleanId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(value)) throw new Error('PROJECT_REFERENCE_ID_INVALID');
  return value;
}

function validateId(value: string, code: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(value)) throw new Error(code);
}

function cleanProgress(value: number) {
  if (!Number.isFinite(value)) throw new Error('PROJECT_PROGRESS_INVALID');
  return Math.max(0, Math.min(100, Math.round(value)));
}

function positiveRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('PROJECT_DOMAIN_STORE_INVALID');
  return value;
}

function validDate(value: unknown) {
  return typeof value === 'string' && Boolean(value) && !Number.isNaN(Date.parse(value));
}

function invalid(code: string): never {
  throw new Error(code);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
