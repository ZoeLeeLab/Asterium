// @vitest-environment node
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { ProjectFileDeletionService } from '../../src/main/project/ProjectFileDeletionService';
import { ProjectWorkspaceStore } from '../../src/main/project/ProjectWorkspaceStore';
import { ProjectFileStore } from '../../src/main/project/ProjectFileStore';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { FileDeletionInspection, FileDeletionResult } from '../../src/shared/projectWorkspace';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ profile: '', trash: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.profile, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, safeStorage: {}, clipboard: {}, dialog: {}, shell: { trashItem: electron.trash },
}));
type Handler = (event: { sender: object }, value?: unknown) => unknown;
const keys = ['projectInspectFileDeletion', 'projectDeleteFile'] as const;
const handlers = new Map<string, Handler>(), removed: string[] = [], sender = { send: vi.fn() };
const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
let root: string, dispose: (() => Promise<void>) | undefined;
const invoke = async <T = unknown>(key: keyof typeof DESKTOP_IPC, value?: unknown) => await handlers.get(DESKTOP_IPC[key])!({ sender }, value) as T;
beforeEach(async () => {
  vi.resetAllMocks(); handlers.clear(); removed.length = 0;
  root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-file-deletion-ipc-')); electron.profile = path.join(root, 'profile'); await mkdir(electron.profile);
  dispose = registerAgentIpc({ handle: (channel: string, handler: Handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); },
  } as unknown as IpcMain, () => window, { environment: { profile: 'autotest', label: 'Fixture', userDataDirectory: electron.profile, projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root, appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false, restoreBackgroundServices: false, mcpPort: 0 } });
  await invoke('studioMcpStatus'); sender.send.mockClear();
});
afterEach(async () => {
  try { vi.restoreAllMocks(); await dispose?.(); expect(handlers.size).toBe(0); expect(removed).toHaveLength(230); for (const key of keys) expect(removed.filter(channel => channel === DESKTOP_IPC[key])).toHaveLength(1); }
  finally { dispose = undefined; await testRm(root, { recursive: true, force: true }); }
});
const input = { projectId: 'fixture-project', fileId: 'fixture-file' }, target = { kind: 'project_file' as const, ...input };
it('keeps both registrations in the original slot and checks the sender before malformed input or service calls', async () => {
  const all = [...handlers.keys()], index = all.indexOf(DESKTOP_IPC.projectInspectFileDeletion);
  expect(all.slice(index - 1, index + 3)).toEqual([DESKTOP_IPC.projectListFiles, ...keys.map(key => DESKTOP_IPC[key]), DESKTOP_IPC.projectGetExecutionPolicy]);
  const inspect = vi.spyOn(ProjectFileDeletionService.prototype, 'inspect'), remove = vi.spyOn(ProjectFileDeletionService.prototype, 'delete');
  for (const key of keys) await expect(handlers.get(DESKTOP_IPC[key])!({ sender: {} }, null)).rejects.toThrow('INVALID_IPC_SENDER');
  expect(inspect).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(electron.trash).not.toHaveBeenCalled();
});
it('preserves parameter validation, extra-field handling and untrimmed strings for both operations', async () => {
  const inspect = vi.spyOn(ProjectFileDeletionService.prototype, 'inspect').mockResolvedValue({} as FileDeletionInspection), remove = vi.spyOn(ProjectFileDeletionService.prototype, 'delete').mockResolvedValue({ projectSnapshots: [] } as unknown as FileDeletionResult);
  for (const key of keys) for (const value of [null, [], {}, { ...input, projectId: 1 }, { ...input, fileId: undefined }]) await expect(invoke(key, value)).rejects.toThrow('INVALID_PROJECT_FILE_REQUEST');
  expect(inspect).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  for (const key of keys) await invoke(key, { projectId: ' ', fileId: '', ignored: 'fixture' });
  expect(inspect).toHaveBeenCalledExactlyOnceWith({ kind: 'project_file', projectId: ' ', fileId: '' }); expect(remove).toHaveBeenCalledExactlyOnceWith({ kind: 'project_file', projectId: ' ', fileId: '' });
});
it('returns the exact inspection without notifications and preserves service rejection', async () => {
  const receipt = { target, name: '合成文件', sourceState: 'available', action: 'trash_and_remove', requiresConfirmation: true, canDelete: false, references: [] } as FileDeletionInspection;
  const inspect = vi.spyOn(ProjectFileDeletionService.prototype, 'inspect').mockResolvedValue(receipt);
  await expect(invoke('projectInspectFileDeletion', input)).resolves.toBe(receipt); expect(inspect).toHaveBeenCalledExactlyOnceWith(target); expect(sender.send).not.toHaveBeenCalled();
  const failure = new Error('SYNTHETIC_INSPECTION_FAILURE'); inspect.mockRejectedValueOnce(failure); await expect(invoke('projectInspectFileDeletion', input)).rejects.toBe(failure); expect(electron.trash).not.toHaveBeenCalled();
});
it('awaits deletion, publishes every returned project snapshot in order and returns the same receipt', async () => {
  let finish!: (value: FileDeletionResult) => void; const pending = new Promise<FileDeletionResult>(resolve => { finish = resolve; });
  const remove = vi.spyOn(ProjectFileDeletionService.prototype, 'delete').mockReturnValue(pending), snapshots = [{ projectId: input.projectId, files: [] }, { projectId: 'fixture-second-project', files: [] }];
  const receipt: FileDeletionResult = { target, removedAt: '2026-01-18T00:00:00.000Z', projectSnapshots: snapshots };
  const result = invoke('projectDeleteFile', input); expect(remove).toHaveBeenCalledExactlyOnceWith(target); expect(sender.send).not.toHaveBeenCalled(); finish(receipt);
  await expect(result).resolves.toBe(receipt); expect(sender.send.mock.calls).toEqual(snapshots.map(snapshot => [DESKTOP_IPC.projectFilesChanged, snapshot]));
});
it('does not publish after a failed deletion and preserves a notification failure after deletion succeeds', async () => {
  const failure = new Error('SYNTHETIC_DELETE_FAILURE'), remove = vi.spyOn(ProjectFileDeletionService.prototype, 'delete').mockRejectedValueOnce(failure);
  await expect(invoke('projectDeleteFile', input)).rejects.toBe(failure); expect(sender.send).not.toHaveBeenCalled();
  remove.mockResolvedValue({ target, removedAt: '2026-01-18T00:00:00.000Z', projectSnapshots: [{ projectId: input.projectId, files: [] }, { projectId: 'fixture-other', files: [] }] });
  sender.send.mockImplementationOnce(() => { throw failure; }); await expect(invoke('projectDeleteFile', input)).rejects.toBe(failure); expect(sender.send).toHaveBeenCalledTimes(1);
});
it('uses the existing service to inspect and trash only an owned indexed project file, preserving unrelated bytes', async () => {
  const workspaces = new ProjectWorkspaceStore(path.join(electron.profile, 'project-workspaces.v1.json'), () => path.join(root, 'projects'));
  const workspace = await workspaces.create({ projectId: input.projectId, name: '合成删除项目' });
  const owned = path.join(workspace.rootPath, 'fixture.md'), other = path.join(workspace.rootPath, 'other.md'); await writeFile(owned, '合成删除文件'); await writeFile(other, '合成保留文件');
  const files = new ProjectFileStore(path.join(electron.profile, 'project-files.v1.json'), workspaces);
  await files.initializeProject(workspace, [{ artifactId: 'fixture-artifact', relativePath: 'fixture.md', originalPath: owned }]);
  const before = await files.list(input.projectId), indexed = before.find(file => file.relativePath === 'fixture.md')!; const selection = { projectId: input.projectId, fileId: indexed.fileId };
  electron.trash.mockImplementation(async (file: string) => { expect(file).toBe(owned); await rename(file, path.join(root, 'fixture-recycle-bin.md')); });
  await expect(invoke('projectInspectFileDeletion', selection)).resolves.toMatchObject({ canDelete: true, action: 'trash_and_remove', requiresConfirmation: true });
  expect(electron.trash).not.toHaveBeenCalled(); await expect(invoke('projectDeleteFile', selection)).resolves.toMatchObject({ target: { kind: 'project_file', ...selection }, projectSnapshots: [{ projectId: input.projectId, files: before.filter(file => file.fileId !== indexed.fileId) }] });
  expect(electron.trash).toHaveBeenCalledExactlyOnceWith(owned); expect(await readFile(other, 'utf8')).toBe('合成保留文件'); expect(await readFile(path.join(root, 'fixture-recycle-bin.md'), 'utf8')).toBe('合成删除文件');
});
