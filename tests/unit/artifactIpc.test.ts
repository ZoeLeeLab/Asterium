// @vitest-environment node
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow, IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactRegistry } from '../../src/main/security/ArtifactRegistry';
import { ProjectFileDeletionService } from '../../src/main/project/ProjectFileDeletionService';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { FileDeletionResult } from '../../src/shared/projectWorkspace';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({
  root: '',
  showSaveDialog: vi.fn(),
  openPath: vi.fn(),
  openExternal: vi.fn(),
  showItemInFolder: vi.fn(),
  writeText: vi.fn(),
}));
const browserLink = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn() }));

vi.mock('electron', () => ({
  app: {
    getPath: () => electron.root,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    whenReady: async () => undefined,
  },
  BrowserWindow: class {},
  clipboard: { writeText: electron.writeText },
  dialog: { showSaveDialog: electron.showSaveDialog },
  safeStorage: {},
  shell: { openPath: electron.openPath, openExternal: electron.openExternal, showItemInFolder: electron.showItemInFolder },
}));
vi.mock('../../src/main/security/ArtifactBrowserLink', () => ({ createArtifactBrowserLink: browserLink.create }));

const id = 'fixture-document';
const conversationId = 'fixture-chat';
const content = '# 合成交付\r\n';
const sender = { send: vi.fn() };
const window = { webContents: sender, isDestroyed: () => false };
type Handler = (event: { sender: typeof sender }, value?: unknown) => unknown;
const handlers = new Map<string, Handler>();
const artifactChannels = {
  artifactInspect: 'inspect',
  artifactResolveConversationLink: 'resolve-conversation-link',
  artifactRead: 'read',
  artifactOpen: 'open',
  artifactOpenInBrowser: 'open-in-browser',
  artifactReveal: 'reveal',
  artifactCopyPath: 'copy-path',
  artifactSaveAs: 'save-as',
  artifactSaveToProject: 'save-to-project',
  artifactInspectDeletion: 'inspect-deletion',
  artifactDelete: 'delete',
  artifactCacheStats: 'cache-stats',
  artifactClearCache: 'clear-cache',
} as const;
let artifactPath: string;
let dispose: (() => Promise<void>) | undefined;

async function invoke<T = unknown>(channel: string, value?: unknown, caller = sender): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
  return await handler({ sender: caller }, value) as T;
}

beforeEach(async () => {
  vi.resetAllMocks();
  electron.root = await mkdtemp(path.join(os.tmpdir(), 'asterium-artifact-ipc-'));
  artifactPath = path.join(electron.root, '交付样例.md');
  await writeFile(artifactPath, content, 'utf8');
  const artifacts = new ArtifactRegistry({
    storePath: path.join(electron.root, 'artifacts.v1.json'),
    cacheDirectory: path.join(electron.root, 'artifact-cache-v2'),
  });
  await artifacts.register({ kind: 'local_path', path: artifactPath }, { id, conversationId, method: 'automatic' });
  await artifacts.register({ kind: 'content', transport: 'base64', value: Buffer.from('fixture cache').toString('base64') },
    { id: 'fixture-cached', name: 'cache.txt', method: 'automatic' });
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
});

afterEach(async () => {
  try {
    await dispose?.();
    expect(handlers.size).toBe(0);
  } finally {
    dispose = undefined;
    handlers.clear();
    vi.restoreAllMocks();
    await testRm(electron.root, { recursive: true, force: true });
  }
});

