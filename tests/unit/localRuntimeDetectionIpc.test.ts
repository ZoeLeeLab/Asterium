// @vitest-environment node
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import type { ClaudeInstallation } from '../../src/main/adapters/ClaudeCodeAdapter';
import type { CodexInstallation } from '../../src/main/adapters/CodexCliAdapter';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import { PartnerRuntimeFactory } from '../../src/main/runtime/PartnerRuntimeFactory';
import { WorkspaceGrantStore } from '../../src/main/security/WorkspaceGrantStore';
import { AGENT_PROTOCOL_VERSION } from '../../src/shared/agentProtocol';
import type { PartnerEvent, SendMessageCommand } from '../../src/shared/agentProtocol';
import type { PartnerAdapter } from '../../src/main/adapters/PartnerAdapter';
import type { AsteriumRuntimeToolController } from '../../src/main/runtime/AsteriumRuntimeTools';
import { testRm } from '../helpers/autoTest.mjs';

const fixture = vi.hoisted(() => ({
  userData: '',
  detectClaude: vi.fn<() => Promise<ClaudeInstallation>>(),
  detectCodex: vi.fn<() => Promise<CodexInstallation>>(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => fixture.userData,
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
vi.mock('../../src/main/adapters/ClaudeCodeAdapter', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/main/adapters/ClaudeCodeAdapter')>(),
  detectClaudeCode: fixture.detectClaude,
}));
vi.mock('../../src/main/adapters/CodexCliAdapter', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/main/adapters/CodexCliAdapter')>(),
  detectCodexCli: fixture.detectCodex,
}));

