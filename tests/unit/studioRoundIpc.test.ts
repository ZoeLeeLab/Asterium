// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi, type MockInstance } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { StudioOrchestrator } from '../../src/main/studio/StudioOrchestrator';
import { StudioRoomStore } from '../../src/main/studio/StudioRoomStore';
import { StudioAttachments } from '../../src/main/studio/StudioAttachments';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';
import { ContextHandoffService } from '../../src/main/runtime/ContextHandoffService';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.root, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, safeStorage: {}, shell: {},
}));
const room = { roomId: 'fixture-room', projectId: 'fixture-project', name: '合成房间', memberIds: ['fixture-partner'] };
const round = { room, messageId: 'fixture-message', content: '合成讨论', authorId: 'fixture-user', speakerQueue: ['fixture-partner'] };
const turn = { roomId: room.roomId, roundId: 'fixture-round', partnerId: 'fixture-partner', source: 'api_partner' };
const channels = [DESKTOP_IPC.studioCancelRound, DESKTOP_IPC.studioStartRound, DESKTOP_IPC.studioPrepareTurn, DESKTOP_IPC.studioFailTurn];

async function withRound(run: (fixture: {
  invoke: <T = unknown>(channel: string, value: unknown, caller?: object) => Promise<T>;
  earlyStart: Promise<unknown>; earlyCancel: Promise<unknown>; fallback: MockInstance<StudioRoomStore['cancelRound']>; fallbackReceipt: unknown;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-round-ipc-')); electron.root = root;
  const sender = { send: vi.fn() }, window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  const handlers = new Map<string, (event: { sender: object }, value: unknown) => unknown>(), removed: string[] = [];
  const fallbackReceipt = { fixture: 'fallback' };
  const fallback = vi.spyOn(StudioRoomStore.prototype, 'cancelRound').mockResolvedValueOnce(fallbackReceipt as never);
  let earlyStart!: Promise<unknown>, earlyCancel!: Promise<unknown>;
  const ipc = { handle: (channel: string, handler: (event: { sender: object }, value: unknown) => unknown) => {
    expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler);
    if (channel === DESKTOP_IPC.studioStartRound) earlyStart = Promise.resolve(handler({ sender }, round)).catch(error => error);
    if (channel === DESKTOP_IPC.studioCancelRound) earlyCancel = Promise.resolve(handler({ sender }, { roomId: room.roomId }));
  }, removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); } } as unknown as IpcMain;
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = registerAgentIpc(ipc, () => window, { environment: { profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root, appUserModelId: 'Asterium.Test',
      allowStartup: false, allowUpdates: false, restoreBackgroundServices: false, mcpPort: 0 } });
    const invoke = async <T,>(channel: string, value: unknown, caller: object = sender) => await handlers.get(channel)!({ sender: caller }, value) as T;
    await run({ invoke, earlyStart, earlyCancel, fallback, fallbackReceipt });
  } finally {
    try { if (dispose) { await dispose(); expect(handlers.size).toBe(0); for (const channel of channels) expect(removed.filter(name => name === channel)).toHaveLength(1); } }
    finally { vi.restoreAllMocks(); await testRm(root, { recursive: true, force: true }); }
  }
}

it('checks all four callers and preserves start, turn, cancellation and failure parameter validation', async () => {
  await withRound(async ({ invoke }) => {
    for (const channel of channels) await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(channels[0], { roomId: '' })).rejects.toThrow('INVALID_STUDIO_CANCEL_REQUEST');
    for (const value of [null, { ...round, room: { ...room, name: ' ' } }, { ...round, content: ' ' }, { ...round, attachments: [] }, { ...round, speakerQueue: [] },
      { ...round, attachmentSelectionIds: ['pending-attachment-fixture', 'pending-attachment-fixture'] }, { ...round, attachmentSelectionIds: ['bad'] },
      { ...round, mentions: [{ partnerId: 'fixture', label: ' ', source: 'user' }] }]) await expect(invoke(channels[1], value)).rejects.toThrow('INVALID_STUDIO_ROUND_REQUEST');
    for (const value of [null, { ...turn, source: 'bad' }, { ...turn, adapterType: 'bad' }, { ...turn, partnerRootGrantId: 1 }, { ...turn, codexRuntimeEnvironment: 'bad' }]) await expect(invoke(channels[2], value)).rejects.toThrow('INVALID_STUDIO_TURN_REQUEST');
    for (const value of [null, {}, { ...turn, roundId: 1 }]) await expect(invoke(channels[3], value)).rejects.toThrow('INVALID_STUDIO_FAIL_REQUEST');
  });
});

