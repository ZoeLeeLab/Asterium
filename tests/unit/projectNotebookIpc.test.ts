// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_IPC as AGENT_IPC } from '../../src/shared/desktopIpc';
import type { ProjectNotebook } from '../../src/shared/projectNotebook';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({
  root: '',
  fromWebContents: vi.fn(),
  showSaveDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => electron.root,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    whenReady: async () => undefined,
  },
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  clipboard: {},
  dialog: { showSaveDialog: electron.showSaveDialog },
  safeStorage: {},
  shell: {},
}));

const target = { partnerId: 'fixture-notebook-partner', projectId: 'fixture-notebook-project' };
const projectName = '样例:项目';
const content = '# 合成笔记\r\n\r\n保留原文和换行。\r\n';
const sender = { send: vi.fn() };
const foreignSender = { send: vi.fn() };
const window = { webContents: sender, isDestroyed: () => false };
const foreignWindow = { webContents: foreignSender, isDestroyed: () => false };
type Handler = (event: { sender: typeof sender }, value?: unknown) => unknown;
const handlers = new Map<string, Handler>();
let dispose: (() => Promise<void>) | undefined;

async function invoke<T = unknown>(channel: string, value?: unknown, caller = sender): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
  return await handler({ sender: caller }, value) as T;
}

beforeEach(async () => {
  electron.root = await mkdtemp(path.join(os.tmpdir(), 'asterium-notebook-ipc-'));
  electron.fromWebContents.mockReset().mockImplementation((value: unknown) =>
    value === sender ? window : value === foreignSender ? foreignWindow : undefined);
  electron.showSaveDialog.mockReset();
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  dispose = registerAgentIpc(ipcMain, () => window as unknown as BrowserWindow, { environment: {
    profile: 'autotest', label: 'Fixture', userDataDirectory: electron.root,
    projectsDirectory: path.join(electron.root, 'projects'), temporaryDirectory: electron.root,
    appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
    restoreBackgroundServices: false, mcpPort: 0,
  } });
  await invoke(AGENT_IPC.savePartnerProfile, {
    partnerId: target.partnerId, sourceMode: 'local_cli',
    publicIdentity: { displayName: '样例伙伴', mentionName: '样例', introduction: '', expertise: '' },
    management: { memoryMode: 'self_managed', personality: false, userProfile: false },
    connectionSettings: {},
  });
  const project = { projectId: target.projectId, name: projectName, memberIds: [target.partnerId] };
  const confirmedRoot = await invoke<string>(AGENT_IPC.projectPreviewCreateLocation, project);
  await invoke(AGENT_IPC.projectCreate, { ...project, confirmedRoot });
});

afterEach(async () => {
  try {
    await dispose?.();
    expect(handlers.size).toBe(0);
  } finally {
    dispose = undefined;
    handlers.clear();
    await testRm(electron.root, { recursive: true, force: true });
  }
});

async function archiveNotebook() {
  await invoke(AGENT_IPC.projectNotebookReplace, { ...target, content, expectedRevision: 0 });
  await invoke(AGENT_IPC.projectRemove, { projectId: target.projectId, roomIds: [] });
}

