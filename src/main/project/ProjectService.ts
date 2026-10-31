import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ProjectMembershipChangeRequest } from '../../shared/projectWorkspace';
import type { PartnerWorkspaceStore, ProjectWorkspaceAssignment } from '../security/PartnerWorkspaceStore';
import type { ArtifactRegistry } from '../security/ArtifactRegistry';
import type { NativeThreadBindingStore } from '../studio/NativeThreadBindingStore';
import type { CreateProjectWorkspaceInput, ProjectWorkspaceStore } from './ProjectWorkspaceStore';
import type { StudioNoteStore } from '../studio/StudioNoteStore';
import type { StudioRoomStore } from '../studio/StudioRoomStore';
import type { StudioRoomMetadata } from '../../shared/studioRuntime';
import {
  ProjectTransactionStore,
  type ProjectDeleteTransaction,
  type ProjectMembershipTransaction,
  type ProjectWorkflowActivationTransaction,
} from './ProjectTransactionStore';
import { ProjectMutationCoordinator } from './ProjectMutationCoordinator';
import type { ProjectDeletionStore } from './ProjectDeletionStore';
import type { ProjectPermissionMode } from '../../shared/projectExecutionPolicy';
import type { ProjectExecutionPolicyStore } from './ProjectExecutionPolicyStore';
import type {
  ProjectCreateRequest,
  ProjectDomainMigrationProject,
  ProjectTaskCreateRequest,
  ProjectTaskRemoveRequest,
  ProjectTaskUpdateRequest,
  ProjectTaskExecutionConfig,
  ProjectUpdateRequest,
} from '../../shared/projectDomain';
import type { ProjectDomainStore } from './ProjectDomainStore';
import type { ProjectTaskExecutionStore } from './ProjectTaskExecutionStore';
import type { ProjectFileStore } from './ProjectFileStore';
import type { ProjectWorkRoleStore } from './ProjectWorkRoleStore';
import type { ProjectWorkflowStore } from './ProjectWorkflowStore';
import type { ProjectWorkflowTemplateStore } from './ProjectWorkflowTemplateStore';
import {
  instantiateProjectWorkflowTemplate,
  instantiateSavedProjectWorkflowTemplate,
  projectWorkflowCatalog,
  projectWorkflowTemplateSummary,
  validateProjectMethodTemplate,
} from './ProjectWorkflowTemplates';
import { taskContractFingerprint } from './ProjectTaskOrchestrator';
import {
  projectWorkRoleSnapshot,
  type ProjectWorkRoleArchiveRequest,
  type ProjectWorkRoleCreateRequest,
  type ProjectWorkRoleRemoveRequest,
  type ProjectWorkRoleUpdateRequest,
} from '../../shared/projectRoles';
import {
  projectMethodTemplateSnapshot,
  type ProjectWorkflowActivateRequest,
  type ProjectWorkflowCreateRequest,
  type ProjectWorkflowRemoveRequest,
  type ProjectWorkflowUpdateRequest,
  type ProjectWorkflowDraftNode,
  type ProjectWorkflowTemplateRemoveRequest,
  type ProjectWorkflowTemplateSaveRequest,
  type ProjectWorkflowTemplateUpdateRequest,
} from '../../shared/projectWorkflows';
import type {
  ProjectWorkflowDraftProposal,
  ProjectWorkflowGenerationProvenance,
  ProjectWorkflowGenerationSourceMessage,
} from '../../shared/projectWorkflowGeneration';
import type { ProjectNotebook } from '../../shared/projectNotebook';

