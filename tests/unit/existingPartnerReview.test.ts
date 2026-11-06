// @vitest-environment node
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CyberBossBridgeClient } from '../../src/main/adapters/CyberBossBridgeClient';
import { describeReviewFile, existingPartnerReviewMessage, runExistingPartnerReview, snapshotReviewArtifact } from '../../src/main/runtime/ExistingPartnerReview';
import { PartnerDelegation } from '../../src/main/runtime/PartnerDelegation';
import { EXISTING_PARTNER_REVIEW_PATH, reviewRequestSchema, type ExistingPartnerReviewRequest } from '../../src/shared/existingPartnerReview';
import { testRm } from '../helpers/autoTest.mjs';

const owner = { conversationId: 'source-chat', partnerId: 'source-partner', turnId: 'source-turn', messageId: 'source-message' };
const filename = 'proposal.md';
const markdown = '# Synthetic proposal\n\nUNIQUE-REVIEW-CONTENT-92';
const file = describeReviewFile(filename, Buffer.from(markdown));
const message = existingPartnerReviewMessage('示例伙伴 A', '请判断这份方案是否可行。', '请找示例伙伴 B 复核。', filename);
const threadId = 'synthetic-thread';
const rawReply = ' 第一段意见。\n\n第二段意见。\n';

it('uploads actual Markdown bytes, recovers a lost receipt after restart, and exposes the full reply on the source task', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-queue-'));
  const storage = path.join(directory, 'delegations.json');
  const uploads: { request: ExistingPartnerReviewRequest; text: string; name: string; type: string }[] = [];
  const lookups: string[] = [];
  let online = false;
  const fetcher: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/auth') return new Response(null, { headers: { 'Set-Cookie': 'cyberboss_web_session=synthetic' } });
    expect(request.headers.get('Cookie')).toBe('cyberboss_web_session=synthetic');
    if (pathname === EXISTING_PARTNER_REVIEW_PATH && request.method === 'GET') return Response.json({ version: 1, threadId });
    if (pathname === EXISTING_PARTNER_REVIEW_PATH && request.method === 'POST') {
      const form = await request.formData();
      const metadata = reviewRequestSchema.parse(JSON.parse(String(form.get('metadata'))));
      const uploaded = form.get('file');
      if (!uploaded || typeof uploaded === 'string') throw new Error('Expected a file part');
      uploads.push({ request: metadata, text: await uploaded.text(), name: uploaded.name, type: uploaded.type });
      throw new Error('Synthetic connection loss after host accepted the task');
    }
    if (pathname.startsWith(EXISTING_PARTNER_REVIEW_PATH + '/')) {
      lookups.push(pathname.split('/').at(-1)!);
      if (!online) return new Response(null, { status: 503 });
      const { requestId } = uploads[0].request;
      return Response.json({ version: 1, requestId, threadId, ...(lookups.length < 3 ? { status: 'running' } : { status: 'succeeded', result: rawReply }) });
    }
    throw new Error('Unexpected mock endpoint');
  };
  const makeQueue = () => new PartnerDelegation(storage, async (_batch, task, signal, lookupOnly) => {
    const client = new CyberBossBridgeClient({ serviceUrl: 'https://review.example.test', secret: 'synthetic', fetcher });
    const key = { threadId: task.review!.threadId, requestId: task.review!.requestId! };
    if (lookupOnly) return runExistingPartnerReview(client, key, undefined, signal, 1);
    expect(await client.reviewCapability(signal)).toEqual({ version: 1, threadId });
    const bytes = Buffer.from(task.reviewDraft!.markdown);
    return runExistingPartnerReview(client, key, { message: task.review!.message, file: describeReviewFile(filename, bytes), bytes }, signal, 1);
  });
  let queue = makeQueue();
  try {
    const batch = await queue.submit(owner, 'tool-call', { tasks: [{ targetPartnerId: 'reviewer', instruction: '请复核方案。', reviewDraft: { name: filename, markdown } }] },
      async () => ({ review: { threadId, message }, materials: [{ id: 'draft', name: filename, sha256: file.sha256 }] }));
    await vi.waitFor(async () => expect((await queue.list(owner.conversationId))[0].tasks[0].status).toBe('uncertain'));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ text: markdown, name: filename, type: 'text/markdown', request: { file, threadId, message } });
    expect(uploads[0].request.message).not.toContain('UNIQUE-REVIEW-CONTENT-92');
    await expect(queue.control(owner.conversationId, batch.tasks[0].id, 'retry')).rejects.toThrow('DELEGATION_RETRY_UNAVAILABLE');
    queue.close();
    queue = makeQueue();
    online = true;
    await queue.resumeReviews(owner.conversationId);
    await vi.waitFor(async () => expect((await queue.list(owner.conversationId))[0].tasks[0]).toMatchObject({ status: 'succeeded', result: rawReply }));
    expect(uploads).toHaveLength(1);
    expect(new Set(lookups)).toEqual(new Set([uploads[0].request.requestId]));
    const [view] = await queue.list(owner.conversationId);
    expect(view).toMatchObject({ id: batch.id, messageId: owner.messageId, tasks: [{ externalReview: true, materials: [{ name: filename }] }] });
    expect(JSON.stringify(view)).not.toContain(markdown);
    expect(view.tasks[0]).not.toHaveProperty('review');
    expect(view.tasks[0]).not.toHaveProperty('reviewDraft');
    expect(await queue.list('another-chat')).toEqual([]);
  } finally {
    queue.close();
    await testRm(directory, { recursive: true, force: true });
  }
});

