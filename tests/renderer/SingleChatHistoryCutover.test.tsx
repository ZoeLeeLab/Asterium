import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SingleChatHistoryStore } from '../../src/main/conversation/SingleChatHistoryStore';
import { SingleChatMessageStore } from '../../src/main/conversation/SingleChatMessageStore';
import { mergeLegacySingleChats } from '../../src/main/conversation/singleChatHistoryProjection';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { ChatPage } from '../../src/renderer/pages/ChatPage';
import { STATE_KEY } from '../../src/renderer/app/persistence';
import type { CodexHistoryRequest, CodexHistorySearchRequest } from '../../src/shared/codexHistory';
import type { ApiPartner } from '../../src/renderer/types/domain';
import { AGENT_PROTOCOL_VERSION, type RendererAgentEvent, type SendMessageCommand } from '../../src/shared/agentProtocol';
import { autoTestOutput } from '../helpers/autoTest.mjs';
import { createTestState } from '../fixtures/applicationState';

const partnerId = 'fixture-api';
const conversationId = 'fixture-history-chat';
const now = '2026-01-01T00:00:00.000Z';

afterEach(() => {
  window.asteriumConversations = undefined;
  window.asteriumAgents = undefined;
});

function seed() {
  const state = createTestState();
  const partner = state.partners.find(item => item.id === partnerId) as ApiPartner;
  state.partners = [{ ...partner, isPrototype: false, configured: true, endpoint: 'https://fixture.invalid', credentialRef: 'fixture' }];
  state.conversations = [{ id: conversationId, partnerId, title: '合成单聊', updatedAt: now, messages: [] }];
  state.activePartnerId = partnerId;
  state.activeConversationId = conversationId;
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function connect(profile: string, stopNextUserWrite?: () => Promise<void>) {
  const history = new SingleChatHistoryStore(profile);
  const legacy = new SingleChatMessageStore(path.join(profile, 'single-chat-messages.v1.json'), history);
  const migrate = vi.fn(async (input, recent?: boolean) => {
    await history.initialize(async () => ({
      profile: input.profile,
      conversations: mergeLegacySingleChats(input.conversations, await legacy.listLegacy()),
      deletedConversationIds: [],
    }));
    return (await (recent ? history.openRecent() : history.open()))!;
  });
  const write = vi.fn<NonNullable<NonNullable<typeof window.asteriumConversations>['writeHistory']>>(async input => {
    if (input.changes.some(change => change.upsert.some(message => message.status === 'sending'))) await stopNextUserWrite?.();
    await history.write(input);
  });
  window.asteriumConversations = {
    delete: vi.fn(), listDeleted: vi.fn(async () => []),
    openHistory: recent => recent ? history.openRecent() : history.open(), migrateHistory: migrate, writeHistory: write,
    readHistoryPage: request => history.readPage(request), searchHistory: request => history.search(request),
    readToolOutput: vi.fn(request => history.readToolOutput(request)),
  };
  let listener: (event: RendererAgentEvent) => void = () => undefined;
  const send = vi.fn(async (_connection, command: SendMessageCommand) => {
    const saved = await history.readConversation(conversationId);
    expect(saved?.conversation.messages.some(message => message.id === command.messageId)).toBe(true);
    return { runId: 'fixture-run', sessionId: 'fixture-session' };
  });
  window.asteriumAgents = {
    detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(),
    resumeSession: vi.fn(), sendApiMessage: send, onEvent: callback => { listener = callback; return () => { listener = () => undefined; }; },
  };
  const emit = (type: string, sequence: number, values = {}) => {
    const command = send.mock.calls[0][1];
    act(() => listener({
      protocolVersion: AGENT_PROTOCOL_VERSION, eventId: 'fixture-event-' + sequence,
      connectionSource: 'api_partner', partnerId, conversationId, clientMessageId: command.clientMessageId,
      runId: 'fixture-run', sessionId: 'fixture-session', occurredAt: now, sequence, type, ...values,
    } as RendererAgentEvent));
  };
  return { history, legacy, migrate, send, emit };
}

function mount() {
  return render(<MemoryRouter initialEntries={['/chat']}><PrototypeProvider><ChatPage /></PrototypeProvider></MemoryRouter>);
}

async function sendPrompt(text: string) {
  const input = await screen.findByRole('textbox', { name: /给 测试伙伴 C 发送消息/ });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  return input;
}

it('cuts over once, preserves the old snapshot, and saves a plain reply at its end', async () => {
  seed();
  const profile = path.join(autoTestOutput(), 'plain');
  const original = localStorage.getItem(STATE_KEY);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const fixture = connect(profile, () => waiting);
  const view = mount();
  await sendPrompt('纯文字问题');
  expect(fixture.send).not.toHaveBeenCalled();
  await act(async () => release());
  await waitFor(() => expect(fixture.send).toHaveBeenCalledOnce());
  fixture.emit('session.bound', 1, { isNew: true });
  fixture.emit('text.delta', 2, { text: '纯文字回复完成' });
  await screen.findByText('纯文字回复完成');
  expect((await fixture.history.readConversation(conversationId))?.conversation.messages.map(message => message.content)).toEqual(['纯文字问题']);
  fixture.emit('run.completed', 3);
  await waitFor(async () => expect((await fixture.legacy.getConversation(conversationId))?.messages.map(message => message.content))
    .toEqual(['纯文字问题', '纯文字回复完成']));
  expect(localStorage.getItem(STATE_KEY)).toBe(original);
  view.unmount();

  localStorage.setItem(STATE_KEY, '{"stale":true}');
  const restarted = connect(profile);
  mount();
  expect(await screen.findByText('纯文字回复完成')).toBeInTheDocument();
  expect(restarted.migrate).not.toHaveBeenCalled();
  expect(restarted.send).not.toHaveBeenCalled();
});

it('reopens at the last completed tool and does not replay the unsaved suffix', async () => {
  seed();
  const profile = path.join(autoTestOutput(), 'tool');
  const fixture = connect(profile);
  const view = mount();
  await sendPrompt('工具测试');
  await waitFor(() => expect(fixture.send).toHaveBeenCalledOnce());
  fixture.emit('session.bound', 1, { isNew: true });
  fixture.emit('text.delta', 2, { text: '工具前已保存的文字' });
  const detail = '合成工具输出开始' + 'x'.repeat(70_000) + '合成工具输出结尾';
  fixture.emit('tool.completed', 3, { toolCallId: 'fixture-tool', summary: '示例工具结果', outcome: 'success', detail });
  await waitFor(async () => {
    const saved = await fixture.history.readConversation(conversationId);
    expect(saved?.conversation.messages.at(-1)?.timeline).toContainEqual(expect.objectContaining({ toolCallId: 'fixture-tool', state: 'success', detailRef: expect.anything() }));
  }, { timeout: 5000 });
  fixture.emit('text.delta', 4, { text: '这一段只在内存' });
  expect(await screen.findByText('这一段只在内存')).toBeInTheDocument();
  view.unmount();

  const restarted = connect(profile);
  mount();
  expect(await screen.findByText('工具前已保存的文字')).toBeInTheDocument();
  expect(screen.getByText('回复中断')).toBeInTheDocument();
  expect(screen.queryByText('这一段只在内存')).not.toBeInTheDocument();
  expect(restarted.send).not.toHaveBeenCalled();
  expect(window.asteriumConversations?.readToolOutput).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '查看工具输出' })).not.toBeInTheDocument();
  expect(screen.queryByText(/合成工具输出开始|合成工具输出结尾/)).not.toBeInTheDocument();
});

