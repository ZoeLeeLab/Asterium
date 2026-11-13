import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

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

function isCodexSessionFile(file: string) {
  return /\.jsonl(?:\.zst)?$/i.test(file);
}

export function sameCodexSessionRecord(left: string, right: string) {
  // Codex can materialize a packed rollout at its indexed .jsonl path during resume.
  return sameCodexPath(left.replace(/\.jsonl\.zst$/i, '.jsonl'), right.replace(/\.jsonl\.zst$/i, '.jsonl'));
}

const dateParts = [/^\d{4}$/, /^(0[1-9]|1[0-2])$/, /^(0[1-9]|[12]\d|3[01])$/];

function codexSessionDirectoryParts(directory: string, sessions: string) {
  const parts = path.relative(comparablePath(sessions), comparablePath(directory)).split(path.sep);
  return parts.length <= dateParts.length && parts.every((part, index) => dateParts[index].test(part)) ? parts : undefined;
}

export function codexSessionDirectoryDate(directory: string, sessions: string) {
  return codexSessionDirectoryParts(directory, sessions)?.join('-');
}

export async function readCodexSessionDirectory(directory: string, codexHome: string) {
  const sessions = await realpath(path.join(codexHome, 'sessions'));
  const canonicalDirectory = await realpath(directory);
  const parts = codexSessionDirectoryParts(canonicalDirectory, sessions);
  if (!parts) throw new Error('请选择 Codex sessions 下的年、月或日文件夹。');

  const filesByThreadId = new Map<string, string[]>();
  let unavailableCount = 0;
  async function scanDateFolder(folder: string, depth: number) {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(folder, entry.name);
      if (depth < dateParts.length) {
        if (entry.isDirectory() && dateParts[depth].test(entry.name)) {
          try {
            if (sameCodexPath(await realpath(entryPath), entryPath)) await scanDateFolder(entryPath, depth + 1);
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          }
        }
        continue;
      }
      if (!entry.isFile() || !isCodexSessionFile(entry.name)) continue;
      try {
        const { file, threadId } = await readSessionHeader(entryPath, sessions);
        if (!sameCodexPath(path.dirname(file), folder)) {
          unavailableCount++;
          continue;
        }
        const files = filesByThreadId.get(threadId) ?? [];
        files.push(file);
        filesByThreadId.set(threadId, files);
      } catch {
        unavailableCount++;
      }
    }
  }

  await scanDateFolder(canonicalDirectory, parts.length);
  return { date: parts.join('-'), directory: canonicalDirectory, sessions, filesByThreadId, unavailableCount };
}

export async function readCodexSessionHeader(filePath: string, codexHome: string) {
  return readSessionHeader(filePath, await realpath(path.join(codexHome, 'sessions')));
}

async function readSessionHeader(filePath: string, sessions: string) {
  const file = await realpath(filePath).catch((error: NodeJS.ErrnoException) => {
    // The App Server may return the original path while only the .zst file exists.
    if (error.code === 'ENOENT' && /\.jsonl$/i.test(filePath)) return realpath(filePath + '.zst');
    throw error;
  });
  const relative = path.relative(comparablePath(sessions), comparablePath(file));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
    || !isCodexSessionFile(file)) {
    throw new Error('请选择当前 Codex 数据目录 sessions 中的线程文件。归档线程请先在 Codex 中恢复。');
  }

  const handle = await open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('CODEX_SESSION_FILE_INVALID');
    const input = handle.createReadStream({ autoClose: false, highWaterMark: 4096, end: 1024 * 1024 - 1 });
    const chunks: Buffer[] = [];
    const stop = new AbortController();
    const readHeader = async (source: Readable) => {
      let size = 0;
      for await (const chunk of source as AsyncIterable<Buffer>) {
        const newline = chunk.indexOf(10);
        const firstLine = newline < 0 ? chunk : chunk.subarray(0, newline);
        size += firstLine.length;
        if (size > 256 * 1024) throw new Error('CODEX_SESSION_FILE_INVALID');
        chunks.push(firstLine);
        if (newline >= 0) {
          stop.abort();
          return;
        }
      }
    };
    try {
      const options = { signal: stop.signal };
      if (/\.zst$/i.test(file)) await pipeline(input, createZstdDecompress(), readHeader, options);
      else await pipeline(input, readHeader, options);
    } catch (error) {
      if (!stop.signal.aborted) throw error;
    }

    const header: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
    if (header && typeof header === 'object' && 'type' in header && header.type === 'session_meta'
      && 'payload' in header && header.payload && typeof header.payload === 'object'
      && 'id' in header.payload && typeof header.payload.id === 'string'
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(header.payload.id)) {
      return { file, threadId: header.payload.id };
    }
    throw new Error('CODEX_SESSION_FILE_INVALID');
  } catch {
    throw new Error('无法识别这个 Codex 线程文件。');
  } finally {
    await handle.close();
  }
}
