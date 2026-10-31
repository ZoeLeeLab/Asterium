import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectWorkflowGenerationStore } from '../../src/main/project/ProjectWorkflowGenerationStore';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asterium-workflow-generation-store-'));
  temporary.push(root);
  const filePath = path.join(root, 'generations.json');
  return { filePath, store: new ProjectWorkflowGenerationStore(filePath) };
}

const sourceMessages = [{
  messageId: 'message-a', seq: 2, authorType: 'user' as const, authorId: 'user-a', content: '核心讨论', contentHash: 'a'.repeat(64),
  createdAt: '2026-10-16T00:00:00.000Z', status: 'completed' as const,
}];

const input = {
  requestId: 'request-a', requestFingerprint: 'fingerprint-a', projectId: 'project-a', roomId: 'room-a', plannerPartnerId: 'partner-a',
  sourceDigest: 'digest-a', sourceMessages,
};

describe('ProjectWorkflowGenerationStore', () => {
  it('persists idempotency and grants runtime startup to only one caller', async () => {
    const { filePath, store } = await fixture();
    const created = await store.create(input);
    const repeated = await store.create(input);
    expect(repeated.id).toBe(created.id);

    const [left, right] = await Promise.all([
      store.claimStart(created.id, { conversationId: 'workflow-plan-a', bindingId: 'binding-a' }),
      store.claimStart(created.id, { conversationId: 'workflow-plan-a', bindingId: 'binding-a' }),
    ]);
    expect([left.claimed, right.claimed].sort()).toEqual([false, true]);
    expect(await new ProjectWorkflowGenerationStore(filePath).get(created.id)).toMatchObject({
      conversationId: 'workflow-plan-a', bindingId: 'binding-a', status: 'running',
    });
    await expect(store.create({ ...input, requestFingerprint: 'different' })).rejects.toThrow('PROJECT_WORKFLOW_GENERATION_IDEMPOTENCY_CONFLICT');
    await expect(store.create({ ...input, requestId: 'request-other', requestFingerprint: 'fingerprint-other' })).rejects.toThrow('PROJECT_WORKFLOW_GENERATION_ALREADY_RUNNING');
  });

  it('recovers running generations as interrupted without changing submitted drafts', async () => {
    const { filePath, store } = await fixture();
    const submitted = await store.create(input);
    await store.markSubmitted(submitted.id, 'workflow-a');
    const running = await store.create({ ...input, requestId: 'request-b', requestFingerprint: 'fingerprint-b' });

    const restarted = new ProjectWorkflowGenerationStore(filePath);
    await restarted.recover();
    expect(await restarted.get(running.id)).toMatchObject({ status: 'interrupted', error: { code: 'PROJECT_WORKFLOW_GENERATION_INTERRUPTED', retryable: true } });
    expect(await restarted.get(submitted.id)).toMatchObject({ status: 'submitted', workflowId: 'workflow-a' });
  });
});
