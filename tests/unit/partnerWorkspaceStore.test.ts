import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationWorkspaceStore } from '../../src/main/security/ConversationWorkspaceStore';
import { PartnerWorkspaceStore } from '../../src/main/security/PartnerWorkspaceStore';
import { WorkspaceGrantStore } from '../../src/main/security/WorkspaceGrantStore';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-partner-workspaces-'));
  temporaryDirectories.push(root);
  const cwd = path.join(root, 'cwd');
  const extraA = path.join(root, 'extra-a');
  const extraB = path.join(root, 'extra-b');
  await Promise.all([cwd, extraA, extraB].map((directory) => import('node:fs/promises').then(({ mkdir }) => mkdir(directory))));
  const grants = new WorkspaceGrantStore(path.join(root, 'workspace-grants.v1.json'));
  const [cwdGrant, extraAGrant, extraBGrant] = await Promise.all([grants.add(cwd), grants.add(extraA), grants.add(extraB)]);
  const store = new PartnerWorkspaceStore(path.join(root, 'conversation-workspaces.v1.json'), grants);
  return { root, cwd, extraA, extraB, cwdGrant, extraAGrant, extraBGrant, grants, store };
}

describe('PartnerWorkspaceStore', () => {
  it('keeps the old class export as a compatibility alias', () => {
    expect(ConversationWorkspaceStore).toBe(PartnerWorkspaceStore);
  });

  it('keeps the existing filename and version 2 partner schema unchanged', async () => {
    const fixture = await setup();
    await fixture.store.ensure('partner-a', fixture.cwdGrant.grantId, [fixture.extraAGrant.grantId]);

    const persisted = JSON.parse(await readFile(path.join(fixture.root, 'conversation-workspaces.v1.json'), 'utf8')) as {
      version: number;
      partners: Record<string, { partnerId: string; cwdGrantId?: string; manualWorkspaceGrantIds: string[] }>;
    };
    expect(persisted).toMatchObject({
      version: 2,
      partners: {
        'partner-a': {
          partnerId: 'partner-a',
          cwdGrantId: fixture.cwdGrant.grantId,
          manualWorkspaceGrantIds: [fixture.extraAGrant.grantId],
        },
      },
    });
  });

  it('shares one cwd and one grant set across all conversations of a partner', async () => {
    const fixture = await setup();
    await fixture.store.ensure('partner-a', fixture.cwdGrant.grantId, [fixture.extraAGrant.grantId]);
    await fixture.store.ensure('partner-a', fixture.cwdGrant.grantId, [fixture.extraBGrant.grantId]);

    expect(await fixture.store.grantIds('partner-a')).toEqual({ cwdGrantId: fixture.cwdGrant.grantId, workspaceGrantIds: [fixture.extraAGrant.grantId] });
    expect(await fixture.store.snapshot('partner-a', 'manual')).toMatchObject({
      cwd: fixture.cwd,
      workspaceFolders: [fixture.cwd, fixture.extraA],
      permissionMode: 'manual',
      managementTool: { name: 'asterium_workspace', actions: ['list', 'add', 'remove'] },
    });

    await fixture.store.add('partner-a', fixture.extraB, 'manual');
    expect((await fixture.store.snapshot('partner-a', 'manual')).workspaceFolders).toEqual([fixture.cwd, fixture.extraA, fixture.extraB]);
  });

  it('denies mutations in read-only mode and never permits cwd removal', async () => {
    const fixture = await setup();
    await fixture.store.ensure('partner-a', fixture.cwdGrant.grantId, [fixture.extraAGrant.grantId]);

    await expect(fixture.store.add('partner-a', fixture.extraB, 'read_only')).rejects.toThrow('ASTERIUM_READ_ONLY');
    await expect(fixture.store.remove('partner-a', fixture.extraA, 'read_only')).rejects.toThrow('ASTERIUM_READ_ONLY');
    await expect(fixture.store.remove('partner-a', fixture.cwd, 'manual')).rejects.toThrow('WORKSPACE_CWD_IMMUTABLE');
    await expect(fixture.store.add('partner-a', 'relative/folder', 'manual')).rejects.toThrow('WORKSPACE_PATH_MUST_BE_ABSOLUTE');
  });

  it('only detaches metadata when removing a workspace or partner', async () => {
    const fixture = await setup();
    const marker = path.join(fixture.extraA, 'user-file.txt');
    await writeFile(marker, 'must survive', 'utf8');
    await fixture.store.ensure('partner-a', fixture.cwdGrant.grantId, [fixture.extraAGrant.grantId]);

    const detached = await fixture.store.remove('partner-a', fixture.extraA, 'manual');
    expect(detached.workspaceFolders).toEqual([fixture.cwd]);
    expect(await readFile(marker, 'utf8')).toBe('must survive');

    await fixture.store.deletePartner('partner-a');
    expect(await fixture.store.grantIds('partner-a')).toBeUndefined();
    expect(await readFile(marker, 'utf8')).toBe('must survive');
  });

  it('publishes the authoritative grant snapshot and rejects stale settings writes', async () => {
    const fixture = await setup();
    const observed: unknown[] = [];
    const unsubscribe = fixture.store.subscribe((state) => observed.push(state));
    await fixture.store.ensure('partner-a', fixture.cwdGrant.grantId, [fixture.extraAGrant.grantId]);

    expect(await fixture.store.configuredState('partner-a')).toMatchObject({
      partnerId: 'partner-a',
      cwd: { grantId: fixture.cwdGrant.grantId, displayPath: fixture.cwd },
      workspaces: [{ grantId: fixture.extraAGrant.grantId, displayPath: fixture.extraA }],
      version: 1,
    });

    await fixture.store.add('partner-a', fixture.extraB, 'manual');
    await expect(fixture.store.sync('partner-a', fixture.cwdGrant.grantId, [], 1)).rejects.toThrow('PARTNER_WORKSPACE_VERSION_CONFLICT');
    expect((await fixture.store.configuredState('partner-a')).workspaces.map((grant) => grant.displayPath)).toEqual([fixture.extraA, fixture.extraB]);
    expect(observed).toHaveLength(2);
    unsubscribe();
  });

  it('refuses the protected profile root and any parent that would expose it', async () => {
    const fixture = await setup();
    const protectedRoot = path.join(fixture.root, 'app-data', 'AsteriumData');
    await mkdir(protectedRoot, { recursive: true });
    const grant = await new WorkspaceGrantStore(path.join(fixture.root, 'protected-grants.json')).add(protectedRoot);
    const store = new PartnerWorkspaceStore(path.join(fixture.root, 'protected-workspaces.json'), new WorkspaceGrantStore(path.join(fixture.root, 'protected-grants.json')), [protectedRoot]);
    await expect(store.ensure('partner-a', grant.grantId, [])).rejects.toThrow('PROFILE_DATA_ACCESS_DENIED');
    await fixture.store.ensure('partner-a', fixture.cwdGrant.grantId, []);
    const protectedStore = new PartnerWorkspaceStore(path.join(fixture.root, 'conversation-workspaces.v1.json'), new WorkspaceGrantStore(path.join(fixture.root, 'workspace-grants.v1.json')), [protectedRoot]);
    await expect(protectedStore.add('partner-a', path.dirname(protectedRoot), 'manual')).rejects.toThrow('PROFILE_DATA_ACCESS_DENIED');
  });

  it('adds and revokes project-sourced workspaces without removing a same-path manual grant', async () => {
    const fixture = await setup();
    await fixture.store.ensure('partner-a', fixture.cwdGrant.grantId, [fixture.extraBGrant.grantId]);
    await fixture.store.reconcileProjects([{ projectId: 'project-a', rootPath: fixture.extraB, partnerIds: ['partner-a'] }]);

    expect(await fixture.store.configuredState('partner-a')).toMatchObject({
      workspaces: expect.arrayContaining([
        expect.objectContaining({ displayPath: fixture.extraB, source: 'manual' }),
        expect.objectContaining({ displayPath: fixture.extraB, source: 'project', projectId: 'project-a' }),
      ]),
    });
    await expect(fixture.store.remove('partner-a', fixture.extraB, 'manual')).rejects.toThrow('PROJECT_WORKSPACE_MANAGED');
    await fixture.store.sync('partner-a', fixture.cwdGrant.grantId, [fixture.extraBGrant.grantId]);

    await fixture.store.reconcileProjects([]);
    const state = await fixture.store.configuredState('partner-a');
    expect(state.workspaces).toEqual([expect.objectContaining({ displayPath: fixture.extraB, source: 'manual' })]);
    expect((await fixture.store.snapshot('partner-a', 'manual')).workspaceFolders).toContain(fixture.extraB);
  });

  it('revokes a project-only workspace when the partner leaves the project', async () => {
    const fixture = await setup();
    await fixture.store.ensure('partner-a', fixture.cwdGrant.grantId, []);
    await fixture.store.reconcileProjects([{ projectId: 'project-a', rootPath: fixture.extraA, partnerIds: ['partner-a'] }]);
    expect((await fixture.store.configuredState('partner-a')).workspaces).toEqual([
      expect.objectContaining({ displayPath: fixture.extraA, source: 'project', projectId: 'project-a' }),
    ]);

    await fixture.store.reconcileProjects([{ projectId: 'project-a', rootPath: fixture.extraA, partnerIds: [] }]);
    expect((await fixture.store.configuredState('partner-a')).workspaces).toEqual([]);
  });

  it('removes newly-created grants when a multi-partner project authorization fails', async () => {
    const fixture = await setup();
    await fixture.store.ensure('partner-a', fixture.cwdGrant.grantId, []);
    await fixture.store.ensure('partner-b', fixture.cwdGrant.grantId, []);
    const add = fixture.grants.add.bind(fixture.grants);
    let createdGrantId = '';
    vi.spyOn(fixture.grants, 'add')
      .mockImplementationOnce(async (rootPath) => {
        const grant = await add(rootPath);
        createdGrantId = grant.grantId;
        return grant;
      })
      .mockRejectedValueOnce(new Error('GRANT_WRITE_FAILED'));

    await expect(fixture.store.reconcileProject({
      projectId: 'project-a', rootPath: fixture.extraA, partnerIds: ['partner-a', 'partner-b'],
    })).rejects.toThrow('GRANT_WRITE_FAILED');

    expect(createdGrantId).not.toBe('');
    expect(await fixture.grants.get(createdGrantId)).toBeUndefined();
    expect(await fixture.store.projectPartnerIds('project-a')).toEqual([]);
  });
});
