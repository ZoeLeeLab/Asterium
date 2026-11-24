// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';
import { SingleChatHistoryStore } from '../../src/main/conversation/SingleChatHistoryStore';
import { ConversationDeletionStore } from '../../src/main/conversation/ConversationDeletionStore';
import { ConversationDeletionService } from '../../src/main/conversation/ConversationDeletionService';
import { WriterLeaseCoordinator } from '../../src/main/runtime/WriterLeaseCoordinator';
import { PartnerDelegation } from '../../src/main/runtime/PartnerDelegation';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { CodexThreadDirectoryPreview } from '../../src/shared/codexThreadImport';
import type { CodexHistorySearchPage } from '../../src/shared/codexHistory';
import { testRm } from '../helpers/autoTest.mjs';

const state = vi.hoisted(() => ({
  profile: '', home: '', cwd: '', file: '', choices: [] as string[],
  read: vi.fn(), locate: vi.fn(), search: vi.fn(), lifecycles: vi.fn(), importedLifecycle: vi.fn(), change: vi.fn(),
}));
const threadId = '00000000-0000-7000-8000-000000000001', partnerId = 'fixture-native-partner', conversationId = 'fixture-native-conversation';
const runtime = () => ({ runtimeId: 'fixture-codex-runtime', executablePath: process.execPath, executableLabel: 'fixture-codex.exe', environment: 'global_cli' as const, environmentLabel: 'Fixture', codexHome: state.home, installed: true, loggedIn: true });
const page = { turns: [{ id: 'fixture-turn', state: 'completed' as const, items: [{ id: 'fixture-text', kind: 'assistant' as const, text: '合成历史' }] }] };
const searchPage: CodexHistorySearchPage = { hits: [{ messageId: 'fixture-hit', turnId: 'fixture-turn' }] };
vi.mock('electron', () => ({
  app: { getPath: (name: string) => name === 'userData' ? state.profile : state.home, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, clipboard: {}, safeStorage: {}, shell: {},
  dialog: { showOpenDialog: vi.fn(async () => { const selected = state.choices.shift(); return { canceled: !selected, filePaths: selected ? [selected] : [] }; }) },
}));
vi.mock('../../src/main/adapters/CodexCliAdapter', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/main/adapters/CodexCliAdapter')>(),
  detectCodexCli: async () => ({ installed: true, loggedIn: true, runtimes: [runtime()] }),
  readCodexThreadsMetadata: async () => [{ threadId, metadata: { file: state.file, cwd: state.cwd, title: '合成线程' } }],
  readCodexThreadMetadata: async () => ({ file: state.file, cwd: state.cwd, title: '合成线程' }),
  readCodexThreadHistory: state.read, locateCodexHistoryTurn: state.locate, searchCodexThreadHistory: state.search,
  getCodexThreadLifecyclesSafely: state.lifecycles, getImportedCodexThreadLifecycle: state.importedLifecycle, changeCodexThreadLifecycle: state.change,
}));
const channels = [DESKTOP_IPC.nativeSyncSingleBindings, DESKTOP_IPC.chooseCodexThreadDirectory, DESKTOP_IPC.confirmCodexThreadImport,
  DESKTOP_IPC.codexImportedWorkspaceStatus, DESKTOP_IPC.chooseCodexImportedDirectory, DESKTOP_IPC.readCodexHistory,
  DESKTOP_IPC.searchCodexHistory, DESKTOP_IPC.getLocalThreadLifecycles, DESKTOP_IPC.changeLocalThreadLifecycle];
type Sender = EventEmitter & { send: ReturnType<typeof vi.fn> };

