import { randomUUID } from 'node:crypto';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify, TextDecoder } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { assertMemoryArchiveRecords } from '../../shared/memoryArchive';
import type { MemoryBackupData } from '../../shared/memoryBackup';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const maxFileBytes = 64 * 1024 * 1024;
const maxDataBytes = 256 * 1024 * 1024;

export async function readMemoryBackup(filePath: string): Promise<MemoryBackupData> {
  const file = await open(filePath, 'r');
  try {
    const info = await file.stat();
    const { size } = info;
    // Use a bounded buffer even if the selected file changes while it is being read.
    if (size > maxFileBytes) throw new Error('MEMORY_BACKUP_TOO_LARGE');
    if (size === 0 || !info.isFile()) throw new Error('MEMORY_BACKUP_INVALID');
    const buffer = Buffer.allocUnsafe(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== size) throw new Error('MEMORY_BACKUP_INVALID');
    try {
      const decoded = await decompress(buffer.subarray(0, size), { maxOutputLength: maxDataBytes });
      const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
      if (!data || typeof data !== 'object' || !('format' in data) || data.format !== 'asterium.partner-memory' || !('version' in data)
        || !('partnerId' in data) || typeof data.partnerId !== 'string' || !('records' in data)
        || !('fallbackMemoryIds' in data) || !Array.isArray(data.fallbackMemoryIds)) throw new Error('MEMORY_BACKUP_INVALID');
      if (data.version !== 1) throw new Error('MEMORY_BACKUP_VERSION_UNSUPPORTED');
      assertMemoryArchiveRecords(data.records, data.partnerId);
      const ids = new Set(data.records.map(record => record.memoryId));
      if (!data.fallbackMemoryIds.every(id => typeof id === 'string' && ids.has(id))) throw new Error('MEMORY_BACKUP_INVALID');
      return { format: data.format, version: data.version, partnerId: data.partnerId, records: data.records, fallbackMemoryIds: data.fallbackMemoryIds };
    } catch (error) {
      if (error instanceof Error && error.message === 'MEMORY_BACKUP_VERSION_UNSUPPORTED') throw error;
      if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('MEMORY_BACKUP_TOO_LARGE', { cause: error });
      throw new Error('MEMORY_BACKUP_INVALID', { cause: error });
    }
  } finally {
    await file.close();
  }
}

export async function writeMemoryBackup(filePath: string, backup: MemoryBackupData) {
  const data = JSON.stringify(backup);
  if (Buffer.byteLength(data) > maxDataBytes) throw new Error('MEMORY_BACKUP_TOO_LARGE');
  const compressed = await compress(data);
  if (compressed.length > maxFileBytes) throw new Error('MEMORY_BACKUP_TOO_LARGE');
  if (path.extname(filePath).toLowerCase() !== '.gz') throw new Error('MEMORY_BACKUP_FILE_EXTENSION');
  const temporary = path.join(path.dirname(filePath), `.asterium-memory-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, compressed, { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
