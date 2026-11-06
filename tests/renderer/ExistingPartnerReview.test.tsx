import { fireEvent, render, screen, within } from '@testing-library/react';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { CyberBossBridgeClient } from '../../src/main/adapters/CyberBossBridgeClient';
import { describeReviewFile, existingPartnerReviewMessage, runExistingPartnerReview } from '../../src/main/runtime/ExistingPartnerReview';
import { PartnerDelegation } from '../../src/main/runtime/PartnerDelegation';
import { App } from '../../src/renderer/app/App';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { EXISTING_PARTNER_REVIEW_PATH, reviewRequestSchema, type ExistingPartnerReviewRequest } from '../../src/shared/existingPartnerReview';
import { testRm } from '../helpers/autoTest.mjs';
import { createTestState } from '../fixtures/applicationState';

afterEach(() => { window.asteriumDelegation = undefined; });

it('keeps a late review result after its own dispatch in the originating assistant bubble', async () => {
  const owner = { conversationId: 'conversation-a-1', partnerId: 'fixture-local-a', turnId: 'synthetic-turn', messageId: 'm2' };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-card-'));
  const threadId = 'synthetic-thread';
  const draft = { name: 'proposal.md', markdown: '# Synthetic proposal' };
  const bytes = Buffer.from(draft.markdown);
  const file = describeReviewFile(draft.name, bytes);
  const message = existingPartnerReviewMessage('测试伙伴 A', '请复核这份方案。', '请找测试伙伴 B 看一下。', draft.name);
  let online = false;
  const uploads: ExistingPartnerReviewRequest[] = [];
  const client = new CyberBossBridgeClient({ serviceUrl: 'https://review.example.test', secret: 'synthetic', fetcher: async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/api/auth') return new Response(null, { headers: { 'Set-Cookie': 'cyberboss_web_session=synthetic' } });
    if (pathname === EXISTING_PARTNER_REVIEW_PATH && init?.method === 'POST') {
      const form = init.body as FormData;
      const upload = form.get('file') as File;
      expect(upload.name).toBe(draft.name);
      const metadata = reviewRequestSchema.parse(JSON.parse(String(form.get('metadata'))));
      uploads.push(metadata);
      return Response.json({ version: 1, requestId: metadata.requestId, threadId, status: 'accepted' });
    }
    if (pathname === `${EXISTING_PARTNER_REVIEW_PATH}/${uploads[0]?.requestId}`) {
      if (!online) return new Response(null, { status: 503 });
      return Response.json({ version: 1, requestId: uploads[0].requestId, threadId, status: 'succeeded', result: '这份方案可以继续。\n\n建议先确认验收范围。' });
    }
    throw new Error('Unexpected mock endpoint');
  } });
  const queue = new PartnerDelegation(path.join(directory, 'delegations.json'), (_batch, task, signal, lookupOnly) =>
    runExistingPartnerReview(client, { requestId: task.review!.requestId!, threadId },
      lookupOnly ? undefined : { message, bytes, file }, signal, 1));
  try {
    await queue.submit(owner, 'synthetic-call', { tasks: [{ targetPartnerId: 'fixture-local-b', instruction: '请复核这份方案。', reviewDraft: draft }] },
      async () => ({ review: { threadId, message }, materials: [{ id: 'draft', name: draft.name, sha256: file.sha256 }] }));
    await vi.waitFor(async () => expect((await queue.list(owner.conversationId))[0].tasks[0].status).toBe('uncertain'));
    window.asteriumDelegation = {
      list: conversationId => queue.list(conversationId),
      interruptWait: vi.fn(async () => false),
      control: vi.fn(async () => undefined),
    };
    const state = createTestState();
    const conversation = state.conversations.find(item => item.id === owner.conversationId)!;
    const [, request, reply] = conversation.messages;
    request.clientMessageId = owner.turnId;
    request.runId = reply.runId = 'synthetic-review-run';
    reply.timeline = [
      { id: 'intro', sequence: 1, kind: 'text', text: '我先看看复核范围。' },
      { id: 'dispatch-other', sequence: 2, kind: 'tool', toolCallId: 'other-call', toolName: 'delegate_tasks', summary: '第一次委派', state: 'success' },
      { id: 'between', sequence: 3, kind: 'text', text: '这份方案也交给伙伴复核。' },
      { id: 'dispatch-target', sequence: 4, kind: 'tool', toolCallId: 'synthetic-call', toolName: 'delegate_tasks', summary: '方案复核', state: 'success' },
      { id: 'wait-review', sequence: 5, kind: 'tool', toolCallId: 'wait-call', toolName: 'wait_delegate_tasks', summary: '等待复核', state: 'success' },
      { id: 'conclusion', sequence: 6, kind: 'text', text: reply.content },
    ];
    conversation.messages.push(
      { ...request, id: 'next-user', content: '我们聊下一件事。', clientMessageId: 'next-turn', runId: 'next-run' },
      { ...reply, id: 'next-assistant', content: '继续下一轮。', runId: 'next-run' },
    );
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
    render(<MemoryRouter initialEntries={['/chat']}><PrototypeProvider><App /></PrototypeProvider></MemoryRouter>);
    const receipt = await screen.findByRole('region', { name: '指派任务' });
    const bubble = receipt.closest<HTMLElement>('.message-bubble')!;
    expect(receipt.closest('article')).toHaveAttribute('id', 'chat-message-m3');
    expect(receipt.parentElement?.firstElementChild).toHaveTextContent('我先看看复核范围。');
    expect(receipt.previousElementSibling).toContainElement(within(bubble).getAllByText(/派出小弟了$/)[1]);
    expect(receipt.nextElementSibling).toHaveTextContent('结束了前台等待');
    expect(bubble).toHaveTextContent(reply.content);
    expect(within(receipt).getByText('待确认')).toBeVisible();
    const details = within(receipt).getByText('测试伙伴 B').closest('details');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(within(receipt).getByText('测试伙伴 B'));
    expect(within(receipt).getByText(draft.name)).toBeVisible();
    expect(within(receipt).queryByRole('button', { name: /取消任务|重试任务/ })).not.toBeInTheDocument();
    online = true;
    await queue.resumeReviews(owner.conversationId);
    expect(await within(receipt).findByText('测试伙伴 A派出的小弟带回了结果', {}, { timeout: 2_500 })).toBeVisible();
    expect(within(receipt).getByText('这份方案可以继续。')).toBeVisible();
    expect(within(receipt).getByText('建议先确认验收范围。')).toBeVisible();
    expect(receipt.closest('article')).toHaveAttribute('id', 'chat-message-m3');
    expect(screen.getAllByRole('region', { name: '指派任务' })).toHaveLength(1);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].message).not.toContain(draft.markdown);
  } finally {
    queue.close();
    await testRm(directory, { recursive: true, force: true });
  }
});


