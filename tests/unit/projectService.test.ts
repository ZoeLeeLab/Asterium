import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectService } from '../../src/main/project/ProjectService';
import { ProjectTransactionStore } from '../../src/main/project/ProjectTransactionStore';
import { ProjectDeletionStore } from '../../src/main/project/ProjectDeletionStore';
import { ProjectExecutionPolicyStore } from '../../src/main/project/ProjectExecutionPolicyStore';
import { ProjectDomainStore } from '../../src/main/project/ProjectDomainStore';
import { ProjectTaskExecutionStore } from '../../src/main/project/ProjectTaskExecutionStore';
import { ProjectWorkRoleStore } from '../../src/main/project/ProjectWorkRoleStore';
import { ProjectWorkflowStore } from '../../src/main/project/ProjectWorkflowStore';
import { ProjectWorkflowTemplateStore } from '../../src/main/project/ProjectWorkflowTemplateStore';
import { PartnerWorkspaceStore } from '../../src/main/security/PartnerWorkspaceStore';
import { WorkspaceGrantStore } from '../../src/main/security/WorkspaceGrantStore';
import { ArtifactRegistry } from '../../src/main/security/ArtifactRegistry';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';
import { ProjectWorkspaceStore } from '../../src/main/project/ProjectWorkspaceStore';
import { StudioNoteStore } from '../../src/main/studio/StudioNoteStore';
import { StudioRoomStore } from '../../src/main/studio/StudioRoomStore';
import { projectWorkRoleSnapshot } from '../../src/shared/projectRoles';

