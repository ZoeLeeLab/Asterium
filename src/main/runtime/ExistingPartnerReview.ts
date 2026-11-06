import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { CyberBossBridgeClient } from '../adapters/CyberBossBridgeClient';
import type { ArtifactRegistry } from '../security/ArtifactRegistry';
import { REVIEW_MARKDOWN_MAX_BYTES, reviewFileNameSchema, type ExistingPartnerReviewRequest } from '../../shared/existingPartnerReview';

type ReviewTransport = Pick<CyberBossBridgeClient, 'submitReview' | 'reviewStatus'>;
type ReviewKey = Pick<ExistingPartnerReviewRequest, 'requestId' | 'threadId'>;

export function describeReviewFile(name: string, bytes: Uint8Array): ExistingPartnerReviewRequest['file'] {
  if (!reviewFileNameSchema.safeParse(name).success) throw new Error('DELEGATION_REVIEW_MARKDOWN_REQUIRED');
  if (!bytes.length || bytes.length > REVIEW_MARKDOWN_MAX_BYTES) throw new Error('DELEGATION_REVIEW_FILE_SIZE');
  try {
    if (!new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim() || bytes.includes(0)) throw new Error();
  } catch { throw new Error('DELEGATION_REVIEW_MARKDOWN_REQUIRED'); }
  return { name, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function snapshotReviewArtifact(
  artifacts: Pick<ArtifactRegistry, 'inspect' | 'pathFor'>,
  artifactId: string,
  owner: { conversationId: string; partnerId: string },
  signal: AbortSignal,
) {
  const artifact = await artifacts.inspect(artifactId);
  if (artifact.conversationId !== owner.conversationId || artifact.partnerId !== owner.partnerId
    || artifact.sourceKind !== 'local_path' || artifact.registrationMethod !== 'deliver_tool') {
    throw new Error('DELEGATION_ATTACHMENT_UNAVAILABLE');
  }
  const chunks: Buffer[] = [];
  const filename = await artifacts.pathFor(artifactId);
  for await (const chunk of createReadStream(filename, { end: REVIEW_MARKDOWN_MAX_BYTES, signal })) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  const file = describeReviewFile(artifact.name, bytes);
  // Preserve the exact UTF-8 byte sequence, including a leading BOM if present.
  return { file, draft: { name: file.name, markdown: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } };
}

export function existingPartnerReviewMessage(sender: string, instruction: string, original: string, filename: string, userName = '用户') {
  const message = [
    `[星丛转交 · 来自${sender}]`,
    instruction,
    `${userName}原话：「${original}」`,
    `附件：${filename}`,
    '本次只请你给评审意见，不要修改代码。',
  ].join('\n');
  if (instruction.length > 1_000 || message.length > 4_000) throw new Error('DELEGATION_REVIEW_MESSAGE_TOO_LONG');
  return message;
}

export async function runExistingPartnerReview(
  client: ReviewTransport,
  key: ReviewKey,
  upload: { message: string; file: ExistingPartnerReviewRequest['file']; bytes: Uint8Array } | undefined,
  signal: AbortSignal,
  pollIntervalMs = 2_000,
) {
  let receipt;
  if (upload) {
    const { bytes, ...metadata } = upload;
    try {
      signal.throwIfAborted();
      receipt = await client.submitReview({ version: 1, ...key, ...metadata }, bytes, signal);
    } catch {
      signal.throwIfAborted();
      // A missing HTTP response is not evidence that the host rejected the upload.
    }
  }
  for (;;) {
    signal.throwIfAborted();
    if (!receipt || receipt.requestId !== key.requestId || receipt.threadId !== key.threadId) {
      try { receipt = await client.reviewStatus(key.requestId, signal); }
      catch { throw new Error('DELEGATION_REVIEW_UNCERTAIN'); }
      if (receipt.requestId !== key.requestId || receipt.threadId !== key.threadId) throw new Error('DELEGATION_REVIEW_UNCERTAIN');
    }
    switch (receipt.status) {
      case 'succeeded': return receipt.result!;
      case 'busy': throw new Error('DELEGATION_REVIEW_BUSY');
      case 'thread_changed': throw new Error('DELEGATION_REVIEW_THREAD_CHANGED');
      case 'file_unreadable': throw new Error('DELEGATION_REVIEW_FILE_UNREADABLE');
      case 'failed': throw new Error('DELEGATION_REVIEW_FAILED');
    }
    await delay(pollIntervalMs, undefined, { signal });
    receipt = undefined;
  }
}