it('leaves a draft in place if the pre-send disk write fails', async () => {
  seed();
  const fixture = connect(path.join(autoTestOutput(), 'disk-full'), async () => { throw new Error('ENOSPC'); });
  mount();
  const input = await sendPrompt('保留合成草稿');
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('消息保存失败');
  expect(alert.querySelector('button')).toBeNull();
  expect(input).toHaveValue('保留合成草稿');
  expect(fixture.send).not.toHaveBeenCalled();
});

it('keeps the latest model context when the reader is viewing a search hit in an older page', async () => {
  seed();
  const source = JSON.parse(localStorage.getItem(STATE_KEY)!);
  source.conversations[0].messages = Array.from({ length: 170 }, (_, index) => ({
    id: 'fixture-old-' + index, authorId: partnerId, createdAt: '00:00',
    content: index === 2 ? '远古索引唯一消息' : '历史回复 ' + index,
  }));
  localStorage.setItem(STATE_KEY, JSON.stringify(source));
  const fixture = connect(path.join(autoTestOutput(), 'search-context'));
  mount();
  expect(await screen.findByText('历史回复 169')).toBeInTheDocument();
  expect(screen.queryByText('远古索引唯一消息')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '搜索当前对话' }));
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索当前对话正文' }), { target: { value: '远古索引' } });
  expect(await screen.findByText('远古索引唯一消息', {}, { timeout: 5000 })).toBeInTheDocument();
  expect(screen.queryByText('历史回复 169')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '关闭当前对话搜索' }));
  await sendPrompt('继续最后的任务');
  await waitFor(() => expect(fixture.send).toHaveBeenCalledOnce());
  const history = fixture.send.mock.calls[0][1].apiContext?.history;
  expect(history?.at(-1)?.content).toBe('历史回复 169');
  expect(history?.some(message => message.content.includes('远古索引'))).toBe(false);
});

