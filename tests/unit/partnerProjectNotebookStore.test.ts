import { testRm as rm } from '../helpers/autoTest.mjs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PartnerProjectNotebookStore } from '../../src/main/notebook/PartnerProjectNotebookStore';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(partnerId = 'partner-a') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-notebook-'));
  temporaryDirectories.push(root);
  let tick = 0;
  const store = new PartnerProjectNotebookStore(root, partnerId, {
    now: () => `2026-10-18T00:00:0${tick++}.000Z`,
  });
  return { root, store };
}

describe('PartnerProjectNotebookStore', () => {
  it('creates, appends, replaces with the latest revision, and survives restart', async () => {
    const value = await fixture();
    const created = await value.store.append({ projectId: 'project-a', projectName: '星丛', content: '# 工作笔记' });
    expect(created).toMatchObject({ partnerId: 'partner-a', projectId: 'project-a', state: 'active', revision: 1, content: '# 工作笔记' });

    const appended = await value.store.append({ projectId: 'project-a', projectName: '星丛', content: '第二段' });
    expect(appended).toMatchObject({ revision: 2, content: '# 工作笔记\n\n第二段' });
    await expect(value.store.replace({ projectId: 'project-a', projectName: '星丛', content: '过期覆盖', expectedRevision: 1 })).rejects.toThrow('PROJECT_NOTEBOOK_REVISION_CONFLICT');

    const replaced = await value.store.replace({ projectId: 'project-a', projectName: '星丛', content: '整理后的正文', expectedRevision: 2 });
    expect(replaced).toMatchObject({ revision: 3, content: '整理后的正文' });
    await expect(new PartnerProjectNotebookStore(value.root, 'partner-a').get('project-a')).resolves.toEqual(replaced);
  });

  it('keeps partners and projects isolated', async () => {
    const value = await fixture('partner-a');
    const otherPartner = new PartnerProjectNotebookStore(value.root, 'partner-b');
    await value.store.append({ projectId: 'project-a', projectName: '项目 A', content: 'A 的私有内容' });
    await value.store.append({ projectId: 'project-b', projectName: '项目 B', content: 'B 的内容' });

    await expect(value.store.get('project-a')).resolves.toMatchObject({ content: 'A 的私有内容' });
    await expect(value.store.get('project-b')).resolves.toMatchObject({ content: 'B 的内容' });
    await expect(otherPartner.list()).rejects.toThrow('PROJECT_NOTEBOOK_OWNER_INVALID');
  });

  it('detects direct Markdown edits and advances the revision before accepting writes', async () => {
    const value = await fixture();
    const created = await value.store.append({ projectId: 'project-a', projectName: '星丛', content: '原内容' });
    const fileName = `${createHash('sha256').update('project-a').digest('hex')}.md`;
    const target = path.join(value.root, 'project-notebooks-v1', fileName);
    await writeFile(target, '用户直接编辑的内容', 'utf8');

    const refreshed = await value.store.get('project-a');
    expect(refreshed).toMatchObject({ revision: created.revision + 1, content: '用户直接编辑的内容' });
    await expect(value.store.replace({ projectId: 'project-a', projectName: '星丛', content: '旧版本覆盖', expectedRevision: created.revision })).rejects.toThrow('PROJECT_NOTEBOOK_REVISION_CONFLICT');
    expect(await readFile(target, 'utf8')).toBe('用户直接编辑的内容');
  });

  it('serializes concurrent appends without dropping either block', async () => {
    const value = await fixture();
    await Promise.all([
      value.store.append({ projectId: 'project-a', projectName: '星丛', content: '第一段' }),
      value.store.append({ projectId: 'project-a', projectName: '星丛', content: '第二段' }),
    ]);
    expect((await value.store.get('project-a'))?.content).toBe('第一段\n\n第二段');
  });

  it('rejects malformed metadata, missing content, invalid revisions, and oversized content', async () => {
    const value = await fixture();
    expect(() => value.store.replace({ projectId: 'project-a', projectName: '星丛', content: '', expectedRevision: -1 })).toThrow('PROJECT_NOTEBOOK_REVISION_INVALID');
    expect(() => value.store.append({ projectId: 'project-a', projectName: '星丛', content: 'x'.repeat(200_001) })).toThrow('PROJECT_NOTEBOOK_CONTENT_INVALID');
    await value.store.append({ projectId: 'project-a', projectName: '星丛', content: '内容' });
    const indexPath = path.join(value.root, 'project-notebooks-v1', 'index.json');
    await writeFile(indexPath, '{}', 'utf8');
    await expect(value.store.list()).rejects.toThrow('PROJECT_NOTEBOOK_INDEX_INVALID');
  });
});
