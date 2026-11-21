import { act, render, waitFor } from '@testing-library/react';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { PartnerRuntimeFactory } from '../../src/main/runtime/PartnerRuntimeFactory';
import { CredentialStore } from '../../src/main/security/CredentialStore';
import { PartnerMemoryService } from '../../src/main/memory/PartnerMemoryService';
import { MemoryImportService } from '../../src/main/memory/MemoryImportService';
import { SingleChatHistoryStore } from '../../src/main/conversation/SingleChatHistoryStore';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import { AGENT_PROTOCOL_VERSION, type MessageAttachment, type NativeThreadLifecycleResult, type RendererAgentEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';
import type { ApiProviderAdapter } from '../../src/main/api/ApiProviderAdapter';
import { PrototypeProvider, usePrototype } from '../../src/renderer/app/PrototypeProvider';
import { prepareSingleChatProfile } from '../../src/renderer/app/persistence';
import { mergePage, mergeNativeCodexMessages } from '../../src/renderer/app/nativeCodexHistory';
import type { CodexHistoryTurn } from '../../src/shared/codexHistory';
import type { LocalCliPartner } from '../../src/renderer/types/domain';
import { createTestState } from '../fixtures/applicationState';
import { MockAdapter } from '../helpers/MockAdapter';
import { testRm } from '../helpers/autoTest.mjs';

const native = vi.hoisted(() => ({ profile: '', workspace: '', home: '', checkedAt: '2026-11-21T00:02:00.000Z', eventAt: '2026-11-21T00:00:10.000Z',
  state: 'active' as 'active' | 'archived' | 'deleted', pause: undefined as Promise<void> | undefined, awaiting: false }));
vi.mock('electron', () => ({
  app: { getPath: () => native.profile, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, clipboard: {}, safeStorage: {}, shell: {},
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [native.workspace] }) },
}));
vi.mock('../../src/main/adapters/CodexCliAdapter', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/main/adapters/CodexCliAdapter')>(),
  detectCodexCli: async () => ({ installed: true, loggedIn: true, runtimes: [{ runtimeId: 'fixture-combination-runtime', executablePath: process.execPath,
    executableLabel: 'fixture-codex', environment: 'path', environmentLabel: 'Fixture', codexHome: native.home, installed: true, loggedIn: true }] }),
  getCodexThreadLifecyclesSafely: async (_exe: string, _cwd: string, ids: string[]) => {
    const { checkedAt, state, pause } = native; native.pause = undefined;
    if (pause) { native.awaiting = true; await pause; native.awaiting = false; }
    return ids.map(threadId => ({ threadId, state, checkedAt }));
  },
}));

