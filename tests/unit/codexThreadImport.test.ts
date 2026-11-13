// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { testRm } from '../helpers/autoTest.mjs';
import { DESKTOP_IPC as AGENT_IPC } from '../../src/shared/desktopIpc';
import { AGENT_PROTOCOL_VERSION } from '../../src/shared/agentProtocol';
import type { CodexAppServerTransport, CodexRpcMessage } from '../../src/main/adapters/codexAppServerProtocol';
import { createInitialState } from '../../src/renderer/data/initialState';

const state = vi.hoisted(() => ({
  root: '',
  home: '',
  cwd: '',
  file: '',
  threadId: '00000001-0000-4000-8000-000000000001',
  selections: [] as string[],
  requests: [] as Array<{ cwd: string; method: string; params?: Record<string, unknown> }>,
  runtimeId: 'test-codex-runtime',
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => name === 'userData' ? state.root : state.home,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    whenReady: async () => undefined,
  },
  BrowserWindow: class {},
  clipboard: {},
  shell: {},
  safeStorage: {},
  dialog: { showOpenDialog: vi.fn(async () => {
    const selected = state.selections.shift();
    return { canceled: !selected, filePaths: selected ? [selected] : [] };
  }) },
}));

vi.mock('../../src/main/adapters/CodexCliAdapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/adapters/CodexCliAdapter')>();
  return {
    ...actual,
    detectCodexCli: async () => ({
      installed: true, loggedIn: true, runtimes: [{
        runtimeId: state.runtimeId, executablePath: 'fixture-codex.exe', executableLabel: 'fixture-codex.exe',
        environment: 'global_cli', environmentLabel: 'Fixture Codex', codexHome: state.home, installed: true, loggedIn: true,
      }],
    }),
    readCodexThreadMetadata: (...args: Parameters<typeof actual.readCodexThreadMetadata>) =>
      actual.readCodexThreadMetadata(args[0], args[1], args[2], (_executable, cwd) => transport(cwd)),
    readCodexThreadHistory: (...args: Parameters<typeof actual.readCodexThreadHistory>) =>
      actual.readCodexThreadHistory(args[0], args[1], args[2], args[3], (_executable, cwd) => transport(cwd)),
    CodexCliAdapter: class extends actual.CodexCliAdapter {
      constructor(...args: ConstructorParameters<typeof actual.CodexCliAdapter>) {
        args[2] = (_executable, cwd) => transport(cwd);
        super(...args);
      }
    },
  };
});

function transport(cwd: string): CodexAppServerTransport {
  const events = new EventEmitter();
  return {
    connected: true,
    start: async () => {},
    close: async () => {},
    respond: () => {},
    onClose: () => () => {},
    onMessage: (handler) => {
      events.on('message', handler);
      return () => { events.off('message', handler); };
    },
    async request<T>(method: string, params?: Record<string, unknown>) {
      state.requests.push({ cwd, method, params });
      if (method === 'thread/read') return { thread: { id: state.threadId, cwd: state.cwd, path: state.file, name: '合成历史', updatedAt: 1_800_000_000 } } as T;
      if (method === 'thread/turns/list') {
        return { data: [{ id: 'history-turn', items: [{ type: 'userMessage', id: 'history-message', content: [{ type: 'text', text: '测试历史' }] }] }] } as T;
      }
      if (method === 'thread/resume') return { thread: { id: params?.threadId }, model: 'gpt-test' } as T;
      if (method === 'turn/start') {
        const threadId = params?.threadId;
        const turnId = 'new-turn-' + state.requests.length;
        queueMicrotask(() => {
          const event: CodexRpcMessage = { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } };
          events.emit('message', event);
        });
        return { turn: { id: turnId } } as T;
      }
      return {} as T;
    },
  };
}