async function withNative(run: (fixture: {
  root: string; bindings: NativeThreadBindingStore; sender: Sender;
  invoke: <T = unknown>(channel: string, value?: unknown, caller?: object) => Promise<T>;
  switchWindow: (sender: Sender) => void; grant: () => Promise<string>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-native-ipc-'));
  state.profile = path.join(root, 'profile'); state.home = path.join(root, 'codex-home'); state.cwd = path.join(root, 'workspace');
  state.file = path.join(state.home, 'sessions', '2026', '01', '18', 'fixture.jsonl'); state.choices.length = 0;
  for (const spy of [state.read, state.locate, state.search, state.lifecycles, state.importedLifecycle, state.change]) spy.mockReset();
  state.read.mockResolvedValue(page); state.locate.mockResolvedValue(page); state.search.mockResolvedValue(searchPage);
  state.lifecycles.mockResolvedValue([{ threadId, state: 'active' }]); state.importedLifecycle.mockResolvedValue({ threadId, state: 'archived' }); state.change.mockResolvedValue({ threadId, state: 'archived' });
  await Promise.all([state.profile, state.cwd, path.dirname(state.file)].map(directory => mkdir(directory, { recursive: true })));
  await writeFile(state.file, JSON.stringify({ type: 'session_meta', payload: { id: threadId } }) + '\n');
  const sender = Object.assign(new EventEmitter(), { send: vi.fn() });
  const senders = new Set<Sender>([sender]); let current: Sender = sender;
  const handlers = new Map<string, (event: { sender: object }, value: unknown) => unknown>(), removed: string[] = [];
  const ipc = { handle: (channel: string, handler: (event: { sender: object }, value: unknown) => unknown) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); }, removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); } } as unknown as IpcMain;
  const invoke = async <T,>(channel: string, value?: unknown, caller: object = current) => await handlers.get(channel)!({ sender: caller }, value) as T;
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = registerAgentIpc(ipc, () => ({ webContents: current, isDestroyed: () => false }) as unknown as BrowserWindow, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: state.profile, projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false, restoreBackgroundServices: false, mcpPort: 0,
    } });
    await invoke(DESKTOP_IPC.studioMcpStatus);
    await run({ root, sender, invoke, bindings: new NativeThreadBindingStore(path.join(state.profile, 'native-thread-bindings.v1.json')),
      switchWindow: next => { senders.add(next); current = next; },
      grant: async () => { state.choices.push(state.cwd); return (await invoke<{ grantId: string }>(DESKTOP_IPC.selectWorkspace, 'partner_root')).grantId; },
    });
  } finally {
    try { for (const item of senders) item.emit('destroyed'); await dispose?.(); expect(handlers.size).toBe(0); for (const channel of channels) expect(removed.filter(name => name === channel)).toHaveLength(1); for (const item of senders) expect(item.listenerCount('destroyed')).toBe(0); }
    finally { vi.restoreAllMocks(); await testRm(root, { recursive: true, force: true }); }
  }
}

it('preserves caller checks for all nine channels before their existing parameter checks', async () => {
  await withNative(async ({ invoke }) => {
    const failures = ['INVALID_SINGLE_BINDING_SYNC', 'CODEX_RUNTIME_SELECTION_REQUIRED', 'INVALID_CODEX_THREAD_IMPORT',
      'INVALID_CODEX_IMPORTED_WORKSPACE', 'INVALID_CODEX_IMPORTED_WORKSPACE', 'INVALID_CODEX_HISTORY_REQUEST',
      'INVALID_CODEX_HISTORY_SEARCH', 'INVALID_LOCAL_THREAD_LIFECYCLE_REQUEST', 'INVALID_LOCAL_THREAD_LIFECYCLE_CHANGE_REQUEST'];
    for (const [index, channel] of channels.entries()) {
      await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER'); await expect(invoke(channel, null)).rejects.toThrow(failures[index]);
    }
    for (const spy of [state.read, state.locate, state.search, state.lifecycles, state.importedLifecycle, state.change]) expect(spy).not.toHaveBeenCalled();
    await expect(invoke(DESKTOP_IPC.searchCodexHistory, { query: 'fixture', after: { index: 60 } })).rejects.toThrow('INVALID_CODEX_HISTORY_SEARCH');
    await expect(invoke(DESKTOP_IPC.readCodexHistory, { partnerId, conversationId, threadId, cursor: '' })).rejects.toThrow('INVALID_CODEX_HISTORY_REQUEST');
  });
});

