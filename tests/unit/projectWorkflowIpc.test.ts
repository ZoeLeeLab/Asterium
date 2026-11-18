// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi, type MockInstance } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { registerProjectWorkflowMutationIpc } from '../../src/main/ipc/projectWorkflowIpc';
import { ProjectDomainStore } from '../../src/main/project/ProjectDomainStore';
import { ProjectService } from '../../src/main/project/ProjectService';
import { ProjectTaskExecutionStore } from '../../src/main/project/ProjectTaskExecutionStore';
import { ProjectTaskOrchestrator } from '../../src/main/project/ProjectTaskOrchestrator';
import { ProjectWorkflowStore } from '../../src/main/project/ProjectWorkflowStore';
import { PartnerRuntimePort } from '../../src/main/runtime/PartnerRuntimePort';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { ProjectWorkflow, ProjectWorkflowActivationResult } from '../../src/shared/projectWorkflows';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.root, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, safeStorage: {}, shell: {},
}));

const projectId = 'fixture-project';
const partnerId = 'fixture-assignee';
const create = DESKTOP_IPC.projectWorkflowCreate;
const update = DESKTOP_IPC.projectWorkflowUpdate;
const remove = DESKTOP_IPC.projectWorkflowRemove;
const activate = DESKTOP_IPC.projectWorkflowActivate;
const queries = [
  [create, { projectId, templateId: false }, 'INVALID_PROJECT_WORKFLOW_CREATE'],
  [update, { projectId, workflowId: 'fixture-workflow', nodes: null }, 'INVALID_PROJECT_WORKFLOW_UPDATE'],
  [remove, { projectId: null, workflowId: 'fixture-workflow' }, 'INVALID_PROJECT_WORKFLOW_REMOVE'],
  [activate, { projectId, workflowId: 'fixture-workflow', activationId: null }, 'INVALID_PROJECT_WORKFLOW_ACTIVATE'],
] as const;

async function withWorkflowIpc(run: (fixture: {
  root: string;
  invoke: <T = unknown>(channel: string, value: unknown, caller?: object) => Promise<T>;
  changes: () => unknown[][];
  orchestratorActivation: MockInstance<ProjectTaskOrchestrator['activate']>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-workflow-ipc-'));
  electron.root = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const removed: string[] = [];
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error('Duplicate IPC channel ' + channel);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); },
  } as unknown as IpcMain;
  const invoke = async <T,>(channel: string, value: unknown, caller: object = sender): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error('Unregistered IPC channel ' + channel);
    return await handler({ sender: caller }, value) as T;
  };
  const orchestratorActivation = vi.spyOn(ProjectTaskOrchestrator.prototype, 'activate').mockResolvedValue(undefined);
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root, projectsDirectory: path.join(root, 'projects'),
      temporaryDirectory: root, appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    await invoke(DESKTOP_IPC.projectDomainInitialize, { legacyProjects: [{ id: projectId, name: '合成验收项目', memberIds: [partnerId] }] });
    await invoke(DESKTOP_IPC.projectCreateWorkspace, { projectId, name: '合成验收项目' });
    sender.send.mockClear();
    await run({ root, invoke, orchestratorActivation, changes: () => sender.send.mock.calls.filter(([channel]) => channel === DESKTOP_IPC.projectWorkflowsChanged) });
  } finally {
    try {
      await dispose?.(); expect(handlers.size).toBe(0);
      for (const [channel] of queries) expect(removed.filter(item => item === channel)).toHaveLength(1);
    } finally { vi.restoreAllMocks(); await testRm(root, { recursive: true, force: true }); }
  }
}