describe('project notebook IPC', () => {
  it('reads and replaces the active notebook, guarding membership and revision', async () => {
    await expect(invoke(AGENT_IPC.projectNotebookGet, target)).resolves.toBeUndefined();
    const request = { ...target, content, expectedRevision: 0 };
    const saved = await invoke<ProjectNotebook>(AGENT_IPC.projectNotebookReplace, request);
    expect(saved).toMatchObject({ ...target, projectName, content, revision: 1, state: 'active' });
    await expect(invoke(AGENT_IPC.projectNotebookReplace, { ...request, content: '过期编辑' }))
      .rejects.toThrow('PROJECT_NOTEBOOK_REVISION_CONFLICT');
    await expect(invoke(AGENT_IPC.projectNotebookGet, target)).resolves.toEqual(saved);
    const nonMember = { ...target, partnerId: 'fixture-non-member' };
    await expect(invoke(AGENT_IPC.projectNotebookGet, nonMember)).rejects.toThrow('PROJECT_NOTEBOOK_ACCESS_DENIED');
    await expect(invoke(AGENT_IPC.projectNotebookReplace, { ...request, ...nonMember })).rejects.toThrow('PROJECT_NOTEBOOK_ACCESS_DENIED');
  });

  it('keeps the validation errors for malformed targets and replacement parameters', async () => {
    const invalidTarget = { ...target, projectId: ' ' };
    for (const channel of [AGENT_IPC.projectNotebookGet, AGENT_IPC.projectNotebookReplace, AGENT_IPC.projectNotebookExport, AGENT_IPC.projectNotebookPurge]) {
      await expect(invoke(channel, invalidTarget)).rejects.toThrow('INVALID_PROJECT_NOTEBOOK_TARGET');
    }
    for (const request of [{ ...target, content, expectedRevision: -1 }, { ...target, content: null, expectedRevision: 0 }]) {
      await expect(invoke(AGENT_IPC.projectNotebookReplace, request)).rejects.toThrow('INVALID_PROJECT_NOTEBOOK_REPLACE');
    }
  });

  it('lists only archived notebooks and purges an archived notebook', async () => {
    await invoke(AGENT_IPC.projectNotebookReplace, { ...target, content, expectedRevision: 0 });
    await expect(invoke(AGENT_IPC.projectNotebookListArchived)).resolves.toEqual([]);
    await expect(invoke(AGENT_IPC.projectNotebookPurge, target)).rejects.toThrow('PROJECT_NOTEBOOK_PURGE_REQUIRES_ARCHIVED');
    await invoke(AGENT_IPC.projectRemove, { projectId: target.projectId, roomIds: [] });
    const archived = await invoke<ProjectNotebook[]>(AGENT_IPC.projectNotebookListArchived);
    expect(archived).toEqual([expect.objectContaining({ ...target, content, state: 'archived' })]);
    await expect(invoke(AGENT_IPC.projectNotebookPurge, target)).resolves.toEqual(archived[0]);
    await expect(invoke(AGENT_IPC.projectNotebookListArchived)).resolves.toEqual([]);
  });

  it('exports the archived Markdown unchanged and respects cancellation', async () => {
    await expect(invoke(AGENT_IPC.projectNotebookExport, target)).rejects.toThrow('PROJECT_NOTEBOOK_ARCHIVED_NOT_FOUND');
    await archiveNotebook();
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    await expect(invoke(AGENT_IPC.projectNotebookExport, target)).resolves.toBe(false);
    expect(electron.showSaveDialog).toHaveBeenCalledWith(window, {
      title: '导出项目工作笔记',
      defaultPath: '样例_项目-工作笔记.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    const destination = path.join(electron.root, 'fixture-export.md');
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
    await expect(invoke(AGENT_IPC.projectNotebookExport, target)).resolves.toBe(true);
    await expect(readFile(destination)).resolves.toEqual(Buffer.from(content, 'utf8'));
  });

  it('currently accepts notebook requests from another window', async () => {
    await expect(invoke(AGENT_IPC.projectNotebookReplace, { ...target, content, expectedRevision: 0 }, foreignSender))
      .resolves.toMatchObject({ content });
    await expect(invoke(AGENT_IPC.projectNotebookGet, target, foreignSender)).resolves.toMatchObject({ content });
    await invoke(AGENT_IPC.projectRemove, { projectId: target.projectId, roomIds: [] });
    await expect(invoke(AGENT_IPC.projectNotebookListArchived, undefined, foreignSender)).resolves.toHaveLength(1);
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    await expect(invoke(AGENT_IPC.projectNotebookExport, target, foreignSender)).resolves.toBe(false);
    expect(electron.showSaveDialog).toHaveBeenCalledWith(foreignWindow, expect.anything());
    await expect(invoke(AGENT_IPC.projectNotebookPurge, target, foreignSender)).resolves.toMatchObject({ content });
  });
});