it('keeps sequential binding validation, deletion filtering and authoritative imported-history protection', async () => {
  await withNative(async ({ bindings, invoke }) => {
    const request = { partnerId, conversationId, nativeThreadId: threadId, source: 'local_cli' };
    await expect(invoke(DESKTOP_IPC.nativeSyncSingleBindings, [request, { ...request, conversationId: 'invalid-next', source: 'invalid' }])).rejects.toThrow('INVALID_SINGLE_BINDING_SYNC');
    expect(await bindings.getForScope(partnerId, 'single', conversationId)).toMatchObject({ nativeThreadId: threadId, state: 'active' });
    const deletions = new ConversationDeletionStore(path.join(state.profile, 'conversation-deletions.v1.json'));
    await deletions.markDeleted({ conversationId: 'fixture-deleted', partnerId, source: 'local_cli' }); await deletions.markCleaned('fixture-deleted');
    await invoke(DESKTOP_IPC.nativeSyncSingleBindings, [{ ...request, conversationId: 'fixture-deleted' }]); expect(await bindings.getForScope(partnerId, 'single', 'fixture-deleted')).toBeUndefined();
    vi.spyOn(SingleChatHistoryStore.prototype, 'isActive').mockResolvedValue(true);
    const read = vi.spyOn(SingleChatHistoryStore.prototype, 'readMetadata').mockResolvedValue({ id: conversationId, partnerId, title: 'Fixture', updatedAt: '', sessionId: threadId, importedCodexThread: true });
    const register = vi.spyOn(NativeThreadBindingStore.prototype, 'registerSingle');
    await invoke(DESKTOP_IPC.nativeSyncSingleBindings, [request]); expect(register).not.toHaveBeenCalled();
    read.mockResolvedValueOnce({ id: conversationId, partnerId, title: 'Fixture', updatedAt: '', sessionId: 'different-thread' });
    await invoke(DESKTOP_IPC.nativeSyncSingleBindings, [request]); expect(register).not.toHaveBeenCalled();
    read.mockResolvedValueOnce({ id: conversationId, partnerId, title: 'Fixture', updatedAt: '', sessionId: threadId });
    await invoke(DESKTOP_IPC.nativeSyncSingleBindings, [request]); expect(register).toHaveBeenCalledExactlyOnceWith(request);
  });
});

it('uses the bound runtime for history, forwards cursor/turn requests and rechecks the binding after a read', async () => {
  await withNative(async ({ bindings, invoke, grant }) => {
    const partnerRootGrantId = await grant();
    await invoke(DESKTOP_IPC.nativeSyncSingleBindings, [{ partnerId, conversationId, nativeThreadId: threadId, source: 'local_cli' }]);
    const request = { partnerId, conversationId, threadId, partnerRootGrantId, codexRuntimeId: runtime().runtimeId, cursor: 'fixture-cursor' };
    await expect(invoke(DESKTOP_IPC.readCodexHistory, { ...request, codexRuntimeId: undefined })).rejects.toThrow('CODEX_RUNTIME_SELECTION_REQUIRED'); expect(state.read).not.toHaveBeenCalled();
    const hidden = { userMessageIds: new Set(), turnIds: new Set() };
    await expect(invoke(DESKTOP_IPC.readCodexHistory, request)).resolves.toBe(page); expect(state.read).toHaveBeenCalledExactlyOnceWith(process.execPath, state.cwd, threadId, request.cursor, undefined, hidden);
    await expect(invoke(DESKTOP_IPC.readCodexHistory, { ...request, aroundTurnId: 'fixture-turn' })).resolves.toBe(page); expect(state.locate).toHaveBeenCalledExactlyOnceWith(process.execPath, state.cwd, threadId, 'fixture-turn', request.cursor, undefined, hidden);
    const binding = (await bindings.getForScope(partnerId, 'single', conversationId))!;
    state.read.mockImplementationOnce(async () => { await bindings.invalidate(binding.bindingId); return page; });
    await expect(invoke(DESKTOP_IPC.readCodexHistory, request)).rejects.toThrow('CODEX_HISTORY_BINDING_UNAVAILABLE');
  });
});

