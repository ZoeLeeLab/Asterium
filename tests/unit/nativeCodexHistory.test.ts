import { expect, it } from 'vitest';
import type { CodexHistoryTurn } from '../../src/shared/codexHistory';
import { codexThreadInUseFailure } from '../../src/shared/codexThreadInUse';
import { mergeNativeCodexMessages, mergePage } from '../../src/renderer/app/nativeCodexHistory';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';
import type { Conversation } from '../../src/renderer/types/domain';

it('reuses unchanged native pages and turns while preserving pagination and thread identity', () => {
  const turns: CodexHistoryTurn[] = [{ id: 'turn-1', state: 'completed', startedAt: '2026-11-21T00:00:00Z', items: [
    { id: 'u', kind: 'user', text: '合成问题' }, { id: 'a', kind: 'assistant', text: '合成回复' },
    { id: 't', kind: 'tool', label: '合成工具', state: 'success' },
  ] }];
  const previous = { key: 'thread-1', turns, nextCursor: 'older' };
  expect(mergePage(previous, previous.key, { turns: structuredClone(turns), nextCursor: 'ignored-overlap' }, false)).toBe(previous);
  expect(mergePage(previous, 'thread-2', { turns: structuredClone(turns) }, false)).not.toBe(previous);
  const cursorChanged = mergePage(previous, previous.key, { turns: [], nextCursor: 'end' }, true);
  expect(cursorChanged.nextCursor).toBe('end');
  expect(cursorChanged.turns[0]).toBe(turns[0]);
  const newer: CodexHistoryTurn = { id: 'turn-2', state: 'completed', items: [{ id: 'a2', kind: 'assistant', text: '新增消息' }] };
  const refreshed = mergePage(previous, previous.key, { turns: [newer, ...structuredClone(turns)] }, false);
  expect(refreshed.turns).toEqual([newer, turns[0]]);
  expect(refreshed.turns[1]).toBe(turns[0]);
  const older = mergePage(previous, previous.key, { turns: [{ ...newer, id: 'turn-0' }], nextCursor: undefined }, true);
  expect(older.turns.map(turn => turn.id)).toEqual(['turn-1', 'turn-0']);
  expect(older.nextCursor).toBeUndefined();
});

it('detects native reply, status, timestamp, tool and item ordering changes', () => {
  const turn: CodexHistoryTurn = { id: 'turn-1', state: 'inProgress', items: [
    { id: 'a', kind: 'assistant', text: '前半段' }, { id: 't', kind: 'tool', label: '命令', state: 'running' },
  ] };
  const previous = { key: 'thread', turns: [turn] };
  const variants: CodexHistoryTurn[] = [
    { ...turn, state: 'completed' }, { ...turn, startedAt: '2026-11-21T00:00:00Z' },
    { ...turn, items: [{ id: 'a', kind: 'assistant', text: '完整回复' }, turn.items[1]] },
    { ...turn, items: [turn.items[0], { id: 't', kind: 'tool', label: '命令', state: 'success' }] },
    { ...turn, items: [turn.items[0], { id: 't', kind: 'tool', label: '新命令', state: 'running' }] },
    { ...turn, items: [turn.items[1], turn.items[0]] }, { ...turn, items: turn.items.slice(0, 1) },
    { ...turn, items: [{ id: 'changed-id', kind: 'assistant', text: '前半段' }, turn.items[1]] },
    { ...turn, items: [{ id: 'a', kind: 'user', text: '前半段' }, turn.items[1]] },
  ];
  for (const variant of variants) {
    const result = mergePage(previous, previous.key, { turns: [variant] }, false);
    expect(result).not.toBe(previous);
    expect(result.turns[0]).toBe(variant);
  }
});

it('recovers the rest of the native turn without replacing the star message ID or attachment references', () => {
  const partial: Conversation = {
    id: 'fixture-chat', partnerId: 'fixture-partner', title: '合成长对话', updatedAt: '00:00',
    sessionId: 'original-thread',
    messages: [
      { id: 'original-prompt', authorId: ASTERIUM_USER_ID, content: '开始', createdAt: '00:00' },
      { id: 'original-reply', authorId: 'fixture-partner', content: '前半段', createdAt: '00:00', runId: 'turn-1',
        timeline: [{ id: 'local-text', sequence: 1, kind: 'text', text: '前半段' },
          { id: 'local-tool', sequence: 2, kind: 'tool', toolCallId: 'local-tool', state: 'success', summary: '星丛工具' }] },
    ],
  };
  const native: CodexHistoryTurn = {
    id: 'turn-1', state: 'completed', items: [
      { id: 'user-1', kind: 'user', text: '开始' },
      { id: 'answer-1', kind: 'assistant', text: '前半段' },
      { id: 'answer-2', kind: 'assistant', text: '后半段' },
    ],
  };
  const restored = mergeNativeCodexMessages(partial, [native]);
  expect(restored.map(message => message.id)).toEqual(['original-prompt', 'original-reply']);
  expect(restored[0]).toBe(partial.messages[0]);
  expect(restored[1].content).toBe('前半段后半段');
  expect(restored[1].timeline?.map(item => item.id)).toEqual(['local-text', 'local-tool', 'answer-2']);
  expect(partial.messages[1].content).toBe('前半段');
});

it('reuses a local user message when only its native answer survived', () => {
  const prompt = { id: 'original-prompt', authorId: ASTERIUM_USER_ID, content: '开始', createdAt: '00:00' };
  const current = { id: 'fixture-chat', partnerId: 'fixture-partner', title: '', updatedAt: '', messages: [prompt] };
  const turns: CodexHistoryTurn[] = [{ id: 'turn-1', state: 'completed', items: [
    { id: 'prompt', kind: 'user', text: '开始' },
    { id: 'answer', kind: 'assistant', text: '已从原线程恢复' },
  ] }];
  expect(mergeNativeCodexMessages(current, turns).map(message => message.content)).toEqual(['开始', '已从原线程恢复']);
});

it('keeps a refused local message separate from an identical prompt accepted in Codex', () => {
  const current: Conversation = {
    id: 'fixture-chat', partnerId: 'fixture-partner', title: '', updatedAt: '',
    messages: [{
      id: 'refused', authorId: ASTERIUM_USER_ID, content: '继续', createdAt: '00:00', status: 'failed',
      error: codexThreadInUseFailure(new Error('CODEX_THREAD_IN_USE')),
    }],
  };
  const turns: CodexHistoryTurn[] = [{ id: 'native-turn', state: 'completed', items: [
    { id: 'prompt', kind: 'user', text: '继续' },
    { id: 'answer', kind: 'assistant', text: '继续整理中' },
  ] }];
  const messages = mergeNativeCodexMessages(current, turns);
  expect(messages.filter(message => message.authorId === ASTERIUM_USER_ID)).toHaveLength(2);
  expect(messages.find(message => message.id === 'refused')).toBe(current.messages[0]);
});

it('shows native-only turns in chronological order and leaves an active live turn alone', () => {
  const current = { id: 'fixture-chat', partnerId: 'fixture-partner', title: '', updatedAt: '', messages: [] };
  const turns: CodexHistoryTurn[] = ['third', 'second', 'first'].map(id => ({
    id, state: 'completed', items: [{ id: 'text', kind: 'assistant', text: id }],
  }));
  expect(mergeNativeCodexMessages(current, turns).map(message => message.content)).toEqual(['first', 'second', 'third']);
  expect(mergeNativeCodexMessages({ ...current, activeRun: { runId: 'third', clientMessageId: 'current' } }, turns)
    .map(message => message.content)).toEqual(['first', 'second']);
});