const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-service-'));
  temporary.push(root);
  const cwdA = path.join(root, 'cwd-a');
  const cwdB = path.join(root, 'cwd-b');
  await Promise.all([cwdA, cwdB].map((directory) => import('node:fs/promises').then(({ mkdir }) => mkdir(directory))));
  const grants = new WorkspaceGrantStore(path.join(root, 'workspace-grants.json'));
  const [grantA, grantB] = await Promise.all([grants.add(cwdA), grants.add(cwdB)]);
  const partnerWorkspaces = new PartnerWorkspaceStore(path.join(root, 'partner-workspaces.json'), grants);
  await partnerWorkspaces.ensure('partner-a', grantA.grantId, []);
  await partnerWorkspaces.ensure('partner-b', grantB.grantId, []);
  const workspaces = new ProjectWorkspaceStore(path.join(root, 'project-workspaces.json'), () => path.join(root, 'projects'));
  const domain = new ProjectDomainStore(path.join(root, 'project-domain.json'));
  await domain.createProject({ id: 'project-a', name: '项目 A', memberIds: ['partner-a'] });
  const workspace = await workspaces.create({ projectId: 'project-a', name: '项目 A' });
  const rooms = new StudioRoomStore(path.join(root, 'rooms.json'));
  await rooms.syncRoom({ roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-a'] });
  const notes = new StudioNoteStore(path.join(root, 'notes.json'));
  await notes.save({ projectId: 'project-a', content: '保留的项目笔记' });
  const bindings = new NativeThreadBindingStore(path.join(root, 'bindings.json'));
  const pending = await bindings.reserve({ partnerId: 'partner-a', source: 'local_cli', scope: 'group', conversationId: 'group:v3:room-a:partner-a', roomId: 'room-a' });
  await bindings.activate(pending.bindingId, 'thread-a');
  const transactions = new ProjectTransactionStore(path.join(root, 'project-transactions.json'));
  const deletionPath = path.join(root, 'project-deletions.json');
  const deletions = new ProjectDeletionStore(deletionPath);
  const executionPolicies = new ProjectExecutionPolicyStore(path.join(root, 'project-execution-policies.json'));
  const executions = new ProjectTaskExecutionStore(path.join(root, 'project-task-executions.json'));
  const roles = new ProjectWorkRoleStore(path.join(root, 'project-work-roles.json'));
  const workflows = new ProjectWorkflowStore(path.join(root, 'project-workflows.json'));
  const workflowTemplates = new ProjectWorkflowTemplateStore(path.join(root, 'project-workflow-templates.json'));
  await executionPolicies.update('project-a', 'full');
  const artifactSource = path.join(root, 'artifact.md');
  await writeFile(artifactSource, '# artifact', 'utf8');
  const artifacts = new ArtifactRegistry({ storePath: path.join(root, 'artifacts.json') });
  await artifacts.register({ kind: 'local_path', path: artifactSource }, { id: 'artifact-a', method: 'automatic', partnerId: 'partner-a' });
  await artifacts.recordProjectDelivery('artifact-a', { projectId: 'project-a', relativePath: 'deliverables\\artifact.md', contentHash: 'hash', sizeBytes: 10, savedAt: '2026-10-13T00:00:00.000Z' });
  const projectNotebook = {
    partnerId: 'partner-a', projectId: 'project-a', projectName: '项目 A', content: '伙伴私有项目笔记', state: 'active' as const,
    revision: 1, contentHash: 'a'.repeat(64), createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z',
  };
  const notebooks = {
    snapshotProject: vi.fn(async () => [projectNotebook]),
    applyProjectMembership: vi.fn(async () => undefined),
    archiveProject: vi.fn(async () => [{ ...projectNotebook, state: 'archived' as const, archivedAt: '2026-10-18T01:00:00.000Z' }]),
    restoreProject: vi.fn(async () => undefined),
  };
  const service = new ProjectService({ workspaces, partnerWorkspaces, rooms, notes, bindings, transactions, deletions, executionPolicies, executions, domain, roles, workflows, workflowTemplates, artifacts, notebooks });
  return { root, workspace, workspaces, partnerWorkspaces, rooms, notes, bindings, transactions, deletionPath, deletions, executionPolicies, executions, domain, roles, workflows, workflowTemplates, artifacts, notebooks, projectNotebook, service };
}

describe('ProjectService', () => {
  it('invalidates only the leaving room member and gives a rejoin a fresh generation while preserving public history', async () => {
    const value = await fixture();
    const original = await value.bindings.getForScope('partner-a', 'group', 'room-a');
    const other = await value.bindings.reserve({ partnerId: 'partner-b', source: 'api_partner', scope: 'group', conversationId: 'group:v3:room-a:partner-b', roomId: 'room-a' });
    await value.bindings.activate(other.bindingId, 'api-thread-b');
    const secondRoom = { roomId: 'room-other', projectId: 'project-a', name: '其他房间', memberIds: ['partner-a'] };
    await value.rooms.syncRoom(secondRoom);
    const otherRoom = await value.bindings.reserve({ partnerId: 'partner-a', source: 'local_cli', scope: 'group', conversationId: 'group:v3:room-other:partner-a', roomId: 'room-other' });
    await value.bindings.activate(otherRoom.bindingId, 'other-room-thread');
    const single = await value.bindings.registerSingle({ partnerId: 'partner-a', source: 'local_cli', conversationId: 'single-a', nativeThreadId: 'single-thread' });
    await value.service.changeMembers({ projectId: 'project-a', projectMemberIds: ['partner-a', 'partner-b'], rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-a', 'partner-b'] }, announcements: ['公开历史必须保留'] }] });
    const ledger = (await value.rooms.getRoom('room-a'))!.messages;
    await value.service.changeMembers({ projectId: 'project-a', projectMemberIds: ['partner-a', 'partner-b'], rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-b'] } }] });
    expect(await value.bindings.getForScope('partner-a', 'group', 'room-a')).toBeUndefined();
    expect((await value.bindings.getForScope('partner-b', 'group', 'room-a'))?.bindingId).toBe(other.bindingId);
    expect((await value.bindings.getForScope('partner-a', 'group', 'room-other'))?.bindingId).toBe(otherRoom.bindingId);
    expect((await value.bindings.getForScope('partner-a', 'single', 'single-a'))?.bindingId).toBe(single.bindingId);
    // A stale metadata refresh cannot add the removed member back.
    expect((await value.service.syncRoom({ roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-a', 'partner-b'] })).metadata.memberIds).toEqual(['partner-b']);
    await value.service.changeMembers({ projectId: 'project-a', projectMemberIds: ['partner-a', 'partner-b'], rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-a', 'partner-b'] } }] });
    const rejoined = await value.bindings.reserve({ partnerId: 'partner-a', source: 'local_cli', scope: 'group', conversationId: 'group:v3:room-a:partner-a', roomId: 'room-a', generationScopedConversation: true });
    expect(rejoined.generation).toBe(original!.generation + 1); expect(rejoined.conversationId).not.toBe(original!.conversationId);
    expect(rejoined.nativeThreadId).toBeUndefined(); expect(rejoined.bootstrap).toBeUndefined();
    expect((await value.rooms.getRoom('room-a'))!.messages).toEqual(ledger);
  });
  it('restores invalidated bindings when a later membership step fails', async () => {
    const value = await fixture(), before = await value.bindings.getForScope('partner-a', 'group', 'room-a');
    value.notebooks.applyProjectMembership.mockRejectedValueOnce(new Error('NOTEBOOK_WRITE_FAILED'));
    await expect(value.service.changeMembers({ projectId: 'project-a', projectMemberIds: ['partner-a'], rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: [] } }] })).rejects.toThrow('NOTEBOOK_WRITE_FAILED');
    expect(await value.bindings.getForScope('partner-a', 'group', 'room-a')).toEqual(before);
    expect((await value.rooms.getRoom('room-a'))!.metadata.memberIds).toEqual(['partner-a']);
    expect(await value.transactions.get()).toBeUndefined();
  });
  it('refuses a member transaction while any project room has a live round', async () => {
    const value = await fixture();
    const room = (await value.rooms.getRoom('room-a'))!.metadata;
    await value.rooms.startRound({ room, messageId: 'm', authorId: 'user', content: '正在讨论', speakerQueue: ['partner-a'] });
    await expect(value.service.changeMembers({ projectId: 'project-a', projectMemberIds: ['partner-a'], rooms: [{ room: { ...room, memberIds: [] } }] })).rejects.toThrow('STUDIO_PROJECT_HAS_ACTIVE_ROUND');
    expect(await value.bindings.getForScope('partner-a', 'group', 'room-a')).toMatchObject({ state: 'active' });
  });
  it('validates a generated DAG, snapshots references, and persists generation provenance idempotently', async () => {
    const value = await fixture();
    const role = (await value.roles.catalog('project-a')).roles.find((item) => !item.archivedAt)!;
    const sourceMessages = [
      { messageId: 'message-a', seq: 1, authorType: 'user' as const, authorId: 'user-a', content: '核心目标', contentHash: 'a'.repeat(64), createdAt: '2026-10-16T00:00:00.000Z', status: 'completed' as const },
      { messageId: 'message-b', seq: 3, authorType: 'partner' as const, authorId: 'partner-a', content: '讨论总结', contentHash: 'b'.repeat(64), createdAt: '2026-10-16T00:02:00.000Z', status: 'completed' as const },
    ];
    const input = {
      projectId: 'project-a', roomId: 'room-a', plannerPartnerId: 'partner-a', generationId: 'generation-a', sourceDigest: 'digest-a', sourceMessages,
      proposal: {
        name: '讨论生成流程', description: '仍可编辑', generationSummary: '根据目标和总结生成。',
        nodes: [{
          clientKey: 'step-a', title: '实现核心目标', description: '按公开讨论完成', assigneePartnerId: 'partner-a', dependencyKeys: [], acceptanceCriteria: ['核心目标完成'],
          workRoleId: role.id, completionRule: { type: 'executor_submit' as const }, sourceMessageIds: ['message-a', 'message-b'], basisSummary: '目标与总结共同支持。',
        }],
      },
    };

    const created = await value.service.createGeneratedWorkflow(input);
    const repeated = await value.service.createGeneratedWorkflow(input);
    expect(repeated.id).toBe(created.id);
    expect(created).toMatchObject({
      status: 'draft', nodes: [{ assigneeId: 'partner-a', execution: { workRole: { roleId: role.id, roleRevision: role.revision }, completionRule: { type: 'executor_submit' } } }],
      generationProvenance: {
        generationId: 'generation-a', roomId: 'room-a', plannerPartnerId: 'partner-a', sourceDigest: 'digest-a',
        generationSummary: '根据目标和总结生成。', messageRefs: [{ messageId: 'message-a', seq: 1 }, { messageId: 'message-b', seq: 3 }],
        nodeBasis: [expect.objectContaining({ sourceMessageIds: ['message-a', 'message-b'], summary: '目标与总结共同支持。' })],
      },
    });
    await expect(value.service.createGeneratedWorkflow({
      ...input, generationId: 'generation-b', proposal: { ...input.proposal, nodes: [{ ...input.proposal.nodes[0], sourceMessageIds: [] }] },
    })).rejects.toThrow('PROJECT_WORKFLOW_GENERATION_NODE_SOURCE_REQUIRED');
  });

  it('creates, updates and removes project templates without mutating existing drafts', async () => {
    const value = await fixture();
    const original = await value.service.createWorkflow({ projectId: 'project-a', templateId: 'quick-implementation' });
    const assigned = await value.service.updateWorkflow({
      projectId: 'project-a', workflowId: original.id, expectedRevision: original.revision,
      name: '可复用实现', description: '第一版', nodes: original.nodes.map((node) => ({ ...node, assigneeId: 'partner-a' })),
    });
    const template = await value.service.saveWorkflowTemplate({
      projectId: 'project-a', workflowId: assigned.id, expectedWorkflowRevision: assigned.revision,
      name: '项目实现模板', description: '只在项目 A 中可用',
    });
    expect((await value.service.workflowCatalog('project-a')).templates.at(-1)).toMatchObject({
      id: template.id, kind: 'project', projectId: 'project-a', revision: 1,
    });

    const firstInstance = await value.service.createWorkflow({ projectId: 'project-a', templateId: template.id });
    expect(firstInstance.nodes[0]).toMatchObject({ title: assigned.nodes[0].title, assigneeId: 'partner-a' });
    expect(firstInstance.nodes[0].id).not.toBe(assigned.nodes[0].id);

    const edited = await value.service.updateWorkflow({
      projectId: 'project-a', workflowId: assigned.id, expectedRevision: assigned.revision,
      name: assigned.name, description: assigned.description,
      nodes: assigned.nodes.map((node) => ({ ...node, title: '更新后的模板步骤' })),
    });
    const updatedTemplate = await value.service.updateWorkflowTemplate({
      projectId: 'project-a', templateId: template.id, expectedTemplateRevision: template.revision,
      workflowId: edited.id, expectedWorkflowRevision: edited.revision,
      name: template.name, description: template.description,
    });
    const secondInstance = await value.service.createWorkflow({ projectId: 'project-a', templateId: template.id });
    expect(secondInstance.nodes[0].title).toBe('更新后的模板步骤');
    expect((await value.workflows.get('project-a', firstInstance.id))?.nodes[0].title).toBe(assigned.nodes[0].title);

    await value.service.removeWorkflowTemplate({ projectId: 'project-a', templateId: template.id, expectedRevision: updatedTemplate.revision });
    expect(await value.workflows.get('project-a', firstInstance.id)).toBeDefined();
    await expect(value.service.createWorkflow({ projectId: 'project-a', templateId: template.id })).rejects.toThrow('PROJECT_WORKFLOW_TEMPLATE_NOT_FOUND');
  });

  it('makes stale custom-template partner references visible in a safe editable draft', async () => {
    const value = await fixture();
    const original = await value.service.createWorkflow({ projectId: 'project-a', templateId: 'quick-implementation' });
    const assigned = await value.service.updateWorkflow({
      projectId: 'project-a', workflowId: original.id, expectedRevision: original.revision,
      name: original.name, description: original.description, nodes: original.nodes.map((node) => ({ ...node, assigneeId: 'partner-a' })),
    });
    const template = await value.service.saveWorkflowTemplate({
      projectId: 'project-a', workflowId: assigned.id, expectedWorkflowRevision: assigned.revision, name: '失效伙伴模板',
    });
    await value.domain.updateMembers('project-a', []);

    const instance = await value.service.createWorkflow({ projectId: 'project-a', templateId: template.id });
    expect(instance.nodes[0].assigneeId).toBeUndefined();
    expect(instance.templateWarnings).toEqual(['“实现并自检”的原执行伙伴已不在项目中，请重新选择。']);
  });

  it('creates an editable template draft and atomically activates its full DAG', async () => {
    const value = await fixture();
    const existingTask = await value.service.createTask({ projectId: 'project-a', title: '既有任务', assigneeId: 'partner-a' });
    const draft = await value.service.createWorkflow({ projectId: 'project-a', templateId: 'standard-development' });
    expect(draft).toMatchObject({ status: 'draft', sourceTemplate: { templateId: 'standard-development', templateVersion: '1' } });
    expect(draft.nodes).toHaveLength(4);

    const assigned = await value.service.updateWorkflow({
      projectId: 'project-a', workflowId: draft.id, expectedRevision: draft.revision,
      name: draft.name, description: draft.description,
      nodes: draft.nodes.map((node) => ({ ...node, assigneeId: 'partner-a' })),
    });
    const result = await value.service.activateWorkflow({
      projectId: 'project-a', workflowId: assigned.id, expectedRevision: assigned.revision, activationId: 'activation-standard',
    });
    expect(result.workflow).toMatchObject({ status: 'active', activationId: 'activation-standard' });
    expect(result.taskIds).toHaveLength(4);
    expect(result.attemptIds).toHaveLength(4);

    const domain = await value.domain.projectSnapshot('project-a');
    const attempts = (await value.executions.snapshot('project-a')).attempts;
    expect(domain?.tasks).toHaveLength(5);
    expect(domain?.tasks.find((task) => task.id === existingTask.id)).toEqual(existingTask);
    expect(domain?.tasks.filter((task) => result.taskIds.includes(task.id)).map((task) => task.execution?.methodTemplate?.templateId)).toEqual([
      'method-solution-boundary', 'method-implementation-self-check', 'method-independent-verification', 'method-delivery-readiness',
    ]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['queued', 'waiting_dependencies', 'waiting_dependencies', 'waiting_dependencies']);
    expect(attempts.every((attempt) => Boolean(attempt.contractSourceFingerprint))).toBe(true);
    expect(attempts.slice(1).every((attempt) => attempt.blockedByTaskIds.length === 1)).toBe(true);

    const repeated = await value.service.activateWorkflow({
      projectId: 'project-a', workflowId: assigned.id, expectedRevision: assigned.revision, activationId: 'activation-standard',
    });
    expect(repeated.taskIds).toEqual(result.taskIds);
    expect((await value.domain.projectSnapshot('project-a'))?.tasks).toHaveLength(5);
    expect((await value.executions.snapshot('project-a')).attempts).toHaveLength(4);
  });

  it('rolls domain, attempt, and workflow stores back when workflow activation fails', async () => {
    const value = await fixture();
    const draft = await value.service.createWorkflow({ projectId: 'project-a', templateId: 'quick-implementation' });
    const assigned = await value.service.updateWorkflow({
      projectId: 'project-a', workflowId: draft.id, expectedRevision: draft.revision,
      name: draft.name, description: draft.description, nodes: draft.nodes.map((node) => ({ ...node, assigneeId: 'partner-a' })),
    });
    vi.spyOn(value.executions, 'createAttemptBatch').mockRejectedValueOnce(new Error('INJECTED_ATTEMPT_FAILURE'));

    await expect(value.service.activateWorkflow({
      projectId: 'project-a', workflowId: assigned.id, expectedRevision: assigned.revision, activationId: 'activation-fails',
    })).rejects.toThrow('INJECTED_ATTEMPT_FAILURE');

    expect((await value.domain.projectSnapshot('project-a'))?.tasks).toEqual([]);
    expect((await value.executions.snapshot('project-a')).attempts).toEqual([]);
    expect(await value.workflows.get('project-a', assigned.id)).toEqual(assigned);
    expect(await value.transactions.get()).toBeUndefined();
  });

  it('repairs an interrupted workflow activation from all three durable snapshots on restart', async () => {
    const value = await fixture();
    const workflow = await value.service.createWorkflow({ projectId: 'project-a', templateId: 'quick-implementation' });
    const domain = await value.domain.projectSnapshot('project-a');
    const execution = await value.executions.projectSnapshot('project-a');
    await value.transactions.begin({
      kind: 'workflow_activation', projectId: 'project-a', workflow,
      project: domain!.project, tasks: domain!.tasks, taskExecution: execution, activationId: 'activation-interrupted',
    });
    await value.workflows.markActivating('project-a', workflow.id, workflow.revision, 'activation-interrupted');
    const leakedTask = await value.domain.createTask({ projectId: 'project-a', title: '不应保留', assigneeId: 'partner-a' });
    await value.executions.createAttempt({
      projectId: 'project-a', taskId: leakedTask.id, taskRevision: leakedTask.revision,
      assigneeId: 'partner-a', permissionMode: 'full', blockedByTaskIds: [],
    });

    const restarted = new ProjectService({
      workspaces: value.workspaces, partnerWorkspaces: value.partnerWorkspaces, rooms: value.rooms,
      notes: value.notes, bindings: value.bindings, transactions: value.transactions, deletions: value.deletions,
      executionPolicies: value.executionPolicies, executions: value.executions, domain: value.domain,
      roles: value.roles, workflows: value.workflows, workflowTemplates: value.workflowTemplates, artifacts: value.artifacts,
    });
    await restarted.recover();

    expect((await value.domain.projectSnapshot('project-a'))?.tasks).toEqual([]);
    expect((await value.executions.snapshot('project-a')).attempts).toEqual([]);
    expect(await value.workflows.get('project-a', workflow.id)).toEqual(workflow);
    expect(await value.transactions.get()).toBeUndefined();
  });

  it('reconciles an active workflow completion projection during restart recovery', async () => {
    const value = await fixture();
    const draft = await value.service.createWorkflow({ projectId: 'project-a', templateId: 'quick-implementation' });
    const assigned = await value.service.updateWorkflow({
      projectId: 'project-a', workflowId: draft.id, expectedRevision: draft.revision,
      name: draft.name, description: draft.description, nodes: draft.nodes.map((node) => ({ ...node, assigneeId: 'partner-a' })),
    });
    const activated = await value.service.activateWorkflow({
      projectId: 'project-a', workflowId: assigned.id, expectedRevision: assigned.revision, activationId: 'activation-complete-on-restart',
    });
    await value.domain.setTaskStatusForExecution('project-a', activated.taskIds[0], 'completed');

    const restarted = new ProjectService({
      workspaces: value.workspaces, partnerWorkspaces: value.partnerWorkspaces, rooms: value.rooms,
      notes: value.notes, bindings: value.bindings, transactions: value.transactions, deletions: value.deletions,
      executionPolicies: value.executionPolicies, executions: value.executions, domain: value.domain,
      roles: value.roles, workflows: value.workflows, workflowTemplates: value.workflowTemplates, artifacts: value.artifacts,
    });
    await restarted.recover();

    expect(await value.workflows.get('project-a', assigned.id)).toMatchObject({ status: 'completed', activationId: 'activation-complete-on-restart' });
  });

  it('does not delete a task that belongs to an active workflow instance', async () => {
    const value = await fixture();
    const task = await value.domain.createTask({ projectId: 'project-a', title: '流程任务', assigneeId: 'partner-a' });
    const draft = await value.workflows.createDraft({
      projectId: 'project-a', name: '任务保护',
      nodes: [{ id: 'step-a', position: 0, title: '流程任务', description: '', assigneeId: 'partner-a', dependencyNodeIds: [], acceptanceCriteria: [], note: '' }],
    });
    await value.workflows.markActivating('project-a', draft.id, draft.revision, 'activation-protected');
    await value.workflows.markActive('project-a', draft.id, 'activation-protected', [{ draftNodeId: 'step-a', taskId: task.id }]);

    await expect(value.service.removeTask({ projectId: 'project-a', taskId: task.id, expectedRevision: task.revision }))
      .rejects.toThrow('PROJECT_TASK_BELONGS_TO_ACTIVE_WORKFLOW');
    expect((await value.domain.projectSnapshot('project-a'))?.tasks).toContainEqual(task);
  });

  it('validates role selections in Main while keeping saved task snapshots immutable', async () => {
    const value = await fixture();
    const projectRole = await value.service.createRole({ scope: 'project', projectId: 'project-a', name: '项目实现', responsibilities: ['实现旧范围'], prompt: '旧 Prompt' });
    const globalRole = await value.service.createRole({ scope: 'global', name: '全局审计', responsibilities: ['检查边界'] });
    const selected = projectWorkRoleSnapshot(projectRole);
    const task = await value.service.createTask({
      projectId: 'project-a', title: '带角色任务', assigneeId: 'partner-a', execution: { workRole: selected, completionRule: { type: 'executor_submit' } },
    });

    await value.service.updateRole({ roleId: projectRole.id, expectedRevision: projectRole.revision, name: '项目实现新版', responsibilities: ['实现新范围'], prompt: '新 Prompt' });
    const preserved = await value.service.updateTask({
      projectId: 'project-a', taskId: task.id, expectedRevision: task.revision, title: '只改标题', status: task.status,
      dependencyIds: [], acceptanceCriteria: [], execution: task.execution,
    });
    expect(preserved.execution?.workRole).toEqual(selected);
    await expect(value.service.createTask({
      projectId: 'project-a', title: '不能新选旧快照', execution: { workRole: selected },
    })).rejects.toThrow('PROJECT_WORK_ROLE_SNAPSHOT_STALE');

    await value.service.removeProject('project-a', ['room-a']);
    expect(await value.roles.projectRoles('project-a')).toEqual([]);
    expect((await value.roles.catalog('project-a')).roles.some((role) => role.id === globalRole.id)).toBe(true);
  });

  it('protects active attempts from task, membership, and project mutations', async () => {
    const value = await fixture();
    const task = await value.service.createTask({ projectId: 'project-a', title: '活动任务', assigneeId: 'partner-a' });
    await value.executions.createAttempt({
      projectId: 'project-a', taskId: task.id, taskRevision: task.revision, assigneeId: 'partner-a', permissionMode: 'full', blockedByTaskIds: [],
    });

    await expect(value.service.updateTask({
      projectId: 'project-a', taskId: task.id, expectedRevision: task.revision, title: task.title,
      status: task.status, dependencyIds: [], acceptanceCriteria: [],
    })).rejects.toThrow('PROJECT_TASK_HAS_ACTIVE_ATTEMPT');
    await expect(value.service.changeMembers({ projectId: 'project-a', projectMemberIds: [], rooms: [] })).rejects.toThrow('PROJECT_HAS_ACTIVE_TASK_ATTEMPTS');
    await expect(value.service.removeProject('project-a', [])).rejects.toThrow('PROJECT_HAS_ACTIVE_TASK_ATTEMPTS');
  });

  it('creates the Main project domain, workspace, and shared policy as one operation', async () => {
    const value = await fixture();
    const created = await value.service.createProject({
      projectId: 'project-b', name: '项目 B', description: 'Main 权威项目', tags: ['测试'], memberIds: [],
    });

    expect(created.project).toMatchObject({ id: 'project-b', description: 'Main 权威项目', revision: 1 });
    expect(created.workspace.projectId).toBe('project-b');
    expect(await value.workspaces.get('project-b')).toBeDefined();
    expect(await value.executionPolicies.get('project-b')).toMatchObject({ permissionMode: 'manual' });
    expect(await value.transactions.get()).toBeUndefined();
  });

  it('removes partial Main project state when project creation fails', async () => {
    const value = await fixture();
    vi.spyOn(value.workspaces, 'create').mockRejectedValueOnce(new Error('WORKSPACE_CREATE_FAILED'));

    await expect(value.service.createProject({ projectId: 'project-b', name: '项目 B' })).rejects.toThrow('WORKSPACE_CREATE_FAILED');
    expect(await value.domain.getProject('project-b')).toBeUndefined();
    expect(await value.workspaces.get('project-b')).toBeUndefined();
    expect(await value.executionPolicies.get('project-b')).toBeUndefined();
    expect(await value.transactions.get()).toBeUndefined();
  });

  it('rejects duplicate creation without deleting the existing project', async () => {
    const value = await fixture();

    await expect(value.service.createProject({ projectId: 'project-a', name: '覆盖项目' })).rejects.toThrow('PROJECT_ALREADY_EXISTS');
    expect(await value.domain.getProject('project-a')).toMatchObject({ name: '项目 A' });
    expect(await value.workspaces.get('project-a')).toBeDefined();
    expect(await value.executionPolicies.get('project-a')).toMatchObject({ permissionMode: 'full' });
  });

  it('stores one project policy without creating records for unknown projects', async () => {
    const value = await fixture();

    await expect(value.service.getExecutionPolicy('project-a')).resolves.toMatchObject({ permissionMode: 'full' });
    await expect(value.service.setExecutionPolicy('project-a', 'read_only')).resolves.toMatchObject({ permissionMode: 'read_only' });
    await expect(value.service.setExecutionPolicy('project-unknown', 'full')).rejects.toThrow('PROJECT_NOT_FOUND');
    await expect(value.executionPolicies.get('project-unknown')).resolves.toBeUndefined();
  });

  it('commits project, room, and workspace membership as one application operation', async () => {
    const value = await fixture();
    const result = await value.service.changeMembers({
      projectId: 'project-a',
      projectMemberIds: ['partner-a', 'partner-b'],
      rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-b'] }, announcements: ['partner-b 加入了群聊'] }],
    });

    expect(result.projectMemberIds).toEqual(['partner-a', 'partner-b']);
    expect(result.project.memberIds).toEqual(['partner-a', 'partner-b']);
    expect((await value.domain.getProject('project-a'))?.memberIds).toEqual(['partner-a', 'partner-b']);
    expect((await value.rooms.getRoom('room-a'))?.metadata.memberIds).toEqual(['partner-b']);
    expect((await value.rooms.getRoom('room-a'))?.messages.at(-1)?.content).toBe('partner-b 加入了群聊');
    expect((await value.partnerWorkspaces.configuredState('partner-a')).workspaces).toEqual([expect.objectContaining({ projectId: 'project-a' })]);
    expect((await value.partnerWorkspaces.configuredState('partner-b')).workspaces).toEqual([expect.objectContaining({ projectId: 'project-a' })]);
    expect(value.notebooks.applyProjectMembership).toHaveBeenCalledWith('project-a', '项目 A', ['partner-a', 'partner-b']);
  });

  it('restores workspace authorization when the atomic room update fails', async () => {
    const value = await fixture();
    await value.service.changeMembers({
      projectId: 'project-a', projectMemberIds: ['partner-a'],
      rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-a'] } }],
    });
    vi.spyOn(value.rooms, 'applyProjectMemberships').mockRejectedValueOnce(new Error('ROOM_WRITE_FAILED'));

    await expect(value.service.changeMembers({
      projectId: 'project-a', projectMemberIds: ['partner-b'],
      rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-b'] } }],
    })).rejects.toThrow('ROOM_WRITE_FAILED');

    expect(await value.partnerWorkspaces.projectPartnerIds('project-a')).toEqual(['partner-a']);
    expect((await value.rooms.getRoom('room-a'))?.metadata.memberIds).toEqual(['partner-a']);
    expect((await value.domain.getProject('project-a'))?.memberIds).toEqual(['partner-a']);
    expect(value.notebooks.restoreProject).toHaveBeenCalledWith([value.projectNotebook]);
  });

  it('rejects room members outside the project before changing any store', async () => {
    const value = await fixture();

    await expect(value.service.changeMembers({
      projectId: 'project-a', projectMemberIds: ['partner-a'],
      rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-b'] } }],
    })).rejects.toThrow('PROJECT_ROOM_MEMBER_NOT_IN_PROJECT');

    expect(await value.partnerWorkspaces.projectPartnerIds('project-a')).toEqual([]);
    expect((await value.rooms.getRoom('room-a'))?.metadata.memberIds).toEqual(['partner-a']);
    expect(await value.transactions.get()).toBeUndefined();
  });

  it('rejects a room id already owned by another project and rolls authorization back', async () => {
    const value = await fixture();
    await value.rooms.syncRoom({ roomId: 'room-b', projectId: 'project-b', name: '群聊 B', memberIds: ['partner-b'] });

    await expect(value.service.changeMembers({
      projectId: 'project-a', projectMemberIds: ['partner-b'],
      rooms: [{ room: { roomId: 'room-b', projectId: 'project-a', name: '冲突群聊', memberIds: ['partner-b'] } }],
    })).rejects.toThrow('PROJECT_ROOM_SCOPE_MISMATCH');

    expect(await value.partnerWorkspaces.projectPartnerIds('project-a')).toEqual([]);
    expect((await value.rooms.getRoom('room-b'))?.metadata).toMatchObject({ projectId: 'project-b', name: '群聊 B' });
    expect(await value.transactions.get()).toBeUndefined();
  });

  it('prunes removed project members from Main-owned rooms omitted by a stale Renderer', async () => {
    const value = await fixture();
    await value.rooms.syncRoom({ roomId: 'room-hidden', projectId: 'project-a', name: '遗漏群聊', memberIds: ['partner-b'] });
    await value.service.changeMembers({
      projectId: 'project-a', projectMemberIds: ['partner-a', 'partner-b'],
      rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-a'] } }],
    });

    await value.service.changeMembers({
      projectId: 'project-a', projectMemberIds: ['partner-a'],
      rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-a'] } }],
    });

    expect((await value.rooms.getRoom('room-hidden'))?.metadata.memberIds).toEqual([]);
    expect(await value.partnerWorkspaces.projectPartnerIds('project-a')).toEqual(['partner-a']);
  });

  it('deletes project configuration while preserving the user directory and Studio chat ledger', async () => {
    const value = await fixture();
    const removableWorkflow = await value.service.createWorkflow({ projectId: 'project-a', templateId: 'blank', name: '待删除流程' });
    await value.service.saveWorkflowTemplate({
      projectId: 'project-a', workflowId: removableWorkflow.id, expectedWorkflowRevision: removableWorkflow.revision, name: '待删除模板',
    });
    const task = await value.service.createTask({ projectId: 'project-a', title: '历史任务', assigneeId: 'partner-a' });
    const attempt = await value.executions.createAttempt({
      projectId: 'project-a', taskId: task.id, taskRevision: task.revision, assigneeId: 'partner-a', permissionMode: 'full', blockedByTaskIds: [],
    });
    await value.executions.transition(attempt.id, ['queued'], { status: 'cancelled', eventType: 'cancelled', finished: true });
    await value.service.changeMembers({
      projectId: 'project-a', projectMemberIds: ['partner-a'],
      rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-a'] } }],
    });
    const workspaceBinding = await value.bindings.reserve({
      partnerId: 'partner-a', source: 'local_cli', scope: 'workspace', conversationId: 'workspace:v1:project-a:partner-a', projectId: 'project-a',
    });
    await value.bindings.activate(workspaceBinding.bindingId, 'thread-workspace');
    const marker = path.join(value.workspace.rootPath, 'user-file.txt');
    await writeFile(marker, 'keep', 'utf8');

    await value.service.removeProject('project-a', []);

    expect(await value.rooms.listProject('project-a')).toHaveLength(1);
    expect(await value.notes.list('project-a')).toEqual([]);
    expect(await value.workspaces.get('project-a')).toBeUndefined();
    expect(await value.executionPolicies.get('project-a')).toBeUndefined();
    expect(await value.partnerWorkspaces.projectPartnerIds('project-a')).toEqual([]);
    expect(await value.bindings.getForScope('partner-a', 'group', 'room-a')).toMatchObject({ nativeThreadId: 'thread-a', state: 'active' });
    expect(await value.bindings.getForScope('partner-a', 'workspace', 'project-a')).toBeUndefined();
    expect(await value.artifacts.listProjectDeliveries('project-a')).toEqual([]);
    expect(await value.domain.getProject('project-a')).toBeUndefined();
    expect(await value.workflows.listProject('project-a')).toEqual([]);
    expect(await value.workflowTemplates.listProject('project-a')).toEqual([]);
    expect((await value.executions.snapshot('project-a')).attempts).toEqual([]);
    expect(value.notebooks.archiveProject).toHaveBeenCalledWith('project-a', '项目 A');
    expect(await readFile(marker, 'utf8')).toBe('keep');
    expect(await readdir(value.workspace.rootPath)).toContain('deliverables');
    await expect(value.service.syncRoom({
      roomId: 'room-late', projectId: 'project-a', name: '迟到房间同步', memberIds: ['partner-a'],
    })).rejects.toThrow('PROJECT_REMOVED');
    expect(await value.rooms.getRoom('room-late')).toBeUndefined();
  });

  it('keeps a completed deletion authoritative after restart and rejects stale room hydration', async () => {
    const value = await fixture();
    await value.service.removeProject('project-a', ['room-a']);

    const restarted = new ProjectService({
      workspaces: value.workspaces, partnerWorkspaces: value.partnerWorkspaces, rooms: value.rooms,
      notes: value.notes, bindings: value.bindings, transactions: value.transactions, deletions: new ProjectDeletionStore(value.deletionPath),
      executionPolicies: value.executionPolicies,
      domain: value.domain, roles: value.roles, workflows: value.workflows, workflowTemplates: value.workflowTemplates,
      artifacts: value.artifacts,
    });
    await restarted.recover();

    await expect(restarted.syncRoom({
      roomId: 'room-a', projectId: 'project-a', name: '来自旧 Renderer 的群聊', memberIds: ['partner-a'],
    })).rejects.toThrow('PROJECT_REMOVED');
    expect(await value.rooms.listProject('project-a')).toHaveLength(1);
    expect(await value.deletions.list()).toEqual(['project-a']);
  });

  it.each([
    ['note removal', (value: Awaited<ReturnType<typeof fixture>>) => vi.spyOn(value.notes, 'removeProject').mockRejectedValueOnce(new Error('DELETE_STAGE_FAILED'))],
    ['authorization removal', (value: Awaited<ReturnType<typeof fixture>>) => vi.spyOn(value.partnerWorkspaces, 'reconcileProject').mockRejectedValueOnce(new Error('DELETE_STAGE_FAILED'))],
    ['workspace index removal', (value: Awaited<ReturnType<typeof fixture>>) => vi.spyOn(value.workspaces, 'remove').mockRejectedValueOnce(new Error('DELETE_STAGE_FAILED'))],
    ['workspace binding removal', (value: Awaited<ReturnType<typeof fixture>>) => vi.spyOn(value.bindings, 'removeProjects').mockRejectedValueOnce(new Error('DELETE_STAGE_FAILED'))],
    ['delivery metadata removal', (value: Awaited<ReturnType<typeof fixture>>) => vi.spyOn(value.artifacts, 'removeProjectDeliveries').mockRejectedValueOnce(new Error('DELETE_STAGE_FAILED'))],
    ['workflow removal', (value: Awaited<ReturnType<typeof fixture>>) => vi.spyOn(value.workflows, 'removeProject').mockRejectedValueOnce(new Error('DELETE_STAGE_FAILED'))],
    ['workflow template removal', (value: Awaited<ReturnType<typeof fixture>>) => vi.spyOn(value.workflowTemplates, 'removeProject').mockRejectedValueOnce(new Error('DELETE_STAGE_FAILED'))],
    ['notebook archive', (value: Awaited<ReturnType<typeof fixture>>) => value.notebooks.archiveProject.mockRejectedValueOnce(new Error('DELETE_STAGE_FAILED'))],
    ['durable deletion marker', (value: Awaited<ReturnType<typeof fixture>>) => vi.spyOn(value.deletions, 'markDeleted').mockRejectedValueOnce(new Error('DELETE_STAGE_FAILED'))],
  ])('rolls every project store back when %s fails', async (_label, fail) => {
    const value = await fixture();
    const transactionWorkflow = await value.service.createWorkflow({ projectId: 'project-a', templateId: 'blank', name: '事务流程' });
    await value.service.saveWorkflowTemplate({
      projectId: 'project-a', workflowId: transactionWorkflow.id, expectedWorkflowRevision: transactionWorkflow.revision, name: '事务模板',
    });
    const task = await value.service.createTask({ projectId: 'project-a', title: '事务历史', assigneeId: 'partner-a' });
    const attempt = await value.executions.createAttempt({
      projectId: 'project-a', taskId: task.id, taskRevision: task.revision, assigneeId: 'partner-a', permissionMode: 'full', blockedByTaskIds: [],
    });
    await value.executions.transition(attempt.id, ['queued'], { status: 'cancelled', eventType: 'cancelled', finished: true });
    await value.service.changeMembers({
      projectId: 'project-a', projectMemberIds: ['partner-a'],
      rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-a'] } }],
    });
    fail(value);

    await expect(value.service.removeProject('project-a', [])).rejects.toThrow('DELETE_STAGE_FAILED');

    expect(await value.rooms.listProject('project-a')).toHaveLength(1);
    expect(await value.notes.list('project-a')).toHaveLength(1);
    expect(await value.workspaces.get('project-a')).toBeDefined();
    expect(await value.executionPolicies.get('project-a')).toMatchObject({ permissionMode: 'full' });
    expect(await value.partnerWorkspaces.projectPartnerIds('project-a')).toEqual(['partner-a']);
    expect(await value.bindings.getForScope('partner-a', 'group', 'room-a')).toMatchObject({ nativeThreadId: 'thread-a', state: 'active' });
    expect(await value.artifacts.listProjectDeliveries('project-a')).toHaveLength(1);
    expect(await value.domain.getProject('project-a')).toBeDefined();
    expect(await value.workflows.listProject('project-a')).toHaveLength(1);
    expect(await value.workflowTemplates.listProject('project-a')).toHaveLength(1);
    expect(await value.executions.findAttempt(attempt.id)).toBeDefined();
    expect(value.notebooks.restoreProject).toHaveBeenCalledWith([value.projectNotebook]);
    expect(await value.transactions.get()).toBeUndefined();
  });

  it('repairs an interrupted membership change from its durable transaction snapshot on restart', async () => {
    const value = await fixture();
    await value.service.changeMembers({
      projectId: 'project-a', projectMemberIds: ['partner-a'],
      rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-a'] } }],
    });
    const previousRooms = await value.rooms.listProject('project-a');
    const previousDomain = await value.domain.projectSnapshot('project-a');
    const previousBindings = await value.bindings.listForRooms(['room-a']);
    await value.transactions.begin({
      kind: 'project_membership', projectId: 'project-a', rooms: previousRooms,
      bindings: previousBindings,
      partnerIds: ['partner-a'], rootPath: value.workspace.rootPath,
      project: previousDomain!.project, tasks: previousDomain!.tasks, projectNotebooks: [value.projectNotebook],
    });
    await value.partnerWorkspaces.reconcileProject({ projectId: 'project-a', rootPath: value.workspace.rootPath, partnerIds: ['partner-b'] });
    await value.rooms.applyProjectMemberships('project-a', [{ room: {
      roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-b'],
    } }]);
    await value.domain.updateMembers('project-a', ['partner-b']);
    await value.bindings.invalidateRoomMembers('room-a', ['partner-a']);

    const restarted = new ProjectService({
      workspaces: value.workspaces, partnerWorkspaces: value.partnerWorkspaces, rooms: value.rooms,
      notes: value.notes, bindings: value.bindings, transactions: value.transactions, deletions: value.deletions, executionPolicies: value.executionPolicies, artifacts: value.artifacts,
      domain: value.domain, roles: value.roles, workflows: value.workflows, workflowTemplates: value.workflowTemplates, notebooks: value.notebooks,
    });
    await restarted.recover();

    expect(await value.partnerWorkspaces.projectPartnerIds('project-a')).toEqual(['partner-a']);
    expect((await value.rooms.getRoom('room-a'))?.metadata.memberIds).toEqual(['partner-a']);
    expect((await value.domain.getProject('project-a'))?.memberIds).toEqual(['partner-a']);
    expect(await value.bindings.getForScope('partner-a', 'group', 'room-a')).toEqual(previousBindings[0]);
    expect(value.notebooks.restoreProject).toHaveBeenCalledWith([value.projectNotebook]);
    expect(await value.transactions.get()).toBeUndefined();
  });

  it('repairs an interrupted project deletion from its durable transaction snapshot on restart', async () => {
    const value = await fixture();
    const projectRole = await value.service.createRole({
      scope: 'project', projectId: 'project-a', name: '删除恢复测试角色', responsibilities: ['验证项目角色恢复'],
    });
    const projectWorkflow = await value.service.createWorkflow({ projectId: 'project-a', templateId: 'blank', name: '删除恢复测试流程' });
    const projectWorkflowTemplate = await value.service.saveWorkflowTemplate({
      projectId: 'project-a', workflowId: projectWorkflow.id, expectedWorkflowRevision: projectWorkflow.revision, name: '删除恢复测试模板',
    });
    await value.service.changeMembers({
      projectId: 'project-a', projectMemberIds: ['partner-a'],
      rooms: [{ room: { roomId: 'room-a', projectId: 'project-a', name: '群聊 A', memberIds: ['partner-a'] } }],
    });
    const rooms = await value.rooms.listProject('project-a');
    const notes = await value.notes.list('project-a');
    const bindings = await value.bindings.listForRooms(['room-a']);
    const deliveries = await value.artifacts.listProjectDeliveries('project-a');
    const executionPolicy = await value.executionPolicies.get('project-a');
    const domain = await value.domain.projectSnapshot('project-a');
    const projectRoles = await value.roles.projectRoles('project-a');
    const projectWorkflows = await value.workflows.listProject('project-a');
    const projectWorkflowTemplates = await value.workflowTemplates.listProject('project-a');
    await value.transactions.begin({ kind: 'project_delete', projectId: 'project-a', rooms, notes, workspace: value.workspace, executionPolicy, project: domain!.project, tasks: domain!.tasks, projectRoles, projectWorkflows, projectWorkflowTemplates, partnerIds: ['partner-a'], bindings, deliveries, projectNotebooks: [value.projectNotebook] });
    await value.rooms.removeProject('project-a');
    await value.notes.removeProject('project-a');
    await value.partnerWorkspaces.reconcileProject({ projectId: 'project-a', partnerIds: [] });
    await value.workspaces.remove('project-a');
    await value.executionPolicies.remove('project-a');
    await value.domain.removeProject('project-a');
    await value.roles.removeProject('project-a');
    await value.workflows.removeProject('project-a');
    await value.workflowTemplates.removeProject('project-a');
    await value.artifacts.removeProjectDeliveries('project-a');
    await value.deletions.markDeleted('project-a');

    const restarted = new ProjectService({
      workspaces: value.workspaces, partnerWorkspaces: value.partnerWorkspaces, rooms: value.rooms,
      notes: value.notes, bindings: value.bindings, transactions: value.transactions, deletions: value.deletions, executionPolicies: value.executionPolicies, artifacts: value.artifacts,
      domain: value.domain, roles: value.roles, workflows: value.workflows, workflowTemplates: value.workflowTemplates, notebooks: value.notebooks,
    });
    await restarted.recover();

    expect(await value.rooms.listProject('project-a')).toHaveLength(1);
    expect(await value.notes.list('project-a')).toHaveLength(1);
    expect(await value.workspaces.get('project-a')).toBeDefined();
    expect(await value.executionPolicies.get('project-a')).toMatchObject({ permissionMode: 'full' });
    expect(await value.partnerWorkspaces.projectPartnerIds('project-a')).toEqual(['partner-a']);
    expect(await value.artifacts.listProjectDeliveries('project-a')).toHaveLength(1);
    expect(await value.domain.getProject('project-a')).toBeDefined();
    expect(await value.roles.projectRoles('project-a')).toEqual([projectRole]);
    expect(await value.workflows.listProject('project-a')).toEqual([projectWorkflow]);
    expect(await value.workflowTemplates.listProject('project-a')).toEqual([projectWorkflowTemplate]);
    expect(value.notebooks.restoreProject).toHaveBeenCalledWith([value.projectNotebook]);
    expect(await value.deletions.list()).toEqual([]);
    expect(await value.transactions.get()).toBeUndefined();
  });

  it('cleans an interrupted project creation from its durable transaction on restart', async () => {
    const value = await fixture();
    await value.transactions.begin({ kind: 'project_create', projectId: 'project-b' });
    await value.domain.createProject({ id: 'project-b', name: '未完成项目' });
    await value.workspaces.create({ projectId: 'project-b', name: '未完成项目' });
    await value.executionPolicies.getOrCreate('project-b');

    const restarted = new ProjectService({
      workspaces: value.workspaces, partnerWorkspaces: value.partnerWorkspaces, rooms: value.rooms,
      notes: value.notes, bindings: value.bindings, transactions: value.transactions, deletions: value.deletions,
      executionPolicies: value.executionPolicies, domain: value.domain, roles: value.roles, workflows: value.workflows, workflowTemplates: value.workflowTemplates, artifacts: value.artifacts,
    });
    await restarted.recover();

    expect(await value.domain.getProject('project-b')).toBeUndefined();
    expect(await value.workspaces.get('project-b')).toBeUndefined();
    expect(await value.executionPolicies.get('project-b')).toBeUndefined();
    expect(await value.transactions.get()).toBeUndefined();
  });
});
