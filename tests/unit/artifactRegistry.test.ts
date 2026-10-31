import { mkdtemp, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactRegistry } from '../../src/main/security/ArtifactRegistry';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ArtifactRegistry', () => {
  it('allows startup refreshes to probe stale renderer records without throwing', async () => {
    const registry = new ArtifactRegistry();
    await expect(registry.inspectIfRegistered('stale-artifact-id')).resolves.toBeUndefined();
    await expect(registry.inspect('stale-artifact-id')).rejects.toThrow('ARTIFACT_NOT_REGISTERED');
  });

  it('reads local files outside workspaces and restores opaque references', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-artifact-'));
    temporaryDirectories.push(root);
    const file = path.join(root, 'result.md');
    const store = path.join(root, '.state', 'artifacts.json');
    await writeFile(file, '# 交付\n\n完成。', 'utf8');
    const registry = new ArtifactRegistry(store);
    const info = await registry.register({ kind: 'local_path', path: file }, { id: 'artifact-1', method: 'automatic' });
    expect(info.previewKind).toBe('markdown');
    expect((await registry.read('artifact-1')).text).toContain('# 交付');
    const restored = new ArtifactRegistry(store);
    expect((await restored.inspect('artifact-1')).name).toBe('result.md');
  });

  it('deduplicates the same available local file within one run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-artifact-dedupe-'));
    temporaryDirectories.push(root);
    const file = path.join(root, 'final.md');
    await writeFile(file, '# final', 'utf8');
    const registry = new ArtifactRegistry({ storePath: path.join(root, '.state', 'artifacts.json') });

    const automatic = await registry.register({ kind: 'local_path', path: file }, { id: 'automatic-file', runId: 'run-1', conversationId: 'conversation-1', method: 'automatic' });
    const explicit = await registry.register({ kind: 'local_path', path: file }, { id: 'explicit-delivery', runId: 'run-1', conversationId: 'conversation-1', method: 'deliver_tool' });
    const nextRun = await registry.register({ kind: 'local_path', path: file }, { id: 'next-run-delivery', runId: 'run-2', conversationId: 'conversation-1', method: 'deliver_tool' });

    expect(explicit.id).toBe(automatic.id);
    expect(nextRun.id).toBe('next-run-delivery');
    expect(await registry.listConversation('conversation-1')).toHaveLength(2);
  });

  it('keeps delivery history when the original local file moves', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-grant-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'asterium-outside-'));
    temporaryDirectories.push(root, outside);
    const file = path.join(outside, 'secret.txt');
    await writeFile(file, 'nope', 'utf8');
    const registry = new ArtifactRegistry({ storePath: path.join(root, 'artifacts.json') });
    await registry.register({ kind: 'local_path', path: file }, { id: 'artifact-2', method: 'manual' });
    await rename(file, `${file}.moved`);
    expect((await registry.inspect('artifact-2')).availability).toBe('missing');
    await expect(registry.read('artifact-2')).rejects.toThrow('ARTIFACT_SOURCE_MISSING');
    await rename(`${file}.moved`, file);
    expect((await registry.inspect('artifact-2')).availability).toBe('available');
    expect((await registry.read('artifact-2')).text).toBe('nope');
  });

  it('tombstones an explicitly removed artifact while preserving its delivery provenance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-artifact-delete-'));
    temporaryDirectories.push(root);
    const file = path.join(root, 'result.txt');
    const store = path.join(root, 'artifacts.json');
    await writeFile(file, 'result', 'utf8');
    const registry = new ArtifactRegistry({ storePath: store });
    await registry.register({ kind: 'local_path', path: file }, { id: 'artifact-delete', conversationId: 'conversation-a', method: 'deliver_tool' });
    await registry.recordProjectDelivery('artifact-delete', {
      projectId: 'project-a', relativePath: 'result.txt', contentHash: 'hash', sizeBytes: 6,
      savedAt: '2026-10-17T00:00:00.000Z',
    });

    await registry.markRemoved('artifact-delete', '2026-10-17T01:00:00.000Z');
    expect(await registry.listConversation('conversation-a')).toEqual([]);
    await expect(registry.inspect('artifact-delete')).rejects.toThrow('ARTIFACT_NOT_REGISTERED');
    expect(await registry.allProjectDeliveries()).toContainEqual(expect.objectContaining({ artifactId: 'artifact-delete', projectId: 'project-a' }));

    const restarted = new ArtifactRegistry({ storePath: store });
    expect(await restarted.listConversation('conversation-a')).toEqual([]);
    expect(await restarted.allProjectDeliveries()).toContainEqual(expect.objectContaining({ artifactId: 'artifact-delete', projectId: 'project-a' }));
  });

  it.runIf(process.platform === 'win32')('normalizes Git Bash paths reported by local partners before checking delivery availability', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-artifact-git-bash-'));
    temporaryDirectories.push(root);
    const file = path.join(root, 'result.txt');
    await writeFile(file, 'normalized', 'utf8');
    const gitBashPath = file.replace(/^([A-Za-z]):\\/, '/$1/').replaceAll('\\', '/');
    const registry = new ArtifactRegistry({ storePath: path.join(root, 'artifacts.json') });

    const info = await registry.register({ kind: 'local_path', path: gitBashPath }, { id: 'git-bash-delivery', method: 'automatic' });

    expect(info.availability).toBe('available');
    expect((await registry.read('git-bash-delivery')).text).toBe('normalized');
  });

  it('migrates v1 records without changing their artifact ids', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-v1-'));
    temporaryDirectories.push(root);
    const file = path.join(root, 'legacy.txt');
    const store = path.join(root, 'artifacts.v1.json');
    await writeFile(file, 'legacy', 'utf8');
    await writeFile(store, JSON.stringify({ version: 1, items: [{ id: 'legacy-id', name: 'legacy.txt', extension: '.txt', mediaType: 'text/plain', sizeBytes: 6, previewKind: 'text', absolutePath: file, roots: [root] }] }), 'utf8');
    const registry = new ArtifactRegistry(store);
    expect((await registry.inspect('legacy-id')).sourceKind).toBe('local_path');
    expect((await registry.read('legacy-id')).text).toBe('legacy');
  });

  it('caches inline content once while preserving separate delivery records', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-content-'));
    temporaryDirectories.push(root);
    const registry = new ArtifactRegistry({ storePath: path.join(root, 'artifacts.json'), cacheDirectory: path.join(root, 'cache') });
    const value = Buffer.from('same-content').toString('base64');
    await registry.register({ kind: 'content', transport: 'base64', value }, { id: 'content-a', name: 'a.txt', mediaType: 'text/plain', method: 'message_image' });
    await registry.register({ kind: 'content', transport: 'base64', value }, { id: 'content-b', name: 'b.txt', mediaType: 'text/plain', method: 'deliver_tool' });
    expect((await registry.cacheStats()).itemCount).toBe(1);
    expect((await registry.inspect('content-a')).name).toBe('a.txt');
    expect((await registry.inspect('content-b')).name).toBe('b.txt');
    expect(await readFile(path.join(root, 'artifacts.json'), 'utf8')).not.toContain(value);
  });

  it('accepts in-memory bytes and materializes them from the shared cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-bytes-'));
    temporaryDirectories.push(root);
    const registry = new ArtifactRegistry({ storePath: path.join(root, 'artifacts.json'), cacheDirectory: path.join(root, 'cache') });
    await registry.register({ kind: 'content', transport: 'bytes', value: [...Buffer.from('memory bytes')] }, { id: 'bytes', name: 'memory.txt', mediaType: 'text/plain', method: 'automatic' });
    expect((await registry.read('bytes')).text).toBe('memory bytes');
  });

  it('classifies HTML and common Office files for built-in preview', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-preview-kinds-'));
    temporaryDirectories.push(root);
    const registry = new ArtifactRegistry({ storePath: path.join(root, 'artifacts.json') });
    const cases = [
      ['page.html', 'html'], ['report.docx', 'word'], ['budget.xlsx', 'sheet'],
      ['legacy.xls', 'sheet'], ['slides.pptx', 'slides'],
    ] as const;
    for (const [name, previewKind] of cases) {
      const file = path.join(root, name);
      await writeFile(file, name.endsWith('.html') ? '<h1>星丛</h1>' : 'preview-fixture');
      const info = await registry.register({ kind: 'local_path', path: file }, { id: name, method: 'manual' });
      expect(info.previewKind).toBe(previewKind);
      const content = await registry.read(name);
      if (previewKind === 'html') expect(content.text).toContain('星丛');
      else expect(content.dataUrl).toMatch(/^data:/);
    }
  });

  it('repairs preview metadata stored before HTML and DOCX support was added', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-preview-migration-'));
    temporaryDirectories.push(root);
    const store = path.join(root, 'artifacts.json');
    const files = [path.join(root, 'legacy.html'), path.join(root, 'legacy.docx')];
    await Promise.all(files.map((file) => writeFile(file, 'legacy-preview')));
    await writeFile(store, JSON.stringify({ version: 2, items: files.map((file, index) => ({
      id: `legacy-preview-${index}`, name: path.basename(file), extension: path.extname(file),
      mediaType: 'application/octet-stream', previewKind: 'unsupported', sourceKind: 'local_path',
      registrationMethod: 'manual', availability: 'available', cached: false,
      createdAt: '2026-09-20T00:00:00.000Z', source: { kind: 'local_path', path: file },
    })) }), 'utf8');
    const registry = new ArtifactRegistry(store);
    expect((await registry.inspect('legacy-preview-0')).previewKind).toBe('html');
    expect((await registry.inspect('legacy-preview-1')).previewKind).toBe('word');
    const persisted = await readFile(store, 'utf8');
    expect(persisted).toContain('text/html');
    expect(persisted).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('allows HTML previews up to 20 MB while keeping ordinary text at 5 MB', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-html-limit-'));
    temporaryDirectories.push(root);
    const html = path.join(root, 'large.html');
    const text = path.join(root, 'large.txt');
    const oversizedHtml = path.join(root, 'too-large.html');
    await Promise.all([writeFile(html, ''), writeFile(text, ''), writeFile(oversizedHtml, '')]);
    await Promise.all([
      truncate(html, 5 * 1024 * 1024 + 64 * 1024),
      truncate(text, 5 * 1024 * 1024 + 64 * 1024),
      truncate(oversizedHtml, 20 * 1024 * 1024 + 1),
    ]);
    const registry = new ArtifactRegistry({ storePath: path.join(root, 'artifacts.json') });
    await registry.register({ kind: 'local_path', path: html }, { id: 'large-html', method: 'manual' });
    await registry.register({ kind: 'local_path', path: text }, { id: 'large-text', method: 'manual' });
    await registry.register({ kind: 'local_path', path: oversizedHtml }, { id: 'oversized-html', method: 'manual' });
    expect((await registry.read('large-html')).text).toHaveLength(5 * 1024 * 1024 + 64 * 1024);
    await expect(registry.read('large-text')).rejects.toThrow('ARTIFACT_TOO_LARGE');
    await expect(registry.read('oversized-html')).rejects.toThrow('ARTIFACT_TOO_LARGE');
  });

  it('rejects unsafe network sources and private redirect targets', async () => {
    const registry = new ArtifactRegistry();
    await expect(registry.register({ kind: 'content', transport: 'https_url', value: 'http://example.com/file.png' }, { method: 'message_image' })).rejects.toThrow('ARTIFACT_URL_REJECTED');
    await expect(registry.register({ kind: 'content', transport: 'https_url', value: 'https://user:pass@example.com/file.png' }, { method: 'message_image' })).rejects.toThrow('ARTIFACT_URL_REJECTED');
    await registry.register({ kind: 'content', transport: 'https_url', value: 'https://127.0.0.1/file.png' }, { id: 'private-url', method: 'message_image' });
    await expect(registry.read('private-url')).rejects.toThrow('ARTIFACT_URL_REJECTED');
  });

  it('drops legacy project-copy metadata because registry records are not project backups', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-project-metadata-'));
    temporaryDirectories.push(root);
    const file = path.join(root, 'deliverable.txt');
    const store = path.join(root, 'artifacts.json');
    await writeFile(file, 'permanent result', 'utf8');
    await writeFile(store, JSON.stringify({ version: 2, items: [{
      id: 'project-source', name: 'deliverable.txt', extension: '.txt', mediaType: 'text/plain', sizeBytes: 16,
      previewKind: 'text', sourceKind: 'local_path', registrationMethod: 'automatic', availability: 'available', cached: false,
      createdAt: '2026-10-13T00:00:00.000Z', source: { kind: 'local_path', path: file },
      projectCopies: { 'project-demo': { blobHash: 'legacy-hash', absolutePath: path.join(root, 'legacy-blob'), savedAt: '2026-10-13T00:00:00.000Z' } },
    }] }), 'utf8');

    const registry = new ArtifactRegistry({ storePath: store });
    expect((await registry.inspect('project-source')).availability).toBe('available');
    expect(await readFile(store, 'utf8')).not.toContain('projectCopies');
  });
});
