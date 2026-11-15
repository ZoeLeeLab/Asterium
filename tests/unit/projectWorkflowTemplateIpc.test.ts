// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { ProjectWorkflow, ProjectWorkflowCatalog, ProjectWorkflowTemplate } from '../../src/shared/projectWorkflows';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.root,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    whenReady: async () => undefined,
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: {},
  shell: {},
}));

it('preserves template revision checks, saved drafts, and workflow refresh events through IPC', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-workflow-template-ipc-'));
  electron.root = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error('Duplicate IPC channel ' + channel);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const invoke = async <T = unknown>(channel: string, value: unknown, caller: object = sender): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error('Unregistered IPC channel ' + channel);
    return await handler({ sender: caller }, value) as T;
  };
  const save = 'asterium:project-workflow-template:save';
  const update = 'asterium:project-workflow-template:update';
  const remove = 'asterium:project-workflow-template:remove';
  const catalogQuery = 'asterium:project-workflow:catalog';
  const listQuery = 'asterium:project-workflow:list';
  const changed = 'asterium:project-workflows:changed';
  const projectId = 'fixture-project';
  const refreshes = () => sender.send.mock.calls.filter(([channel]) => channel === changed);
  const refresh = [changed, { type: 'changed', projectId }];

  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    expect([...handlers.keys()].filter((channel) => channel.startsWith('asterium:project-workflow-template:')).sort())
      .toEqual([remove, save, update]);
    for (const [channel, error] of [
      [save, 'INVALID_PROJECT_WORKFLOW_TEMPLATE_SAVE'],
      [update, 'INVALID_PROJECT_WORKFLOW_TEMPLATE_UPDATE'],
      [remove, 'INVALID_PROJECT_WORKFLOW_TEMPLATE_REMOVE'],
    ]) {
      await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(channel, null)).rejects.toThrow(error);
    }

    await invoke(DESKTOP_IPC.projectDomainInitialize, { legacyProjects: [{ id: projectId, name: 'Fixture project' }] });
    sender.send.mockClear();
    for (const channel of [catalogQuery, listQuery]) {
      await expect(invoke(channel, projectId, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(channel, { projectId })).rejects.toThrow('INVALID_PROJECT_WORKFLOW_QUERY');
      await expect(invoke(channel, 'missing-fixture-project')).rejects.toThrow('PROJECT_NOT_FOUND');
    }
    const initialCatalog = await invoke<ProjectWorkflowCatalog>(catalogQuery, projectId);
    expect(initialCatalog.templates).toContainEqual(expect.objectContaining({ id: 'quick-implementation', kind: 'builtin' }));
    await expect(invoke(listQuery, projectId)).resolves.toEqual([]);
    expect(refreshes()).toEqual([]);

    const source = await invoke<ProjectWorkflow>(DESKTOP_IPC.projectWorkflowCreate, { projectId, templateId: 'quick-implementation' });
    const saveRequest = { projectId, workflowId: source.id, expectedWorkflowRevision: source.revision, name: 'Fixture template' };
    sender.send.mockClear();
    const saved = await invoke<ProjectWorkflowTemplate>(save, saveRequest);
    expect(saved).toMatchObject({ projectId, name: saveRequest.name, revision: 1 });
    expect(refreshes()).toEqual([refresh]);
    sender.send.mockClear();
    await expect(invoke(catalogQuery, projectId)).resolves.toEqual({
      ...initialCatalog,
      templates: [...initialCatalog.templates, {
        id: saved.id, version: '1', name: saved.name, description: saved.description,
        nodeCount: saved.nodes.length, kind: 'project', projectId, revision: 1,
      }],
    });
    await expect(invoke(listQuery, projectId)).resolves.toEqual([source]);
    expect(refreshes()).toEqual([]);

    const existing = await invoke<ProjectWorkflow>(DESKTOP_IPC.projectWorkflowCreate, { projectId, templateId: saved.id });
    const revisedSource = await invoke<ProjectWorkflow>(DESKTOP_IPC.projectWorkflowUpdate, {
      projectId, workflowId: source.id, expectedRevision: source.revision,
      name: source.name, description: source.description,
      nodes: source.nodes.map((node) => ({ ...node, title: 'Revised fixture step' })),
    });
    const updateRequest = {
      ...saveRequest, expectedWorkflowRevision: revisedSource.revision,
      templateId: saved.id, expectedTemplateRevision: saved.revision, name: 'Revised fixture template',
    };

    sender.send.mockClear();
    await expect(invoke(save, saveRequest)).rejects.toThrow('PROJECT_WORKFLOW_REVISION_CONFLICT');
    await expect(invoke(update, { ...updateRequest, expectedWorkflowRevision: source.revision })).rejects.toThrow('PROJECT_WORKFLOW_REVISION_CONFLICT');
    expect(refreshes()).toEqual([]);
    const updated = await invoke<ProjectWorkflowTemplate>(update, updateRequest);
    expect(updated).toMatchObject({ id: saved.id, name: updateRequest.name, revision: saved.revision + 1 });
    expect(updated.nodes[0].title).toBe('Revised fixture step');
    await expect(invoke(update, updateRequest)).rejects.toThrow('PROJECT_WORKFLOW_TEMPLATE_REVISION_CONFLICT');
    expect(refreshes()).toEqual([refresh]);
    const drafts = await invoke<ProjectWorkflow[]>(listQuery, projectId);
    expect(drafts.find((workflow) => workflow.id === existing.id)).toEqual(existing);

    sender.send.mockClear();
    const target = { projectId, templateId: saved.id };
    await expect(invoke(remove, { ...target, expectedRevision: saved.revision })).rejects.toThrow('PROJECT_WORKFLOW_TEMPLATE_REVISION_CONFLICT');
    expect(refreshes()).toEqual([]);
    await expect(invoke(remove, { ...target, expectedRevision: updated.revision })).resolves.toBeUndefined();
    expect(refreshes()).toEqual([refresh]);
    const catalog = await invoke<ProjectWorkflowCatalog>(catalogQuery, projectId);
    expect(catalog.templates.some((template) => template.id === saved.id)).toBe(false);
  } finally {
    try {
      await dispose?.();
      expect(handlers.size).toBe(0);
    } finally {
      await testRm(root, { recursive: true, force: true });
    }
  }
});
