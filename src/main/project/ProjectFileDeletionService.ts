import path from 'node:path';
import type {
  FileDeletionInspection,
  FileDeletionReference,
  FileDeletionResult,
  FileDeletionTarget,
  ProjectFileRecordSnapshot,
  ProjectFileVersionRef,
} from '../../shared/projectWorkspace';
import type { TaskAttempt } from '../../shared/projectTaskExecution';
import type { ArtifactRegistry } from '../security/ArtifactRegistry';
import type { ProjectDomainStore } from './ProjectDomainStore';
import type { ProjectFileStore } from './ProjectFileStore';
import type { ProjectMutationCoordinator } from './ProjectMutationCoordinator';
import type { ProjectTaskExecutionStore } from './ProjectTaskExecutionStore';
import type { ProjectWorkflowStore } from './ProjectWorkflowStore';
import type { ProjectWorkspaceStore } from './ProjectWorkspaceStore';

interface ProjectFileDeletionServiceOptions {
  files: ProjectFileStore;
  artifacts: ArtifactRegistry;
  workspaces: ProjectWorkspaceStore;
  domain: ProjectDomainStore;
  executions: ProjectTaskExecutionStore;
  workflows: ProjectWorkflowStore;
  coordinator: ProjectMutationCoordinator;
  trashItem: (absolutePath: string) => Promise<void>;
}

interface IndexedProjectFile {
  record: ProjectFileRecordSnapshot;
  absolutePath: string;
}

export class ProjectFileDeletionService {
  constructor(private readonly options: ProjectFileDeletionServiceOptions) {}

  inspect(target: FileDeletionTarget) {
    return this.inspectInternal(target);
  }

  delete(target: FileDeletionTarget): Promise<FileDeletionResult> {
    return this.options.coordinator.run(async () => {
      const inspection = await this.inspectInternal(target);
      if (!inspection.canDelete) throw new Error('FILE_DELETE_REFERENCED');
      if (inspection.action === 'trash_and_remove') {
        if (!inspection.absolutePath) throw new Error('FILE_DELETE_PATH_REQUIRED');
        await this.options.trashItem(inspection.absolutePath);
      }
      const removedAt = new Date().toISOString();
      const projectIds = new Set<string>();
      if (target.kind === 'project_file') {
        await this.options.files.markRemoved(target.projectId, target.fileId, removedAt);
        projectIds.add(target.projectId);
      } else {
        await this.options.artifacts.markRemoved(target.artifactId, removedAt);
      }
      const projectSnapshots = await Promise.all([...projectIds].map(async (projectId) => ({
        projectId,
        files: await this.options.files.list(projectId),
      })));
      return { target, removedAt, projectSnapshots };
    });
  }

  private async inspectInternal(target: FileDeletionTarget): Promise<FileDeletionInspection> {
    const [domain, attempts, indexedFiles] = await Promise.all([
      this.options.domain.snapshot(),
      this.options.executions.snapshot(),
      this.indexedProjectFiles(),
    ]);
    const workflows = (await Promise.all(domain.projects.map((project) => this.options.workflows.listProject(project.id)))).flat();
    const projectNames = new Map(domain.projects.map((project) => [project.id, project.name]));
    const tasks = new Map(domain.tasks.map((task) => [task.id, task]));
    const operationalTasks = operationalTaskReasons(domain.tasks, workflows);

    if (target.kind === 'project_file') {
      const snapshot = await this.options.files.deletionSnapshot(target.projectId, target.fileId);
      const linkedFileIds = indexedFiles
        .filter((item) => !item.record.removedAt && samePath(item.absolutePath, snapshot.absolutePath))
        .map((item) => item.record.fileId);
      const references = uniqueReferences(taskReferences(linkedFileIds, attempts.attempts, tasks, projectNames, operationalTasks));
      return inspection({
        target,
        name: path.basename(snapshot.record.relativePath),
        absolutePath: snapshot.absolutePath,
        available: snapshot.available,
        references,
      });
    }

    const artifact = await this.options.artifacts.deletionSnapshot(target.artifactId);
    const linkedFiles = indexedFiles.filter((item) => !item.record.removedAt && (
      item.record.artifactId === target.artifactId
      || Boolean(artifact.sourcePath && samePath(item.absolutePath, artifact.sourcePath))
    ));
    const references = uniqueReferences(taskReferences(
      linkedFiles.map((item) => item.record.fileId),
      attempts.attempts,
      tasks,
      projectNames,
      operationalTasks,
    ));
    const available = artifact.availability === 'available';
    return inspection({
      target,
      name: artifact.name,
      absolutePath: artifact.sourcePath,
      available,
      references,
      sourceUnavailable: artifact.availability === 'unavailable',
    });
  }