async function withMain(run: (fixture: {
  invoke: <T = unknown>(channel: string, ...values: unknown[]) => Promise<T>;
  poll: NonNullable<typeof window.asteriumAgents>['getLocalThreadLifecycles'];
  checkFinished: () => Promise<NativeThreadLifecycleResult[]>;
  write: ReturnType<typeof vi.fn<NonNullable<NonNullable<typeof window.asteriumConversations>['writeHistory']>>>;
  send: ReturnType<typeof vi.fn<NonNullable<NonNullable<typeof window.asteriumAgents>['sendLocalCliMessage']>>>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-phase6-combination-'));
  native.profile = path.join(root, 'profile'); native.workspace = path.join(root, 'workspace'); native.home = path.join(root, 'codex-home');
  native.checkedAt = '2026-11-21T00:02:00.000Z'; native.eventAt = '2026-11-21T00:00:10.000Z'; native.state = 'active'; native.awaiting = false; native.pause = undefined;
  await Promise.all([native.profile, native.workspace, native.home].map(directory => mkdir(directory)));
  const listeners = new Set<(event: RendererAgentEvent) => void>();
  const sender = { send: (channel: string, event: RendererAgentEvent) => { if (channel === DESKTOP_IPC.event) for (const listener of listeners) listener(event); } };
  const handlers = new Map<string, (...args: unknown[]) => unknown>(), removed: string[] = [];
  const ipc = { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); } } as unknown as IpcMain;
  const windowFixture = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  const invoke = async <T,>(channel: string, ...values: unknown[]) => await handlers.get(channel)!({ sender }, ...values) as T;
  const adapter = new MockAdapter();
  const originalSend = adapter.sendMessage.bind(adapter);
  vi.spyOn(adapter, 'sendMessage').mockImplementation(command => {
    const stream = originalSend(command), occurredAt = native.eventAt;
    return { async *[Symbol.asyncIterator]() { for await (const event of stream) yield { ...event, occurredAt }; } };
  });
  vi.spyOn(PartnerRuntimeFactory.prototype, 'getLocal').mockReturnValue(adapter as never);
  vi.spyOn(PartnerRuntimeFactory.prototype, 'createApi').mockReturnValue(adapter as never);
  vi.spyOn(CredentialStore.prototype, 'get').mockResolvedValue('fixture-combination-secret');
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = registerAgentIpc(ipc, () => windowFixture, { environment: { profile: 'autotest', label: 'Fixture', userDataDirectory: native.profile,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root, appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0 } });
    await invoke(DESKTOP_IPC.studioMcpStatus);
    const write = vi.fn<NonNullable<NonNullable<typeof window.asteriumConversations>['writeHistory']>>(input => invoke(DESKTOP_IPC.conversationWriteHistory, input));
    window.asteriumConversations = {
      delete: request => invoke(DESKTOP_IPC.conversationDelete, request), listDeleted: () => invoke(DESKTOP_IPC.conversationListDeleted),
      openHistory: recent => invoke(DESKTOP_IPC.conversationOpenHistory, recent), migrateHistory: (input, recent) => invoke(DESKTOP_IPC.conversationMigrateHistory, input, recent),
      writeHistory: write, readHistoryPage: request => invoke(DESKTOP_IPC.conversationReadHistoryPage, request),
    };
    let checked: Promise<NativeThreadLifecycleResult[]> = Promise.resolve([]);
    const poll = vi.fn<NonNullable<NonNullable<typeof window.asteriumAgents>['getLocalThreadLifecycles']>>(request => {
      checked = invoke(DESKTOP_IPC.getLocalThreadLifecycles, request); return checked;
    });
    const send = vi.fn<NonNullable<NonNullable<typeof window.asteriumAgents>['sendLocalCliMessage']>>((adapterType, partnerId, partnerRootGrantId, workspaceGrantIds, command, codexRuntimeId, codexRuntimeEnvironment) =>
      invoke(DESKTOP_IPC.sendMessage, { adapterType, partnerId, partnerRootGrantId, workspaceGrantIds, command, codexRuntimeId, codexRuntimeEnvironment }));
    window.asteriumAgents = { detectClaude: vi.fn(), selectWorkspace: purpose => invoke(DESKTOP_IPC.selectWorkspace, purpose), sendClaudeMessage: vi.fn(),
      sendLocalCliMessage: send, getLocalThreadLifecycles: poll, cancelRun: command => invoke(DESKTOP_IPC.cancelRun, command),
      resumeSession: command => invoke(DESKTOP_IPC.resumeSession, command), onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    await run({ invoke, poll, checkFinished: () => checked, write, send });
  } finally {
    window.asteriumAgents = undefined; window.asteriumConversations = undefined;
    try { await dispose?.(); expect(handlers.size).toBe(0); expect(removed).toHaveLength(230); }
    finally { vi.restoreAllMocks(); await testRm(root, { recursive: true, force: true }); }
  }
}

