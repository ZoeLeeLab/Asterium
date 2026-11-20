// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { PartnerProfileStore } from '../../src/main/partner/PartnerProfileStore';
import { StudioRuntimeCatalog } from '../../src/main/studio/StudioRuntimeCatalog';
import { StudioWakeControlService } from '../../src/main/studio/StudioWakeControlService';
import { ApiConnectionStore } from '../../src/main/api/ApiConnectionStore';
import { McpConnectionManager } from '../../src/main/api/extensions/McpConnectionManager';
import { SqliteMemoryCutover } from '../../src/main/memory/SqliteMemoryCutover';
import { MemoryFallbackInventory } from '../../src/main/memory/fallback/MemoryFallbackInventory';
import { MemoryFallbackScheduler } from '../../src/main/memory/fallback/MemoryFallbackScheduler';
import { PartnerDiaryCatalog } from '../../src/main/diary/PartnerDiaryCatalog';
import { PartnerDiaryService } from '../../src/main/diary/PartnerDiaryService';
import { PartnerDiaryScheduler } from '../../src/main/diary/PartnerDiaryScheduler';
import { ProjectTaskOrchestrator } from '../../src/main/project/ProjectTaskOrchestrator';
import { PartnerRuntimePort } from '../../src/main/runtime/PartnerRuntimePort';
import { AutomationScheduler } from '../../src/main/automation/AutomationScheduler';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { PartnerProfileSeed, PartnerProfilesSyncResult, PartnerProfileSnapshot } from '../../src/shared/agentProtocol';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '', trash: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.root, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, safeStorage: {}, shell: { trashItem: electron.trash },
}));
const user = { displayName: '合成用户', introduction: '合成介绍', updatedAt: '' };
const connection = { provider: 'openai' as const, endpoint: 'https://api.example.test/v1', model: 'fixture-model', credentialRef: 'fixture-credential', workspaceGrantIds: [] };
function seed(partnerId = 'fixture-partner', persist = true, available = true): PartnerProfileSeed {
  return { partnerId, sourceMode: 'api_partner', publicIdentity: { displayName: partnerId, introduction: '合成伙伴', expertise: '测试', mentionName: partnerId },
    management: { userProfile: false, personality: false, memoryMode: 'none' },
    connectionSettings: { endpoint: connection.endpoint, configuredModel: connection.model, __studioRuntime: { persist, available, runtime: { kind: 'api', connection } }, __diaryRuntime: { available: false, credentialRef: 'fixture-diary-credential' } } };
}

async function withProfiles(background: boolean, run: (fixture: {
  root: string; trace: string[];
  invoke: <T = unknown>(channel: string, value: unknown, caller?: object) => Promise<T>;
  observed: ReturnType<typeof observeBackground>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-profile-ipc-'));
  electron.root = root; electron.trash.mockReset().mockResolvedValue(undefined);
  const trace: string[] = [];
  const observed = observeBackground(trace);
  const originalPrepare = SqliteMemoryCutover.prototype.run;
  const prepare = vi.spyOn(SqliteMemoryCutover.prototype, 'run').mockImplementation(function (this: SqliteMemoryCutover) { trace.push('prepare'); return originalPrepare.call(this); });
  const wake = vi.spyOn(StudioWakeControlService.prototype, 'changed').mockImplementation(async () => { trace.push('wake'); });
  vi.spyOn(AutomationScheduler.prototype, 'start').mockResolvedValue(undefined);
  const sender = { send: vi.fn() }, handlers = new Map<string, (event: { sender: object }, value: unknown) => unknown>(), removed: string[] = [];
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  const ipc = { handle: (channel: string, handler: (event: { sender: object }, value: unknown) => unknown) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); }, removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel); } } as unknown as IpcMain;
  const invoke = async <T,>(channel: string, value: unknown, caller: object = sender) => await handlers.get(channel)!({ sender: caller }, value) as T;
  let dispose: (() => Promise<void>) | undefined;
  try {
    dispose = registerAgentIpc(ipc, () => window, { environment: { profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root, appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false, restoreBackgroundServices: background, mcpPort: 0 } });
    await invoke(DESKTOP_IPC.studioMcpStatus, undefined);
    trace.length = 0; prepare.mockClear(); wake.mockClear();
    await run({ root, trace, invoke, observed });
  } finally {
    try { await dispose?.(); expect(handlers.size).toBe(0); for (const channel of [DESKTOP_IPC.syncPartnerProfiles, DESKTOP_IPC.savePartnerProfile, DESKTOP_IPC.trashPartnerProfile]) expect(removed.filter(name => name === channel)).toHaveLength(1); }
    finally { vi.restoreAllMocks(); await testRm(root, { recursive: true, force: true }); }
  }
}

