// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { AdapterHost } from '../../src/main/AdapterHost';
import { registerAgentIpc } from '../../src/main/agentIpc';
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

async function withRunInteraction(run: (invoke: (channel: string, value: unknown, caller?: object) => Promise<unknown>) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-run-interaction-ipc-'));
  electron.userData = root;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
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
      await run(invoke);
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
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
