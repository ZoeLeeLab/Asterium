// @vitest-environment node
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { ProjectWorkRoleCatalog, ProjectWorkRoleDefinition } from '../../src/shared/projectRoles';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.root,
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

it('keeps the project role IPC contract from registration through cleanup', async () => {
  const { registerAgentIpc } = await import('../../src/main/agentIpc');
  electron.root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-role-ipc-'));
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: typeof sender }, value: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const invoke = async <T = unknown>(channel: string, value: unknown, caller = sender): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Unregistered IPC channel: ${channel}`);
    return await handler({ sender: caller }, value) as T;
  };
  const channels = {
    list: 'asterium:project-role:list',
    create: 'asterium:project-role:create',
    update: 'asterium:project-role:update',
    archive: 'asterium:project-role:archive',
    remove: 'asterium:project-role:remove',
  };
  const changed = 'asterium:project-roles:changed';
  const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
    profile: 'autotest', label: 'Fixture', userDataDirectory: electron.root,
    projectsDirectory: path.join(electron.root, 'projects'), temporaryDirectory: electron.root,
    appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
    restoreBackgroundServices: false, mcpPort: 0,
  } });
  try {
    expect([...handlers.keys()].filter((channel) => channel.startsWith('asterium:project-role:')).sort())
      .toEqual(Object.values(channels).sort());
    const foreign = { send: vi.fn() };
    for (const [channel, value, error] of [
      [channels.list, null, 'INVALID_PROJECT_ROLE_QUERY'],
      [channels.create, { scope: 'builtin' }, 'INVALID_PROJECT_ROLE_CREATE'],
      [channels.update, { roleId: 1 }, 'INVALID_PROJECT_ROLE_UPDATE'],
      [channels.archive, { roleId: 'fixture-role', archived: 'true' }, 'INVALID_PROJECT_ROLE_ARCHIVE'],
      [channels.remove, [], 'INVALID_PROJECT_ROLE_REMOVE'],
    ] as const) {
      await expect(invoke(channel, value, foreign)).rejects.toThrow('INVALID_IPC_SENDER');
      await expect(invoke(channel, value)).rejects.toThrow(error);
    }

    const projectId = 'fixture-project';
    await expect(invoke(channels.list, projectId)).rejects.toThrow('PROJECT_NOT_FOUND');
    await invoke(DESKTOP_IPC.projectDomainInitialize, { legacyProjects: [{ id: projectId, name: '合成项目' }] });
    const catalog = await invoke<ProjectWorkRoleCatalog>(channels.list, projectId);
    expect(catalog).toMatchObject({ version: 1, projectId, roles: expect.arrayContaining([expect.objectContaining({ scope: 'builtin' })]) });

    const fields = { name: '合成角色', responsibilities: ['复核测试资料'] };
    const role = await invoke<ProjectWorkRoleDefinition>(channels.create, { scope: 'project', projectId, ...fields });
    expect(role).toMatchObject({ ...fields, scope: 'project', projectId, id: expect.any(String), revision: 1 });
    const roleId = role.id;
    const updated = await invoke<ProjectWorkRoleDefinition>(channels.update, { ...fields, roleId, expectedRevision: 1, name: '合成角色更新' });
    expect(updated).toMatchObject({ id: roleId, name: '合成角色更新', revision: 2 });
    const archived = await invoke<ProjectWorkRoleDefinition>(channels.archive, { roleId, expectedRevision: 2, archived: true });
    expect(archived).toMatchObject({ id: roleId, name: updated.name, revision: 3, archivedAt: expect.any(String) });
    await expect(invoke(channels.list, projectId)).resolves.toEqual({ ...catalog, roles: [...catalog.roles, archived] });
    await expect(invoke(channels.remove, { roleId, expectedRevision: 2 })).rejects.toThrow('PROJECT_WORK_ROLE_REVISION_CONFLICT');
    await expect(invoke(channels.remove, { roleId, expectedRevision: 3 })).resolves.toBeUndefined();
    await expect(invoke(channels.list, projectId)).resolves.toEqual(catalog);

    const notifications = sender.send.mock.calls.filter(([channel]) => channel === changed);
    expect(notifications).toHaveLength(4);
    for (const notification of notifications) {
      expect(notification).toEqual([changed, { type: 'changed', scope: 'project', projectId }]);
    }
  } finally {
    try {
      await dispose();
      expect(handlers.size).toBe(0);
    } finally {
      await testRm(electron.root, { recursive: true, force: true });
    }
  }
});