interface ProjectServiceOptions {
  workspaces: ProjectWorkspaceStore;
  partnerWorkspaces: PartnerWorkspaceStore;
  rooms: StudioRoomStore;
  notes: StudioNoteStore;
  bindings: NativeThreadBindingStore;
  transactions: ProjectTransactionStore;
  deletions: ProjectDeletionStore;
  executionPolicies: ProjectExecutionPolicyStore;
  domain: ProjectDomainStore;
  roles: ProjectWorkRoleStore;
  workflows: ProjectWorkflowStore;
  workflowTemplates: ProjectWorkflowTemplateStore;
  executions?: ProjectTaskExecutionStore;
  artifacts: Pick<ArtifactRegistry, 'listProjectDeliveries' | 'removeProjectDeliveries' | 'restoreProjectDeliveries'>;
  files?: Pick<ProjectFileStore, 'initializeProject' | 'projectSnapshot' | 'removeProject' | 'restoreProject'>;
  notebooks?: {
    snapshotProject: (projectId: string) => Promise<ProjectNotebook[]>;
    applyProjectMembership: (projectId: string, projectName: string, activePartnerIds: string[]) => Promise<void>;
    archiveProject: (projectId: string, projectName: string) => Promise<ProjectNotebook[]>;
    restoreProject: (notebooks: ProjectNotebook[]) => Promise<void>;
  };
  coordinator?: ProjectMutationCoordinator;
  workflowActivationGuard?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export class ProjectService {
  private readonly coordinator: ProjectMutationCoordinator;
  private recovered?: Promise<void>;

  constructor(private readonly options: ProjectServiceOptions) {
    this.coordinator = options.coordinator ?? new ProjectMutationCoordinator();
  }

  recover() {
    this.recovered ??= this.coordinator.run(() => this.recoverPending());
    return this.recovered;
  }

  initializeDomain(legacyProjects: ProjectDomainMigrationProject[]) {
    return this.run(async () => this.options.domain.initialize(legacyProjects, await this.options.deletions.list()));
  }

  createProject(input: Omit<ProjectCreateRequest, 'locationSelectionId'> & { selectedRoot?: string }) {
    return this.run(async () => {
      validateProjectId(input.projectId);
      if (await this.options.domain.getProject(input.projectId) || await this.options.workspaces.get(input.projectId)) throw new Error('PROJECT_ALREADY_EXISTS');
      const transaction = await this.options.transactions.begin({ kind: 'project_create', projectId: input.projectId });
      try {
        const project = await this.options.domain.createProject({
          id: input.projectId,
          name: input.name,
          description: input.description,
          avatarDataUrl: input.avatarDataUrl,
          tags: input.tags,
          memberIds: input.memberIds,
        });
        const workspace = await this.options.workspaces.create({
          projectId: input.projectId,
          name: project.name,
          description: project.description,
          ...(input.selectedRoot ? { selectedRoot: input.selectedRoot } : {}),
        });
        await this.options.files?.initializeProject(workspace);
        await this.options.executionPolicies.getOrCreate(input.projectId);
        await this.options.deletions.markActive(input.projectId);
        await this.options.transactions.clear(transaction.transactionId);
        this.coordinator.markProjectActive(input.projectId);
        return { project, workspace };
      } catch (error) {
        try {
          await this.cleanupCreate(input.projectId);
          await this.options.transactions.clear(transaction.transactionId);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'PROJECT_CREATE_COMPENSATION_FAILED', { cause: rollbackError });
        }
        throw error;
      }
    });
  }

  createWorkspace(input: CreateProjectWorkspaceInput) {
    return this.run(async () => {
      if (!await this.options.domain.getProject(input.projectId)) throw new Error('PROJECT_NOT_FOUND');
      const workspace = await this.options.workspaces.create(input);
      await this.options.files?.initializeProject(workspace);
      await this.options.executionPolicies.getOrCreate(input.projectId);
      await this.options.deletions.markActive(input.projectId);
      this.coordinator.markProjectActive(input.projectId);
      return workspace;
    });
  }

  updateProject(input: ProjectUpdateRequest) {
    return this.run(() => this.options.domain.updateProject(input));
  }

  createTask(input: ProjectTaskCreateRequest) {
    return this.run(async () => {
      const execution = await this.validateTaskExecution(input.projectId, input.execution);
      return this.options.domain.createTask({ ...input, ...(execution ? { execution } : {}) });
    });
  }

  updateTask(input: ProjectTaskUpdateRequest) {
    return this.run(async () => {
      await this.assertTaskMutable(input.projectId, input.taskId);
      const snapshot = await this.options.domain.projectSnapshot(input.projectId);
      const existing = snapshot?.tasks.find((task) => task.id === input.taskId);
      if (!existing) throw new Error('PROJECT_TASK_NOT_FOUND');
      const execution = input.execution
        ? await this.validateTaskExecution(input.projectId, input.execution, existing.execution)
        : undefined;
      return this.options.domain.updateTask({ ...input, ...(execution ? { execution } : {}) });
    });
  }

  listRoles(projectId: string) {
    return this.run(async () => {
      if (!await this.options.domain.getProject(projectId)) throw new Error('PROJECT_NOT_FOUND');
      return this.options.roles.catalog(projectId);
    });
  }

  createRole(request: ProjectWorkRoleCreateRequest) {
    return this.run(async () => {
      if (request.scope === 'project' && (!request.projectId || !await this.options.domain.getProject(request.projectId))) throw new Error('PROJECT_NOT_FOUND');
      return this.options.roles.create(request);
    });
  }

  updateRole(request: ProjectWorkRoleUpdateRequest) {
    return this.run(() => this.options.roles.update(request));
  }

  archiveRole(request: ProjectWorkRoleArchiveRequest) {
    return this.run(() => this.options.roles.setArchived(request));
  }

  removeRole(request: ProjectWorkRoleRemoveRequest) {
    return this.run(() => this.options.roles.remove(request));
  }

  workflowCatalog(projectId: string) {
    return this.run(async () => {
      if (!await this.options.domain.getProject(projectId)) throw new Error('PROJECT_NOT_FOUND');
      const catalog = projectWorkflowCatalog();
      const projectTemplates = await this.options.workflowTemplates.listProject(projectId);
      return { ...catalog, templates: [...catalog.templates, ...projectTemplates.map(projectWorkflowTemplateSummary)] };
    });
  }

  listWorkflows(projectId: string) {
    return this.run(async () => {
      if (!await this.options.domain.getProject(projectId)) throw new Error('PROJECT_NOT_FOUND');
      return this.options.workflows.listProject(projectId);
    });
  }

