// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { ProjectDomainStore } from '../../src/main/project/ProjectDomainStore';
import { ProjectTaskExecutionStore } from '../../src/main/project/ProjectTaskExecutionStore';
import { ProjectWorkflowStore } from '../../src/main/project/ProjectWorkflowStore';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { ProjectTask } from '../../src/shared/projectDomain';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.root, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: {},
  shell: {},
}));

const create = 'asterium:project-task:create';
const update = 'asterium:project-task:update';
const remove = 'asterium:project-task:remove';
const changed = 'asterium:project-domain:changed';
const projectId = 'fixture-project';
const assigneeId = 'fixture-partner';

async function withTaskIpc(run: (fixture: {
  root: string;
  domain: ProjectDomainStore;
  invoke: <T = unknown>(channel: string, request: unknown, caller?: object) => Promise<T>;
  changes: () => unknown[][];
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-task-ipc-'));
  electron.root = root;
  const domain = new ProjectDomainStore(path.join(root, 'project-domain.v1.json'));
  const sender = { send: vi.fn<(channel: string, data: unknown) => void>() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const invoke = async <T,>(channel: string, value: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return await handler({ sender: caller }, value) as T;
  };
  try {
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await invoke(DESKTOP_IPC.projectDomainInitialize, { legacyProjects: [{ id: projectId, name: '合成项目', memberIds: [assigneeId] }] });
      sender.send.mockClear();
      await run({ root, domain, invoke, changes: () => sender.send.mock.calls.filter(([channel]) => channel === changed) });
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
}

it('validates callers and request fields, preserves task revisions and publishes saved snapshots', async () => {
  await withTaskIpc(async ({ domain, invoke, changes }) => {
    for (const [channel, request, error] of [
      [create, { projectId, title: null }, 'INVALID_PROJECT_TASK_CREATE'],
      [update, { projectId, taskId: null }, 'INVALID_PROJECT_TASK_UPDATE'],
      [remove, { projectId: false, taskId: 'fixture-task' }, 'INVALID_PROJECT_TASK_REMOVE'],
    ] as const) {
      await expect(invoke(channel, request, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(channel, request)).rejects.toThrow(error);
    }
    expect(changes()).toEqual([]);

    const input = { projectId, title: '合成任务', assigneeId };
    const created = await invoke<ProjectTask>(create, input);
    expect(created).toMatchObject({ ...input, id: expect.any(String), revision: 1, status: 'todo' });
    const target = { projectId, taskId: created.id, expectedRevision: created.revision };
    const edit = { ...input, ...target, title: '合成任务更新', status: created.status };
    const edited = await invoke<ProjectTask>(update, edit);
    expect(edited).toMatchObject({ id: created.id, code: created.code, title: edit.title, revision: 2 });

    await expect(invoke(update, edit)).rejects.toThrow('PROJECT_TASK_REVISION_CONFLICT');
    await expect(invoke(remove, target)).rejects.toThrow('PROJECT_TASK_REVISION_CONFLICT');
    await expect(domain.projectSnapshot(projectId)).resolves.toMatchObject({ tasks: [edited] });
    await expect(invoke(remove, { ...target, expectedRevision: edited.revision })).resolves.toBeUndefined();
    await expect(domain.projectSnapshot(projectId)).resolves.toMatchObject({ tasks: [] });
    expect(changes()).toEqual([[created], [edited], []].map(tasks => [
      changed, { type: 'snapshot', snapshot: expect.objectContaining({ tasks }) },
    ]));
  });
});

it('keeps active attempts and tasks referenced by active workflows protected', async () => {
  await withTaskIpc(async ({ root, domain, invoke, changes }) => {
    const input = { projectId, title: '受保护的合成任务', assigneeId };
    const active = await invoke<ProjectTask>(create, input);
    const inWorkflow = await invoke<ProjectTask>(create, { ...input, title: '合成工作流任务' });
    const executions = new ProjectTaskExecutionStore(path.join(root, 'project-task-executions.v1.json'));
    await executions.createAttempt({
      projectId, taskId: active.id, taskRevision: active.revision, assigneeId, permissionMode: 'full', blockedByTaskIds: [],
    });
    const workflows = new ProjectWorkflowStore(path.join(root, 'project-workflows.v1.json'));
    const node = { id: 'fixture-node', position: 0, title: inWorkflow.title, description: '', assigneeId, dependencyNodeIds: [], acceptanceCriteria: [], note: '' };
    const draft = await workflows.createDraft({ projectId, name: '合成工作流', nodes: [node] });
    await workflows.markActivating(projectId, draft.id, draft.revision, 'fixture-activation');
    await workflows.markActive(projectId, draft.id, 'fixture-activation', [{ draftNodeId: node.id, taskId: inWorkflow.id }]);

    const target = { projectId, taskId: active.id, expectedRevision: active.revision };
    await expect(invoke(update, { ...input, ...target, status: active.status })).rejects.toThrow('PROJECT_TASK_HAS_ACTIVE_ATTEMPT');
    await expect(invoke(remove, target)).rejects.toThrow('PROJECT_TASK_HAS_ACTIVE_ATTEMPT');
    await expect(invoke(remove, { ...target, taskId: inWorkflow.id, expectedRevision: inWorkflow.revision }))
      .rejects.toThrow('PROJECT_TASK_BELONGS_TO_ACTIVE_WORKFLOW');
    await expect(domain.projectSnapshot(projectId)).resolves.toMatchObject({ tasks: [active, inWorkflow] });
    expect(changes()).toHaveLength(2);
  });
});