it('imports a different working directory, recovers it after a rename, and keeps the partner source and thread IDs separate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-codex-import-'));
  const partnerCwd = path.join(root, 'partner-default');
  const moved = path.join(root, 'renamed-project');
  state.root = path.join(root, 'app-data');
  state.cwd = path.join(root, 'codex-project');
  state.home = path.join(root, 'codex-home');
  state.file = path.join(state.home, 'sessions', '2026', `rollout-${state.threadId}.jsonl`);
  await Promise.all([state.root, partnerCwd, state.cwd, path.dirname(state.file)].map(directory => mkdir(directory, { recursive: true })));
  await writeFile(state.file, JSON.stringify({ type: 'session_meta', payload: { id: state.threadId } }) + '\ninvalid body is not parsed\n');

  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const { dialog } = await import('electron');
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sendEvent = vi.fn();
  const sender = Object.assign(new EventEmitter(), { send: sendEvent });
  const main = {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  const invoke = <T = unknown>(channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender }, ...args) as Promise<T>;
  const create = () => registerAgentIpc(main, () => window, { environment: {
    profile: 'autotest', label: 'Fixture', userDataDirectory: state.root, projectsDirectory: root,
    temporaryDirectory: root, appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
    restoreBackgroundServices: false, mcpPort: 0,
  } });
  let dispose = create();
  try {
    const { conversations: _conversations, ...profile } = createInitialState();
    await invoke(AGENT_IPC.conversationMigrateHistory, { profile, conversations: [] });
    const partnerId = 'partner-codex-fixture';
    const savePartner = () => invoke(AGENT_IPC.savePartnerProfile, {
      partnerId, publicIdentity: { displayName: '测试 Codex', mentionName: '测试', introduction: '', expertise: '' },
      connectionSettings: {
        adapterType: 'codex_cli', location: 'local', sessionMode: 'new',
        __studioRuntime: { persist: true, available: true, runtime: { kind: 'local', adapterType: 'codex_cli', workspaceGrantIds: [] } },
      },
      sourceMode: 'local_cli', management: { memoryMode: 'self_managed', personality: false, userProfile: false },
    });
    await savePartner();
    state.selections.push(partnerCwd);
    const grant = await invoke<{ grantId: string }>(AGENT_IPC.selectWorkspace, 'partner_root');
    await invoke(AGENT_IPC.syncPartnerWorkspace, { partnerId, cwdGrantId: grant.grantId, workspaceGrantIds: [] });

    const choose = () => invoke<import('../../src/shared/codexThreadImport').CodexThreadImportPreview | null>(AGENT_IPC.chooseCodexThread, { runtimeId: state.runtimeId });
    expect(await choose()).toBeNull();
    const outside = path.join(root, 'other.jsonl');
    await writeFile(outside, '{}');
    state.selections.push(outside);
    await expect(choose()).rejects.toThrow('sessions');
    state.selections.push(state.file);
    const preview = await choose();
    expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(window, expect.objectContaining({
      defaultPath: path.join(state.home, 'sessions'), properties: ['openFile', 'showHiddenFiles'],
    }));
    expect(preview).toMatchObject({ threadId: state.threadId, cwd: state.cwd, directoryAvailable: true });
    const confirm = () => invoke<import('../../src/shared/codexThreadImport').CodexThreadImportResult>(AGENT_IPC.confirmCodexThreadImport, { partnerId, permissionMode: 'manual', selectionId: preview?.selectionId });
    const [first, repeated] = await Promise.all([confirm(), confirm()]);
    expect(first).toEqual(repeated);
    if (first.kind !== 'conversation') throw new Error('Expected an imported conversation');
    const conversationId = first.conversation.id;

    const send = (id: string, threadId: string, clientId: string) => invoke(AGENT_IPC.sendMessage, {
      adapterType: 'codex_cli', partnerId, partnerRootGrantId: grant.grantId, workspaceGrantIds: [], codexRuntimeId: state.runtimeId,
      command: { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: clientId, clientMessageId: clientId,
        partnerId, conversationId: id, sessionId: threadId, connectionSource: 'local_cli', content: { type: 'text', text: '续接测试' } },
    });
    const waitForRun = async (count: number) => vi.waitFor(() => expect(sendEvent.mock.calls.filter(call => call[1]?.type === 'run.completed')).toHaveLength(count));

    await send('ordinary-chat', 'ordinary-thread', 'ordinary-message');
    await waitForRun(1);
    await send(conversationId, state.threadId, 'before-rename');
    await waitForRun(2);
    expect(state.requests.filter(request => request.method === 'thread/resume')).toMatchObject([
      { cwd: partnerCwd, params: { threadId: 'ordinary-thread', cwd: partnerCwd } },
      { cwd: state.cwd, params: { threadId: state.threadId, cwd: state.cwd, excludeTurns: true } },
    ]);

    await rename(state.cwd, moved);
    const status = { partnerId, conversationId };
    await expect(invoke(AGENT_IPC.codexImportedWorkspaceStatus, status)).resolves.toEqual({ directory: state.cwd, available: false });
    await expect(send(conversationId, state.threadId, 'blocked')).rejects.toThrow('CODEX_IMPORTED_DIRECTORY_UNAVAILABLE');
    const history = await invoke(AGENT_IPC.readCodexHistory, { ...status, threadId: state.threadId });
    expect(history).toMatchObject({ turns: [{ id: 'history-turn' }] });
    state.selections.push(moved);
    await expect(invoke(AGENT_IPC.chooseCodexImportedDirectory, status)).resolves.toEqual({ directory: moved, available: true });

    await dispose();
    dispose = create();
    await expect(invoke(AGENT_IPC.codexImportedWorkspaceStatus, status)).resolves.toEqual({ directory: moved, available: true });
    await send(conversationId, state.threadId, 'after-restart');
    await waitForRun(3);
    expect(state.requests.filter(request => request.method === 'thread/resume').at(-1)).toMatchObject({
      cwd: moved, params: { threadId: state.threadId, cwd: moved, excludeTurns: true },
    });
  } finally {
    await dispose();
    await testRm(root, { recursive: true, force: true });
  }
});