function observeBackground(trace: string[]) {
  return {
    inventory: vi.spyOn(MemoryFallbackInventory.prototype, 'activate').mockImplementation(async () => { trace.push('inventory.activate'); }),
    refresh: vi.spyOn(MemoryFallbackInventory.prototype, 'refresh').mockImplementation(async () => { trace.push('inventory.refresh'); }),
    fallback: vi.spyOn(MemoryFallbackScheduler.prototype, 'start').mockImplementation(async () => { trace.push('fallback.start'); }),
    recovery: vi.spyOn(PartnerDiaryService.prototype, 'recover').mockImplementation(async () => { trace.push('diary.recover'); }),
    diaryStart: vi.spyOn(PartnerDiaryScheduler.prototype, 'start').mockImplementation(async () => { trace.push('diary.start'); }),
    diaryChanged: vi.spyOn(PartnerDiaryScheduler.prototype, 'changed').mockImplementation(async () => { trace.push('diary.changed'); }),
    tasks: vi.spyOn(ProjectTaskOrchestrator.prototype, 'activate').mockImplementation(async () => { trace.push('tasks.activate'); }),
  };
}

it('keeps sender validation before all three parameter checks and every side effect', async () => {
  await withProfiles(false, async ({ trace, invoke }) => {
    for (const [channel, message] of [[DESKTOP_IPC.syncPartnerProfiles, 'INVALID_PARTNER_PROFILE_SYNC'], [DESKTOP_IPC.savePartnerProfile, 'INVALID_PARTNER_PROFILE'], [DESKTOP_IPC.trashPartnerProfile, 'INVALID_PARTNER_PROFILE_TRASH']]) {
      await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(channel, null)).rejects.toThrow(message);
    }
    for (const value of [{ ...seed(), partnerId: '../fixture' }, { ...seed(), expectedRevision: 'invalid' }, { ...seed(), publicIdentity: { ...seed().publicIdentity, displayName: 'x'.repeat(81) } }, { ...seed(), management: { userProfile: false, personality: 1, memoryMode: 'none' } }, { ...seed(), connectionSettings: { fixture: () => undefined } }]) {
      await expect(invoke(DESKTOP_IPC.savePartnerProfile, value)).rejects.toThrow('INVALID_PARTNER_PROFILE');
      await expect(invoke(DESKTOP_IPC.syncPartnerProfiles, { user, partners: [value] })).rejects.toThrow('INVALID_PARTNER_PROFILE_SYNC');
    }
    await expect(invoke(DESKTOP_IPC.syncPartnerProfiles, { user: { ...user, revision: 'invalid' }, partners: [] })).rejects.toThrow('INVALID_PARTNER_PROFILE_SYNC');
    await expect(invoke(DESKTOP_IPC.trashPartnerProfile, { partnerId: '' })).rejects.toThrow('INVALID_PARTNER_PROFILE_TRASH');
    expect(trace).toEqual([]); expect(electron.trash).not.toHaveBeenCalled();
  });
});