it('uses Main-owned delegation identities for history and search, ignoring forged renderer visibility fields', async () => {
  await withNative(async ({ invoke, grant }) => {
    const partnerRootGrantId = await grant();
    await invoke(DESKTOP_IPC.nativeSyncSingleBindings, [{ partnerId, conversationId, nativeThreadId: threadId, source: 'local_cli' }]);
    const hidden = { userMessageIds: new Set(['fixture-main-input']), turnIds: new Set(['fixture-main-turn']) };
    const provenance = vi.spyOn(PartnerDelegation.prototype, 'hiddenHistoryInputs').mockResolvedValue(hidden);
    const request = { partnerId, conversationId, threadId, partnerRootGrantId, codexRuntimeId: runtime().runtimeId,
      hiddenInputs: { userMessageIds: ['fixture-forged-user-input'], turnIds: ['fixture-forged-turn'] } };
    await invoke(DESKTOP_IPC.readCodexHistory, request);
    expect(state.read).toHaveBeenLastCalledWith(process.execPath, state.cwd, threadId, undefined, undefined, hidden);
    await invoke(DESKTOP_IPC.searchCodexHistory, { ...request, query: '合成查询' });
    expect(state.search.mock.calls.at(-1)?.[5]).toBe(hidden);
    expect(provenance.mock.calls).toEqual([[conversationId, partnerId, threadId], [conversationId, partnerId, threadId]]);
  });
});

it('cancels only the preceding search in one window and retains the newest controller until completion', async () => {
  await withNative(async ({ sender, invoke, grant }) => {
    const partnerRootGrantId = await grant(); await invoke(DESKTOP_IPC.nativeSyncSingleBindings, [{ partnerId, conversationId, nativeThreadId: threadId, source: 'local_cli' }]);
    const requests: Array<{ signal: AbortSignal; finish: (page: CodexHistorySearchPage) => void }> = [];
    state.search.mockImplementation((_exe, _cwd, _request, signal: AbortSignal) => new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      requests.push({ signal, finish: value => { signal.removeEventListener('abort', abort); resolve(value); } });
    }));
    const request = { partnerId, conversationId, threadId, partnerRootGrantId, codexRuntimeId: runtime().runtimeId, query: 'fixture' };
    const first = invoke(DESKTOP_IPC.searchCodexHistory, request); const failedFirst = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const second = invoke(DESKTOP_IPC.searchCodexHistory, request); const failedSecond = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(requests).toHaveLength(2)); await failedFirst; expect(requests[0].signal.aborted).toBe(true);
    const third = invoke(DESKTOP_IPC.searchCodexHistory, { ...request, query: '' });
    await vi.waitFor(() => expect(requests).toHaveLength(3)); await failedSecond; expect(requests[1].signal.aborted).toBe(true); expect(requests[2].signal.aborted).toBe(false);
    requests[2].finish(searchPage); await expect(third).resolves.toBe(searchPage); expect(sender.listenerCount('destroyed')).toBe(0);
  });
});