  private async indexedProjectFiles() {
    const records = await this.options.files.allSnapshots();
    const workspacePairs = await Promise.all([...new Set(records.map((record) => record.projectId))].map(async (projectId) => [
      projectId,
      await this.options.workspaces.get(projectId),
    ] as const));
    const workspaces = new Map(workspacePairs);
    return records.flatMap((record): IndexedProjectFile[] => {
      const workspace = workspaces.get(record.projectId);
      return workspace ? [{ record, absolutePath: path.resolve(workspace.rootPath, record.relativePath) }] : [];
    });
  }
}

function inspection(input: {
  target: FileDeletionTarget;
  name: string;
  absolutePath?: string;
  available: boolean;
  sourceUnavailable?: boolean;
  references: FileDeletionReference[];
}): FileDeletionInspection {
  const sourceState = input.available ? 'available' : input.sourceUnavailable ? 'unavailable' : 'missing';
  const canDelete = !input.available || input.references.length === 0;
  return {
    target: input.target,
    name: input.name,
    ...(input.absolutePath ? { absolutePath: input.absolutePath } : {}),
    sourceState,
    action: input.available && input.absolutePath ? 'trash_and_remove' : 'remove_record',
    requiresConfirmation: input.available,
    canDelete,
    references: input.references,
  };
}

function taskReferences(
  fileIds: string[],
  attempts: TaskAttempt[],
  tasks: Map<string, { id: string; code: string; title: string }>,
  projectNames: Map<string, string>,
  operationalTasks: Map<string, string[]>,
) {
  const targets = new Set(fileIds);
  if (!targets.size) return [];
  const references: FileDeletionReference[] = [];
  for (const attempt of attempts) {
    const reasons = operationalTasks.get(attempt.taskId);
    if (!reasons?.length || attempt.status === 'failed' || attempt.status === 'cancelled') continue;
    const sources = attemptFileReferenceSources(attempt);
    for (const source of sources) {
      for (const ref of source.refs) {
        if (!targets.has(ref.fileId)) continue;
        const task = tasks.get(attempt.taskId);
        const projectName = projectNames.get(attempt.projectId) ?? attempt.projectId;
        const taskName = task ? `${task.code} ${task.title}` : attempt.taskId;
        references.push({
          kind: 'task',
          label: `项目“${projectName}”的任务 ${taskName}（${reasons.join('、')}；${source.label}）`,
          projectId: attempt.projectId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          fileId: ref.fileId,
          relativePath: ref.relativePath,
        });
      }
    }
  }
  return references;
}

function operationalTaskReasons(
  tasks: Array<{ id: string; projectId: string; status: string; dependencyIds: string[] }>,
  workflows: Array<{ status: string; activatedTasks?: Array<{ taskId: string }> }>,
) {
  const reasons = new Map<string, Set<string>>();
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const activeWorkflowTaskIds = new Set(workflows
    .filter((workflow) => workflow.status === 'active')
    .flatMap((workflow) => workflow.activatedTasks?.map((mapping) => mapping.taskId) ?? []));
  const add = (taskId: string, reason: string) => {
    const current = reasons.get(taskId) ?? new Set<string>();
    current.add(reason);
    reasons.set(taskId, current);
  };
  const visitDependencies = (taskId: string, visited = new Set<string>()) => {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    for (const dependencyId of tasksById.get(taskId)?.dependencyIds ?? []) {
      add(dependencyId, '后续节点依赖');
      visitDependencies(dependencyId, visited);
    }
  };
  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled') continue;
    add(task.id, '未完成任务');
    if (activeWorkflowTaskIds.has(task.id)) add(task.id, '活动流程');
    visitDependencies(task.id);
  }
  return new Map([...reasons].map(([taskId, taskReasons]) => [taskId, [...taskReasons]]));
}

function attemptFileReferenceSources(attempt: TaskAttempt) {
  const sources: Array<{ label: string; refs: ProjectFileVersionRef[] }> = [];
  if (attempt.handoff?.fileRefs?.length) sources.push({ label: '结构化交付', refs: attempt.handoff.fileRefs });
  for (const dependency of attempt.contract?.dependencyHandoffs ?? []) {
    if (dependency.fileRefs?.length) sources.push({ label: '依赖交付', refs: dependency.fileRefs });
  }
  const stage = attempt.contract?.stageContext;
  if (stage?.type === 'review') {
    for (const handoff of stage.candidateHandoffs) if (handoff.fileRefs?.length) sources.push({ label: '复核输入', refs: handoff.fileRefs });
  } else if (stage?.type === 'rework') {
    for (const handoff of stage.previousHandoffs) if (handoff.fileRefs?.length) sources.push({ label: '返工输入', refs: handoff.fileRefs });
  }
  return sources;
}

function uniqueReferences(references: FileDeletionReference[]) {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = [reference.kind, reference.projectId, reference.taskId, reference.attemptId, reference.fileId, reference.relativePath, reference.label].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function samePath(left: string, right: string) { return pathKey(path.resolve(left)) === pathKey(path.resolve(right)); }
function pathKey(value: string) { return path.normalize(value).replaceAll('\\', '/').toLocaleLowerCase('en-US'); }

