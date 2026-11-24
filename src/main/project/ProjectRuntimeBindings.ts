import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectDomainSnapshot } from '../../shared/projectDomain';
import { ProjectDomainStore } from './ProjectDomainStore';
import { ProjectFileStore } from './ProjectFileStore';
import { ProjectRunChangeRecorder } from './ProjectRunChangeRecorder';
import { ProjectService } from './ProjectService';
import { ProjectTaskOrchestrator } from './ProjectTaskOrchestrator';
import { ProjectTaskRuntime } from './ProjectTaskRuntime';
import { ProjectWorkRoleStore } from './ProjectWorkRoleStore';
import { ProjectWorkflowGenerationRuntime } from './ProjectWorkflowGenerationRuntime';
import { ProjectWorkflowGenerationStore } from './ProjectWorkflowGenerationStore';
import { ProjectWorkflowStore } from './ProjectWorkflowStore';
import { createMessageRuntime } from '../runtime/MessageRuntime';
import { RunCoordinator } from '../runtime/RunCoordinator';
import { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import { StudioRoomStore } from '../studio/StudioRoomStore';
import { StudioRuntimeCatalog } from '../studio/StudioRuntimeCatalog';
interface Dependencies {
  nativeBindings: NativeThreadBindingStore;
  projectChanges: ProjectRunChangeRecorder;
  projectDomain: ProjectDomainStore;
  projectFiles: ProjectFileStore;
  projectService: ProjectService;
  projectTaskOrchestrator: ProjectTaskOrchestrator;
  projectTaskRuntimeRef: { current?: ProjectTaskRuntime };
  projectWorkflowGenerations: ProjectWorkflowGenerationStore;
  projectWorkflows: ProjectWorkflowStore;
  projectWorkRoles: ProjectWorkRoleStore;
  runCoordinator: RunCoordinator;
  startApiRuntime: ReturnType<typeof createMessageRuntime>['startApiRuntime'];
  startLocalRuntime: ReturnType<typeof createMessageRuntime>['startLocalRuntime'];
  studioRooms: StudioRoomStore;
  studioRuntimeCatalog: StudioRuntimeCatalog;
  temporaryDirectory: () => string;
}

export function createProjectRuntimeBindings(dependencies: Dependencies) {
  const { nativeBindings, projectChanges, projectDomain, projectFiles, projectService, projectTaskOrchestrator, projectTaskRuntimeRef, projectWorkflowGenerations, projectWorkflows, projectWorkRoles, runCoordinator, startApiRuntime, startLocalRuntime, studioRooms, studioRuntimeCatalog, temporaryDirectory } = dependencies;
  const taskOptions: ConstructorParameters<typeof ProjectTaskRuntime>[0] = {
    catalog: studioRuntimeCatalog,
    bindings: nativeBindings,
    startApi: ({ partner, command, projectRoot }) => {
      if (partner.runtime.kind !== 'api') throw new Error('PROJECT_TASK_PARTNER_RUNTIME_UNAVAILABLE');
      return startApiRuntime({ connection: partner.runtime.connection, command, projectRootOverride: projectRoot });
    },
    startLocal: ({ partner, command, projectRoot }) => {
      if (partner.runtime.kind !== 'local') throw new Error('PROJECT_TASK_PARTNER_RUNTIME_UNAVAILABLE');
      return startLocalRuntime({
        adapterType: partner.runtime.adapterType,
        partnerId: partner.partnerId,
        partnerRootGrantId: partner.runtime.partnerRootGrantId,
        workspaceGrantIds: [],
        command,
        codexRuntimeId: partner.runtime.codexRuntimeId,
        codexRuntimeEnvironment: partner.runtime.codexRuntimeEnvironment,
        projectRootOverride: projectRoot,
      });
    },
    cancelRun: (command) => runCoordinator.cancel(command),
    submitHandoff: async (attemptId, handoff) => {
      const result = await projectTaskOrchestrator.submitHandoff(attemptId, handoff);
      projectTaskRuntimeRef.current?.reportChanges(attemptId, handoff.changedPaths, projectChanges, handoff.verification);
      return result;
    },
    submitReview: (attemptId, review) => projectTaskOrchestrator.submitReview(attemptId, review),
    captureChangedFiles: (projectId, changedPaths) => projectFiles.captureChangedPaths(projectId, changedPaths),
  };
  const workflowOptions: ConstructorParameters<typeof ProjectWorkflowGenerationRuntime>[0] = {
    generations: projectWorkflowGenerations,
    rooms: studioRooms,
    catalog: studioRuntimeCatalog,
    bindings: nativeBindings,
    project: (projectId) => projectDomain.getProject(projectId),
    roles: (projectId) => projectWorkRoles.catalog(projectId),
    workflowCatalog: (projectId) => projectService.workflowCatalog(projectId),
    createWorkflow: (input) => projectService.createGeneratedWorkflow(input),
    workflowForGeneration: (generationId) => projectWorkflows.getByGenerationId(generationId),
    startApi: ({ partner, command, planningRoot }) => {
      if (partner.runtime.kind !== 'api') throw new Error('PROJECT_WORKFLOW_GENERATION_PLANNER_UNAVAILABLE');
      return startApiRuntime({ connection: partner.runtime.connection, command, projectRootOverride: planningRoot });
    },
    startLocal: ({ partner, command, planningRoot }) => {
      if (partner.runtime.kind !== 'local') throw new Error('PROJECT_WORKFLOW_GENERATION_PLANNER_UNAVAILABLE');
      return startLocalRuntime({
        adapterType: partner.runtime.adapterType,
        partnerId: partner.partnerId,
        partnerRootGrantId: partner.runtime.partnerRootGrantId,
        workspaceGrantIds: [],
        command,
        codexRuntimeId: partner.runtime.codexRuntimeId,
        codexRuntimeEnvironment: partner.runtime.codexRuntimeEnvironment,
        projectRootOverride: planningRoot,
      });
    },
    cancelRun: (command) => runCoordinator.cancel(command),
    planningRoot: async () => {
      const root = path.join(temporaryDirectory(), 'workflow-planning');
      await mkdir(root, { recursive: true });
      return root;
    },
  };
  return { taskOptions, workflowOptions };
}

export function createProjectStateReconciler(projectTaskOrchestrator: ProjectTaskOrchestrator, projectWorkflows: ProjectWorkflowStore) {
  return (snapshot: ProjectDomainSnapshot) => {
    void projectTaskOrchestrator.reconcileProject(snapshot).catch((error) => console.error('Failed to reconcile project task dependencies.', error));
    for (const project of snapshot.projects) {
      void projectWorkflows.reconcileProject(project.id, snapshot.tasks.filter((task) => task.projectId === project.id))
        .catch((error) => console.error('Failed to reconcile project workflow state.', error));
    }
  };
}