it('isolates searches and import selections by window and removes destroyed-window listeners', async () => {
  await withNative(async ({ sender, switchWindow, invoke, grant }) => {
    const partnerRootGrantId = await grant(); await invoke(DESKTOP_IPC.nativeSyncSingleBindings, [{ partnerId, conversationId, nativeThreadId: threadId, source: 'local_cli' }]);
    state.choices.push(path.dirname(state.file));
    const selection = await invoke<CodexThreadDirectoryPreview>(DESKTOP_IPC.chooseCodexThreadDirectory, { runtimeId: runtime().runtimeId }); expect(selection.threads).toHaveLength(1);
    const searches: Array<{ signal: AbortSignal; finish: () => void }> = [];
    state.search.mockImplementation((_exe, _cwd, _request, signal: AbortSignal) => new Promise((resolve, reject) => { const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); searches.push({ signal, finish: () => { signal.removeEventListener('abort', abort); resolve(searchPage); } }); }));
    const request = { partnerId, conversationId, threadId, partnerRootGrantId, codexRuntimeId: runtime().runtimeId, query: 'fixture' };
    const first = invoke(DESKTOP_IPC.searchCodexHistory, request); const failedFirst = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(searches).toHaveLength(1));
    const other = Object.assign(new EventEmitter(), { send: vi.fn() }); switchWindow(other);
    await expect(invoke(DESKTOP_IPC.confirmCodexThreadImport, { partnerId, selectionId: selection.threads[0].selectionId, permissionMode: 'manual' })).rejects.toThrow('请重新选择 Codex 日期文件夹及线程。');
    const second = invoke(DESKTOP_IPC.searchCodexHistory, request); await vi.waitFor(() => expect(searches).toHaveLength(2)); expect(searches[0].signal.aborted).toBe(false);
    sender.emit('destroyed'); await failedFirst; expect(searches[1].signal.aborted).toBe(false); searches[1].finish(); await expect(second).resolves.toBe(searchPage);
    expect(sender.listenerCount('destroyed')).toBe(0); expect(other.listenerCount('destroyed')).toBe(0);
  });
});

it('preserves imported-directory cancellation, protection, busy checks and lease release on failures and success', async () => {
  await withNative(async ({ root, bindings, invoke }) => {
    const binding = await bindings.reserveCodexImport(partnerId, threadId, { originalCwd: state.cwd, directory: state.cwd, canonicalDirectory: state.cwd, runtimeId: runtime().runtimeId, runtimeEnvironment: 'global_cli', codexHome: state.home }); await bindings.activate(binding.bindingId, threadId);
    const request = { partnerId, conversationId: binding.conversationId };
    await expect(invoke(DESKTOP_IPC.codexImportedWorkspaceStatus, request)).resolves.toEqual({ directory: state.cwd, available: true });
    await expect(invoke(DESKTOP_IPC.chooseCodexImportedDirectory, request)).resolves.toBeNull();
    state.choices.push(state.profile); await expect(invoke(DESKTOP_IPC.chooseCodexImportedDirectory, request)).rejects.toThrow('该目录不可访问');
    const target = path.join(root, 'replacement'); await mkdir(target);
    const acquire = vi.spyOn(WriterLeaseCoordinator.prototype, 'tryAcquire').mockReturnValueOnce(undefined);
    state.choices.push(target); await expect(invoke(DESKTOP_IPC.chooseCodexImportedDirectory, request)).rejects.toThrow('CODEX_IMPORTED_CONVERSATION_BUSY'); acquire.mockRestore();
    const releases: Array<ReturnType<typeof vi.fn>> = [], original = WriterLeaseCoordinator.prototype.tryAcquire;
    vi.spyOn(WriterLeaseCoordinator.prototype, 'tryAcquire').mockImplementation(function (this: WriterLeaseCoordinator, ...args) { const lease = original.apply(this, args); if (!lease) return lease; const release = vi.fn(() => lease.release()); releases.push(release); return { ...lease, release }; });
    const error = new Error('SYNTHETIC_DIRECTORY_FAILURE'); const update = vi.spyOn(NativeThreadBindingStore.prototype, 'updateImportedCodexDirectory').mockRejectedValueOnce(error);
    state.choices.push(target); await expect(invoke(DESKTOP_IPC.chooseCodexImportedDirectory, request)).rejects.toBe(error); expect(releases[0]).toHaveBeenCalledTimes(1);
    state.choices.push(target); await expect(invoke(DESKTOP_IPC.chooseCodexImportedDirectory, request)).resolves.toEqual({ directory: target, available: true }); expect(releases[1]).toHaveBeenCalledTimes(1); expect(update).toHaveBeenLastCalledWith(binding.bindingId, state.cwd, target, target);
    const deleted = vi.spyOn(ConversationDeletionService.prototype, 'isDeleted').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    state.choices.push(target); await expect(invoke(DESKTOP_IPC.chooseCodexImportedDirectory, request)).rejects.toThrow('CODEX_IMPORTED_THREAD_MISMATCH'); expect(releases[2]).toHaveBeenCalledTimes(1); expect(deleted).toHaveBeenCalledTimes(2);
  });
});