  createWorkflow(request: ProjectWorkflowCreateRequest) {
    return this.run(async () => {
      const project = await this.options.domain.getProject(request.projectId);
      if (!project) throw new Error('PROJECT_NOT_FOUND');
      const roles = (await this.options.roles.catalog(request.projectId)).roles;
      const savedTemplate = await this.options.workflowTemplates.get(request.projectId, request.templateId);
      const instantiated = savedTemplate
        ? instantiateSavedProjectWorkflowTemplate(savedTemplate, roles, project)
        : { ...instantiateProjectWorkflowTemplate(request.templateId, roles), warnings: [] as string[] };
      return this.options.workflows.createDraft({
        projectId: request.projectId,
        name: request.name?.trim() || instantiated.template.name,
        description: instantiated.template.description,
        sourceTemplate: { templateId: instantiated.template.id, templateVersion: instantiated.template.version },
        ...(instantiated.warnings.length ? { templateWarnings: instantiated.warnings } : {}),
        nodes: instantiated.nodes,
      });
    });
  }

  createGeneratedWorkflow(input: {
    projectId: string;
    roomId: string;
    plannerPartnerId: string;
    generationId: string;
    sourceDigest: string;
    sourceMessages: ProjectWorkflowGenerationSourceMessage[];
    proposal: ProjectWorkflowDraftProposal;
  }) {
    return this.run(async () => {
      const repeated = await this.options.workflows.getByGenerationId(input.generationId);
      if (repeated) return repeated;
      const project = await this.options.domain.getProject(input.projectId);
      if (!project) throw new Error('PROJECT_NOT_FOUND');
      if (!input.proposal.nodes.length) throw new Error('PROJECT_WORKFLOW_GENERATION_EMPTY');
      if (input.proposal.nodes.length > 40) throw new Error('PROJECT_WORKFLOW_GENERATION_NODE_LIMIT');
      const roleCatalog = await this.options.roles.catalog(input.projectId);
      const roles = new Map(roleCatalog.roles.filter((role) => !role.archivedAt).map((role) => [role.id, role]));
      const methods = new Map(projectWorkflowCatalog().methods.map((method) => [method.templateId, method]));
      const sourceMessageIds = new Set(input.sourceMessages.map((message) => message.messageId));
      const clientKeys = input.proposal.nodes.map((node) => cleanProposalKey(node.clientKey));
      if (new Set(clientKeys).size !== clientKeys.length) throw new Error('PROJECT_WORKFLOW_GENERATION_NODE_DUPLICATE');
      const nodeIds = new Map(clientKeys.map((key) => [key, randomUUID()]));
      const warnings: string[] = [];
      const nodes: ProjectWorkflowDraftNode[] = input.proposal.nodes.map((proposalNode, position) => {
        const clientKey = clientKeys[position];
        if (proposalNode.dependencyKeys.some((key) => !nodeIds.has(key))) throw new Error('PROJECT_WORKFLOW_GENERATION_DEPENDENCY_INVALID');
        if (!proposalNode.sourceMessageIds.length) throw new Error('PROJECT_WORKFLOW_GENERATION_NODE_SOURCE_REQUIRED');
        if (proposalNode.sourceMessageIds.some((id) => !sourceMessageIds.has(id))) throw new Error('PROJECT_WORKFLOW_GENERATION_SOURCE_INVALID');
        let assigneeId = proposalNode.assigneePartnerId;
        if (assigneeId && !project.memberIds.includes(assigneeId)) {
          warnings.push(`“${proposalNode.title}”的执行伙伴已不在项目中，请重新选择。`);
          assigneeId = undefined;
        }
        const execution: ProjectTaskExecutionConfig = {};
        if (proposalNode.workRoleId) {
          const role = roles.get(proposalNode.workRoleId);
          if (role) execution.workRole = projectWorkRoleSnapshot(role);
          else warnings.push(`“${proposalNode.title}”的执行角色已不可用，请重新选择。`);
        }
        let completionRule = structuredClone(proposalNode.completionRule);
        if (completionRule.type === 'partner_review') {
          if (!project.memberIds.includes(completionRule.reviewerPartnerId) || completionRule.reviewerPartnerId === assigneeId) {
            warnings.push(`“${proposalNode.title}”的独立复核伙伴已不可用，已改为等待用户确认。`);
            completionRule = { type: 'user_confirm' };
          } else if (proposalNode.reviewRoleId) {
            const role = roles.get(proposalNode.reviewRoleId);
            if (role) execution.reviewWorkRole = projectWorkRoleSnapshot(role);
            else warnings.push(`“${proposalNode.title}”的复核角色已不可用，请重新选择。`);
          }
        }
        execution.completionRule = completionRule;
        if (proposalNode.methodTemplateId) {
          const method = methods.get(proposalNode.methodTemplateId);
          if (method) execution.methodTemplate = projectMethodTemplateSnapshot(method);
          else warnings.push(`“${proposalNode.title}”的方法模板已不可用，请重新选择。`);
        }
        return {
          id: nodeIds.get(clientKey)!, position, title: proposalNode.title, description: proposalNode.description,
          ...(assigneeId ? { assigneeId } : {}),
          dependencyNodeIds: proposalNode.dependencyKeys.map((key) => nodeIds.get(key)!),
          acceptanceCriteria: proposalNode.acceptanceCriteria, note: proposalNode.note ?? '', execution,
        };
      });
      const provenance: ProjectWorkflowGenerationProvenance = {
        generationId: input.generationId,
        roomId: input.roomId,
        plannerPartnerId: input.plannerPartnerId,
        sourceDigest: input.sourceDigest,
        messageRefs: input.sourceMessages.map(({ messageId, seq, contentHash }) => ({ messageId, seq, contentHash })),
        generationSummary: input.proposal.generationSummary,
        nodeBasis: input.proposal.nodes.map((node, index) => ({
          draftNodeId: nodeIds.get(clientKeys[index])!,
          sourceMessageIds: [...new Set(node.sourceMessageIds)],
          ...(node.basisSummary?.trim() ? { summary: node.basisSummary.trim() } : {}),
        })),
        generatedAt: new Date().toISOString(),
      };
      const validated = await this.validateWorkflowNodes(input.projectId, nodes, []);
      return this.options.workflows.createDraft({
        projectId: input.projectId,
        name: input.proposal.name,
        description: input.proposal.description,
        generationProvenance: provenance,
        ...(warnings.length ? { generationWarnings: warnings } : {}),
        nodes: validated,
      });
    });
  }