it('syncs runtime-only seeds but persists filtered seeds, strips runtime settings and migrates only eligible API bindings', async () => {
  await withProfiles(false, async ({ root, trace, invoke, observed }) => {
    const originalCatalog = StudioRuntimeCatalog.prototype.sync, originalProfiles = PartnerProfileStore.prototype.sync;
    const catalog = vi.spyOn(StudioRuntimeCatalog.prototype, 'sync').mockImplementation(function (this: StudioRuntimeCatalog, ...args) { trace.push('catalog.sync'); return originalCatalog.apply(this, args); });
    const profiles = vi.spyOn(PartnerProfileStore.prototype, 'sync').mockImplementation(function (this: PartnerProfileStore, ...args) { trace.push('profiles.sync'); return originalProfiles.apply(this, args); });
    const migrate = vi.spyOn(ApiConnectionStore.prototype, 'migrateLegacy').mockImplementation(async id => { trace.push('migrate:' + id); });
    const mcp = vi.spyOn(McpConnectionManager.prototype, 'reconcilePartners').mockImplementation(async () => { trace.push('mcp'); });
    const diary = vi.spyOn(PartnerDiaryCatalog.prototype, 'sync').mockImplementation(() => { trace.push('diary.sync'); });
    const partners = [seed('fixture-live'), seed('fixture-transient', false), seed('fixture-offline', true, false), { ...seed('fixture-unconfigured'), connectionSettings: {} }];
    const result = await invoke<PartnerProfilesSyncResult>(DESKTOP_IPC.syncPartnerProfiles, { user, partners });
    expect(trace).toEqual(['prepare', 'catalog.sync', 'migrate:fixture-live', 'mcp', 'diary.sync', 'wake', 'profiles.sync']);
    expect(catalog).toHaveBeenCalledExactlyOnceWith(user, partners); expect(migrate).toHaveBeenCalledExactlyOnceWith('fixture-live', connection); expect(mcp).toHaveBeenCalledExactlyOnceWith(); expect(diary).toHaveBeenCalledExactlyOnceWith(partners);
    expect(result).toBe(await profiles.mock.results[0].value); expect(result.partners.map(item => item.partnerId)).toEqual(['fixture-live', 'fixture-offline', 'fixture-unconfigured']);
    for (const persisted of profiles.mock.calls[0][1]) { expect(persisted.connectionSettings).not.toHaveProperty('__studioRuntime'); expect(persisted.connectionSettings).not.toHaveProperty('__diaryRuntime'); }
    const runtime = catalog.mock.contexts[0] as StudioRuntimeCatalog; expect(runtime.partner('fixture-transient')?.available).toBe(true);
    const disk = await readFile(path.join(root, 'AsteriumData', 'partners', result.partners[0].directoryName, 'connection.json'), 'utf8'); expect(disk).not.toContain('__studioRuntime'); expect(disk).not.toContain('__diaryRuntime');
    expect(observed.inventory).not.toHaveBeenCalled(); expect(observed.fallback).not.toHaveBeenCalled(); expect(observed.recovery).not.toHaveBeenCalled(); expect(observed.tasks).not.toHaveBeenCalled();
  });
});

it('starts background services only after persistence and preserves their order and failure propagation', async () => {
  await withProfiles(true, async ({ trace, invoke, observed }) => {
    const original = PartnerProfileStore.prototype.sync;
    vi.spyOn(PartnerProfileStore.prototype, 'sync').mockImplementation(function (this: PartnerProfileStore, ...args) { trace.push('profiles.sync'); return original.apply(this, args); });
    const value = { user, partners: [] };
    await invoke(DESKTOP_IPC.syncPartnerProfiles, value);
    expect(trace).toEqual(['prepare', 'wake', 'profiles.sync', 'inventory.activate', 'fallback.start', 'diary.recover', 'diary.start', 'diary.changed', 'tasks.activate']);
    const runtime = observed.tasks.mock.calls[0][0]; expect(runtime).toBeInstanceOf(PartnerRuntimePort);
    trace.length = 0; observed.recovery.mockRejectedValueOnce(new Error('SYNTHETIC_DIARY_RECOVERY_FAILURE'));
    await expect(invoke(DESKTOP_IPC.syncPartnerProfiles, value)).rejects.toThrow('SYNTHETIC_DIARY_RECOVERY_FAILURE');
    expect(trace).toEqual(['prepare', 'wake', 'profiles.sync', 'inventory.activate', 'fallback.start']);
    expect(observed.tasks).toHaveBeenCalledTimes(1);
    await invoke(DESKTOP_IPC.syncPartnerProfiles, value); expect(observed.tasks.mock.calls[1][0]).toBe(runtime);
  });
});

