// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { AdapterHost } from '../../src/main/AdapterHost';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { RunCoordinator } from '../../src/main/runtime/RunCoordinator';
import { PartnerRuntimeFactory } from '../../src/main/runtime/PartnerRuntimeFactory';
import { SessionBootstrapService } from '../../src/main/runtime/SessionBootstrapService';
import { ContextHandoffService } from '../../src/main/runtime/ContextHandoffService';
import { AutomationConfirmations } from '../../src/main/automation/AutomationConfirmations';
import { ApiConnectionStore } from '../../src/main/api/ApiConnectionStore';
import { CredentialStore } from '../../src/main/security/CredentialStore';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';
import { StudioRuntimeCatalog } from '../../src/main/studio/StudioRuntimeCatalog';
import { PartnerDiaryCatalog } from '../../src/main/diary/PartnerDiaryCatalog';
import { CyberBossBridgeClient } from '../../src/main/adapters/CyberBossBridgeClient';
import type { DelegationBatchView } from '../../src/main/runtime/PartnerDelegation';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import { AGENT_PROTOCOL_VERSION, type ResolveUserInputCommand, type SendGuidanceCommand, type SendGuidanceResult } from '../../src/shared/agentProtocol';
import { MockAdapter } from '../helpers/MockAdapter';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  safeStorage: {},
  shell: {},
}));

const guidanceChannel = 'asterium:agent:send-guidance';
const inputChannel = 'asterium:agent:resolve-user-input';
const target = {
  protocolVersion: AGENT_PROTOCOL_VERSION, partnerId: 'fixture-partner', conversationId: 'fixture-chat',
  connectionSource: 'local_cli', runId: 'fixture-run', sessionId: 'fixture-session',
} as const;
const guidance: SendGuidanceCommand = {
  ...target, type: 'guidance.send', commandId: 'fixture-guidance', clientMessageId: 'fixture-guidance-message',
  content: { type: 'text', text: '合成指导' },
};
const input: ResolveUserInputCommand = {
  ...target, type: 'user_input.resolve', commandId: 'fixture-input', clientMessageId: 'fixture-input-message',
  requestId: 'fixture-request', answers: { 'fixture-question': ['合成选项'] }, customAnswers: { 'fixture-other': '合成回答' },
};

async function withRunInteraction(run: (invoke: (channel: string, value: unknown, caller?: object) => Promise<unknown>, sent: unknown[][]) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-run-interaction-ipc-'));
  electron.userData = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const removed: string[] = [];
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); },
  } as unknown as IpcMain;
  const invoke = async (channel: string, value: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return handler({ sender: caller }, value);
  };
  try {
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await run(invoke, sender.send.mock.calls);
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
    for (const channel of [DESKTOP_IPC.sendApiMessage, DESKTOP_IPC.sendMessage, DESKTOP_IPC.cancelRun, DESKTOP_IPC.resolveAuthorization, DESKTOP_IPC.resumeSession, guidanceChannel, inputChannel]) expect(removed.filter(name => name === channel)).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
    await testRm(root, { recursive: true, force: true });
  }
}