it('treats a mismatched receipt as unknown and surfaces an explicit busy response', async () => {
  const key = { requestId: '00000001-0000-4000-8000-000000000001', threadId };
  const signal = new AbortController().signal;
  const upload = { message, file, bytes: Buffer.from(markdown) };
  const client = {
    submitReview: vi.fn(async () => ({ version: 1 as const, ...key, status: 'busy' as const })),
    reviewStatus: vi.fn(async () => ({ version: 1 as const, ...key, threadId: 'another-thread', status: 'succeeded' as const, result: 'wrong thread' })),
  };
  await expect(runExistingPartnerReview(client, key, upload, signal)).rejects.toThrow('DELEGATION_REVIEW_BUSY');
  expect(client.reviewStatus).not.toHaveBeenCalled();
  await expect(runExistingPartnerReview(client, key, undefined, signal)).rejects.toThrow('DELEGATION_REVIEW_UNCERTAIN');
  expect(client.submitReview).toHaveBeenCalledTimes(1);
});

it('rejects wrong file types, unsafe names, oversized files and invalid UTF-8', () => {
  expect(() => describeReviewFile('photo.png', Buffer.from(markdown))).toThrow('DELEGATION_REVIEW_MARKDOWN_REQUIRED');
  expect(() => describeReviewFile('../proposal.md', Buffer.from(markdown))).toThrow('DELEGATION_REVIEW_MARKDOWN_REQUIRED');
  expect(() => describeReviewFile(filename, Buffer.alloc(160_001))).toThrow('DELEGATION_REVIEW_FILE_SIZE');
  expect(() => describeReviewFile(filename, Buffer.from([0xff]))).toThrow('DELEGATION_REVIEW_MARKDOWN_REQUIRED');
});

it('freezes bytes from a delivered file only within its source conversation and partner', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-artifact-'));
  try {
    const diskFile = path.join(directory, filename);
    const original = Buffer.from('\uFEFF# Synthetic file\r\n');
    await writeFile(diskFile, original);
    const artifacts = {
      inspect: vi.fn(async () => ({
        id: 'artifact', name: filename, extension: '.md', mediaType: 'text/markdown',
        sizeBytes: original.length, previewKind: 'markdown' as const, sourceKind: 'local_path' as const,
        registrationMethod: 'deliver_tool' as const, availability: 'available' as const, cached: false,
        createdAt: '', conversationId: owner.conversationId, partnerId: owner.partnerId,
      })),
      pathFor: vi.fn(async () => diskFile),
    };
    const signal = new AbortController().signal;
    await expect(snapshotReviewArtifact(artifacts, 'artifact', { ...owner, conversationId: 'unrelated' }, signal)).rejects.toThrow('DELEGATION_ATTACHMENT_UNAVAILABLE');
    expect(artifacts.pathFor).not.toHaveBeenCalled();
    const snapshot = await snapshotReviewArtifact(artifacts, 'artifact', owner, signal);
    await writeFile(diskFile, 'changed after snapshot');
    expect(Buffer.from(snapshot.draft.markdown)).toEqual(original);
    expect(snapshot.file).toEqual(describeReviewFile(filename, original));
  } finally {
    await testRm(directory, { recursive: true, force: true });
  }
});

it('allows an explicit busy retry with a new dispatch ID and the same frozen file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-busy-'));
  const executions: { requestId: string; markdown: string }[] = [];
  const queue = new PartnerDelegation(path.join(directory, 'delegations.json'), async (_batch, task) => {
    executions.push({ requestId: task.review!.requestId!, markdown: task.reviewDraft!.markdown });
    if (executions.length === 1) throw new Error('DELEGATION_REVIEW_BUSY');
    return rawReply;
  });
  try {
    const batch = await queue.submit(owner, 'busy-tool-call', {
      tasks: [{ targetPartnerId: 'reviewer', instruction: '请复核。', reviewDraft: { name: filename, markdown } }],
    }, async () => ({ review: { threadId, message } }));
    await vi.waitFor(async () => expect((await queue.list(owner.conversationId))[0].tasks[0].reason).toBe('DELEGATION_REVIEW_BUSY'));
    expect(await queue.readySummaries()).toEqual([]);
    await queue.control(owner.conversationId, batch.tasks[0].id, 'retry');
    await vi.waitFor(async () => expect((await queue.list(owner.conversationId))[0].tasks[0]).toMatchObject({ status: 'succeeded', result: rawReply }));
    expect(executions).toHaveLength(2);
    expect(executions[0].requestId).not.toBe(executions[1].requestId);
    expect(executions.map(attempt => attempt.markdown)).toEqual([markdown, markdown]);
  } finally {
    queue.close();
    await testRm(directory, { recursive: true, force: true });
  }
});
