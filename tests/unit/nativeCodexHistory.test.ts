import { expect, it } from 'vitest';
import type { CodexHistoryTurn } from '../../src/shared/codexHistory';
import { mergeNativeCodexMessages } from '../../src/renderer/app/nativeCodexHistory';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';
import type { Conversation } from '../../src/renderer/types/domain';

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

it('shows native-only turns in chronological order and leaves an active live turn alone', () => {
  const current = { id: 'fixture-chat', partnerId: 'fixture-partner', title: '', updatedAt: '', messages: [] };
  const turns: CodexHistoryTurn[] = ['third', 'second', 'first'].map(id => ({
    id, state: 'completed', items: [{ id: 'text', kind: 'assistant', text: id }],
  }));
  expect(mergeNativeCodexMessages(current, turns).map(message => message.content)).toEqual(['first', 'second', 'third']);
  expect(mergeNativeCodexMessages({ ...current, activeRun: { runId: 'third', clientMessageId: 'current' } }, turns)
    .map(message => message.content)).toEqual(['first', 'second']);
});