it('persists real phase-6 local sends, keeps 100 unchanged focus checks write-free, and preserves IDs through resume and native-page refresh', async () => {
  await withMain(async ({ invoke, poll, checkFinished, write, send }) => {
    const grant = await invoke<{ grantId: string }>(DESKTOP_IPC.selectWorkspace, 'partner_root');
    const state = createTestState(), template = state.partners[0] as LocalCliPartner;
    const partner: LocalCliPartner = { ...template, isPrototype: false, connectionKind: 'local_codex', location: 'local', sessionMode: 'resume',
      partnerRootGrantId: grant.grantId, workspaceGrantIds: [], codexRuntimeId: 'fixture-combination-runtime',
      codexRuntime: { environment: 'path', environmentLabel: 'Fixture', executableLabel: 'fixture-codex', codexHome: native.home, loggedIn: true } };
    state.partners = [partner]; state.projects = []; state.groupChats = [];
    const id = 'fixture-combination-chat'; state.conversations = [{ id, partnerId: partner.id, title: '合成组合单聊', updatedAt: '', messages: [] }];
    state.activePartnerId = partner.id; state.activeConversationId = id;
    await invoke(DESKTOP_IPC.savePartnerProfile, { partnerId: partner.id, sourceMode: 'local_cli', publicIdentity: partner.publicIdentity,
      management: partner.profileManagement, connectionSettings: { adapterType: 'codex_cli' } });
    await invoke(DESKTOP_IPC.conversationMigrateHistory, { profile: prepareSingleChatProfile(state), conversations: state.conversations });
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZsAAAAASUVORK5CYII=', 'base64'));
    const pending = await invoke<{ selectionId: string }>(DESKTOP_IPC.attachmentStageClipboardImage, png);
    const attachments = await invoke<MessageAttachment[]>(DESKTOP_IPC.attachmentCommit, { conversationId: id, selectionIds: [pending.selectionId], messageId: 'fixture-original-prompt' });
    let context!: ReturnType<typeof usePrototype>;
    function Probe() { context = usePrototype(); return <output>{context.state.conversations.find(item => item.id === id)?.messages.map(item => item.content).join('|')}</output>; }
    const view = render(<MemoryRouter><PrototypeProvider><Probe /></PrototypeProvider></MemoryRouter>);
    try {
      await waitFor(() => expect(context.state.activeConversationId).toBe(id));
      await waitFor(() => expect(context.chatHistoryLoading).toBe(false));
      await act(async () => { expect(await context.sendChatMessage(id, '合成组合问题', attachments, 'fixture-original-prompt')).toBe(true); });
      await waitFor(() => expect(context.state.conversations[0].messages.at(-1)?.runState).toBe('completed'));
      await waitFor(() => expect(write.mock.calls.some(([input]) => input.changes.some(change => change.upsert.some(message => message.runState === 'completed')))).toBe(true));
      expect(send).toHaveBeenCalledTimes(1);
      const conversation = context.state.conversations[0], ids = conversation.messages.map(message => message.id);
      await act(async () => { await checkFinished(); });
      write.mockClear(); const diskWrites = vi.spyOn(SingleChatHistoryStore.prototype, 'write');
      const priorChecks = vi.mocked(poll!).mock.calls.length;
      const clock = vi.spyOn(Date, 'now'); let time = Date.now();
      for (let i = 0; i < 100; i++) {
        time += 2000; clock.mockReturnValue(time);
        await act(async () => { window.dispatchEvent(new Event('focus')); await checkFinished(); });
      }
      clock.mockRestore(); expect(poll).toHaveBeenCalledTimes(priorChecks + 100); expect(write).not.toHaveBeenCalled(); expect(diskWrites).not.toHaveBeenCalled();
      const command = send.mock.calls[0][4];
      await act(async () => { await window.asteriumAgents!.resumeSession({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'session.resume',
        commandId: 'fixture-combination-resume', partnerId: partner.id, conversationId: id, connectionSource: 'local_cli', sessionId: conversation.sessionId!, afterSequence: 0 }); });
      expect(context.state.conversations[0].messages.map(message => message.id)).toEqual(ids);
      expect(context.state.conversations[0].messages.map(message => message.content)).toEqual(['合成组合问题', '你好，星丛。']);
      const assistant = context.state.conversations[0].messages.at(-1)!;
      const turn: CodexHistoryTurn = { id: assistant.runId!, state: 'completed', items: [{ id: 'fixture-native-answer', kind: 'assistant', text: assistant.content }] };
      const page = mergePage(undefined, conversation.sessionId!, { turns: [turn], nextCursor: 'fixture-older' }, false);
      expect(mergePage(page, page.key, { turns: structuredClone(page.turns) }, false)).toBe(page);
      const changed = mergePage(page, page.key, { turns: [{ ...turn, items: [{ id: 'fixture-native-answer', kind: 'assistant', text: assistant.content + ' 合成恢复尾段' }] }] }, false);
      const merged = mergeNativeCodexMessages(context.state.conversations[0], changed.turns);
      expect(merged.map(message => message.id)).toEqual(ids); expect(merged.at(-1)?.content).toContain('合成恢复尾段');
      expect(merged[0].attachments?.map(attachment => attachment.id)).toEqual(attachments.map(attachment => attachment.id));
      expect((await invoke<MessageAttachment[]>(DESKTOP_IPC.attachmentList, id)).map(attachment => attachment.id)).toEqual(attachments.map(attachment => attachment.id));
      expect(command.content.text).toBe('合成组合问题');

      let release!: () => void;
      native.pause = new Promise<void>(resolve => { release = resolve; }); native.state = 'deleted';
      const deletion = vi.spyOn(window.asteriumConversations!, 'delete');
      const staleClock = vi.spyOn(Date, 'now').mockReturnValue(time + 4000);
      try {
        act(() => window.dispatchEvent(new Event('focus')));
        await waitFor(() => expect(native.awaiting).toBe(true));
        native.eventAt = '2026-11-21T00:03:00.000Z'; native.state = 'active';
        await act(async () => { expect(await context.sendChatMessage(id, '合成聚焦期间的新消息')).toBe(true); });
        await waitFor(() => expect(context.state.conversations[0].messages).toHaveLength(4));
        await waitFor(() => expect(context.state.conversations[0].messages.at(-1)?.runState).toBe('completed'));
        await act(async () => { await Promise.all(write.mock.results.map(result => result.value)); });
        const savedBeforeStale = write.mock.calls.length;
        await act(async () => { release(); await checkFinished(); });
        expect(context.state.conversations[0]).toMatchObject({ nativeThreadState: 'active', nativeThreadStateCheckedAt: native.eventAt });
        expect(context.state.conversations[0].isArchived).not.toBe(true); expect(write).toHaveBeenCalledTimes(savedBeforeStale);
        expect(deletion).not.toHaveBeenCalled();
        expect(context.state.conversations[0].messages.filter(message => message.content === '合成聚焦期间的新消息')).toHaveLength(1);
        expect(new Set(context.state.conversations[0].messages.map(message => message.id)).size).toBe(4);
        expect((await invoke<MessageAttachment[]>(DESKTOP_IPC.attachmentList, id)).map(attachment => attachment.id)).toEqual(attachments.map(attachment => attachment.id));
      } finally { release(); staleClock.mockRestore(); }
    } finally { view.unmount(); }
  });
});

