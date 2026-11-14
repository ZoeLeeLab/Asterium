// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { StudioNote } from '../../src/shared/studioNotes';
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

it('preserves the four studio note channels, sender and parameter checks, and note lifecycle', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  electron.root = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-note-ipc-'));
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: typeof sender }, value?: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const invoke = async <T = unknown>(channel: string, value?: unknown, caller = sender): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return await handler({ sender: caller }, value) as T;
  };
  const { studioNoteList: list, studioNoteSave: save, studioNoteSetStatus: setStatus, studioNoteDelete: remove } = DESKTOP_IPC;
  const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
    profile: 'autotest', label: 'Fixture', userDataDirectory: electron.root,
    projectsDirectory: path.join(electron.root, 'projects'), temporaryDirectory: electron.root,
    appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
    restoreBackgroundServices: false, mcpPort: 0,
  } });
  try {
    expect([...handlers.keys()].filter((channel) => channel.startsWith('asterium:studio-note:')).sort()).toEqual([
      'asterium:studio-note:delete', 'asterium:studio-note:list', 'asterium:studio-note:save', 'asterium:studio-note:set-status',
    ]);
    const foreign = { send: vi.fn() };
    for (const [channel, value, error] of [
      [list, null, 'INVALID_STUDIO_NOTE_PROJECT'],
      [save, { id: 1, projectId: 'fixture-project', content: '合成便签' }, 'INVALID_STUDIO_NOTE'],
      [setStatus, { id: 'fixture-note', status: 'invalid' }, 'INVALID_STUDIO_NOTE_STATUS'],
      [remove, '', 'INVALID_STUDIO_NOTE_ID'],
    ] as const) {
      await expect(invoke(channel, value, foreign)).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(channel, value)).rejects.toThrow(error);
    }

    const projectId = 'fixture-project';
    await expect(invoke(list)).resolves.toEqual([]);
    const note = await invoke<StudioNote>(save, { projectId, content: '  合成便签  ' });
    expect(note).toMatchObject({ projectId, content: '合成便签', status: 'open' });
    const other = await invoke<StudioNote>(save, { projectId: 'fixture-other-project', content: '另一条便签' });
    const updated = await invoke<StudioNote>(save, { id: note.id, projectId, content: '更新合成便签' });
    expect(updated).toMatchObject({ id: note.id, content: '更新合成便签', status: 'open' });
    expect(updated.createdAt).toBe(note.createdAt);
    const completed = await invoke<StudioNote>(setStatus, { id: note.id, status: 'completed' });
    expect(completed).toMatchObject({ ...updated, updatedAt: expect.any(String), status: 'completed', completedAt: expect.any(String) });
    await expect(invoke(list, projectId)).resolves.toEqual([completed]);
    await expect(invoke(remove, note.id)).resolves.toBeUndefined();
    await expect(invoke(remove, note.id)).resolves.toBeUndefined();
    await expect(invoke(list)).resolves.toEqual([other]);
  } finally {
    try {
      await dispose();
      expect(handlers.size).toBe(0);
    } finally {
      await testRm(electron.root, { recursive: true, force: true });
    }
  }
});
