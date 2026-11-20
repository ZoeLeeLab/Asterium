// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { ApiAgentSessionStore, type ApiAgentSession } from '../../src/main/api/ApiAgentSessionStore';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.root, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, clipboard: {}, safeStorage: {}, shell: {}, dialog: {},
}));
const channel = DESKTOP_IPC.deleteApiSession;
function session(partnerId: string, conversationId: string): ApiAgentSession {
  return { version: 1, partnerId, conversationId, provider: 'openai', bootstrapSystemPrompt: '合成启动资料', turns: [{
    clientMessageId: 'fixture-message', userContent: '合成问题', messages: [{ role: 'assistant', content: '合成回答', reasoningContent: '' }], completedAt: '2026-01-18T00:00:00.000Z',
  }], updatedAt: '2026-01-18T00:00:00.000Z' };
}

async function withSession(run: (fixture: { store: ApiAgentSessionStore; invoke: (value: unknown, caller?: object) => Promise<unknown> }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-session-delete-ipc-')); electron.root = root;
  const sender = { send: vi.fn() }, handlers = new Map<string, (event: { sender: object }, value: unknown) => unknown>(), removed: string[] = [];
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  const ipc = { handle: (name: string, handler: (event: { sender: object }, value: unknown) => unknown) => { expect(handlers.has(name)).toBe(false); handlers.set(name, handler); }, removeHandler: (name: string) => { removed.push(name); handlers.delete(name); } } as unknown as IpcMain;
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = registerAgentIpc(ipc, () => window, { environment: { profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root, appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false, restoreBackgroundServices: false, mcpPort: 0 } });
    await run({ store: new ApiAgentSessionStore(path.join(root, 'api-agent-sessions', 'v1')), invoke: async (value, caller = sender) => await handlers.get(channel)!({ sender: caller }, value) });
  } finally {
    try { await dispose?.(); expect(handlers.size).toBe(0); expect(removed.filter(name => name === channel)).toHaveLength(1); }
    finally { vi.restoreAllMocks(); await testRm(root, { recursive: true, force: true }); }
  }
}

it('rejects foreign senders before validation and preserves the existing optional conversation field check', async () => {
  await withSession(async ({ invoke }) => {
    const one = vi.spyOn(ApiAgentSessionStore.prototype, 'delete'), all = vi.spyOn(ApiAgentSessionStore.prototype, 'deletePartner');
    await expect(invoke(null, {})).rejects.toThrow('INVALID_IPC_SENDER');
    for (const value of [null, [], {}, { partnerId: '' }, { partnerId: 1 }, { partnerId: 'fixture', conversationId: null }, { partnerId: 'fixture', conversationId: 4 }]) await expect(invoke(value)).rejects.toThrow('INVALID_API_SESSION_DELETE');
    expect(one).not.toHaveBeenCalled(); expect(all).not.toHaveBeenCalled();
  });
});

it('deletes one cache or all caches for just one partner, retaining the empty-string whole-partner branch', async () => {
  await withSession(async ({ store, invoke }) => {
    const a1 = session('fixture-a', 'fixture-one'), a2 = session('fixture-a', 'fixture-two'), b1 = session('fixture-b', 'fixture-one');
    await store.remember(a1); await store.remember(a2); await store.remember(b1);
    const beforeA2 = await store.load(a2.partnerId, a2.conversationId), beforeB1 = await store.load(b1.partnerId, b1.conversationId);
    const one = vi.spyOn(ApiAgentSessionStore.prototype, 'delete'), all = vi.spyOn(ApiAgentSessionStore.prototype, 'deletePartner');
    await expect(invoke({ partnerId: a1.partnerId, conversationId: a1.conversationId })).resolves.toBeUndefined();
    expect(one).toHaveBeenCalledExactlyOnceWith(a1.partnerId, a1.conversationId); expect(all).not.toHaveBeenCalled();
    await expect(store.load(a1.partnerId, a1.conversationId)).resolves.toBeUndefined();
    await expect(store.load(a2.partnerId, a2.conversationId)).resolves.toEqual(beforeA2); await expect(store.load(b1.partnerId, b1.conversationId)).resolves.toEqual(beforeB1);
    await expect(invoke({ partnerId: a1.partnerId })).resolves.toBeUndefined(); expect(all).toHaveBeenCalledExactlyOnceWith(a1.partnerId);
    await expect(store.load(a2.partnerId, a2.conversationId)).resolves.toBeUndefined(); await expect(store.load(b1.partnerId, b1.conversationId)).resolves.toEqual(beforeB1);
    await store.remember(a1); await store.remember(a2);
    await expect(invoke({ partnerId: a1.partnerId, conversationId: '' })).resolves.toBeUndefined(); expect(all).toHaveBeenCalledTimes(2);
    await expect(store.load(a1.partnerId, a1.conversationId)).resolves.toBeUndefined(); await expect(store.load(a2.partnerId, a2.conversationId)).resolves.toBeUndefined(); await expect(store.load(b1.partnerId, b1.conversationId)).resolves.toEqual(beforeB1);
  });
});

it('forwards strings without trimming, propagates either store error and permits a later fresh request', async () => {
  await withSession(async ({ invoke }) => {
    const error = new Error('SYNTHETIC_SESSION_DELETE_FAILURE');
    const one = vi.spyOn(ApiAgentSessionStore.prototype, 'delete').mockRejectedValueOnce(error);
    await expect(invoke({ partnerId: ' fixture ', conversationId: ' ' })).rejects.toBe(error); expect(one).toHaveBeenCalledExactlyOnceWith(' fixture ', ' ');
    await expect(invoke({ partnerId: 'fixture', conversationId: 'missing' })).resolves.toBeUndefined();
    const all = vi.spyOn(ApiAgentSessionStore.prototype, 'deletePartner').mockRejectedValueOnce(error);
    await expect(invoke({ partnerId: 'fixture', conversationId: '' })).rejects.toBe(error); expect(all).toHaveBeenCalledExactlyOnceWith('fixture');
    await expect(invoke({ partnerId: 'fixture' })).resolves.toBeUndefined();
  });
});
