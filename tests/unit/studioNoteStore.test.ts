import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioNoteStore } from '../../src/main/studio/StudioNoteStore';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('StudioNoteStore', () => {
  it('persists project-scoped notes through complete, archive, restore, edit, and delete', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-notes-'));
    temporary.push(directory);
    const file = path.join(directory, 'notes.json');
    const store = new StudioNoteStore(file);
    const first = await store.save({ projectId: 'project-a', content: '修复群聊附件' });
    await store.save({ projectId: 'project-b', content: '另一个项目' });

    expect(await store.list('project-a')).toEqual([expect.objectContaining({ id: first.id, status: 'open' })]);
    expect(await store.setStatus(first.id, 'completed')).toMatchObject({ status: 'completed', completedAt: expect.any(String) });
    const archived = await store.setStatus(first.id, 'archived');
    expect(archived).toMatchObject({ status: 'archived', archivedAt: expect.any(String) });
    expect(archived).not.toHaveProperty('completedAt');
    const restored = await store.setStatus(first.id, 'open');
    expect(restored).toMatchObject({ status: 'open' });
    expect(restored).not.toHaveProperty('archivedAt');
    expect(await store.save({ id: first.id, projectId: 'project-a', content: '修复群聊附件上传' })).toMatchObject({ content: '修复群聊附件上传' });

    const restarted = new StudioNoteStore(file);
    expect(await restarted.list('project-a')).toHaveLength(1);
    await restarted.remove(first.id);
    expect(await restarted.list('project-a')).toEqual([]);
    expect(await restarted.list('project-b')).toHaveLength(1);
  });

  it('removes every note for a deleted project without touching other projects', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-notes-project-'));
    temporary.push(directory);
    const store = new StudioNoteStore(path.join(directory, 'notes.json'));
    await store.save({ projectId: 'project-a', content: '第一条' });
    await store.save({ projectId: 'project-a', content: '第二条' });
    await store.save({ projectId: 'project-b', content: '保留这一条' });

    await store.removeProject('project-a');

    expect(await store.list('project-a')).toEqual([]);
    expect(await store.list('project-b')).toEqual([expect.objectContaining({ content: '保留这一条' })]);
  });
});