  updateWorkflow(request: ProjectWorkflowUpdateRequest) {
    return this.run(async () => {
      const existing = await this.options.workflows.get(request.projectId, request.workflowId);
      if (!existing) throw new Error('PROJECT_WORKFLOW_NOT_FOUND');
      const nodes = await this.validateWorkflowNodes(request.projectId, request.nodes, existing.nodes);
      return this.options.workflows.updateDraft({ ...request, nodes });
    });
  }

  removeWorkflow(request: ProjectWorkflowRemoveRequest) {
    return this.run(() => this.options.workflows.remove(request.projectId, request.workflowId, request.expectedRevision));
  }

  saveWorkflowTemplate(request: ProjectWorkflowTemplateSaveRequest) {
    return this.run(async () => {
      const workflow = await this.requireTemplateSourceWorkflow(request.projectId, request.workflowId, request.expectedWorkflowRevision);
      return this.options.workflowTemplates.create({
        projectId: request.projectId,
        name: request.name,
        description: request.description ?? '',
        nodes: workflow.nodes,
      });
    });
  }

  updateWorkflowTemplate(request: ProjectWorkflowTemplateUpdateRequest) {
    return this.run(async () => {
      const workflow = await this.requireTemplateSourceWorkflow(request.projectId, request.workflowId, request.expectedWorkflowRevision);
      return this.options.workflowTemplates.update({
        projectId: request.projectId,
        templateId: request.templateId,
        expectedRevision: request.expectedTemplateRevision,
        name: request.name,
        description: request.description ?? '',
        nodes: workflow.nodes,
      });
    });
  }

  removeWorkflowTemplate(request: ProjectWorkflowTemplateRemoveRequest) {
    return this.run(async () => {
      if (!await this.options.domain.getProject(request.projectId)) throw new Error('PROJECT_NOT_FOUND');
      return this.options.workflowTemplates.remove(request.projectId, request.templateId, request.expectedRevision);
    });
  }

  activateWorkflow(request: ProjectWorkflowActivateRequest) {
    const activate = () => this.run(() => this.activateWorkflowNow(request));
    return this.options.workflowActivationGuard ? this.options.workflowActivationGuard(activate) : activate();
  }

  removeTask(input: ProjectTaskRemoveRequest) {
    return this.run(async () => {
      await this.assertTaskMutable(input.projectId, input.taskId);
      await this.options.workflows.assertTaskRemovable(input.projectId, input.taskId);
      return this.options.domain.removeTask(input.projectId, input.taskId, input.expectedRevision);
    });
  }

  getWorkspace(projectId: string) {
    return this.run(() => this.options.workspaces.get(projectId));
  }

  getExecutionPolicy(projectId: string) {
    return this.run(async () => {
      this.coordinator.assertProjectActive(projectId);
      if (!await this.options.workspaces.get(projectId)) throw new Error('PROJECT_NOT_FOUND');
      return this.options.executionPolicies.getOrCreate(projectId);
    });
  }

  setExecutionPolicy(projectId: string, permissionMode: ProjectPermissionMode) {
    return this.run(async () => {
      this.coordinator.assertProjectActive(projectId);
      if (!await this.options.workspaces.get(projectId)) throw new Error('PROJECT_NOT_FOUND');
      return this.options.executionPolicies.update(projectId, permissionMode);
    });
  }

  syncWorkspaceMemberships(assignments: ProjectWorkspaceAssignment[]) {
    return this.run(() => this.options.partnerWorkspaces.reconcileProjects(assignments));
  }

