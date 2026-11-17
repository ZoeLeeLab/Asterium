// @vitest-environment node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudioOrchestrator } from '../../src/main/studio/StudioOrchestrator';
import { StudioRoomStore } from '../../src/main/studio/StudioRoomStore';
import type { StudioRoomSnapshot } from '../../src/shared/studioRuntime';
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

const sender = { send: vi.fn() };
const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
type Handler = (event: { sender: object }, request: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const get = 'asterium:studio:get-room';
const exportMarkdown = 'asterium:studio:export-markdown';
const setMuted = 'asterium:studio:set-muted';
const setSettings = 'asterium:studio:set-settings';
const announce = 'asterium:studio:announce';
const resolveDiscussion = 'asterium:studio:resolve-discussion';
const roomChanged = 'asterium:studio:room-changed';
let dispose: (() => Promise<void>) | undefined;
let ledgerPath: string;
let rooms: StudioRoomStore;

async function invoke<T = unknown>(channel: string, request: unknown, caller: object = sender): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
  return await handler({ sender: caller }, request) as T;
}

beforeEach(async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-room-ipc-'));
  electron.root = root;
  electron.fromWebContents.mockReset().mockReturnValue(window);
  electron.showSaveDialog.mockReset();
  sender.send.mockClear();
  ledgerPath = path.join(root, 'studio-rooms.v1.json');
  rooms = new StudioRoomStore(ledgerPath);
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  dispose = registerAgentIpc(ipcMain, () => window, { environment: {
    profile: 'autotest', label: 'Fixture', userDataDirectory: root,
    projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
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
    if (electron.root) await testRm(electron.root, { recursive: true, force: true });
    electron.root = '';
  }
});

it('reads an archived studio room and exports the supplied Markdown unchanged through IPC', async () => {
  const metadata = { roomId: 'fixture-room', projectId: 'fixture-project', name: '样例:群聊', memberIds: [], archived: true };
  const snapshot = await rooms.syncRoom(metadata);
  const originalLedger = await readFile(ledgerPath);
  const request = { roomId: metadata.roomId, content: '# 合成群聊\r\n\r\n保留中文、格式和换行。 🌱\r\n' };
  const destination = path.join(electron.root, 'fixture-export.md');

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
});

it('filters room members, broadcasts saved settings, and rejects settings changes during an active round', async () => {
  const roomId = 'fixture-room';
  const [first, second] = ['fixture-first-partner', 'fixture-second-partner'];
  const metadata = { roomId, projectId: 'fixture-project', name: 'Fixture room', memberIds: [first, second] };
  await rooms.syncRoom(metadata);
  const muteRequest = { roomId, partnerIds: [first, 'fixture-non-member', first] };
  const settingsRequest = {
    roomId,
    settings: { speakingMode: 'selected_partners', selectedPartnerIds: [second, second, 'fixture-non-member'], discussionProtectionEnabled: false },
  };
  const changes = () => sender.send.mock.calls.filter(([channel]) => channel === roomChanged);

  await expect(invoke(setMuted, muteRequest, {})).rejects.toThrow('INVALID_IPC_SENDER');
  await expect(invoke(setSettings, settingsRequest, {})).rejects.toThrow('INVALID_IPC_SENDER');
  await expect(invoke(setMuted, { ...muteRequest, partnerIds: [42] })).rejects.toThrow('INVALID_STUDIO_MUTE_REQUEST');
  await expect(invoke(setSettings, { ...settingsRequest, settings: { ...settingsRequest.settings, speakingMode: 'unknown' } }))
    .rejects.toThrow('INVALID_STUDIO_SETTINGS_REQUEST');
  expect(changes()).toEqual([]);

  const muted = await invoke<StudioRoomSnapshot>(setMuted, muteRequest);
  expect(muted.mutedPartnerIds).toEqual([first]);
  await expect(rooms.getRoom(roomId)).resolves.toEqual(muted);
  expect(changes()).toEqual([[roomChanged, muted]]);
  sender.send.mockClear();

  const configured = await invoke<StudioRoomSnapshot>(setSettings, settingsRequest);
  expect(configured.settings).toEqual({ ...settingsRequest.settings, selectedPartnerIds: [second] });
  await expect(rooms.getRoom(roomId)).resolves.toEqual(configured);
  expect(changes()).toEqual([[roomChanged, configured]]);

  const active = await rooms.startRound({
    room: metadata, messageId: 'fixture-message', content: 'Fixture discussion.', authorId: 'fixture-user', speakerQueue: [second],
  });
  expect(active.activeRound?.state).toBe('queued');
  sender.send.mockClear();
  await expect(invoke(setSettings, { ...settingsRequest, settings: { ...settingsRequest.settings, speakingMode: 'round_robin' } }))
    .rejects.toThrow('STUDIO_ROUND_ALREADY_ACTIVE');
  await expect(invoke(get, roomId)).resolves.toEqual(active);
  expect(changes()).toEqual([]);
});

it('persists a system announcement and broadcasts its snapshot without starting a round in an idle room', async () => {
  const roomId = 'fixture-room';
  const initial = await rooms.syncRoom({
    roomId, projectId: 'fixture-project', name: 'Fixture room', memberIds: ['fixture-partner'],
  });
  const request = { roomId, content: '  Fixture announcement.  ' };
  const changes = () => sender.send.mock.calls.filter(([channel]) => channel === roomChanged);

  await expect(invoke(announce, request, {})).rejects.toThrow('INVALID_IPC_SENDER');
  await expect(invoke(announce, { roomId, content: null })).rejects.toThrow('INVALID_STUDIO_ANNOUNCEMENT');
  await expect(invoke(announce, { ...request, content: ' \t\n ' })).rejects.toThrow('STUDIO_ANNOUNCEMENT_REQUIRED');
  await expect(invoke(announce, { ...request, roomId: 'missing-fixture-room' })).rejects.toThrow('STUDIO_ROOM_NOT_FOUND');
  await expect(invoke(get, roomId)).resolves.toEqual(initial);
  expect(changes()).toEqual([]);

  const saved = await invoke<StudioRoomSnapshot>(announce, request);
  expect(saved).toEqual({
    ...initial,
    messages: [expect.objectContaining({
      roomId, seq: 1, authorType: 'system', authorId: 'system',
      content: 'Fixture announcement.', status: 'completed',
    })],
  });
  expect(saved.activeRound).toBeUndefined();
  await expect(rooms.getRoom(roomId)).resolves.toEqual(saved);
  expect(changes()).toEqual([[roomChanged, saved]]);
});

it('continues or ends a pending discussion, rejects repeats and forwards the saved round snapshot', async () => {
  const roomId = 'fixture-room';
  const partnerId = 'fixture-partner';
  const room = { roomId, projectId: 'fixture-project', name: 'Fixture room', memberIds: [partnerId] };
  await rooms.syncRoom(room);
  await rooms.startRound({ room, messageId: 'fixture-discussion', content: '合成讨论', authorId: 'fixture-user', speakerQueue: [partnerId] });
  const pending = JSON.parse(await readFile(ledgerPath, 'utf8'));
  pending.rooms[roomId].activeRound.state = 'waiting_discussion_decision';
  await writeFile(ledgerPath, JSON.stringify(pending), 'utf8');

  const request = { roomId, decision: 'continue' };
  const changes = () => sender.send.mock.calls.filter(([channel]) => channel === roomChanged);
  const handleSnapshot = vi.spyOn(StudioOrchestrator.prototype, 'handleSnapshot').mockImplementation(() => undefined);
  try {
    await expect(invoke(resolveDiscussion, request, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(resolveDiscussion, { ...request, decision: 'invalid' })).rejects.toThrow('INVALID_STUDIO_DISCUSSION_DECISION');
    await expect(invoke(resolveDiscussion, { ...request, roomId: 'fixture-missing-room' })).rejects.toThrow('STUDIO_ROOM_NOT_FOUND');
    expect(changes()).toEqual([]);
    expect(handleSnapshot).not.toHaveBeenCalled();

    const continued = await invoke<StudioRoomSnapshot>(resolveDiscussion, request);
    expect(continued.activeRound).toMatchObject({ state: 'queued', discussionPauseCount: 1, members: [{ partnerId, state: 'queued' }] });
    await expect(invoke(get, roomId)).resolves.toEqual(continued);
    await expect(invoke(resolveDiscussion, request)).rejects.toThrow('STUDIO_DISCUSSION_DECISION_NOT_PENDING');
    expect(changes()).toEqual([[roomChanged, continued]]);
    expect(handleSnapshot).toHaveBeenCalledExactlyOnceWith(continued);

    await writeFile(ledgerPath, JSON.stringify(pending), 'utf8');
    const ended = await invoke<StudioRoomSnapshot>(resolveDiscussion, { roomId, decision: 'end' });
    expect(ended.activeRound).toMatchObject({ state: 'completed', members: [{ partnerId, state: 'cancelled' }] });
    await expect(invoke(get, roomId)).resolves.toEqual(ended);
    await expect(invoke(resolveDiscussion, { roomId, decision: 'end' })).rejects.toThrow('STUDIO_DISCUSSION_DECISION_NOT_PENDING');
    expect(changes()).toEqual([[roomChanged, continued], [roomChanged, ended]]);
    expect(handleSnapshot.mock.calls).toEqual([[continued], [ended]]);
  } finally {
    handleSnapshot.mockRestore();
  }
});