it('retains Claude unsupported receipts, normal Codex resolution and the imported lifecycle branch', async () => {
  await withNative(async ({ bindings, invoke, grant }) => {
    const claude = { adapterType: 'claude_code', partnerId, threadIds: ['fixture-claude', 'fixture-claude'] };
    await expect(invoke(DESKTOP_IPC.getLocalThreadLifecycles, claude)).resolves.toMatchObject([{ threadId: 'fixture-claude', state: 'unsupported' }, { threadId: 'fixture-claude', state: 'unsupported' }]);
    await expect(invoke(DESKTOP_IPC.changeLocalThreadLifecycle, { ...claude, threadId: 'fixture-claude', action: 'delete' })).resolves.toMatchObject({ threadId: 'fixture-claude', state: 'unsupported' });
    expect(state.change).not.toHaveBeenCalled(); expect(state.lifecycles).not.toHaveBeenCalled();
    const partnerRootGrantId = await grant(), normal = { adapterType: 'codex_cli', partnerId, partnerRootGrantId, codexRuntimeId: runtime().runtimeId, threadIds: [threadId, threadId] };
    const receipt = [{ threadId, state: 'active' }]; state.lifecycles.mockResolvedValueOnce(receipt);
    await expect(invoke(DESKTOP_IPC.getLocalThreadLifecycles, normal)).resolves.toBe(receipt); expect(state.lifecycles).toHaveBeenCalledExactlyOnceWith(process.execPath, state.cwd, normal.threadIds);
    const imported = await bindings.reserveCodexImport(partnerId, threadId, { originalCwd: state.cwd, directory: state.cwd, canonicalDirectory: state.cwd, runtimeId: runtime().runtimeId, runtimeEnvironment: 'global_cli', codexHome: state.home }); await bindings.activate(imported.bindingId, threadId);
    await expect(invoke(DESKTOP_IPC.getLocalThreadLifecycles, { ...normal, partnerRootGrantId: undefined, conversationId: imported.conversationId, threadIds: [threadId] })).resolves.toEqual([{ threadId, state: 'archived' }]);
    expect(state.importedLifecycle).toHaveBeenCalledExactlyOnceWith(process.execPath, os.homedir(), state.home, threadId);
    await expect(invoke(DESKTOP_IPC.changeLocalThreadLifecycle, { adapterType: 'codex_cli', partnerId, threadId, action: 'archive' })).rejects.toThrow('PARTNER_ROOT_GRANT_REQUIRED');
    await expect(invoke(DESKTOP_IPC.changeLocalThreadLifecycle, { adapterType: 'codex_cli', partnerId, partnerRootGrantId, codexRuntimeId: runtime().runtimeId, threadId, action: 'archive' })).resolves.toEqual({ threadId, state: 'archived' }); expect(state.change).toHaveBeenCalledExactlyOnceWith(process.execPath, state.cwd, threadId, 'archive');
  });
});