it('checks the main sender, returns the existing detection results and refreshes the installation used by local runs', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-runtime-detection-ipc-'));
  const userData = path.join(root, 'profile');
  const workspace = path.join(root, 'workspace');
  fixture.userData = userData;
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value?: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const claudeChannel = 'asterium:agent:detect-claude';
  const codexChannel = 'asterium:agent:detect-codex';
  const invoke = (channel: string, value?: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return handler({ sender: caller }, value);
  };

  try {
    await Promise.all([mkdir(userData), mkdir(workspace)]);
    const grant = await new WorkspaceGrantStore(path.join(userData, 'workspace-grants.v1.json')).add(workspace);
    const claude = {
      installed: true, loggedIn: true, version: 'fixture-claude-1', authMethod: 'fixture-auth',
      executableLabel: 'fixture-claude.exe', executablePath: path.join(root, 'fixture-claude.exe'),
    };
    const updatedClaude = { ...claude, version: 'fixture-claude-2', executablePath: path.join(root, 'fixture-updated-claude.exe') };
    const runtime: CodexInstallation['runtimes'][number] = {
      installed: true, loggedIn: true, runtimeId: 'fixture-codex', environment: 'global_cli', environmentLabel: 'Fixture Codex',
      executableLabel: 'fixture-codex.exe', executablePath: path.join(root, 'fixture-codex.exe'), codexHome: path.join(root, 'fixture-codex-home'),
    };
    const updatedRuntime = { ...runtime, executablePath: path.join(root, 'fixture-updated-codex.exe') };
    const codex = { installed: true, loggedIn: true, runtimes: [runtime], recommendedRuntimeId: runtime.runtimeId };
    const updatedCodex = { ...codex, runtimes: [updatedRuntime] };
    const detectionError = new Error('Fixture detection failed');
    fixture.detectClaude.mockResolvedValueOnce(claude).mockResolvedValueOnce(updatedClaude).mockRejectedValueOnce(detectionError);
    fixture.detectCodex.mockResolvedValueOnce(codex).mockResolvedValueOnce(updatedCodex).mockRejectedValueOnce(detectionError);
    const getLocal = vi.spyOn(PartnerRuntimeFactory.prototype, 'getLocal').mockImplementation(() => {
      throw new Error('Fixture runtime reached');
    });
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: userData,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await expect(invoke(claudeChannel, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(codexChannel, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
      expect(fixture.detectClaude).not.toHaveBeenCalled();
      expect(fixture.detectCodex).not.toHaveBeenCalled();

      const publicClaude = {
        installed: true, loggedIn: true, authMethod: claude.authMethod, executableLabel: claude.executableLabel, error: undefined,
      };
      await expect(invoke(claudeChannel)).resolves.toStrictEqual({ ...publicClaude, version: claude.version });
      await expect(invoke(claudeChannel)).resolves.toStrictEqual({ ...publicClaude, version: updatedClaude.version });
      await expect(invoke(codexChannel)).resolves.toBe(codex);
      await expect(invoke(codexChannel)).resolves.toBe(updatedCodex);
      await expect(invoke(claudeChannel)).rejects.toBe(detectionError);
      await expect(invoke(codexChannel)).rejects.toBe(detectionError);

      const profiles = new PartnerProfileStore(path.join(userData, 'AsteriumData'));
      for (const [adapterType, executablePath] of [
        ['claude_code', updatedClaude.executablePath], ['codex_cli', updatedRuntime.executablePath],
      ] as const) {
        const id = 'fixture-' + adapterType;
        await profiles.savePartner({
          partnerId: id, sourceMode: 'local_cli', connectionSettings: { adapterType },
          publicIdentity: { displayName: id, mentionName: id, introduction: '', expertise: '' },
          management: { memoryMode: 'self_managed', personality: false, userProfile: false },
        });
        await expect(invoke('asterium:agent:send-message', {
          adapterType, partnerId: id, partnerRootGrantId: grant.grantId, workspaceGrantIds: [],
          ...(adapterType === 'codex_cli' ? { codexRuntimeId: runtime.runtimeId } : {}),
          command: {
            protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: id, clientMessageId: id,
            partnerId: id, conversationId: id, connectionSource: 'local_cli', content: { type: 'text', text: '合成消息' },
          },
        })).rejects.toThrow('Fixture runtime reached');
        expect(getLocal).toHaveBeenLastCalledWith(expect.objectContaining({ adapterType, executablePath }));
      }
      expect(fixture.detectClaude).toHaveBeenCalledTimes(3);
      expect(fixture.detectCodex).toHaveBeenCalledTimes(3);
    } finally {
      try { await dispose(); }
      finally { getLocal.mockRestore(); }
    }
    expect(handlers.has(claudeChannel)).toBe(false);
    expect(handlers.has(codexChannel)).toBe(false);
  } finally {
    await testRm(root, { recursive: true, force: true });
  }
});

it('rebinds a queued turn to its own tools under the writer lease on the same native adapter', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-local-turn-lease-'));
  fixture.userData = path.join(root, 'profile');
  const workspace = path.join(root, 'workspace');
  await Promise.all([mkdir(fixture.userData), mkdir(workspace)]);
  const grant = await new WorkspaceGrantStore(path.join(fixture.userData, 'workspace-grants.v1.json')).add(workspace);
  const runtime: CodexInstallation['runtimes'][number] = { installed: true, loggedIn: true, runtimeId: 'fixture-runtime', environment: 'global_cli',
    environmentLabel: 'Fixture', executablePath: path.join(root, 'fixture-cli.exe'), executableLabel: 'fixture-cli.exe', codexHome: path.join(root, 'fixture-home') };
  fixture.detectCodex.mockReset().mockResolvedValue({ installed: true, loggedIn: true, runtimes: [runtime], recommendedRuntimeId: runtime.runtimeId });
  await new PartnerProfileStore(path.join(fixture.userData, 'AsteriumData')).savePartner({
    partnerId: 'fixture-partner', sourceMode: 'local_cli', connectionSettings: { adapterType: 'codex_cli' },
    publicIdentity: { displayName: 'Fixture', mentionName: 'fixture', introduction: '', expertise: '' },
    management: { memoryMode: 'self_managed', personality: false, userProfile: false },
  });
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value?: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) } as unknown as IpcMain;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let tools: AsteriumRuntimeToolController | undefined;
  const seen: (AsteriumRuntimeToolController | undefined)[] = [];
  const adapter: PartnerAdapter = {
    connectionSource: 'local_cli', capabilities: { streamingText: true, cancellation: true, sessionResume: true, toolEvents: true, fileEvents: true, authorizationBridge: true, extensions: [] },
    replaceRuntimeTools: value => { tools = value; },
    async *sendMessage(command) {
      seen.push(tools);
      const base = { protocolVersion: AGENT_PROTOCOL_VERSION, eventId: command.commandId, partnerId: command.partnerId,
        conversationId: command.conversationId, connectionSource: command.connectionSource, clientMessageId: command.clientMessageId,
        runId: command.commandId, sessionId: 'fixture-session', occurredAt: '2026-01-01T00:00:00.000Z' };
      yield { ...base, type: 'session.bound', sequence: 1, isNew: !command.sessionId } as PartnerEvent;
      if (seen.length === 1) await gate;
      yield { ...base, type: 'run.completed', sequence: 2, finishReason: 'completed' } as PartnerEvent;
    }, async *resumeSession() {}, cancel: vi.fn(), resolveAuthorization: vi.fn(),
  };
  const getLocal = vi.spyOn(PartnerRuntimeFactory.prototype, 'getLocal').mockImplementation(request => {
    if (!request.deferRuntimeConfiguration) tools = request.runtimeTools;
    return adapter;
  });
  const dispose = registerAgentIpc(ipcMain, () => window, { environment: { profile: 'autotest', label: 'Fixture', userDataDirectory: fixture.userData,
    projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root, appUserModelId: 'Asterium.Test',
    allowStartup: false, allowUpdates: false, restoreBackgroundServices: false, mcpPort: 0 } });
  const send = (id: string) => {
    const command: SendMessageCommand = { protocolVersion: AGENT_PROTOCOL_VERSION, type: 'message.send', commandId: id, clientMessageId: id,
      partnerId: 'fixture-partner', conversationId: 'fixture-conversation', connectionSource: 'local_cli',
      ...(id === 'fixture-second' ? { sessionId: 'fixture-session' } : {}), content: { type: 'text', text: '合成内容' } };
    return handlers.get('asterium:agent:send-message')!({ sender }, { adapterType: 'codex_cli', partnerId: command.partnerId,
      partnerRootGrantId: grant.grantId, workspaceGrantIds: [], codexRuntimeId: runtime.runtimeId, command });
  };
  try {
    await send('fixture-first');
    const second = send('fixture-second');
    await vi.waitFor(() => expect(getLocal).toHaveBeenCalledTimes(2));
    expect(getLocal.mock.calls.every(([request]) => request.deferRuntimeConfiguration)).toBe(true);
    expect(tools).toBe(seen[0]);
    release(); await second;
    await vi.waitFor(() => expect(sender.send.mock.calls.some(call => call[1]?.type === 'run.completed' && call[1]?.clientMessageId === 'fixture-second')).toBe(true));
    expect(seen).toEqual(getLocal.mock.calls.map(([request]) => request.runtimeTools));
    expect(getLocal.mock.calls[0][0].adapterKey).toBe(getLocal.mock.calls[1][0].adapterKey);
  } finally { release(); await dispose(); getLocal.mockRestore(); await testRm(root, { recursive: true, force: true }); }
});