it('imports tagged and legacy memories through the same service read by the phase-6 API starter', async () => {
  await withMain(async ({ invoke }) => {
    const partnerId = 'fixture-combination-memory';
    await invoke(DESKTOP_IPC.savePartnerProfile, { partnerId, sourceMode: 'api_partner', publicIdentity: { displayName: '合成记忆伙伴', introduction: '', expertise: '', mentionName: '合成记忆' },
      management: { userProfile: false, personality: false, memoryMode: 'asterium' }, connectionSettings: {} });
    const snapshots = vi.spyOn(PartnerMemoryService.prototype, 'snapshot');
    await invoke(DESKTOP_IPC.memoryArchiveQuery, { partnerId });
    const memories = snapshots.mock.contexts.at(-1) as PartnerMemoryService;
    const adapter: ApiProviderAdapter = { provider: 'fixture', capabilities: { streamingText: true, reasoning: false, toolCalls: false,
      attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } },
      stream: async function* () { yield { type: 'text.delta', text: JSON.stringify([
        { type: 'stable_fact', body: '合成用户按阶段验收项目。', tags: [' 验收 ', '验收', '项目'], paragraph: 1 },
        { type: 'stable_fact', body: '合成用户保留独立提交。', paragraph: 1 },
      ]) }; } };
    const importer = new MemoryImportService(memories, id => id === partnerId, async () => adapter);
    try {
      const batchId = '00000000-0000-7000-8000-000000000001';
      const preview = await importer.preview({ partnerId, batchId, label: '合成旧对话', text: '合成用户按阶段验收项目，并保留独立提交。', endpoint: 'https://api.example.test', provider: 'fixture', model: 'fixture-model' });
      await importer.confirm({ partnerId, batchId, selected: preview.candidates.map(({ id, type, body }) => ({ id, type, body })) });
      const records = await memories.list(partnerId);
      expect(records.find(record => record.body.includes('验收'))?.tags).toEqual(['验收', '项目']); expect(records.find(record => record.body.includes('独立提交'))?.tags).toEqual([]);
      const create = vi.mocked(PartnerRuntimeFactory.prototype.createApi);
      const command: SendMessageCommand = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: 'fixture-memory-send', clientMessageId: 'fixture-memory-message',
        partnerId, conversationId: 'fixture-memory-chat', connectionSource: 'api_partner', content: { type: 'text', text: '合成新会话' } };
      const before = snapshots.mock.calls.length;
      await invoke(DESKTOP_IPC.sendApiMessage, { connection: { provider: 'openai', endpoint: 'https://api.example.test/v1', model: 'fixture-model', credentialRef: 'fixture-secret' }, command });
      const sent = create.mock.calls.at(-1)![0].command;
      expect(sent.sessionBootstrap?.content).toContain('合成用户按阶段验收项目。'); expect(sent.sessionBootstrap?.content).toContain('合成用户保留独立提交。');
      expect(snapshots.mock.contexts.slice(before)).toContain(memories);
    } finally { importer.dispose(); }
  });
});
