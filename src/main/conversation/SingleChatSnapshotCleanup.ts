import { createReadStream } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

const maxRecordBytes = 64 * 1024 * 1024;
const newline = Buffer.from('\n');

export interface HistorySnapshotPlan {
  stamp: string;
  latestMetadataOffset: number;
  count: number;
  bytes: number;
}

export async function historySnapshotStamp(root: string, target: string) {
  const canonicalRoot = await realpath(root);
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative.startsWith('..')
    || path.relative(path.dirname(path.join(canonicalRoot, relative)), await realpath(path.dirname(target)))) {
    throw new Error('SNAPSHOT_PATH_INVALID');
  }
  const file = await lstat(target, { bigint: true });
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('SNAPSHOT_PATH_INVALID');
  return [file.dev, file.ino, file.size, file.mtimeNs].join(':');
}

export async function inspectHistorySnapshots(root: string, target: string): Promise<HistorySnapshotPlan> {
  const stamp = await historySnapshotStamp(root, target);
  let latestMetadataOffset = -1;
  let lastSavings = 0;
  let count = 0;
  let bytes = 0;
  for await (const { record, offset, complete } of historyLines(target)) {
    if (!complete) break;
    const replacement = withoutSnapshot(record);
    if (replacement === undefined) continue;
    if (lastSavings > 0) { count++; bytes += lastSavings; }
    latestMetadataOffset = offset;
    lastSavings = replacement ? record.length - replacement.length : 0;
  }
  if (await historySnapshotStamp(root, target) !== stamp) throw new Error('SNAPSHOT_PLAN_CHANGED');
  return { stamp, latestMetadataOffset, count, bytes };
}

export async function stageHistorySnapshotCleanup(target: string, temporary: string, plan: HistorySnapshotPlan) {
  const output = await open(temporary, 'wx', 0o600);
  let count = 0;
  let bytes = 0;
  let buffers: Buffer[] = [];
  let buffered = 0;
  const flush = async () => {
    if (!buffered) return;
    await output.writeFile(Buffer.concat(buffers, buffered));
    buffers = [];
    buffered = 0;
  };
  try {
    try {
      for await (const { record, offset, complete } of historyLines(target)) {
        const replacement = complete && offset < plan.latestMetadataOffset ? withoutSnapshot(record) : undefined;
        if (replacement && replacement.length < record.length) { count++; bytes += record.length - replacement.length; }
        const line = replacement && replacement.length < record.length ? replacement : record;
        buffers.push(line);
        buffered += line.length;
        if (complete) { buffers.push(newline); buffered++; }
        if (buffered >= 1024 * 1024) await flush();
      }
      if (count !== plan.count || bytes !== plan.bytes) throw new Error('SNAPSHOT_PLAN_CHANGED');
      await flush();
      await output.sync();
    } finally {
      await output.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

// A later complete metadata record replaces every earlier delivery list. Return null
// for metadata with no sizable list and undefined when no metadata was written.
function withoutSnapshot(record: Buffer): Buffer | null | undefined {
  const event: unknown = JSON.parse(record.toString('utf8'));
  if (!isRecord(event)) throw new Error('SNAPSHOT_LOG_INVALID');
  const key = event.type === 'conversation.imported' ? 'conversation' : event.type === 'checkpoint' ? 'metadata' : undefined;
  if (!key || !isRecord(event[key])) return undefined;
  const metadata = { ...event[key] };
  if (!Array.isArray(metadata.artifacts)) return null;
  delete metadata.artifacts;
  return Buffer.from(JSON.stringify({ ...event, [key]: metadata }));
}

async function* historyLines(target: string) {
  let pieces: Buffer[] = [];
  let pieceBytes = 0;
  let offset = 0;
  for await (const chunk of createReadStream(target, { highWaterMark: 1024 * 1024 })) {
    const buffer: Buffer = chunk;
    let start = 0;
    for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, start)) {
      const segment = buffer.subarray(start, end);
      if (pieceBytes + segment.length > maxRecordBytes) throw new Error('SNAPSHOT_LOG_RECORD_TOO_LARGE');
      const record = pieces.length ? Buffer.concat([...pieces, segment]) : segment;
      yield { record, offset, complete: true };
      offset += record.length + 1;
      start = end + 1;
      pieces = [];
      pieceBytes = 0;
    }
    if (start < buffer.length) {
      pieces.push(buffer.subarray(start));
      pieceBytes += buffer.length - start;
      if (pieceBytes > maxRecordBytes) throw new Error('SNAPSHOT_LOG_RECORD_TOO_LARGE');
    }
  }
  if (pieceBytes) yield { record: Buffer.concat(pieces, pieceBytes), offset, complete: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
