import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

function comparablePath(value: string) {
  if (process.platform !== 'win32') return path.resolve(value);
  const prefix = '\\\\?\\';
  const normalized = value.slice(0, prefix.length + 4).toUpperCase() === prefix + 'UNC' + path.sep
    ? path.sep.repeat(2) + value.slice(prefix.length + 4)
    : value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return path.resolve(normalized).toLowerCase();
}

export function sameCodexPath(left: string, right: string) {
  return comparablePath(left) === comparablePath(right);
}

export async function readCodexSessionHeader(filePath: string, codexHome: string) {
  const sessions = comparablePath(await realpath(path.join(codexHome, 'sessions')));
  const file = await realpath(filePath);
  const relative = path.relative(sessions, comparablePath(file));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
    || path.extname(file).toLowerCase() !== '.jsonl') {
    throw new Error('请选择当前 Codex 数据目录 sessions 中的线程文件。归档线程请先在 Codex 中恢复。');
  }

  const handle = await open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('CODEX_SESSION_FILE_INVALID');
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(4096);
    for (let size = 0; size < 256 * 1024;) {
      const { bytesRead } = await handle.read(buffer);
      const newline = buffer.subarray(0, bytesRead).indexOf(10);
      if (newline >= 0 || !bytesRead) {
        chunks.push(buffer.subarray(0, newline >= 0 ? newline : 0));
        const header: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
        if (!header || typeof header !== 'object' || !('type' in header) || header.type !== 'session_meta'
          || !('payload' in header) || !header.payload || typeof header.payload !== 'object') break;
        const { payload } = header;
        if ('id' in payload && typeof payload.id === 'string'
          && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(payload.id)) {
          return { file, threadId: payload.id };
        }
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      size += bytesRead;
    }
    throw new Error('CODEX_SESSION_FILE_INVALID');
  } catch {
    throw new Error('无法识别这个 Codex 线程文件。');
  } finally {
    await handle.close();
  }
}
