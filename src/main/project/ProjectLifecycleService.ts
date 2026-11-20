import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProjectCreateRequest, ProjectDomainMigrationProject } from '../../shared/projectDomain';
import type { GeneralSettingsStore } from '../settings/GeneralSettingsStore';
import { validateProjectDirectory } from '../settings/projectDirectory';
import type { ArtifactDeliveryService } from './ArtifactDeliveryService';
import type { ProjectRunChangeRecorder } from './ProjectRunChangeRecorder';
import type { ProjectService } from './ProjectService';
import type { ProjectWorkflowGenerationStore } from './ProjectWorkflowGenerationStore';
import type { ProjectWorkspaceStore } from './ProjectWorkspaceStore';

interface ProjectLifecycleOptions {
  selections: Map<string, string>;
  projectService: Pick<ProjectService, 'initializeDomain' | 'createProject' | 'createWorkspace' | 'removeProject'>;
  projectWorkspaces: Pick<ProjectWorkspaceStore, 'get' | 'preview'>;
  generalSettings: Pick<GeneralSettingsStore, 'get'>;
  artifactDelivery: Pick<ArtifactDeliveryService, 'initializeProject'>;
  projectWorkflowGenerations: Pick<ProjectWorkflowGenerationStore, 'listProject' | 'removeProject'>;
  projectChanges: Pick<ProjectRunChangeRecorder, 'removeProject'>;
}

export class ProjectLifecycleService {
  constructor(private readonly options: ProjectLifecycleOptions) {}

  saveLocationSelection(directory: string) {
    const selectionId = randomUUID();
    const selectedPath = path.resolve(directory);
    this.options.selections.set(selectionId, selectedPath);
    return { selectionId, path: selectedPath };
  }

  async initializeDomain(legacyProjects: ProjectDomainMigrationProject[]) {
    const { projectService, projectWorkspaces, artifactDelivery } = this.options;
    const snapshot = await projectService.initializeDomain(legacyProjects);
    for (const project of snapshot.projects) {
      if (await projectWorkspaces.get(project.id)) await artifactDelivery.initializeProject(project.id);
    }
    return snapshot;
  }

  async previewCreateLocation(request: ProjectCreateRequest) {
    return (await this.resolveCreateLocation(request)).finalRoot;
  }

  async createProject(request: ProjectCreateRequest) {
    const { projectService, generalSettings, selections } = this.options;
    const { selectedRoot, finalRoot } = await this.resolveCreateLocation(request);
    if (request.confirmedRoot !== finalRoot) throw new Error('PROJECT_CREATE_LOCATION_CHANGED');
    if (!selectedRoot) {
      const custom = (await generalSettings.get()).settings.defaultProjectRoot;
      if (custom) await validateProjectDirectory(custom);
    }
    const result = await projectService.createProject({
      projectId: request.projectId,
      name: request.name,
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.avatarDataUrl !== undefined ? { avatarDataUrl: request.avatarDataUrl } : {}),
      ...(request.tags !== undefined ? { tags: request.tags } : {}),
      ...(request.memberIds !== undefined ? { memberIds: request.memberIds } : {}),
      selectedRoot: finalRoot,
    });
    if (request.locationSelectionId) selections.delete(request.locationSelectionId);
    return result;
  }

  async createWorkspace(value: { projectId: string; name: string; description?: unknown; locationSelectionId?: string }) {
    let selectedRoot: string | undefined;
    if (value.locationSelectionId !== undefined) {
      selectedRoot = this.options.selections.get(value.locationSelectionId);
      this.options.selections.delete(value.locationSelectionId);
      if (!selectedRoot) throw new Error('PROJECT_LOCATION_SELECTION_EXPIRED');
    }
    const workspace = await this.options.projectService.createWorkspace({
      projectId: value.projectId,
      name: value.name,
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(selectedRoot ? { selectedRoot } : {}),
    });
    return workspace;
  }

  async removeProject(projectId: string, roomIds: string[]) {
    const { projectService, projectWorkflowGenerations, projectChanges } = this.options;
    if ((await projectWorkflowGenerations.listProject(projectId)).some((generation) => generation.status === 'running')) throw new Error('PROJECT_HAS_ACTIVE_WORKFLOW_GENERATION');
    await projectService.removeProject(projectId, roomIds);
    await projectWorkflowGenerations.removeProject(projectId);
    await projectChanges.removeProject(projectId).catch((error) => console.error('Project change cleanup failed', error));
  }

  private async resolveCreateLocation(request: ProjectCreateRequest) {
    let selectedRoot: string | undefined;
    if (request.locationSelectionId !== undefined) {
      selectedRoot = this.options.selections.get(request.locationSelectionId);
      if (!selectedRoot) throw new Error('PROJECT_LOCATION_SELECTION_EXPIRED');
    }
    const finalRoot = (await this.options.projectWorkspaces.get(request.projectId))?.rootPath ?? await this.options.projectWorkspaces.preview({ projectId: request.projectId, name: request.name, selectedRoot });
    return { selectedRoot, finalRoot };
  }
}
