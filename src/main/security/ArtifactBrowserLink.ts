import { randomBytes } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream/promises';

const LOOPBACK = '127.0.0.1';
const LINK_LIFETIME_MS = 2 * 60 * 1000;
const INLINE_MEDIA = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon',
  'application/pdf',
]);
const PLAIN_TEXT_MEDIA = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

export async function createArtifactBrowserLink(file: { path: string; name: string; mediaType: string }) {
  const source = await realpath(file.path);
  const fileInfo = await stat(source);
  if (!fileInfo.isFile()) throw new Error('ARTIFACT_SOURCE_MISSING');

  const pathname = `/${randomBytes(24).toString('hex')}`;
  const media = file.mediaType.toLowerCase().split(';', 1)[0].trim();
  const mediaType = INLINE_MEDIA.has(media) ? media : PLAIN_TEXT_MEDIA.has(media) ? 'text/plain; charset=utf-8' : undefined;
  const name = encodeURIComponent(Buffer.from(file.name).toString('utf8')).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
  const server = createServer(async (request, response) => {
    const address = server.address();
    if (!address || typeof address === 'string' || request.headers.host !== `${LOOPBACK}:${address.port}`
      || request.url !== pathname || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response.writeHead(404, { Connection: 'close' }).end();
      return;
    }
    try {
      const handle = await open(source);
      try {
        const current = await handle.stat();
        if (!current.isFile()) throw new Error('ARTIFACT_SOURCE_MISSING');
        response.writeHead(200, {
          'Content-Type': mediaType ?? 'application/octet-stream',
          'Content-Disposition': `${mediaType ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
          'Content-Length': current.size,
          'Cache-Control': 'no-store',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          Connection: 'close',
        });
        if (request.method === 'HEAD' || current.size === 0) response.end();
        else await pipeline(handle.createReadStream({ start: 0, end: current.size - 1 }), response);
      } finally {
        await handle.close();
      }
    } catch {
      if (!response.headersSent) response.writeHead(404, { Connection: 'close' }).end();
      else response.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => { server.off('error', reject); resolve(); });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('ARTIFACT_BROWSER_LINK_UNAVAILABLE');
  }
  const timer = setTimeout(close, LINK_LIFETIME_MS);
  timer.unref();
  function close() {
    clearTimeout(timer);
    server.close();
  }
  return { url: `http://${LOOPBACK}:${address.port}${pathname}`, close };
}