it('retains the early unavailable start and store cancellation fallback, then reads the ready orchestrator live', async () => {
  await withRound(async ({ invoke, earlyStart, earlyCancel, fallback, fallbackReceipt }) => {
    expect(await earlyStart).toMatchObject({ message: 'STUDIO_ORCHESTRATOR_NOT_READY' }); expect(await earlyCancel).toBe(fallbackReceipt);
    expect(fallback).toHaveBeenCalledExactlyOnceWith(room.roomId);
    const receipt = { fixture: 'ready' } as never;
    const start = vi.spyOn(StudioOrchestrator.prototype, 'startRound').mockResolvedValue(receipt);
    const cancel = vi.spyOn(StudioOrchestrator.prototype, 'cancelRound').mockResolvedValue(receipt);
    await expect(invoke(channels[1], round)).resolves.toBe(receipt); expect(start).toHaveBeenCalledExactlyOnceWith(round, undefined);
    await expect(invoke(channels[0], { roomId: ' fixture-room ', ignored: true })).resolves.toBe(receipt);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(' fixture-room '); expect(fallback).toHaveBeenCalledTimes(1);
    const error = new Error('SYNTHETIC_ROUND_CANCEL_FAILURE'); cancel.mockRejectedValueOnce(error); await expect(invoke(channels[0], { roomId: room.roomId })).rejects.toBe(error);
  });
});

it('validates a group handoff before start, forwards the same draft and request, and keeps attachment-only start acceptance', async () => {
  await withRound(async ({ invoke }) => {
    const trace: string[] = [], draft = { fixture: 'resolved-handoff' }, receipt = { fixture: 'started' } as never;
    const validate = vi.spyOn(ContextHandoffService.prototype, 'validate').mockImplementation(async () => { trace.push('validate'); return draft as never; });
    const start = vi.spyOn(StudioOrchestrator.prototype, 'startRound').mockImplementation(async () => { trace.push('start'); return receipt; });
    const request = { ...round, contextHandoff: { fixture: 'source' } };
    await expect(invoke(channels[1], request)).resolves.toBe(receipt); expect(trace).toEqual(['validate', 'start']);
    expect(validate).toHaveBeenCalledExactlyOnceWith(request.contextHandoff, { kind: 'group', id: room.roomId });
    expect(start.mock.calls[0][0]).toBe(request); expect(start.mock.calls[0][1]).toBe(draft);
    const error = new Error('SYNTHETIC_HANDOFF_FAILURE'); validate.mockRejectedValueOnce(error);
    await expect(invoke(channels[1], request)).rejects.toBe(error); expect(start).toHaveBeenCalledTimes(1);
    const attachmentOnly = { ...round, content: '', attachmentSelectionIds: ['pending-attachment-fixture'] };
    await expect(invoke(channels[1], attachmentOnly)).resolves.toBe(receipt); expect(start).toHaveBeenLastCalledWith(attachmentOnly, undefined);
  });
});

it('keeps preparation in the shared runtime helper with identical binding, store and attachment call order', async () => {
  await withRound(async ({ invoke }) => {
    await expect(invoke(channels[2], { ...turn, source: 'existing_thread' })).rejects.toThrow('STUDIO_EXISTING_THREAD_NOT_SUPPORTED');
    const trace: string[] = [], conversationId = `group:v3:${room.roomId}:${turn.partnerId}`;
    const prepared = { fixture: 'prepared' }, result = { fixture: 'with-attachments' };
    const reserve = vi.spyOn(NativeThreadBindingStore.prototype, 'reserve').mockImplementation(async () => { trace.push('binding'); return { generation: 7, conversationId, state: 'reserved' } as never; });
    const prepare = vi.spyOn(StudioRoomStore.prototype, 'prepareTurn').mockImplementation(async () => { trace.push('prepare'); return prepared as never; });
    vi.spyOn(StudioRoomStore.prototype, 'getRoom').mockImplementation(async () => { trace.push('snapshot'); return { messages: [] } as never; });
    const attachments = vi.spyOn(StudioAttachments.prototype, 'prepareTurn').mockImplementation(() => { trace.push('attachments'); return result as never; });
    await expect(invoke(channels[2], turn)).resolves.toBe(result); expect(trace).toEqual(['binding', 'prepare', 'snapshot', 'attachments']);
    expect(reserve).toHaveBeenCalledExactlyOnceWith({ partnerId: turn.partnerId, source: turn.source, scope: 'group', conversationId, generationScopedConversation: true, roomId: room.roomId });
    expect(prepare).toHaveBeenCalledExactlyOnceWith(room.roomId, turn.roundId, turn.partnerId, 7, conversationId, undefined, undefined);
    expect(attachments).toHaveBeenCalledExactlyOnceWith(prepared, []);
    const error = new Error('SYNTHETIC_PREPARE_FAILURE'); prepare.mockRejectedValueOnce(error);
    await expect(invoke(channels[2], turn)).rejects.toBe(error); expect(attachments).toHaveBeenCalledTimes(1);
  });
});

it('preserves the three-string failure guard including empty strings and forwards store results and errors', async () => {
  await withRound(async ({ invoke }) => {
    const receipt = { fixture: 'failed' } as never;
    const fail = vi.spyOn(StudioRoomStore.prototype, 'failPreparedTurn').mockResolvedValue(receipt);
    await expect(invoke(channels[3], { roomId: '', roundId: '', partnerId: '' })).resolves.toBe(receipt);
    expect(fail).toHaveBeenCalledExactlyOnceWith('', '', '');
    const error = new Error('SYNTHETIC_FAIL_TURN_FAILURE'); fail.mockRejectedValueOnce(error);
    await expect(invoke(channels[3], turn)).rejects.toBe(error); await expect(invoke(channels[3], turn)).resolves.toBe(receipt);
  });
});