it('preserves sender-first validation and rejects malformed requests without service writes', async () => {
  await withWorkflowIpc(async ({ invoke, changes, orchestratorActivation }) => {
    const serviceCalls = [
      vi.spyOn(ProjectService.prototype, 'createWorkflow'), vi.spyOn(ProjectService.prototype, 'updateWorkflow'),
      vi.spyOn(ProjectService.prototype, 'removeWorkflow'), vi.spyOn(ProjectService.prototype, 'activateWorkflow'),
    ];
    for (const [channel, invalid, error] of queries) {
      await expect(invoke(channel, invalid, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(channel, invalid)).rejects.toThrow(error);
    }
    for (const call of serviceCalls) expect(call).not.toHaveBeenCalled();
    expect(orchestratorActivation).not.toHaveBeenCalled(); expect(changes()).toEqual([]);
  });
});

it('persists draft create/update/remove results, revision failures and refresh notifications unchanged', async () => {
  await withWorkflowIpc(async ({ root, invoke, changes, orchestratorActivation }) => {
    const created = await invoke<ProjectWorkflow>(create, { projectId, templateId: 'quick-implementation', name: '合成流程' });
    expect(created).toMatchObject({ projectId, name: '合成流程', status: 'draft', revision: 1 });
    expect(changes()).toEqual([[DESKTOP_IPC.projectWorkflowsChanged, { type: 'changed', projectId }]]);
    const request = {
      projectId, workflowId: created.id, expectedRevision: created.revision, name: '合成流程更新',
      description: '合成说明', nodes: created.nodes.map(node => ({ ...node, assigneeId: partnerId })),
    };
    const updated = await invoke<ProjectWorkflow>(update, request);
    expect(updated).toMatchObject({ id: created.id, name: request.name, description: request.description, revision: 2 });
    await expect(invoke(update, request)).rejects.toThrow('PROJECT_WORKFLOW_REVISION_CONFLICT');
    await expect(invoke(remove, { projectId, workflowId: created.id, expectedRevision: created.revision }))
      .rejects.toThrow('PROJECT_WORKFLOW_REVISION_CONFLICT');
    expect(changes()).toHaveLength(2);
    const workflows = new ProjectWorkflowStore(path.join(root, 'project-workflows.v1.json'));
    expect(await workflows.get(projectId, created.id)).toEqual(updated);
    await expect(invoke(remove, { projectId, workflowId: created.id, expectedRevision: updated.revision })).resolves.toBeUndefined();
    expect(await workflows.listProject(projectId)).toEqual([]);
    expect(changes()).toEqual(Array.from({ length: 3 }, () => [DESKTOP_IPC.projectWorkflowsChanged, { type: 'changed', projectId }]));
    expect(orchestratorActivation).not.toHaveBeenCalled();
  });
});

it('commits workflow activation before starting the orchestrator and returns stable activation receipts', async () => {
  await withWorkflowIpc(async ({ root, invoke, orchestratorActivation }) => {
    const workflows = new ProjectWorkflowStore(path.join(root, 'project-workflows.v1.json'));
    const domain = new ProjectDomainStore(path.join(root, 'project-domain.v1.json'));
    const executions = new ProjectTaskExecutionStore(path.join(root, 'project-task-executions.v1.json'));
    const created = await invoke<ProjectWorkflow>(create, { projectId, templateId: 'quick-implementation' });
    const assigned = await invoke<ProjectWorkflow>(update, {
      projectId, workflowId: created.id, expectedRevision: created.revision, name: created.name,
      nodes: created.nodes.map(node => ({ ...node, assigneeId: partnerId })),
    });
    const request = { projectId, workflowId: assigned.id, expectedRevision: assigned.revision, activationId: 'fixture-activation' };
    orchestratorActivation.mockImplementation(async (runtime) => {
      expect(runtime).toBeInstanceOf(PartnerRuntimePort);
      expect(await workflows.get(projectId, assigned.id)).toMatchObject({ status: 'active', activationId: request.activationId });
      expect((await executions.snapshot(projectId)).attempts).toHaveLength(assigned.nodes.length);
    });
    await expect(invoke(activate, { ...request, expectedRevision: assigned.revision - 1 })).rejects.toThrow('PROJECT_WORKFLOW_REVISION_CONFLICT');
    expect(orchestratorActivation).not.toHaveBeenCalled();
    const result = await invoke<ProjectWorkflowActivationResult>(activate, request);
    expect(result.workflow).toMatchObject({ id: assigned.id, status: 'active', activationId: request.activationId });
    expect(result.taskIds).toHaveLength(assigned.nodes.length); expect(result.attemptIds).toHaveLength(assigned.nodes.length);
    expect(orchestratorActivation).toHaveBeenCalledTimes(1);
    const repeated = await invoke<ProjectWorkflowActivationResult>(activate, request);
    expect(repeated).toEqual(result); expect(orchestratorActivation).toHaveBeenCalledTimes(2);
    expect((await domain.projectSnapshot(projectId))?.tasks).toHaveLength(assigned.nodes.length);
    await expect(invoke(update, { projectId, workflowId: assigned.id, name: '合成修改', nodes: assigned.nodes, expectedRevision: result.workflow.revision }))
      .rejects.toThrow('PROJECT_WORKFLOW_NOT_EDITABLE');
    await expect(invoke(remove, { projectId, workflowId: assigned.id, expectedRevision: result.workflow.revision }))
      .rejects.toThrow('PROJECT_WORKFLOW_ACTIVE');
    const failure = new Error('SYNTHETIC_ORCHESTRATOR_FAILURE');
    orchestratorActivation.mockRejectedValueOnce(failure);
    await expect(invoke(activate, request)).rejects.toBe(failure);
    expect(await workflows.get(projectId, assigned.id)).toEqual(result.workflow);
    await expect(invoke(activate, request)).resolves.toEqual(result);
  });
});

it('does not resolve the late runtime while registering, before saving, or after a failed save', async () => {
  const handlers = new Map<string, (event: unknown, value: unknown) => Promise<unknown>>();
  const ipcMain = { handle: (channel: string, handler: (event: unknown, value: unknown) => Promise<unknown>) => handlers.set(channel, handler) } as unknown as IpcMain;
  const window = {} as BrowserWindow;
  let finishSave!: (value: ProjectWorkflowActivationResult) => void;
  const saving = new Promise<ProjectWorkflowActivationResult>(resolve => { finishSave = resolve; });
  const activateWorkflow = vi.fn(() => saving);
  const activateTasks = vi.fn(async (runtime: PartnerRuntimePort) => { void runtime; });
  const runtimeRef: { current?: PartnerRuntimePort } = {};
  const getPartnerRuntimePort = vi.fn(() => {
    if (!runtimeRef.current) throw new Error('SYNTHETIC_RUNTIME_NOT_READY');
    return runtimeRef.current;
  });
  registerProjectWorkflowMutationIpc(ipcMain, {
    projectService: { createWorkflow: vi.fn(), updateWorkflow: vi.fn(), removeWorkflow: vi.fn(), activateWorkflow },
    projectTaskOrchestrator: { activate: activateTasks }, getPartnerRuntimePort,
  }, () => window);
  expect(getPartnerRuntimePort).not.toHaveBeenCalled();
  const request = { projectId, workflowId: 'fixture-workflow', activationId: 'fixture-late-runtime' };
  const pending = handlers.get(activate)!({}, request);
  expect(activateWorkflow).toHaveBeenCalledExactlyOnceWith(request);
  expect(getPartnerRuntimePort).not.toHaveBeenCalled(); expect(activateTasks).not.toHaveBeenCalled();
  const result = { workflow: { id: request.workflowId } as ProjectWorkflow, taskIds: [], attemptIds: [] };
  runtimeRef.current = {} as PartnerRuntimePort;
  finishSave(result);
  await expect(pending).resolves.toBe(result);
  expect(getPartnerRuntimePort).toHaveBeenCalledTimes(1);
  expect(activateTasks).toHaveBeenCalledExactlyOnceWith(runtimeRef.current);
  const error = new Error('SYNTHETIC_SAVE_FAILURE');
  activateWorkflow.mockRejectedValueOnce(error);
  await expect(handlers.get(activate)!({}, request)).rejects.toBe(error);
  expect(getPartnerRuntimePort).toHaveBeenCalledTimes(1); expect(activateTasks).toHaveBeenCalledTimes(1);
});
