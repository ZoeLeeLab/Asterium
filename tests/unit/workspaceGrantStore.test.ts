import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceGrantStore } from '../../src/main/security/WorkspaceGrantStore';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('WorkspaceGrantStore', () => {
  it('restores an explicitly selected directory across store instances', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-workspace-'));
    directories.push(directory);
    const file = path.join(directory, 'user-data', 'workspace-grants.v1.json');
    const first = new WorkspaceGrantStore(file);
    const grant = await first.add(directory);
    const restored = new WorkspaceGrantStore(file);

    expect(await restored.get(grant.grantId)).toBe(path.resolve(directory));
    expect(await readFile(file, 'utf8')).toContain(grant.grantId);
    await restored.deleteMany([grant.grantId]);
    expect(await restored.get(grant.grantId)).toBeUndefined();
  });

  it('refuses to restore a directory that no longer exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-workspace-missing-'));
    directories.push(root);
    const directory = path.join(root, 'selected');
    await mkdir(directory);
    const file = path.join(root, 'workspace-grants.v1.json');
    const store = new WorkspaceGrantStore(file);
    const grant = await store.add(directory);
    await rm(directory, { recursive: true, force: true });
    expect(await new WorkspaceGrantStore(file).get(grant.grantId)).toBeUndefined();
  });
});
