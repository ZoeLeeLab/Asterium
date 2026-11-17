// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMain } from 'electron';
import { expect, it, vi } from 'vitest';
import { registerAgentIpc } from '../../src/main/agentIpc';
import { StudioMcpAccessStore } from '../../src/main/studio/StudioMcpAccessStore';
import { StudioWakeControlService } from '../../src/main/studio/StudioWakeControlService';
import type { PartnerProfileSeed } from '../../src/shared/agentProtocol';
import { DESKTOP_IPC } from '../../src/shared/desktopIpc';
import type { AsteriumStudioMcpApi, StudioMcpStatus } from '../../src/shared/studioMcp';
import { testRm } from '../helpers/autoTest.mjs';

const electron = vi.hoisted(() => ({ userData: '', writeText: vi.fn<(text: string) => void>() }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.userData, getAppPath: () => process.cwd(), isPackaged: false, whenReady: async () => undefined },
  BrowserWindow: class {},
  clipboard: { writeText: electron.writeText },
  dialog: {},
  safeStorage: {},
  shell: {},
}));

const issue = 'asterium:studio-mcp:issue-credential';
const copy = 'asterium:studio-mcp:copy-credential';
const revoke = 'asterium:studio-mcp:revoke-credential';
type IssuedCredential = Awaited<ReturnType<AsteriumStudioMcpApi['issueCredential']>>;

it('only issues to existing-thread partners, validates copying, and revokes authentication without revealing secrets in status', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-mcp-credential-ipc-'));
  electron.userData = root;
  const accessFile = path.join(root, 'studio-mcp-access.v1.json');
  const access = new StudioMcpAccessStore(accessFile, 0, true);
  const sender = { send: vi.fn() };
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
  type Handler = (event: { sender: object }, value: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (name: string, handler: Handler) => {
      if (handlers.has(name)) throw new Error(`Duplicate IPC channel: ${name}`);
      handlers.set(name, handler);
    },
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as IpcMain;
  const invoke = async <T,>(channel: string, value?: unknown, caller: object = sender) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC channel: ${channel}`);
    return await handler({ sender: caller }, value) as T;
  };
  try {
    const dispose = registerAgentIpc(ipcMain, () => window, { environment: {
      profile: 'autotest', label: 'Fixture', userDataDirectory: root,
      projectsDirectory: path.join(root, 'projects'), temporaryDirectory: root,
      appUserModelId: 'Asterium.Test', allowStartup: false, allowUpdates: false,
      restoreBackgroundServices: false, mcpPort: 0,
    } });
    try {
      const partner: PartnerProfileSeed = {
        partnerId: 'fixture-existing-partner', sourceMode: 'existing_thread',
        publicIdentity: { displayName: '合成伙伴', mentionName: '合成伙伴', introduction: '', expertise: '' },
        management: { memoryMode: 'none', personality: false, userProfile: false }, connectionSettings: {},
      };
      const local: PartnerProfileSeed = { ...partner, partnerId: 'fixture-local-partner', sourceMode: 'local_cli' };
      await invoke(DESKTOP_IPC.syncPartnerProfiles, {
        user: { displayName: '合成用户', introduction: '', updatedAt: '' }, partners: [partner, local],
      });
      await invoke(DESKTOP_IPC.studioMcpStatus);
      const running = await invoke<StudioMcpStatus>(DESKTOP_IPC.studioMcpConfigure, { enabled: true, port: 0, publicOrigin: '' });
      const notifyWake = vi.spyOn(StudioWakeControlService.prototype, 'changed');
      const before = await readFile(accessFile);

      for (const channel of [issue, copy, revoke]) {
        await expect(invoke(channel, null, {})).rejects.toThrow('INVALID_IPC_SENDER');
      }
      for (const ineligible of [1, 'fixture-missing-partner', local.partnerId]) {
        await expect(invoke(issue, ineligible)).rejects.toThrow('STUDIO_MCP_PARTNER_REQUIRED');
      }
      await expect(invoke(copy, 'malformed-fixture')).rejects.toThrow('STUDIO_MCP_CREDENTIAL_INVALID');
      await expect(invoke(revoke, null)).rejects.toThrow('STUDIO_MCP_CREDENTIAL_NOT_FOUND');
      await expect(invoke(revoke, 'fixture-missing-credential')).rejects.toThrow('STUDIO_MCP_CREDENTIAL_NOT_FOUND');
      expect(electron.writeText).not.toHaveBeenCalled();
      expect(notifyWake).not.toHaveBeenCalled();
      await expect(readFile(accessFile)).resolves.toEqual(before);

      const first = await invoke<IssuedCredential>(issue, partner.partnerId);
      const second = await invoke<IssuedCredential>(issue, partner.partnerId);
      expect(first).toEqual({
        credential: { credentialId: expect.any(String), partnerId: partner.partnerId, createdAt: expect.any(String) },
        token: expect.stringMatching(/^asterium_[A-Za-z0-9_-]{43}$/u),
      });
      expect(second.token).not.toBe(first.token);
      expect(notifyWake).toHaveBeenCalledTimes(2);
      await expect(invoke(DESKTOP_IPC.studioMcpStatus)).resolves.toEqual({
        ...running, credentials: [first.credential, second.credential],
      });
      await expect(access.authenticate(first.token)).resolves.toEqual(first.credential);
      const saved = await readFile(accessFile, 'utf8');
      expect(saved).not.toContain(first.token);
      expect(saved).not.toContain(second.token);
      expect(JSON.parse(saved).credentials).toEqual([first, second].map(({ credential, token }) => ({
        ...credential, tokenHash: createHash('sha256').update(token).digest('hex'),
      })));

      await expect(invoke(copy, first.token)).resolves.toBeUndefined();
      expect(electron.writeText).toHaveBeenCalledExactlyOnceWith(first.token);
      await expect(readFile(accessFile, 'utf8')).resolves.toBe(saved);
      const revoked = await invoke<StudioMcpStatus>(revoke, first.credential.credentialId);
      expect(revoked).toEqual({
        ...running, credentials: [{ ...first.credential, revokedAt: expect.any(String) }, second.credential],
      });
      await expect(access.authenticate(first.token)).rejects.toThrow('STUDIO_MCP_UNAUTHORIZED');
      await expect(access.authenticate(second.token)).resolves.toEqual(second.credential);
      expect(notifyWake).toHaveBeenCalledTimes(2);
    } finally {
      await dispose();
    }
    expect(handlers.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await testRm(root, { recursive: true, force: true });
  }
});