it('checks sender and command type before routing guidance and input to a running adapter', async () => {
  await withRunInteraction(async invoke => {
    const lookup = vi.spyOn(AdapterHost.prototype, 'adapterForRun');
    await expect(invoke(guidanceChannel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(inputChannel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(guidanceChannel, { ...guidance, content: { type: 'text', text: ' ' } })).rejects.toThrow('INVALID_AGENT_COMMAND');
    await expect(invoke(inputChannel, { ...input, answers: { 'fixture-question': [1] } })).rejects.toThrow('INVALID_AGENT_COMMAND');
    await expect(invoke(guidanceChannel, input)).rejects.toThrow('INVALID_GUIDANCE_COMMAND');
    await expect(invoke(inputChannel, guidance)).rejects.toThrow('INVALID_USER_INPUT_COMMAND');
    expect(lookup).not.toHaveBeenCalled();
  });
});

const sendCommand = { ...target, type: 'message.send' as const, commandId: 'fixture-send', clientMessageId: 'fixture-send-message', content: { type: 'text' as const, text: '合成消息' } };
const apiConnection = { provider: 'openai' as const, endpoint: 'https://api.example.test/v1', model: 'fixture-model', credentialRef: 'fixture-credential', workspaceGrantIds: [] };
const apiRequest = () => ({ connection: { ...apiConnection }, command: { ...sendCommand, connectionSource: 'api_partner' as const } });
const localRequest = () => ({ adapterType: 'claude_code' as const, partnerId: target.partnerId, workspaceGrantIds: [], command: { ...sendCommand } });
const cancelCommand = { ...target, type: 'run.cancel' as const, commandId: 'fixture-cancel', clientMessageId: 'fixture-send-message' };
const authorizationCommand = { ...target, type: 'authorization.resolve' as const, commandId: 'fixture-authorization', clientMessageId: 'fixture-send-message', authorizationId: 'fixture-authorization-id', decision: 'deny' as const };
const resumeCommand = { ...target, type: 'session.resume' as const, commandId: 'fixture-resume', afterSequence: 0 };

it('checks the five message-run callers and preserves request and command validation before any runtime work', async () => {
  await withRunInteraction(async invoke => {
    for (const channel of [DESKTOP_IPC.sendApiMessage, DESKTOP_IPC.sendMessage, DESKTOP_IPC.cancelRun, DESKTOP_IPC.resolveAuthorization, DESKTOP_IPC.resumeSession]) await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
    for (const connection of [{ ...apiConnection, provider: 'bad' }, { ...apiConnection, reasoningEffort: 'medium' }, { ...apiConnection, workspaceGrantIds: [1] }, { ...apiConnection, attachmentCapabilities: { supportsImageInput: true } }]) await expect(invoke(DESKTOP_IPC.sendApiMessage, { ...apiRequest(), connection })).rejects.toThrow('INVALID_API_SEND_REQUEST');
    for (const value of [null, { ...localRequest(), adapterType: 'bad' }, { ...localRequest(), workspaceGrantIds: [1] }, { ...localRequest(), codexRuntimeEnvironment: 'bad' }]) await expect(invoke(DESKTOP_IPC.sendMessage, value)).rejects.toThrow('INVALID_LOCAL_CLI_SEND_REQUEST');
    await expect(invoke(DESKTOP_IPC.sendApiMessage, { ...apiRequest(), command: { ...sendCommand, content: { type: 'text', text: '' } } })).rejects.toThrow('INVALID_AGENT_COMMAND');
    await expect(invoke(DESKTOP_IPC.sendApiMessage, { ...apiRequest(), command: sendCommand })).rejects.toThrow('INVALID_API_SEND_COMMAND');
    await expect(invoke(DESKTOP_IPC.sendMessage, { ...localRequest(), command: guidance })).rejects.toThrow('INVALID_LOCAL_CLI_SEND_COMMAND');
    await expect(invoke(DESKTOP_IPC.sendMessage, { ...localRequest(), command: apiRequest().command })).rejects.toThrow('INVALID_LOCAL_CLI_CONNECTION_SOURCE');
    for (const [channel, error] of [[DESKTOP_IPC.cancelRun, 'INVALID_CANCEL_COMMAND'], [DESKTOP_IPC.resolveAuthorization, 'INVALID_AUTHORIZATION_COMMAND'], [DESKTOP_IPC.resumeSession, 'INVALID_RESUME_COMMAND']]) {
      await expect(invoke(channel, null)).rejects.toThrow('INVALID_AGENT_COMMAND'); await expect(invoke(channel, guidance)).rejects.toThrow(error);
    }
  });
});

it('cancels confirmation ownership before awaiting run cancellation and preserves void authorization/resume results and errors', async () => {
  await withRunInteraction(async invoke => {
    const trace: string[] = []; let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const owner = vi.spyOn(AutomationConfirmations.prototype, 'cancelOwner').mockImplementation(() => { trace.push('owner'); });
    const cancel = vi.spyOn(RunCoordinator.prototype, 'cancel').mockImplementation(async () => { trace.push('cancel'); await pending; trace.push('finished'); });
    const operation = invoke(DESKTOP_IPC.cancelRun, cancelCommand); expect(trace).toEqual(['owner', 'cancel']);
    expect(owner).toHaveBeenCalledExactlyOnceWith(cancelCommand.clientMessageId); expect(cancel).toHaveBeenCalledExactlyOnceWith(cancelCommand);
    finish(); await expect(operation).resolves.toBeUndefined(); expect(trace).toEqual(['owner', 'cancel', 'finished']);
    const auth = vi.spyOn(RunCoordinator.prototype, 'resolveAuthorization').mockResolvedValue(undefined);
    const resume = vi.spyOn(RunCoordinator.prototype, 'resume').mockResolvedValue(undefined);
    for (const [channel, command, call] of [[DESKTOP_IPC.resolveAuthorization, authorizationCommand, auth], [DESKTOP_IPC.resumeSession, resumeCommand, resume]] as const) {
      await expect(invoke(channel, command)).resolves.toBeUndefined(); expect(call.mock.calls[0][0]).toBe(command);
      const error = new Error('SYNTHETIC_RUN_CONTROL_FAILURE'); call.mockRejectedValueOnce(error);
      await expect(invoke(channel, command)).rejects.toBe(error); await expect(invoke(channel, command)).resolves.toBeUndefined();
    }
    const error = new Error('SYNTHETIC_CANCEL_FAILURE'); cancel.mockRejectedValueOnce(error); await expect(invoke(DESKTOP_IPC.cancelRun, cancelCommand)).rejects.toBe(error);
    expect(owner).toHaveBeenCalledTimes(2);
  });
});

it('validates and replaces each single-chat handoff before starting its original runtime and rejects routed or mismatched local handoffs', async () => {
  await withRunInteraction(async invoke => {
    const resolved = { fixture: 'resolved' }, error = new Error('SYNTHETIC_RUNTIME_BOUNDARY');
    const validate = vi.spyOn(ContextHandoffService.prototype, 'validate').mockResolvedValue(resolved as never);
    const api = vi.spyOn(ApiConnectionStore.prototype, 'resolve').mockRejectedValue(error);
    const local = vi.spyOn(NativeThreadBindingStore.prototype, 'getForScope').mockRejectedValue(error);
    const payload = { fixture: 'handoff' };
    for (const [channel, request] of [[DESKTOP_IPC.sendApiMessage, apiRequest()], [DESKTOP_IPC.sendMessage, localRequest()]] as const) {
      const value = { ...request, command: { ...request.command, contextHandoff: payload } };
      await expect(invoke(channel, value)).rejects.toBe(error); expect(value.command.contextHandoff).toBe(resolved);
      expect(validate).toHaveBeenLastCalledWith(payload, { kind: 'single', id: target.conversationId }, target.partnerId);
      const calls = validate.mock.calls.length;
      await expect(invoke(channel, { ...value, command: { ...request.command, route: { scope: 'single' }, contextHandoff: payload } })).rejects.toThrow('HANDOFF_SCOPE_UNAVAILABLE');
      expect(validate).toHaveBeenCalledTimes(calls);
    }
    await expect(invoke(DESKTOP_IPC.sendMessage, { ...localRequest(), partnerId: 'fixture-other', command: { ...sendCommand, contextHandoff: payload } })).rejects.toThrow('HANDOFF_SCOPE_UNAVAILABLE');
    expect(api).toHaveBeenCalledTimes(1); expect(local).toHaveBeenCalledTimes(1);
    const failure = new Error('SYNTHETIC_HANDOFF_FAILURE'); validate.mockRejectedValueOnce(failure);
    await expect(invoke(DESKTOP_IPC.sendApiMessage, { ...apiRequest(), command: { ...apiRequest().command, contextHandoff: payload } })).rejects.toBe(failure); expect(api).toHaveBeenCalledTimes(1);
  });
});

it('returns the API runtime receipt through the existing factory and coordinator without exposing synthetic credentials', async () => {
  await withRunInteraction(async invoke => {
    vi.spyOn(ApiConnectionStore.prototype, 'resolve').mockResolvedValue(apiConnection);
    vi.spyOn(CredentialStore.prototype, 'get').mockResolvedValue('fixture-secret');
    vi.spyOn(SessionBootstrapService.prototype, 'prepare').mockResolvedValue(undefined);
    const adapter = new MockAdapter(), receipt = { runId: 'fixture-api-run', sessionId: 'fixture-api-session' };
    const create = vi.spyOn(PartnerRuntimeFactory.prototype, 'createApi').mockReturnValue(adapter as never);
    const start = vi.spyOn(RunCoordinator.prototype, 'start').mockResolvedValue(receipt);
    await expect(invoke(DESKTOP_IPC.sendApiMessage, apiRequest())).resolves.toBe(receipt);
    expect(create).toHaveBeenCalledTimes(1); expect(create.mock.calls[0][0]).toMatchObject({ provider: 'openai', endpoint: apiConnection.endpoint + '/chat/completions', model: apiConnection.model, apiKey: 'fixture-secret' });
    expect(start).toHaveBeenCalledExactlyOnceWith(adapter, create.mock.calls[0][0].command, { disposeAfter: true, artifactBaseDirectory: undefined, waitForWriter: true });
  });
});

it.each(['0', '1'])('preserves startup, idempotency, cancellation and release with legacy flag %s', async legacy => {
  vi.stubEnv('ASTERIUM_USE_LEGACY_RUN_PATH', legacy);
  try {
    await withRunInteraction(async (invoke, sent) => {
      vi.spyOn(ApiConnectionStore.prototype, 'resolve').mockResolvedValue(apiConnection);
      vi.spyOn(CredentialStore.prototype, 'get').mockResolvedValue('fixture-secret');
      vi.spyOn(SessionBootstrapService.prototype, 'prepare').mockResolvedValue(undefined);
      const adapter = new MockAdapter('cancel'), dispose = vi.fn(async () => undefined);
      const create = vi.spyOn(PartnerRuntimeFactory.prototype, 'createApi').mockReturnValue(Object.assign(adapter, { dispose }) as never);
      const modern = vi.spyOn(RunCoordinator.prototype, 'start');
      const release = vi.spyOn(AdapterHost.prototype, 'releaseRun');
      const request = apiRequest();
      const receipt = await invoke(DESKTOP_IPC.sendApiMessage, request) as { runId: string; sessionId: string };
      await expect(invoke(DESKTOP_IPC.sendApiMessage, apiRequest())).resolves.toEqual(receipt);
      expect(create).toHaveBeenCalledTimes(1);
      expect(adapter.executionCount.get(sendCommand.clientMessageId)).toBe(1);
      expect(modern).toHaveBeenCalledTimes(legacy === '1' ? 0 : 1);
      const cancel = vi.spyOn(adapter, 'cancel');
      await vi.waitFor(() => expect(sent.some(([channel, event]) => channel === DESKTOP_IPC.event && (event as { type?: string })?.type === 'text.delta')).toBe(true));
      await invoke(DESKTOP_IPC.cancelRun, { ...cancelCommand, connectionSource: 'api_partner', ...receipt });
      expect(cancel).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
      expect(release).toHaveBeenCalledWith(receipt.runId);
    });
  } finally { vi.unstubAllEnvs(); }
});

it.each([
  { access: 'read', permissionMode: 'full', planMode: 'default', accepted: true },
  { access: 'write', permissionMode: 'full', planMode: 'default', accepted: true },
  { access: 'write', permissionMode: 'read_only', planMode: 'default', accepted: false },
  { access: 'write', permissionMode: 'full', planMode: 'plan', accepted: false },
] as const)('keeps composed delegation $access/$permissionMode/$planMode on v1 and rejects parent escalation', async row => {
  await withRunInteraction(async invoke => {
    vi.spyOn(ApiConnectionStore.prototype, 'resolve').mockResolvedValue(apiConnection);
    vi.spyOn(CredentialStore.prototype, 'get').mockResolvedValue('fixture-secret');
    vi.spyOn(SessionBootstrapService.prototype, 'prepare').mockResolvedValue(undefined);
    vi.spyOn(RunCoordinator.prototype, 'start').mockResolvedValue({ runId: 'fixture-run', sessionId: 'fixture-session' });
    const create = vi.spyOn(PartnerRuntimeFactory.prototype, 'createApi').mockReturnValue(new MockAdapter() as never);
    const remote = { partnerId: 'fixture-remote', sourceMode: 'existing_thread', available: true, publicIdentity: { displayName: '合成接收伙伴' }, runtime: { kind: 'unsupported' } } as const;
    vi.spyOn(StudioRuntimeCatalog.prototype, 'allPartners').mockReturnValue([remote] as never);
    vi.spyOn(StudioRuntimeCatalog.prototype, 'partner').mockImplementation(id => id === remote.partnerId ? remote as never : undefined);
    vi.spyOn(PartnerDiaryCatalog.prototype, 'current').mockReturnValue({ identity: { sourceMode: 'existing_thread', available: true }, existing: { serviceUrl: 'https://review.example.test', credentialRef: 'fixture-review', threadId: 'fixture-review-thread' } });
    vi.spyOn(CyberBossBridgeClient.prototype, 'reviewCapability').mockResolvedValue({ version: 1, threadId: 'fixture-review-thread' });
    const submit = vi.spyOn(CyberBossBridgeClient.prototype, 'submitReview').mockImplementation(async request => ({ version: 1, requestId: request.requestId, threadId: request.threadId, status: 'succeeded', result: '合成委派结果' }));
    const request = apiRequest();
    await invoke(DESKTOP_IPC.sendApiMessage, { ...request, command: { ...request.command, execution: { permissionMode: row.permissionMode, planMode: row.planMode },
      sourceMessage: { messageId: 'fixture-user-message', authorType: 'user', authorId: 'fixture-user', content: '请处理这份合成方案。', createdAt: '12:00' } } });
    const delegate = create.mock.calls[0][0].runtimeTools.delegation!;
    const signal = new AbortController().signal;
    const targets = JSON.parse(await delegate('list_delegate_partners', {}, signal));
    expect(targets[0].accessModes).toEqual(row.accepted ? ['read', 'write'] : ['read']);
    const dispatch = () => delegate('delegate_tasks', { tasks: [{ targetPartnerId: remote.partnerId, access: row.access, instruction: '处理合成方案。', reviewDraft: { name: 'proposal.md', markdown: '# Synthetic proposal' } }] }, signal, 'fixture-delegation-call');
    if (row.planMode === 'plan') {
      expect(dispatch).toThrow('DELEGATION_PLAN_MODE');
      expect(await invoke(DESKTOP_IPC.delegationList, target.conversationId)).toEqual([]);
      expect(submit).not.toHaveBeenCalled();
      return;
    }
    await dispatch();
    await vi.waitFor(async () => {
      const batches = await invoke(DESKTOP_IPC.delegationList, target.conversationId) as DelegationBatchView[];
      expect(batches[0].tasks[0]).toMatchObject(row.accepted ? { status: 'succeeded', result: '合成委派结果' } : { status: 'failed', reason: 'DELEGATION_ACCESS_DENIED' });
    });
    expect(submit).toHaveBeenCalledTimes(row.accepted ? 1 : 0);
    if (row.accepted) {
      const [metadata, bytes] = submit.mock.calls[0];
      expect(Object.keys(metadata).sort()).toEqual(['file', 'message', 'requestId', 'threadId', 'version']);
      expect(metadata.message).toContain(`本次权限：${row.access}`);
      expect(Buffer.from(bytes).toString('utf8')).toBe('# Synthetic proposal');
    }
  });
});

it('keeps local runtime grant enforcement after validation and does not add a partner-id equality guard without a handoff', async () => {
  await withRunInteraction(async invoke => {
    vi.spyOn(NativeThreadBindingStore.prototype, 'getForScope').mockResolvedValue(undefined);
    vi.spyOn(SessionBootstrapService.prototype, 'prepare').mockResolvedValue(undefined);
    const create = vi.spyOn(PartnerRuntimeFactory.prototype, 'getLocal');
    await expect(invoke(DESKTOP_IPC.sendMessage, localRequest())).rejects.toThrow('PARTNER_ROOT_GRANT_REQUIRED');
    await expect(invoke(DESKTOP_IPC.sendMessage, { ...localRequest(), partnerId: '' })).rejects.toThrow('PARTNER_ROOT_GRANT_REQUIRED');
    expect(create).not.toHaveBeenCalled();
  });
});

it('keeps missing and unsupported run errors and passes active adapter results and failures through', async () => {
  await withRunInteraction(async invoke => {
    const lookup = vi.spyOn(AdapterHost.prototype, 'adapterForRun');
    await expect(invoke(guidanceChannel, guidance)).rejects.toThrow('GUIDANCE_NOT_AVAILABLE');
    await expect(invoke(inputChannel, input)).rejects.toThrow('USER_INPUT_BRIDGE_NOT_AVAILABLE');

    const inactiveCapabilities = new MockAdapter();
    lookup.mockReturnValue(inactiveCapabilities);
    await expect(invoke(guidanceChannel, guidance)).rejects.toThrow('GUIDANCE_NOT_AVAILABLE');
    await expect(invoke(inputChannel, input)).rejects.toThrow('USER_INPUT_BRIDGE_NOT_AVAILABLE');

    const accepted: SendGuidanceResult = { disposition: 'accepted' };
    const deferred: SendGuidanceResult = { disposition: 'deferred' };
    const sendGuidance = vi.fn<(command: SendGuidanceCommand) => Promise<SendGuidanceResult>>()
      .mockResolvedValueOnce(accepted).mockResolvedValueOnce(deferred);
    const resolveUserInput = vi.fn<(command: ResolveUserInputCommand) => Promise<void>>().mockResolvedValue(undefined);
    const active = new MockAdapter();
    const capabilities = { ...active.capabilities, guidance: 'native' as const, userInputBridge: true };
    lookup.mockReturnValue(Object.assign(active, { capabilities, sendGuidance, resolveUserInput }));

    await expect(invoke(guidanceChannel, guidance)).resolves.toBe(accepted);
    await expect(invoke(guidanceChannel, guidance)).resolves.toBe(deferred);
    await expect(invoke(inputChannel, input)).resolves.toBeUndefined();
    expect(sendGuidance).toHaveBeenCalledTimes(2);
    expect(sendGuidance.mock.calls.map(([command]) => command)).toEqual([guidance, guidance]);
    expect(resolveUserInput).toHaveBeenCalledExactlyOnceWith(input);
    expect(lookup.mock.calls.every(([runId]) => runId === target.runId)).toBe(true);

    const guidanceError = new Error('fixture-guidance-failed');
    const inputError = new Error('fixture-input-failed');
    sendGuidance.mockRejectedValueOnce(guidanceError);
    resolveUserInput.mockRejectedValueOnce(inputError);
    await expect(invoke(guidanceChannel, guidance)).rejects.toBe(guidanceError);
    await expect(invoke(inputChannel, input)).rejects.toBe(inputError);
    lookup.mockReturnValue(undefined);
    await expect(invoke(guidanceChannel, guidance)).rejects.toThrow('GUIDANCE_NOT_AVAILABLE');
    await expect(invoke(inputChannel, input)).rejects.toThrow('USER_INPUT_BRIDGE_NOT_AVAILABLE');
  });
});