  syncRoom(metadata: StudioRoomMetadata) {
    return this.run(async () => {
      this.coordinator.assertProjectActive(metadata.projectId);
      const current = await this.options.rooms.getRoom(metadata.roomId);
      if (current && current.metadata.projectId !== metadata.projectId) throw new Error('PROJECT_ROOM_SCOPE_MISMATCH');
      // Hydration may update names, but stale UI state cannot undo a committed
      // leave/rejoin or bypass the member transaction and its binding reset.
      return this.options.rooms.syncRoom(current ? { ...metadata, memberIds: current.metadata.memberIds } : metadata);
    });
  }

  changeMembers(request: ProjectMembershipChangeRequest) {
    return this.run(async () => {
      validateMembershipRequest(request);
      this.coordinator.assertProjectActive(request.projectId);
      await this.assertProjectMutable(request.projectId);
      const projectMemberIds = unique(request.projectMemberIds);
      const requestedRooms = request.rooms.map((change) => ({
        ...change,
        room: { ...change.room, memberIds: unique(change.room.memberIds) },
        announcements: unique(change.announcements ?? []),
      }));
      for (const change of requestedRooms) if (change.room.memberIds.some((id) => !projectMemberIds.includes(id))) throw new Error('PROJECT_ROOM_MEMBER_NOT_IN_PROJECT');

      const workspace = await this.options.workspaces.get(request.projectId);
      const rootPath = workspace && await stat(workspace.rootPath).then((value) => value.isDirectory() ? workspace.rootPath : undefined).catch(() => undefined);
      const previousPartnerIds = await this.options.partnerWorkspaces.projectPartnerIds(request.projectId);
      const previousRooms = await this.options.rooms.listProject(request.projectId);
      if (previousRooms.some((room) => room.activeRound && !['completed', 'failed', 'cancelled'].includes(room.activeRound.state))) throw new Error('STUDIO_PROJECT_HAS_ACTIVE_ROUND');
      const previousBindings = await this.options.bindings.listForRooms(previousRooms.map((room) => room.metadata.roomId));
      const previousDomain = await this.options.domain.projectSnapshot(request.projectId);
      if (!previousDomain) throw new Error('PROJECT_NOT_FOUND');
      const projectNotebooks = await this.options.notebooks?.snapshotProject(request.projectId);
      const requestedRoomIds = new Set(requestedRooms.map((change) => change.room.roomId));
      const rooms = [
        ...requestedRooms,
        ...previousRooms.filter((snapshot) => !requestedRoomIds.has(snapshot.metadata.roomId)).map((snapshot) => ({
          room: {
            ...snapshot.metadata,
            memberIds: snapshot.metadata.memberIds.filter((partnerId) => projectMemberIds.includes(partnerId)),
          },
          announcements: [],
        })),
      ];
      const transaction = await this.options.transactions.begin({
        kind: 'project_membership',
        bindings: previousBindings,
        projectId: request.projectId,
        rooms: previousRooms,
        partnerIds: previousPartnerIds,
        project: previousDomain.project,
        tasks: previousDomain.tasks,
        projectNotebooks,
        ...(rootPath ? { rootPath } : {}),
      });
      try {
        const workspaceStates = await this.options.partnerWorkspaces.reconcileProject({ projectId: request.projectId, rootPath, partnerIds: projectMemberIds });
        const snapshots = await this.options.rooms.applyProjectMemberships(request.projectId, rooms);
        for (const before of previousRooms) {
          const after = snapshots.find((room) => room.metadata.roomId === before.metadata.roomId);
          const removed = before.metadata.memberIds.filter((partnerId) => !after?.metadata.memberIds.includes(partnerId));
          if (removed.length) await this.options.bindings.invalidateRoomMembers(before.metadata.roomId, removed);
        }
        const project = await this.options.domain.updateMembers(request.projectId, projectMemberIds);
        await this.options.notebooks?.applyProjectMembership(request.projectId, project.name, projectMemberIds);
        await this.options.transactions.clear(transaction.transactionId);
        return { projectId: request.projectId, projectMemberIds, project, rooms: snapshots, workspaceStates };
      } catch (error) {
        try {
          await this.restoreMembership(transaction);
          await this.options.transactions.clear(transaction.transactionId);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'PROJECT_MEMBER_COMPENSATION_FAILED', { cause: rollbackError });
        }
        throw error;
      }
    });
  }

  removeProject(projectId: string, requestedRoomIds: string[]) {
    return this.run(async () => {
      validateProjectId(projectId);
      await this.assertProjectMutable(projectId);
      const requestedRooms = await Promise.all(unique(requestedRoomIds).map((roomId) => this.options.rooms.getRoom(roomId)));
      if (requestedRooms.some((room) => room && room.metadata.projectId !== projectId)) throw new Error('PROJECT_ROOM_SCOPE_MISMATCH');
      const rooms = await this.options.rooms.listProject(projectId);
      if (rooms.some((room) => room.activeRound && !['completed', 'failed', 'cancelled'].includes(room.activeRound.state))) throw new Error('STUDIO_PROJECT_HAS_ACTIVE_ROUND');
      const notes = await this.options.notes.list(projectId);
      const workspace = await this.options.workspaces.get(projectId);
      const executionPolicy = await this.options.executionPolicies.getOrCreate(projectId);
      const domain = await this.options.domain.projectSnapshot(projectId);
      const taskExecution = await this.options.executions?.projectSnapshot(projectId);
      const partnerIds = await this.options.partnerWorkspaces.projectPartnerIds(projectId);
      const roomIds = unique([...rooms.map((room) => room.metadata.roomId), ...requestedRoomIds]);
      const bindings = [
        ...await this.options.bindings.listForRooms(roomIds),
        ...await this.options.bindings.listForProjects([projectId]),
      ];
      const deliveries = await this.options.artifacts.listProjectDeliveries(projectId);
      const projectFiles = await this.options.files?.projectSnapshot(projectId);
      const projectRoles = await this.options.roles.projectRoles(projectId);
      const projectWorkflows = await this.options.workflows.listProject(projectId);
      const projectWorkflowTemplates = await this.options.workflowTemplates.listProject(projectId);
      const projectNotebooks = await this.options.notebooks?.snapshotProject(projectId);
      const transaction = await this.options.transactions.begin({
        kind: 'project_delete', projectId, rooms, notes, workspace, executionPolicy,
        project: domain?.project, tasks: domain?.tasks, projectRoles, projectWorkflows, projectWorkflowTemplates, taskExecution, partnerIds, bindings, deliveries, projectFiles, projectNotebooks,
      });
      try {
        await this.options.notes.removeProject(projectId);
        await this.options.partnerWorkspaces.reconcileProject({ projectId, partnerIds: [] });
        await this.options.workspaces.remove(projectId);
        await this.options.files?.removeProject(projectId);
        await this.options.executionPolicies.remove(projectId);
        await this.options.executions?.removeProject(projectId);
        await this.options.roles.removeProject(projectId);
        await this.options.workflows.removeProject(projectId);
        await this.options.workflowTemplates.removeProject(projectId);
        if (domain?.project) await this.options.notebooks?.archiveProject(projectId, domain.project.name);
        await this.options.domain.removeProject(projectId);
        await this.options.bindings.removeProjects([projectId]);
        await this.options.artifacts.removeProjectDeliveries(projectId);
        await this.options.deletions.markDeleted(projectId);
        await this.options.transactions.clear(transaction.transactionId);
        this.coordinator.markProjectDeleted(projectId);
      } catch (error) {
        try {
          await this.restoreDelete(transaction);
          await this.options.transactions.clear(transaction.transactionId);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'PROJECT_DELETE_COMPENSATION_FAILED', { cause: rollbackError });
        }
        throw error;
      }
    });
  }

  removeRoom(roomId: string) {
    return this.run(async () => {
      const room = await this.options.rooms.getRoom(roomId);
      if (!room) return;
      if (room.activeRound && !['completed', 'failed', 'cancelled'].includes(room.activeRound.state)) throw new Error('STUDIO_ROUND_ALREADY_ACTIVE');
      const bindings = await this.options.bindings.listForRooms([roomId]);
      try {
        await this.options.rooms.removeRoom(roomId);
        await this.options.bindings.removeRooms([roomId]);
      } catch (error) {
        await this.options.rooms.restoreProject(room.metadata.projectId, [
          ...(await this.options.rooms.listProject(room.metadata.projectId)).filter((item) => item.metadata.roomId !== roomId),
          room,
        ]);
        await this.options.bindings.restore(bindings);
        throw error;
      }
    });
  }

  private async activateWorkflowNow(request: ProjectWorkflowActivateRequest) {
    validateProjectId(request.projectId);
    const workflow = await this.options.workflows.get(request.projectId, request.workflowId);
    if (!workflow) throw new Error('PROJECT_WORKFLOW_NOT_FOUND');
    if ((workflow.status === 'active' || workflow.status === 'completed') && workflow.activationId === request.activationId) {
      const execution = await this.options.executions?.snapshot(request.projectId);
      const taskIds = workflow.activatedTasks?.map((item) => item.taskId) ?? [];
      return {
        workflow,
        taskIds,
        attemptIds: execution?.attempts.filter((attempt) => taskIds.includes(attempt.taskId) && attempt.purpose === 'execution').map((attempt) => attempt.id) ?? [],
      };
    }
    if (!this.options.executions) throw new Error('PROJECT_TASK_EXECUTION_NOT_CONNECTED');
    if (!workflow.nodes.length) throw new Error('PROJECT_WORKFLOW_EMPTY');
    if (!await this.options.workspaces.get(request.projectId)) throw new Error('PROJECT_WORKSPACE_NOT_READY');
    await this.assertProjectMutable(request.projectId);
    const domain = await this.options.domain.projectSnapshot(request.projectId);
    if (!domain) throw new Error('PROJECT_NOT_FOUND');
    const execution = await this.options.executions.projectSnapshot(request.projectId);
    const activationId = request.activationId;
    const transaction = await this.options.transactions.begin({
      kind: 'workflow_activation', projectId: request.projectId, workflow,
      project: domain.project, tasks: domain.tasks, taskExecution: execution, activationId,
    });
    try {
      await this.options.workflows.markActivating(request.projectId, request.workflowId, request.expectedRevision, activationId);
      const taskIds = new Map(workflow.nodes.map((node) => [node.id, randomUUID()]));
      const created = await this.options.domain.createTaskBatch(request.projectId, workflow.nodes.map((node) => ({
        projectId: request.projectId,
        taskId: taskIds.get(node.id)!,
        title: node.title,
        description: node.description,
        assigneeId: node.assigneeId,
        status: node.dependencyNodeIds.length ? 'blocked' : 'todo',
        dependencyIds: node.dependencyNodeIds.map((id) => taskIds.get(id)!),
        acceptanceCriteria: node.acceptanceCriteria,
        note: node.note,
        execution: node.execution,
      })));
      const policy = await this.options.executionPolicies.getOrCreate(request.projectId);
      const attempts = await this.options.executions.createAttemptBatch(created.map((task) => {
        if (!task.assigneeId) throw new Error('PROJECT_WORKFLOW_ASSIGNEE_REQUIRED');
        return {
          projectId: request.projectId,
          taskId: task.id,
          taskRevision: task.revision,
          contractSourceFingerprint: taskContractFingerprint(task),
          assigneeId: task.assigneeId,
          permissionMode: policy.permissionMode,
          blockedByTaskIds: [...task.dependencyIds],
        };
      }));
      const active = await this.options.workflows.markActive(
        request.projectId,
        request.workflowId,
        activationId,
        workflow.nodes.map((node) => ({ draftNodeId: node.id, taskId: taskIds.get(node.id)! })),
      );
      await this.options.transactions.clear(transaction.transactionId);
      return { workflow: active, taskIds: created.map((task) => task.id), attemptIds: attempts.map((attempt) => attempt.id) };
    } catch (error) {
      try {
        await this.restoreWorkflowActivation(transaction);
        await this.options.transactions.clear(transaction.transactionId);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'PROJECT_WORKFLOW_ACTIVATION_COMPENSATION_FAILED', { cause: rollbackError });
      }
      throw error;
    }
  }

  private run<T>(operation: () => Promise<T>) {
    return this.recover().then(() => this.coordinator.run(operation));
  }

  private async recoverPending() {
    const pending = await this.options.transactions.get();
    if (pending) {
      if (pending.kind === 'project_create') await this.cleanupCreate(pending.projectId);
      else if (pending.kind === 'project_delete') await this.restoreDelete(pending);
      else if (pending.kind === 'project_membership') await this.restoreMembership(pending);
      else await this.restoreWorkflowActivation(pending);
      await this.options.transactions.clear(pending.transactionId);
    }
    this.coordinator.replaceDeletedProjects(await this.options.deletions.list());
    const domain = await this.options.domain.snapshot();
    for (const project of domain.projects) {
      await this.options.workflows.reconcileProject(project.id, domain.tasks.filter((task) => task.projectId === project.id));
    }
  }

  private async restoreMembership(transaction: ProjectMembershipTransaction) {
    if (transaction.bindings) await this.options.bindings.restore(transaction.bindings);
    if (transaction.project) await this.options.domain.restoreProject(transaction.project, transaction.tasks ?? []);
    if (transaction.projectNotebooks) await this.options.notebooks?.restoreProject(transaction.projectNotebooks);
    await this.options.rooms.restoreProject(transaction.projectId, transaction.rooms);
    await this.options.partnerWorkspaces.reconcileProject({
      projectId: transaction.projectId,
      rootPath: transaction.rootPath,
      partnerIds: transaction.partnerIds,
    });
  }

  private async restoreDelete(transaction: ProjectDeleteTransaction) {
    if (transaction.project) await this.options.domain.restoreProject(transaction.project, transaction.tasks ?? []);
    await this.options.roles.restoreProject(transaction.projectId, transaction.projectRoles ?? []);
    await this.options.workflows.restoreProject(transaction.projectId, transaction.projectWorkflows ?? []);
    await this.options.workflowTemplates.restoreProject(transaction.projectId, transaction.projectWorkflowTemplates ?? []);
    if (transaction.taskExecution && this.options.executions) await this.options.executions.restoreProject(transaction.taskExecution);
    if (transaction.workspace) await this.options.workspaces.restore(transaction.workspace);
    if (transaction.projectFiles?.length) await this.options.files?.restoreProject(transaction.projectFiles);
    if (transaction.executionPolicy) await this.options.executionPolicies.restore(transaction.executionPolicy);
    if (transaction.projectNotebooks) await this.options.notebooks?.restoreProject(transaction.projectNotebooks);
    await this.options.notes.restoreProject(transaction.projectId, transaction.notes);
    await this.options.rooms.restoreProject(transaction.projectId, transaction.rooms);
    await this.options.partnerWorkspaces.reconcileProject({
      projectId: transaction.projectId,
      rootPath: transaction.workspace?.rootPath,
      partnerIds: transaction.partnerIds,
    });
    await this.options.bindings.restore(transaction.bindings);
    await this.options.artifacts.restoreProjectDeliveries(transaction.deliveries);
    await this.options.deletions.markActive(transaction.projectId);
    this.coordinator.markProjectActive(transaction.projectId);
  }

  private async cleanupCreate(projectId: string) {
    await this.options.domain.removeProject(projectId);
    await this.options.roles.removeProject(projectId);
    await this.options.workflows.removeProject(projectId);
    await this.options.workflowTemplates.removeProject(projectId);
    await this.options.executions?.removeProject(projectId);
    await this.options.workspaces.remove(projectId);
    await this.options.files?.removeProject(projectId);
    await this.options.executionPolicies.remove(projectId);
  }

  private async assertTaskMutable(projectId: string, taskId: string) {
    if (await this.options.executions?.activeForTask(projectId, taskId)
      || await this.options.executions?.pendingCompletionForTask(projectId, taskId)) throw new Error('PROJECT_TASK_HAS_ACTIVE_ATTEMPT');
  }

  private async assertProjectMutable(projectId: string) {
    if ((await this.options.executions?.activeForProject(projectId))?.length) throw new Error('PROJECT_HAS_ACTIVE_TASK_ATTEMPTS');
  }

  private async restoreWorkflowActivation(transaction: ProjectWorkflowActivationTransaction) {
    await this.options.domain.restoreProject(transaction.project, transaction.tasks);
    if (this.options.executions) await this.options.executions.restoreProject(transaction.taskExecution);
    await this.options.workflows.restore(transaction.workflow);
  }

  private async validateTaskExecution(projectId: string, execution?: ProjectTaskExecutionConfig, existing?: ProjectTaskExecutionConfig) {
    if (!execution) return undefined;
    const validated: ProjectTaskExecutionConfig = { ...execution };
    if (execution.workRole && !sameRoleSnapshot(execution.workRole, existing?.workRole)) {
      validated.workRole = await this.options.roles.validateSnapshot(projectId, execution.workRole);
    }
    if (execution.reviewWorkRole && !sameRoleSnapshot(execution.reviewWorkRole, existing?.reviewWorkRole)) {
      validated.reviewWorkRole = await this.options.roles.validateSnapshot(projectId, execution.reviewWorkRole);
    }
    if (execution.methodTemplate) validated.methodTemplate = validateProjectMethodTemplate(execution.methodTemplate, existing?.methodTemplate);
    return validated;
  }

  private async validateWorkflowNodes(projectId: string, nodes: ProjectWorkflowDraftNode[], existingNodes: ProjectWorkflowDraftNode[]) {
    const existing = new Map(existingNodes.map((node) => [node.id, node]));
    const project = await this.options.domain.getProject(projectId);
    if (!project) throw new Error('PROJECT_NOT_FOUND');
    return Promise.all(nodes.map(async (node) => {
      if (node.assigneeId && !project.memberIds.includes(node.assigneeId)) throw new Error('PROJECT_TASK_ASSIGNEE_NOT_MEMBER');
      const previous = existing.get(node.id);
      const execution = await this.validateTaskExecution(projectId, node.execution, previous?.execution);
      if (execution?.completionRule?.type === 'partner_review') {
        if (!project.memberIds.includes(execution.completionRule.reviewerPartnerId)) throw new Error('PROJECT_TASK_REVIEWER_NOT_MEMBER');
        if (execution.completionRule.reviewerPartnerId === node.assigneeId) throw new Error('PROJECT_TASK_REVIEWER_MUST_BE_INDEPENDENT');
      }
      return { ...node, ...(execution ? { execution } : {}) };
    }));
  }

  private async requireTemplateSourceWorkflow(projectId: string, workflowId: string, expectedRevision: number) {
    if (!await this.options.domain.getProject(projectId)) throw new Error('PROJECT_NOT_FOUND');
    const workflow = await this.options.workflows.get(projectId, workflowId);
    if (!workflow) throw new Error('PROJECT_WORKFLOW_NOT_FOUND');
    if (workflow.status !== 'draft') throw new Error('PROJECT_WORKFLOW_NOT_EDITABLE');
    if (workflow.revision !== expectedRevision) throw new Error('PROJECT_WORKFLOW_REVISION_CONFLICT');
    return workflow;
  }
}

function validateMembershipRequest(request: ProjectMembershipChangeRequest) {
  validateProjectId(request.projectId);
  if (!Array.isArray(request.projectMemberIds) || !Array.isArray(request.rooms)) throw new Error('INVALID_PROJECT_MEMBER_CHANGE');
  for (const change of request.rooms) {
    if (!change?.room || change.room.projectId !== request.projectId || !change.room.roomId || !Array.isArray(change.room.memberIds)) throw new Error('INVALID_PROJECT_MEMBER_CHANGE');
  }
}

function validateProjectId(projectId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) throw new Error('INVALID_PROJECT_ID');
}

function unique(values: string[]) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function sameRoleSnapshot(left: NonNullable<ProjectTaskExecutionConfig['workRole']>, right?: NonNullable<ProjectTaskExecutionConfig['workRole']>) {
  return Boolean(right) && JSON.stringify(left) === JSON.stringify(right);
}

function cleanProposalKey(value: string) {
  const key = value?.trim();
  if (!key || key.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) throw new Error('PROJECT_WORKFLOW_GENERATION_NODE_KEY_INVALID');
  return key;
}
