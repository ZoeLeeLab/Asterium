import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export interface AttachmentSnapshotCandidate {
  file: string;
  sizeBytes: number;
  sha256: string;
}

interface VerifiedSnapshot extends AttachmentSnapshotCandidate {
  stamp: string;
  links: bigint;
}

export interface AttachmentSnapshotDuplicate {
  keep: VerifiedSnapshot;
  duplicate: VerifiedSnapshot;
}

export async function attachmentSnapshotFile(root: string, file: string) {
  const relative = path.relative(root, file);
  if (!relative || path.isAbsolute(relative) || relative.startsWith('..')
    || path.relative(path.dirname(path.join(await realpath(root), relative)), await realpath(path.dirname(file)))) {
    throw new Error('SNAPSHOT_PATH_INVALID');
  }
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('SNAPSHOT_PATH_INVALID');
  return info;
}

export async function planAttachmentSnapshotCleanup(root: string, candidates: AttachmentSnapshotCandidate[]) {
  const groups = new Map<string, AttachmentSnapshotCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.sha256 + ':' + candidate.sizeBytes;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  const entries: AttachmentSnapshotDuplicate[] = [];
  let skippedCount = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let keep: VerifiedSnapshot | undefined;
    for (const candidate of group) {
      try {
        const file = await verifySnapshot(root, candidate);
        if (!keep) keep = file;
        else if (file.links === 1n && file.stamp !== keep.stamp) entries.push({ keep, duplicate: file });
      } catch { skippedCount++; }
    }
  }
  return { entries, skippedCount };
}

export async function clearAttachmentSnapshotDuplicate(root: string, { keep, duplicate }: AttachmentSnapshotDuplicate) {
  const check = async () => {
    const current = await verifySnapshot(root, duplicate);
    if (current.stamp !== duplicate.stamp || current.links !== 1n || (await verifySnapshot(root, keep)).stamp !== keep.stamp) {
      throw new Error('SNAPSHOT_PLAN_CHANGED');
    }
  };
  await check();
  const temporary = duplicate.file + '.snapshot-cleanup-' + randomUUID();
  // Both names remain available to the original message IDs. Only the duplicate
  // internal file is replaced, and the verified bytes already exist at the keeper.
  await link(keep.file, temporary);
  try {
    await check();
    await rename(temporary, duplicate.file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function verifySnapshot(root: string, candidate: AttachmentSnapshotCandidate): Promise<VerifiedSnapshot> {
  const before = await attachmentSnapshotFile(root, candidate.file);
  if (before.size !== BigInt(candidate.sizeBytes)) throw new Error('SNAPSHOT_PLAN_CHANGED');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(candidate.file)) hash.update(chunk);
  const stamp = [before.dev, before.ino, before.size, before.mtimeNs].join(':');
  const after = await attachmentSnapshotFile(root, candidate.file);
  if (hash.digest('hex') !== candidate.sha256 || stamp !== [after.dev, after.ino, after.size, after.mtimeNs].join(':')) {
    throw new Error('SNAPSHOT_PLAN_CHANGED');
  }
  return { ...candidate, stamp, links: after.nlink };
}
