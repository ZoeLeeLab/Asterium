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
