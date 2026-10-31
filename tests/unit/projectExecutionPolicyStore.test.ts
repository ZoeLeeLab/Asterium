import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectExecutionPolicyStore } from '../../src/main/project/ProjectExecutionPolicyStore';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function storePath() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-policy-'));
  temporary.push(directory);
  return path.join(directory, 'project-execution-policies.v1.json');
}

describe('ProjectExecutionPolicyStore', () => {
  it('creates one manual policy per project, persists updates, and publishes changes', async () => {
    const filePath = await storePath();
    const store = new ProjectExecutionPolicyStore(filePath);
    const listener = vi.fn();
    store.subscribe(listener);

    await expect(store.getOrCreate('project-one')).resolves.toMatchObject({ projectId: 'project-one', permissionMode: 'manual' });
    await expect(store.update('project-one', 'full')).resolves.toMatchObject({ projectId: 'project-one', permissionMode: 'full' });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-one', permissionMode: 'full' }));

    const restarted = new ProjectExecutionPolicyStore(filePath);
    await expect(restarted.getOrCreate('project-one')).resolves.toMatchObject({ permissionMode: 'full' });
    expect(JSON.parse(await readFile(filePath, 'utf8')).policies).toHaveLength(1);
  });

  it('normalizes obsolete automatic project policies to manual and rejects automatic updates', async () => {
    const filePath = await storePath();
    await writeFile(filePath, JSON.stringify({
      version: 1,
      policies: [{ version: 1, projectId: 'project-old', permissionMode: 'automatic', updatedAt: '2026-10-15T00:00:00.000Z' }],
    }), 'utf8');
    const store = new ProjectExecutionPolicyStore(filePath);

    await expect(store.getOrCreate('project-old')).resolves.toMatchObject({ permissionMode: 'manual' });
    expect(() => store.update('project-old', 'automatic' as never)).toThrow('INVALID_PROJECT_PERMISSION_MODE');
  });
});