it('reveals a native-only search result without replacing the latest local conversation', async () => {
  const state = createTestState();
  const partner = state.partners[0];
  if (partner.sourceMode !== 'local_cli') throw new Error('expected a local partner');
  state.partners[0] = {
    ...partner, isPrototype: false, connectionKind: 'local_codex', adapterType: 'codex_cli', codexRuntimeId: 'fixture-runtime',
  };
  const id = state.activeConversationId;
  const chat = state.conversations.find(item => item.id === id)!;
  chat.sessionId = 'fixture-original-thread';
  chat.messages = [{ id: 'fixture-latest', authorId: partner.id, createdAt: '00:00', content: '星丛本地当前记录' }];
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  connect(path.join(autoTestOutput(), 'native-search'));
  const read = vi.fn(async (request: CodexHistoryRequest) => ({
    turns: request.aroundTurnId ? [{
      id: request.aroundTurnId, state: 'completed' as const,
      items: [{ id: 'answer', kind: 'assistant' as const, text: request.aroundTurnId === 'older-turn' ? '原线程的下一条旧记录' : '仅在原线程的旧记录' }],
    }] : [],
  }));
  const search = vi.fn<(request: CodexHistorySearchRequest) => Promise<import('../../src/shared/codexHistory').CodexHistorySearchPage>>(async request => request.after ? {
    hits: [{ turnId: 'older-turn', messageId: 'codex-history:older-turn:assistant', pageCursor: 'next-fixture-cursor' }],
  } : {
    hits: [{ turnId: 'original-turn', messageId: 'codex-history:original-turn:assistant', pageCursor: 'older-fixture-cursor' }],
    next: { pageCursor: 'next-fixture-cursor', index: 0 },
  });
  Object.assign(window.asteriumAgents!, { readCodexHistory: read, searchCodexHistory: search });
  mount();
  expect(await screen.findByText('星丛本地当前记录')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '搜索当前对话' }));
  const input = screen.getByRole('searchbox', { name: '搜索当前对话正文' });
  fireEvent.change(input, { target: { value: '旧记录' } });
  expect(await screen.findByText('仅在原线程的旧记录', {}, { timeout: 5000 })).toBeInTheDocument();
  expect(screen.queryByText('星丛本地当前记录')).not.toBeInTheDocument();
  expect(search).toHaveBeenCalledWith(expect.objectContaining({ conversationId: id, threadId: chat.sessionId, query: '旧记录' }));
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ threadId: chat.sessionId, cursor: 'older-fixture-cursor', aroundTurnId: 'original-turn' }));

  expect(screen.queryByRole('button', { name: '切换到星丛记录' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '更多匹配' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '下一条匹配' }));
  expect(await screen.findByText('原线程的下一条旧记录', {}, { timeout: 5000 })).toBeInTheDocument();
  expect(search).toHaveBeenCalledWith(expect.objectContaining({ after: { pageCursor: 'next-fixture-cursor', index: 0 } }));
  fireEvent.click(screen.getByRole('button', { name: '回到底部' }));
  expect(await screen.findByText('星丛本地当前记录')).toBeInTheDocument();

  fireEvent.change(input, { target: { value: '仅在原线程' } });
  expect(await screen.findByText('仅在原线程的旧记录', {}, { timeout: 5000 })).toBeInTheDocument();
  search.mockRejectedValueOnce(new Error('CODEX_HISTORY_UNAVAILABLE'));
  fireEvent.change(input, { target: { value: '本地当前记录' } });
  expect(await screen.findByText('星丛本地当前记录', {}, { timeout: 5000 })).toBeInTheDocument();
  expect(screen.queryByText('仅在原线程的旧记录')).not.toBeInTheDocument();
});
