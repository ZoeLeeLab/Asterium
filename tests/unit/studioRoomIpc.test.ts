// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { StudioRoomStore } from '../../src/main/studio/StudioRoomStore';
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
  BrowserWindow: class { static fromWebContents = electron.fromWebContents; },
  clipboard: {},
  dialog: { showSaveDialog: electron.showSaveDialog },
  safeStorage: {},
  shell: {},
}));

it('reads an archived studio room and exports the supplied Markdown unchanged through IPC', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-room-ipc-'));
  electron.root = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  electron.fromWebContents.mockReturnValue(window);
  type Handler = (event: { sender: object }, request: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const get = 'asterium:studio:get-room';
  const exportMarkdown = 'asterium:studio:export-markdown';
  const invoke = async (channel: string, request: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return handler({ sender: caller }, request);
  };

  try {
    const ledgerPath = path.join(root, 'studio-rooms.v1.json');
    const rooms = new StudioRoomStore(ledgerPath);
    const metadata = { roomId: 'fixture-room', projectId: 'fixture-project', name: '样例:群聊', memberIds: [], archived: true };
    const snapshot = await rooms.syncRoom(metadata);
    const originalLedger = await readFile(ledgerPath);
    const request = { roomId: metadata.roomId, content: '# 合成群聊\r\n\r\n保留中文、格式和换行。 🌱\r\n' };
    const destination = path.join(root, 'fixture-export.md');
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await expect(invoke(get, metadata.roomId, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(exportMarkdown, request, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(get, '')).rejects.toThrow('INVALID_STUDIO_ROOM_ID');
      await expect(invoke(get, 'missing-fixture-room')).resolves.toBeUndefined();
      await expect(invoke(get, metadata.roomId)).resolves.toEqual(snapshot);
      await expect(invoke(exportMarkdown, { ...request, content: null })).rejects.toThrow('INVALID_STUDIO_MARKDOWN_EXPORT');
      await expect(invoke(exportMarkdown, { ...request, content: '界'.repeat(3_333_334) })).rejects.toThrow('INVALID_STUDIO_MARKDOWN_EXPORT');
      await expect(invoke(exportMarkdown, { ...request, roomId: 'missing-fixture-room' })).rejects.toThrow('STUDIO_ROOM_NOT_FOUND');
      electron.fromWebContents.mockReturnValueOnce(null);
      await expect(invoke(exportMarkdown, request)).rejects.toThrow('STUDIO_EXPORT_WINDOW_UNAVAILABLE');
      expect(electron.showSaveDialog).not.toHaveBeenCalled();

      electron.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: destination });
      await expect(invoke(exportMarkdown, request)).resolves.toBe(false);
      expect(electron.fromWebContents).toHaveBeenLastCalledWith(sender);
      expect(electron.showSaveDialog).toHaveBeenLastCalledWith(window, {
        title: '导出群聊记录',
        defaultPath: '样例_群聊-群聊记录.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
      await expect(invoke(exportMarkdown, request)).resolves.toBe(true);
      await expect(readFile(destination)).resolves.toEqual(Buffer.from(request.content, 'utf8'));
      await expect(readFile(ledgerPath)).resolves.toEqual(originalLedger);
    } finally {
      await dispose();
    }
    expect(handlers.has(get)).toBe(false);
    expect(handlers.has(exportMarkdown)).toBe(false);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
});
