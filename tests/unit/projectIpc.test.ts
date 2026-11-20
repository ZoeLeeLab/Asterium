// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { ProjectService } from '../../src/main/project/ProjectService';
import { ProjectWorkspaceStore } from '../../src/main/project/ProjectWorkspaceStore';
import { ProjectWorkflowGenerationStore } from '../../src/main/project/ProjectWorkflowGenerationStore';
import { ProjectRunChangeRecorder } from '../../src/main/project/ProjectRunChangeRecorder';
import { ArtifactDeliveryService } from '../../src/main/project/ArtifactDeliveryService';
import { GeneralSettingsStore } from '../../src/main/settings/GeneralSettingsStore';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { ProjectCreateRequest, ProjectCreateResult } from '../../src/shared/projectDomain';
import type { ProjectWorkflowGeneration } from '../../src/shared/projectWorkflowGeneration';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '', choose: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.root, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, clipboard: {}, safeStorage: {}, shell: {}, dialog: { showOpenDialog: electron.choose },
}));
const invalid = [
  [DESKTOP_IPC.projectDomainInitialize, null, 'INVALID_PROJECT_DOMAIN_MIGRATION'],
  [DESKTOP_IPC.projectPreviewCreateLocation, null, 'INVALID_PROJECT_CREATE_REQUEST'],
  [DESKTOP_IPC.projectCreate, null, 'INVALID_PROJECT_CREATE_REQUEST'],
  [DESKTOP_IPC.projectUpdate, null, 'INVALID_PROJECT_UPDATE_REQUEST'],
  [DESKTOP_IPC.projectGetExecutionPolicy, null, 'INVALID_PROJECT_ID'],
  [DESKTOP_IPC.projectSetExecutionPolicy, { projectId: 'fixture', permissionMode: 'invalid' }, 'INVALID_PROJECT_EXECUTION_POLICY'],
  [DESKTOP_IPC.projectSyncMembers, [{ projectId: 'fixture', partnerIds: [1] }], 'INVALID_PROJECT_MEMBER_SYNC'],
  [DESKTOP_IPC.projectChangeMembers, [], 'INVALID_PROJECT_MEMBER_CHANGE'],
  [DESKTOP_IPC.projectRemove, { projectId: 'fixture', roomIds: [''] }, 'INVALID_PROJECT_REMOVE_REQUEST'],
] as const;

async function withProject(run: (fixture: {
  root: string; sender: { send: ReturnType<typeof vi.fn> };
  invoke: <T = unknown>(channel: string, value?: unknown, caller?: object) => Promise<T>;
  create: (request: ProjectCreateRequest) => Promise<ProjectCreateResult>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-ipc-'));
  electron.root = root; electron.choose.mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
  const sender = { send: vi.fn() }, handlers = new Map<string, (event: { sender: object }, value: unknown) => unknown>();
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  const removed: string[] = [];
  const ipc = { handle: (channel: string, handler: (event: { sender: object }, value: unknown) => unknown) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); }, removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); } } as unknown as IpcMain;
  const invoke = async <T,>(channel: string, value?: unknown, caller: object = sender) => await handlers.get(channel)!({ sender: caller }, value) as T;
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = registerAgentIpc(ipc, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root, projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false, restoreBackgroundServices: false, mcpPort: 0,
    } });
    await run({ root, sender, invoke, create: async request => {
      const confirmedRoot = await invoke<string>(DESKTOP_IPC.projectPreviewCreateLocation, request);
      return invoke<ProjectCreateResult>(DESKTOP_IPC.projectCreate, { ...request, confirmedRoot });
    } });
  } finally {
    try { await dispose?.(); expect(handlers.size).toBe(0); for (const channel of [DESKTOP_IPC.projectChooseLocation, ...invalid.map(([channel]) => channel)]) expect(removed.filter(name => name === channel)).toHaveLength(1); }
    finally { vi.restoreAllMocks(); await testRm(root, { recursive: true, force: true }); }
  }
}