describe('artifact IPC', () => {
  it('registers exactly the original channels and checks the sender before validation', async () => {
    const channels = Object.entries(artifactChannels).map(([key, suffix]) => {
      const channel = DESKTOP_IPC[key as keyof typeof artifactChannels];
      expect(channel).toBe(`asterium:artifact:${suffix}`);
      return channel;
    });
    expect([...handlers.keys()].filter((value) => value.startsWith('asterium:artifact:')).sort()).toEqual(channels.sort());
    for (const channel of channels) {
      await expect(invoke(channel, undefined, { send: vi.fn() })).rejects.toThrow('INVALID_IPC_SENDER');
      if (channel === DESKTOP_IPC.artifactCacheStats || channel === DESKTOP_IPC.artifactClearCache) continue;
      const error = channel === DESKTOP_IPC.artifactResolveConversationLink ? 'INVALID_ARTIFACT_LINK'
        : channel === DESKTOP_IPC.artifactSaveToProject ? 'INVALID_PROJECT_ARTIFACT_REQUEST' : 'INVALID_ARTIFACT_ID';
      await expect(invoke(channel, undefined)).rejects.toThrow(error);
    }
    for (const value of [{ conversationId: ' ', href: '' }, { conversationId: 'x'.repeat(513), href: '' }, { conversationId, href: 1 }]) {
      await expect(invoke(DESKTOP_IPC.artifactResolveConversationLink, value)).rejects.toThrow('INVALID_ARTIFACT_LINK');
    }
    await expect(invoke(DESKTOP_IPC.artifactSaveToProject, { artifactId: id, projectId: ' ' })).rejects.toThrow('INVALID_PROJECT_ARTIFACT_REQUEST');
  });

  it('inspects, reads and resolves the exact delivered file only within its conversation', async () => {
    const info = await invoke(DESKTOP_IPC.artifactInspect, id);
    expect(info).toMatchObject({ id, name: '交付样例.md', availability: 'available', previewKind: 'markdown' });
    await expect(invoke(DESKTOP_IPC.artifactInspect, 'fixture-missing')).resolves.toBeNull();
    await expect(invoke(DESKTOP_IPC.artifactRead, id)).resolves.toEqual({ info, text: content });
    const href = pathToFileURL(artifactPath).href;
    await expect(invoke(DESKTOP_IPC.artifactResolveConversationLink, { conversationId, href }))
      .resolves.toEqual({ artifact: info, action: 'preview' });
    await expect(invoke(DESKTOP_IPC.artifactResolveConversationLink, { conversationId: 'fixture-other-chat', href })).resolves.toBeNull();
  });

  it('uses the original paths for opening, revealing and copying, and surfaces shell errors', async () => {
    electron.openPath.mockResolvedValueOnce('').mockResolvedValueOnce('fixture open error');
    await expect(invoke(DESKTOP_IPC.artifactOpen, id)).resolves.toBeUndefined();
    await expect(invoke(DESKTOP_IPC.artifactOpen, id)).rejects.toThrow('fixture open error');
    expect(electron.openPath).toHaveBeenCalledWith(artifactPath);
    await expect(invoke(DESKTOP_IPC.artifactReveal, id)).resolves.toBeUndefined();
    expect(electron.showItemInFolder).toHaveBeenCalledWith(artifactPath);
    await expect(invoke(DESKTOP_IPC.artifactCopyPath, id)).resolves.toBeUndefined();
    expect(electron.writeText).toHaveBeenCalledWith(artifactPath);
    await expect(invoke(DESKTOP_IPC.artifactCopyPath, 'fixture-cached')).rejects.toThrow('ARTIFACT_HAS_NO_ORIGINAL_PATH');
  });

  it('hands off the temporary browser link and closes it if launch fails', async () => {
    const url = 'http://127.0.0.1:12345/fixture';
    browserLink.create.mockResolvedValue({ url, close: browserLink.close });
    const error = new Error('fixture browser launch failed');
    electron.openExternal.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    await expect(invoke(DESKTOP_IPC.artifactOpenInBrowser, id)).resolves.toBeUndefined();
    expect(browserLink.create).toHaveBeenCalledWith({ path: artifactPath, name: '交付样例.md', mediaType: 'text/markdown' });
    expect(electron.openExternal).toHaveBeenCalledWith(url);
    expect(browserLink.close).not.toHaveBeenCalled();
    await expect(invoke(DESKTOP_IPC.artifactOpenInBrowser, id)).rejects.toBe(error);
    expect(browserLink.close).toHaveBeenCalledTimes(1);
  });

  it('leaves cancelled exports untouched and copies the exact bytes on confirmation', async () => {
    const destination = path.join(electron.root, 'fixture-export.md');
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: destination })
      .mockResolvedValueOnce({ canceled: false, filePath: destination });
    await expect(invoke(DESKTOP_IPC.artifactSaveAs, id)).resolves.toBe(false);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(electron.showSaveDialog).toHaveBeenCalledWith(window, { defaultPath: '交付样例.md' });
    await expect(invoke(DESKTOP_IPC.artifactSaveAs, id)).resolves.toBe(true);
    await expect(readFile(destination)).resolves.toEqual(Buffer.from(content));
  });

  it('saves a partner delivery to the project and publishes its updated file list', async () => {
    const projectId = 'fixture-project';
    const project = { projectId, name: '样例项目' };
    const confirmedRoot = await invoke<string>(DESKTOP_IPC.projectPreviewCreateLocation, project);
    await invoke(DESKTOP_IPC.projectCreate, { ...project, confirmedRoot });
    sender.send.mockClear();
    const result = await invoke<{ absolutePath: string }>(DESKTOP_IPC.artifactSaveToProject, { artifactId: id, projectId: ` ${projectId} ` });
    expect(result).toMatchObject({ artifactId: id, projectId, name: '交付样例.md' });
    await expect(readFile(result.absolutePath)).resolves.toEqual(Buffer.from(content));
    expect(sender.send).toHaveBeenCalledWith(DESKTOP_IPC.projectFilesChanged, {
      projectId, files: expect.arrayContaining([expect.objectContaining({ artifactId: id, category: 'delivery' })]),
    });
  });

  it('returns the deletion result and republishes every snapshot supplied by the service', async () => {
    const target = { kind: 'artifact', artifactId: id } as const;
    await expect(invoke(DESKTOP_IPC.artifactInspectDeletion, id)).resolves.toMatchObject({ target, canDelete: true, action: 'trash_and_remove' });
    const result: FileDeletionResult = {
      target, removedAt: '2026-01-01T00:00:00.000Z',
      projectSnapshots: [{ projectId: 'fixture-project-a', files: [] }, { projectId: 'fixture-project-b', files: [] }],
    };
    const remove = vi.spyOn(ProjectFileDeletionService.prototype, 'delete').mockResolvedValueOnce(result);
    sender.send.mockClear();
    await expect(invoke(DESKTOP_IPC.artifactDelete, id)).resolves.toBe(result);
    expect(remove).toHaveBeenCalledWith(target);
    expect(sender.send.mock.calls).toEqual(result.projectSnapshots.map((snapshot) => [DESKTOP_IPC.projectFilesChanged, snapshot]));
  });

  it('reports and clears delivery cache without removing the local source', async () => {
    await expect(invoke(DESKTOP_IPC.artifactCacheStats)).resolves.toMatchObject({ itemCount: 1, sizeBytes: 13 });
    await expect(invoke(DESKTOP_IPC.artifactClearCache)).resolves.toMatchObject({ itemCount: 0, sizeBytes: 0 });
    await expect(invoke(DESKTOP_IPC.artifactCacheStats)).resolves.toMatchObject({ itemCount: 0, sizeBytes: 0 });
    await expect(readFile(artifactPath, 'utf8')).resolves.toBe(content);
  });
});