it('saves before runtime changes and keeps the explicit legacy-binding replacement flag and later refreshes', async () => {
  await withProfiles(false, async ({ trace, invoke, observed }) => {
    const originalSave = PartnerProfileStore.prototype.savePartner, originalUpsert = StudioRuntimeCatalog.prototype.upsert;
    const save = vi.spyOn(PartnerProfileStore.prototype, 'savePartner').mockImplementation(function (this: PartnerProfileStore, ...args) { trace.push('profiles.save'); return originalSave.apply(this, args); });
    const upsert = vi.spyOn(StudioRuntimeCatalog.prototype, 'upsert').mockImplementation(function (this: StudioRuntimeCatalog, ...args) { trace.push('catalog.upsert'); return originalUpsert.apply(this, args); });
    const migrate = vi.spyOn(ApiConnectionStore.prototype, 'migrateLegacy').mockImplementation(async () => { trace.push('migrate'); });
    const mcp = vi.spyOn(McpConnectionManager.prototype, 'reconcilePartners').mockImplementation(async () => { trace.push('mcp'); });
    const diary = vi.spyOn(PartnerDiaryCatalog.prototype, 'upsert').mockImplementation(() => { trace.push('diary.upsert'); });
    const input = seed();
    const saved = await invoke<PartnerProfileSnapshot>(DESKTOP_IPC.savePartnerProfile, input);
    expect(saved).toBe(await save.mock.results[0].value);
    expect(trace).toEqual(['prepare', 'profiles.save', 'catalog.upsert', 'migrate', 'mcp', 'diary.upsert', 'wake', 'inventory.refresh', 'diary.changed']);
    expect(save.mock.calls[0][0].connectionSettings).not.toHaveProperty('__studioRuntime'); expect(upsert).toHaveBeenCalledExactlyOnceWith(input);
    expect(migrate).toHaveBeenCalledExactlyOnceWith(input.partnerId, connection, true); expect(mcp).toHaveBeenCalledExactlyOnceWith(input.partnerId); expect(diary).toHaveBeenCalledExactlyOnceWith(input);
    expect(observed.inventory).not.toHaveBeenCalled(); expect(observed.tasks).not.toHaveBeenCalled();
    trace.length = 0;
    await expect(invoke(DESKTOP_IPC.savePartnerProfile, { ...input, expectedRevision: 'a'.repeat(64) })).rejects.toThrow('PROFILE_VERSION_CONFLICT');
    expect(trace).toEqual(['prepare', 'profiles.save']); expect(upsert).toHaveBeenCalledTimes(1);
  });
});

it('stops on preparation and MCP failures without hiding them or continuing later coordination', async () => {
  await withProfiles(false, async ({ trace, invoke, observed }) => {
    const error = new Error('SYNTHETIC_PROFILE_COORDINATION_FAILURE');
    vi.mocked(SqliteMemoryCutover.prototype.run).mockRejectedValueOnce(error);
    await expect(invoke(DESKTOP_IPC.savePartnerProfile, seed())).rejects.toBe(error); expect(trace).toEqual([]);
    const mcp = vi.spyOn(McpConnectionManager.prototype, 'reconcilePartners').mockRejectedValueOnce(error);
    await expect(invoke(DESKTOP_IPC.savePartnerProfile, seed())).rejects.toBe(error);
    expect(mcp).toHaveBeenCalledExactlyOnceWith('fixture-partner'); expect(observed.refresh).not.toHaveBeenCalled(); expect(observed.diaryChanged).not.toHaveBeenCalled();
  });
});

it('prepares before trashing only the selected partner directory and preserves missing/error results', async () => {
  await withProfiles(false, async ({ root, trace, invoke }) => {
    const snapshot = await invoke<PartnerProfileSnapshot>(DESKTOP_IPC.savePartnerProfile, seed()); trace.length = 0;
    await expect(invoke(DESKTOP_IPC.trashPartnerProfile, { partnerId: 'fixture-absent' })).resolves.toBe(false); expect(trace).toEqual(['prepare']); expect(electron.trash).not.toHaveBeenCalled();
    const target = path.join(root, 'AsteriumData', 'partners', snapshot.directoryName), file = path.join(target, 'partner.json'), before = await readFile(file, 'utf8');
    const error = new Error('SYNTHETIC_TRASH_FAILURE'); electron.trash.mockRejectedValueOnce(error);
    await expect(invoke(DESKTOP_IPC.trashPartnerProfile, { partnerId: snapshot.partnerId })).rejects.toBe(error); expect(electron.trash).toHaveBeenCalledExactlyOnceWith(target); await expect(readFile(file, 'utf8')).resolves.toBe(before);
    await expect(invoke(DESKTOP_IPC.trashPartnerProfile, { partnerId: snapshot.partnerId })).resolves.toBe(true); expect(electron.trash).toHaveBeenLastCalledWith(target);
  });
});