it('preserves all ten sender checks and the existing shallow parameter validation', async () => {
  await withProject(async ({ invoke }) => {
    await expect(invoke(DESKTOP_IPC.projectChooseLocation, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
    for (const [channel, value, message] of invalid) {
      await expect(invoke(channel, value, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(channel, value)).rejects.toThrow(message);
    }
    expect(electron.choose).not.toHaveBeenCalled();
    for (const channel of [DESKTOP_IPC.projectPreviewCreateLocation, DESKTOP_IPC.projectCreate]) {
      await expect(invoke(channel, { projectId: 'fixture', name: 'Fixture', locationSelectionId: 3 })).rejects.toThrow('INVALID_PROJECT_LOCATION_SELECTION');
      await expect(invoke(channel, { projectId: 'fixture', name: 'Fixture', locationSelectionId: 'expired' })).rejects.toThrow('PROJECT_LOCATION_SELECTION_EXPIRED');
    }
    const update = vi.spyOn(ProjectService.prototype, 'updateProject').mockRejectedValueOnce(new Error('SYNTHETIC_UPDATE_FAILURE'));
    const request = { projectId: '', name: 7, fixtureExtra: true };
    await expect(invoke(DESKTOP_IPC.projectUpdate, request)).rejects.toThrow('SYNTHETIC_UPDATE_FAILURE');
    expect(update).toHaveBeenCalledExactlyOnceWith(request);
  });
});

it('keeps selections reusable on preview, changed confirmation and failed creation, consuming only after success', async () => {
  await withProject(async ({ root, invoke }) => {
    await expect(invoke(DESKTOP_IPC.projectChooseLocation)).resolves.toBeNull();
    electron.choose.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    await expect(invoke(DESKTOP_IPC.projectChooseLocation)).resolves.toBeNull();
    const target = path.join(root, 'selected');
    electron.choose.mockResolvedValue({ canceled: false, filePaths: [path.join(target, '..', 'selected')] });
    const first = await invoke<{ selectionId: string; path: string }>(DESKTOP_IPC.projectChooseLocation);
    const second = await invoke<{ selectionId: string }>(DESKTOP_IPC.projectChooseLocation);
    expect(first.path).toBe(path.resolve(target)); expect(first.selectionId).not.toBe(second.selectionId);
    const request = { projectId: 'fixture-created', name: 'Fixture', description: '', tags: ['fixture'], memberIds: [], locationSelectionId: first.selectionId };
    await expect(invoke(DESKTOP_IPC.projectPreviewCreateLocation, request)).resolves.toBe(target);
    await expect(invoke(DESKTOP_IPC.projectCreate, { ...request, confirmedRoot: target + '-changed' })).rejects.toThrow('PROJECT_CREATE_LOCATION_CHANGED');
    const create = vi.spyOn(ProjectService.prototype, 'createProject').mockRejectedValueOnce(new Error('SYNTHETIC_CREATE_FAILURE'));
    await expect(invoke(DESKTOP_IPC.projectCreate, { ...request, confirmedRoot: target })).rejects.toThrow('SYNTHETIC_CREATE_FAILURE');
    await expect(invoke(DESKTOP_IPC.projectPreviewCreateLocation, request)).resolves.toBe(target);
    const result = await invoke<ProjectCreateResult>(DESKTOP_IPC.projectCreate, { ...request, confirmedRoot: target });
    expect(result.project.id).toBe(request.projectId); expect(result.workspace.rootPath).toBe(target);
    expect(create.mock.calls).toEqual([0, 1].map(() => [{ projectId: request.projectId, name: request.name, description: '', tags: ['fixture'], memberIds: [], selectedRoot: target }]));
    await expect(invoke(DESKTOP_IPC.projectPreviewCreateLocation, request)).rejects.toThrow('PROJECT_LOCATION_SELECTION_EXPIRED');
  });
});

it('preserves default-root validation and uses the existing workspace path before previewing a new path', async () => {
  await withProject(async ({ root, create, invoke }) => {
    const settings = new GeneralSettingsStore(path.join(root, 'general-settings.v1.json'));
    const custom = path.join(root, 'custom'); await mkdir(custom); await settings.update({ defaultProjectRoot: custom });
    const result = await create({ projectId: 'fixture-default', name: 'Fixture default' });
    expect(result.workspace.rootPath.startsWith(custom + path.sep)).toBe(true);
    const preview = vi.spyOn(ProjectWorkspaceStore.prototype, 'preview');
    await expect(invoke(DESKTOP_IPC.projectPreviewCreateLocation, { projectId: result.project.id, name: 'Changed name' })).resolves.toBe(result.workspace.rootPath);
    expect(preview).not.toHaveBeenCalled();
    const read = vi.spyOn(GeneralSettingsStore.prototype, 'get').mockRejectedValueOnce(new Error('SYNTHETIC_SETTINGS_FAILURE'));
    await expect(invoke(DESKTOP_IPC.projectCreate, { projectId: result.project.id, name: 'Fixture', confirmedRoot: result.workspace.rootPath })).rejects.toThrow('SYNTHETIC_SETTINGS_FAILURE');
    expect(read).toHaveBeenCalled();
  });
});

it('initializes legacy delivery indexes sequentially only for projects with an existing workspace', async () => {
  await withProject(async ({ invoke }) => {
    await invoke(DESKTOP_IPC.projectDomainInitialize, { legacyProjects: [
      { id: 'fixture-a', name: 'Fixture A' }, { id: 'fixture-b', name: 'Fixture B' }, { id: 'fixture-no-workspace', name: 'Fixture absent' },
    ] });
    await invoke(DESKTOP_IPC.projectCreateWorkspace, { projectId: 'fixture-a', name: 'Fixture A' });
    await invoke(DESKTOP_IPC.projectCreateWorkspace, { projectId: 'fixture-b', name: 'Fixture B' });
    const initialize = vi.spyOn(ArtifactDeliveryService.prototype, 'initializeProject').mockResolvedValue([]);
    const request = { legacyProjects: [{ id: 'fixture-no-workspace', name: 'Fixture absent' }] };
    const domain = vi.spyOn(ProjectService.prototype, 'initializeDomain');
    const snapshot = await invoke<{ projects: Array<{ id: string }> }>(DESKTOP_IPC.projectDomainInitialize, request);
    expect(domain).toHaveBeenCalledExactlyOnceWith(request.legacyProjects);
    expect(snapshot.projects.map(project => project.id).sort()).toEqual(['fixture-a', 'fixture-b', 'fixture-no-workspace']);
    expect(initialize.mock.calls).toEqual(snapshot.projects.filter(project => project.id !== 'fixture-no-workspace').map(project => [project.id]));
    initialize.mockRejectedValueOnce(new Error('SYNTHETIC_INDEX_FAILURE'));
    await expect(invoke(DESKTOP_IPC.projectDomainInitialize, { legacyProjects: [] })).rejects.toThrow('SYNTHETIC_INDEX_FAILURE');
  });
});

it('keeps policies and member filtering in the existing service, preserving order, duplicates and errors', async () => {
  await withProject(async ({ root, create, invoke }) => {
    const saved = await create({ projectId: 'fixture-members', name: 'Fixture members' });
    await expect(invoke(DESKTOP_IPC.projectGetExecutionPolicy, saved.project.id)).resolves.toMatchObject({ permissionMode: 'manual' });
    for (const permissionMode of ['read_only', 'full', 'manual']) await expect(invoke(DESKTOP_IPC.projectSetExecutionPolicy, { projectId: saved.project.id, permissionMode })).resolves.toMatchObject({ permissionMode });
    const assignments = vi.spyOn(ProjectService.prototype, 'syncWorkspaceMemberships');
    const notDirectory = path.join(root, 'file.txt'); await writeFile(notDirectory, 'SYNTHETIC_NON_DIRECTORY');
    const get = vi.spyOn(ProjectWorkspaceStore.prototype, 'get');
    const missing = { ...saved.workspace, projectId: 'fixture-missing', rootPath: path.join(root, 'absent') };
    get.mockImplementation(async id => id === saved.project.id ? saved.workspace : id === missing.projectId ? missing : id === 'fixture-file' ? { ...missing, rootPath: notDirectory } : undefined);
    const value = [{ projectId: 'fixture-unknown', partnerIds: [] }, { projectId: missing.projectId, partnerIds: [] }, { projectId: 'fixture-file', partnerIds: [] }, { projectId: saved.project.id, partnerIds: ['fixture-partner', 'fixture-partner'] }, { projectId: saved.project.id, partnerIds: [] }];
    await invoke(DESKTOP_IPC.projectSyncMembers, value);
    expect(assignments).toHaveBeenCalledExactlyOnceWith(value.slice(3).map(item => ({ projectId: item.projectId, rootPath: saved.workspace.rootPath, partnerIds: item.partnerIds })));
    const error = new Error('SYNTHETIC_MEMBERSHIP_FAILURE'); assignments.mockRejectedValueOnce(error);
    await expect(invoke(DESKTOP_IPC.projectSyncMembers, [])).rejects.toBe(error);
    const change = vi.spyOn(ProjectService.prototype, 'changeMembers').mockRejectedValueOnce(error);
    const request = { fixtureExtra: true };
    await expect(invoke(DESKTOP_IPC.projectChangeMembers, request)).rejects.toBe(error); expect(change).toHaveBeenCalledExactlyOnceWith(request);
  });
});

it('guards project deletion and keeps service, generation and best-effort change cleanup in order', async () => {
  await withProject(async ({ invoke }) => {
    const order: string[] = [], error = new Error('SYNTHETIC_DELETE_FAILURE');
    const list = vi.spyOn(ProjectWorkflowGenerationStore.prototype, 'listProject').mockImplementation(async () => { order.push('list'); return []; });
    const remove = vi.spyOn(ProjectService.prototype, 'removeProject').mockImplementation(async () => { order.push('project'); });
    const generations = vi.spyOn(ProjectWorkflowGenerationStore.prototype, 'removeProject').mockImplementation(async () => { order.push('generations'); });
    const changes = vi.spyOn(ProjectRunChangeRecorder.prototype, 'removeProject').mockImplementation(async () => { order.push('changes'); });
    const request = { projectId: 'fixture-remove', roomIds: ['fixture-room', 'fixture-room'] };
    list.mockResolvedValueOnce([{ status: 'running' } as ProjectWorkflowGeneration]);
    await expect(invoke(DESKTOP_IPC.projectRemove, request)).rejects.toThrow('PROJECT_HAS_ACTIVE_WORKFLOW_GENERATION'); expect(order).toEqual([]); expect(remove).not.toHaveBeenCalled();
    remove.mockRejectedValueOnce(error);
    await expect(invoke(DESKTOP_IPC.projectRemove, request)).rejects.toBe(error); expect(order).toEqual(['list']); expect(generations).not.toHaveBeenCalled();
    order.length = 0; generations.mockRejectedValueOnce(error);
    await expect(invoke(DESKTOP_IPC.projectRemove, request)).rejects.toBe(error); expect(order).toEqual(['list', 'project']); expect(changes).not.toHaveBeenCalled();
    order.length = 0; changes.mockRejectedValueOnce(error); const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(invoke(DESKTOP_IPC.projectRemove, request)).resolves.toBeUndefined(); expect(order).toEqual(['list', 'project', 'generations']); expect(logged).toHaveBeenCalledExactlyOnceWith('Project change cleanup failed', error);
    order.length = 0;
    await expect(invoke(DESKTOP_IPC.projectRemove, request)).resolves.toBeUndefined(); expect(order).toEqual(['list', 'project', 'generations', 'changes']); expect(remove).toHaveBeenLastCalledWith(request.projectId, request.roomIds);
  });
});

it('keeps workspace selection consumption before the service call, including failures and optional fields', async () => {
  await withProject(async ({ root, invoke }) => {
    const channel = DESKTOP_IPC.projectCreateWorkspace;
    await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(channel, null)).rejects.toThrow('INVALID_PROJECT_WORKSPACE_REQUEST');
    await expect(invoke(channel, { projectId: 'fixture', name: 'Fixture', locationSelectionId: false })).rejects.toThrow('INVALID_PROJECT_LOCATION_SELECTION');
    electron.choose.mockResolvedValue({ canceled: false, filePaths: [path.join(root, 'workspace')] });
    const selected = await invoke<{ selectionId: string }>(DESKTOP_IPC.projectChooseLocation);
    const request = { projectId: 'fixture-legacy', name: 'Fixture legacy', description: 3, locationSelectionId: selected.selectionId };
    const create = vi.spyOn(ProjectService.prototype, 'createWorkspace').mockRejectedValueOnce(new Error('SYNTHETIC_WORKSPACE_FAILURE'));
    await expect(invoke(channel, request)).rejects.toThrow('SYNTHETIC_WORKSPACE_FAILURE');
    expect(create).toHaveBeenCalledExactlyOnceWith({ projectId: request.projectId, name: request.name, selectedRoot: path.join(root, 'workspace') });
    await expect(invoke(channel, request)).rejects.toThrow('PROJECT_LOCATION_SELECTION_EXPIRED'); expect(create).toHaveBeenCalledTimes(1);
    await invoke(DESKTOP_IPC.projectDomainInitialize, { legacyProjects: [{ id: request.projectId, name: request.name }] });
    const next = await invoke<{ selectionId: string }>(DESKTOP_IPC.projectChooseLocation);
    await expect(invoke(channel, { ...request, locationSelectionId: next.selectionId, description: '' })).resolves.toMatchObject({ projectId: request.projectId, rootPath: path.join(root, 'workspace') });
    expect(create).toHaveBeenLastCalledWith({ projectId: request.projectId, name: request.name, description: '', selectedRoot: path.join(root, 'workspace') });
    await expect(invoke(channel, { ...request, locationSelectionId: next.selectionId })).rejects.toThrow('PROJECT_LOCATION_SELECTION_EXPIRED');
    expect(await invoke(channel, { projectId: request.projectId, name: request.name })).toMatchObject({ projectId: request.projectId });
  });
});
