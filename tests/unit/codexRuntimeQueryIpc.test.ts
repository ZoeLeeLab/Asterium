// @vitest-environment node
import { mkdir, mkdtemp, realpath, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import type { CodexInstallation } from '../../src/main/adapters/CodexCliAdapter';
import { WorkspaceGrantStore } from '../../src/main/security/WorkspaceGrantStore';
import { NativeThreadBindingStore } from '../../src/main/studio/NativeThreadBindingStore';
import type { CodexRuntimeInfo } from '../../src/shared/agentProtocol';
import type { CodexModelOption } from '../../src/shared/codexModels';
import type { CodexQuotaResult } from '../../src/shared/codexQuota';
import { DESKTOP_IPC as AGENT_IPC } from '../../src/shared/desktopIpc';
import { testRm } from '../helpers/autoTest.mjs';

const fixture = vi.hoisted(() => ({
  userData: '',
  onAccess: undefined as ((filename: string) => void) | undefined,
  detectCodex: vi.fn<() => Promise<CodexInstallation>>(),
  listModels: vi.fn<(exe: string, cwd: string) => Promise<CodexModelOption[]>>(),
  readQuota: vi.fn<(exe: string, cwd: string) => Promise<CodexQuotaResult>>(),
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
vi.mock('../../src/main/adapters/CodexCliAdapter', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/main/adapters/CodexCliAdapter')>(),
  detectCodexCli: fixture.detectCodex,
  listCodexModels: fixture.listModels,
  readCodexQuota: fixture.readQuota,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: async (...args: Parameters<typeof actual.access>) => {
      await actual.access(...args);
      fixture.onAccess?.(String(args[0]));
    },
  };
});

const models: CodexModelOption[] = [{ model: 'fixture-model', displayName: 'Fixture model', efforts: ['medium'] }];
const quota: CodexQuotaResult = { status: 'available', checkedAt: 1, windows: [{ usedPercent: 20 }] };
const partnerId = 'fixture-codex-partner';

async function withQueries(run: (queries: {
  invoke: (channel: string, value: unknown, caller?: object) => Promise<unknown>;
  root: string;
  userData: string;
  workingDirectory: string;
  importedDirectory: string;
  grantId: string;
  runtime: CodexRuntimeInfo;
  importedRuntime: CodexRuntimeInfo;
  bindImported: (overrides?: { canonicalDirectory?: string; codexHome?: string }) => Promise<string>;
}) => Promise<void>) {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-codex-queries-ipc-'));
  const userData = path.join(root, 'profile');
  const workingDirectory = path.join(root, 'workspace');
  const importedDirectory = path.join(root, 'import-workspace');
  fixture.userData = userData;
  fixture.detectCodex.mockReset();
  fixture.listModels.mockReset().mockResolvedValue(models);
  fixture.readQuota.mockReset().mockResolvedValue(quota);
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
  const invoke = (channel: string, value: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return handler({ sender: caller }, value);
  };
  const makeRuntime = (runtimeId: string, environment: CodexRuntimeInfo['environment']): CodexRuntimeInfo => ({
    runtimeId, environment, environmentLabel: 'Fixture Codex',
    installed: true, loggedIn: true, executableLabel: 'fixture-codex.exe',
    executablePath: path.join(root, runtimeId + '.exe'), codexHome: path.join(root, runtimeId + '-home'),
  });
  const runtime = makeRuntime('fixture-cli', 'global_cli');
  const importedRuntime = makeRuntime('fixture-desktop', 'desktop_app');
  fixture.detectCodex.mockResolvedValue({ installed: true, loggedIn: true, runtimes: [runtime, importedRuntime] });
  const bindings = new NativeThreadBindingStore(path.join(userData, 'native-thread-bindings.v1.json'));
  let bindingCount = 0;
  const bindImported = async (overrides: { canonicalDirectory?: string; codexHome?: string } = {}) => {
    const threadId = 'fixture-thread-' + ++bindingCount;
    const binding = await bindings.reserveCodexImport(partnerId, threadId, {
      originalCwd: importedDirectory, directory: importedDirectory, canonicalDirectory: await realpath(importedDirectory),
      runtimeId: importedRuntime.runtimeId, runtimeEnvironment: importedRuntime.environment, codexHome: importedRuntime.codexHome,
      ...overrides,
    });
    await bindings.activate(binding.bindingId, threadId);
    return binding.conversationId;
  };

  try {
    await Promise.all([userData, workingDirectory, importedDirectory].map(directory => mkdir(directory)));
    await Promise.all([runtime, importedRuntime].map(item => writeFile(item.executablePath, 'synthetic executable path')));
    const { grantId } = await new WorkspaceGrantStore(path.join(userData, 'workspace-grants.v1.json')).add(workingDirectory);
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: userData,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      await invoke(AGENT_IPC.savePartnerProfile, {
        partnerId, sourceMode: 'local_cli',
        publicIdentity: { displayName: 'Fixture partner', mentionName: 'Fixture', introduction: '', expertise: '' },
        management: { userProfile: false, personality: false, memoryMode: 'self_managed' },
        connectionSettings: { __studioRuntime: { available: true, runtime: {
          kind: 'local', adapterType: 'codex_cli', codexRuntimeId: runtime.runtimeId,
          codexRuntimeEnvironment: runtime.environment, workspaceGrantIds: [],
        } } },
      });
      await run({ invoke, root, userData, workingDirectory, importedDirectory, grantId, runtime, importedRuntime, bindImported });
    } finally {
      await dispose();
    }
    expect(handlers.has(AGENT_IPC.listCodexModels)).toBe(false);
    expect(handlers.has(AGENT_IPC.readCodexQuota)).toBe(false);
  } finally {
    fixture.onAccess = undefined;
    await testRm(root, { recursive: true, force: true });
  }
}

it('uses the approved ordinary workspace and the pinned runtime and directory of an imported conversation', async () => {
  await withQueries(async ({ invoke, root, userData, workingDirectory, importedDirectory, grantId, runtime, importedRuntime, bindImported }) => {
    const list = AGENT_IPC.listCodexModels;
    const selection = { partnerId, codexRuntimeId: runtime.runtimeId, partnerRootGrantId: grantId };
    await expect(invoke(list, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(list, { codexRuntimeEnvironment: 'invalid' })).rejects.toThrow('INVALID_CODEX_MODEL_LIST_REQUEST');
    await expect(invoke(list, { ...selection, partnerRootGrantId: 'missing-grant' })).rejects.toThrow('PARTNER_ROOT_GRANT_REQUIRED');
    const protectedDirectory = path.join(userData, 'AsteriumData');
    const protectedGrant = await new WorkspaceGrantStore(path.join(userData, 'workspace-grants.v1.json')).add(protectedDirectory);
    await expect(invoke(list, { ...selection, partnerRootGrantId: protectedGrant.grantId })).rejects.toThrow('PROFILE_DATA_ACCESS_DENIED');
    expect(fixture.listModels).not.toHaveBeenCalled();
    await expect(invoke(list, { ...selection, conversationId: 'ordinary-fixture' })).resolves.toEqual(models);
    expect(fixture.listModels).toHaveBeenLastCalledWith(runtime.executablePath, workingDirectory);

    const conversationId = await bindImported();
    await expect(invoke(list, { ...selection, conversationId })).resolves.toEqual(models);
    expect(fixture.listModels).toHaveBeenLastCalledWith(importedRuntime.executablePath, await realpath(importedDirectory));
    const wrongHome = await bindImported({ codexHome: path.join(root, 'moved-home') });
    await expect(invoke(list, { ...selection, conversationId: wrongHome })).rejects.toThrow('CODEX_IMPORTED_HOME_CHANGED');
    const wrongDirectory = await bindImported({ canonicalDirectory: workingDirectory });
    await expect(invoke(list, { ...selection, conversationId: wrongDirectory })).rejects.toThrow('CODEX_IMPORTED_DIRECTORY_UNAVAILABLE');
    await rename(importedDirectory, path.join(root, 'moved-workspace'));
    await expect(invoke(list, { ...selection, conversationId })).rejects.toThrow('CODEX_IMPORTED_DIRECTORY_UNAVAILABLE');
    expect(fixture.listModels).toHaveBeenCalledTimes(2);
  });
});

it('reads ordinary and imported quotas from the selected account without requiring a workspace', async () => {
  await withQueries(async ({ invoke, root, importedDirectory, runtime, importedRuntime, bindImported }) => {
    const read = AGENT_IPC.readCodexQuota;
    await expect(invoke(read, undefined, {})).rejects.toThrow('INVALID_IPC_SENDER');
    await expect(invoke(read, { partnerId: ' ' })).rejects.toThrow('INVALID_CODEX_QUOTA_REQUEST');
    await expect(invoke(read, { partnerId: 'missing-partner' })).resolves.toEqual({ status: 'runtime_unavailable' });
    await expect(invoke(read, { partnerId, importedConversationId: 'missing-import' })).resolves.toEqual({ status: 'runtime_unavailable' });
    expect(fixture.readQuota).not.toHaveBeenCalled();

    await expect(invoke(read, { partnerId })).resolves.toEqual(quota);
    expect(fixture.readQuota).toHaveBeenLastCalledWith(runtime.executablePath, os.homedir());
    const importedConversationId = await bindImported();
    await rename(importedDirectory, path.join(root, 'moved-workspace'));
    await expect(invoke(read, { partnerId, importedConversationId })).resolves.toEqual(quota);
    expect(fixture.readQuota).toHaveBeenLastCalledWith(importedRuntime.executablePath, os.homedir());
    expect(fixture.readQuota).toHaveBeenCalledTimes(2);
  });
});

it('shares overlapping quota requests and allows refresh after success, unavailable status or rejection', async () => {
  await withQueries(async ({ invoke, runtime }) => {
    const refresh = () => invoke(AGENT_IPC.readCodexQuota, { partnerId });
    let finish!: (result: CodexQuotaResult) => void;
    fixture.readQuota.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const first = refresh();
    await vi.waitFor(() => expect(fixture.readQuota).toHaveBeenCalledTimes(1));
    const checkedSecond = new Promise<void>(resolve => {
      fixture.onAccess = filename => { if (filename === runtime.executablePath) resolve(); };
    });
    const second = refresh();
    await checkedSecond;
    await setImmediate();
    expect(fixture.readQuota).toHaveBeenCalledTimes(1);
    finish(quota);
    await expect(Promise.all([first, second])).resolves.toEqual([quota, quota]);

    fixture.readQuota.mockResolvedValueOnce({ status: 'unavailable' });
    await expect(refresh()).resolves.toEqual({ status: 'unavailable' });
    await expect(refresh()).resolves.toEqual(quota);
    fixture.readQuota.mockRejectedValueOnce(new Error('Fixture quota failure'));
    await expect(refresh()).rejects.toThrow('Fixture quota failure');
    await expect(refresh()).resolves.toEqual(quota);
    expect(fixture.readQuota).toHaveBeenCalledTimes(5);
  });
});
