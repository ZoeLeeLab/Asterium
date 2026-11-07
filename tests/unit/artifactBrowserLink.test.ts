import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArtifactBrowserLink } from '../../src/main/security/ArtifactBrowserLink';

describe('artifact browser links', () => {
  let directory: string;
  let source: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'asterium-browser-artifact-'));
    source = join(directory, 'artifact-blob');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('streams only the chosen image through its local token URL', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSxoAAAAASUVORK5CYII=', 'base64');
    await writeFile(source, png);
    const link = await createArtifactBrowserLink({ path: source, name: '概念图.png', mediaType: 'image/png' });
    try {
      const url = new URL(link.url);
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.pathname).toMatch(/^\/[a-f0-9]{48}$/);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''%E6%A6%82%E5%BF%B5%E5%9B%BE.png");
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
      expect((await fetch(url, { method: 'HEAD' })).headers.get('content-length')).toBe(String(png.length));
      expect((await fetch(url, { method: 'POST' })).status).toBe(404);
      expect((await fetch(new URL('/other-file', url))).status).toBe(404);
      expect((await fetch(new URL(`${url.pathname}/../other-file`, url))).status).toBe(404);
    } finally {
      link.close();
    }
    await expect(fetch(link.url)).rejects.toThrow();
  });

  it('downloads active content with the original name instead of serving it as a web page', async () => {
    const html = '<script>fetch("/other-file")</script>';
    await writeFile(source, html);
    const link = await createArtifactBrowserLink({ path: source, name: 'report.html', mediaType: 'text/html; charset=utf-8' });
    try {
      const response = await fetch(link.url);
      expect(response.headers.get('content-type')).toBe('application/octet-stream');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''report.html");
      expect(await response.text()).toBe(html);
    } finally {
      link.close();
    }
  });
});