it.each(['pending reply', 'regenerated reply'] as const)('keeps a folded card on its source turn (%s)', async scenario => {
  const state = createTestState();
  const conversation = state.conversations.find(item => item.id === 'conversation-a-1')!;
  const [, request, reply] = conversation.messages;
  if (scenario === 'pending reply') {
    request.clientMessageId = 'pending-review-turn';
    conversation.messages = conversation.messages.slice(0, 2);
    conversation.awaitingFirstResponse = { clientMessageId: request.clientMessageId, startedAt: '2026-01-01T10:31:00.000Z' };
  } else {
    request.clientMessageId = 'replacement-turn';
    request.runId = reply.runId = 'replacement-run';
  }
  localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
  window.asteriumDelegation = {
    list: vi.fn(async () => [{
      id: 'example-batch', conversationId: conversation.id, partnerId: conversation.partnerId,
      turnId: 'pending-review-turn', messageId: request.id, requestId: 'example-request', createdAt: Date.parse('2026-01-01T10:31:00.000Z'),
      tasks: [{ id: 'example-task', targetPartnerId: 'fixture-local-b', instruction: '请看看附件。', status: 'running' as const, attachmentIds: [], attempt: 1 }],
    }]),
    interruptWait: vi.fn(async () => false),
    control: vi.fn(async () => undefined),
  };

  render(<MemoryRouter initialEntries={['/chat']}><PrototypeProvider><App /></PrototypeProvider></MemoryRouter>);
  const receipt = await screen.findByRole('region', { name: '指派任务' });
  const assistantRow = receipt.closest('article')!;
  expect(assistantRow).not.toHaveClass('message-row--mine');
  expect(assistantRow.previousElementSibling).toHaveAttribute('id', 'chat-message-m2');
  expect(receipt.closest('.turn-timeline')?.firstElementChild).toBe(receipt);
  expect(within(receipt).getByText('正在等小弟汇报回来')).toBeVisible();
  expect(within(receipt).getByText('请看看附件。')).not.toBeVisible();
});
