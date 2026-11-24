import { expect, it } from 'vitest';
import { visibleNativeHistoryTurns } from '../../src/main/conversation/NativeHistoryVisibility';
import { mergeNativeCodexMessages, mergePage } from '../../src/renderer/app/nativeCodexHistory';
import type { CodexHistoryTurn } from '../../src/shared/codexHistory';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';

it('hides only the Main-recorded internal input, keeping the reply, tools and later user guidance', () => {
  const turns: CodexHistoryTurn[] = [{ id: 'fixture-report-turn', state: 'completed', items: [
    { id: 'fixture-native-generated-id', kind: 'user', text: '合成内部回传资料' },
    { id: 'fixture-tool', kind: 'tool', label: '合成操作', state: 'success' },
    { id: 'fixture-guidance', kind: 'user', text: '请简短一些' },
    { id: 'fixture-reply', kind: 'assistant', text: '合成伙伴汇报' },
  ] }];
  const visible = visibleNativeHistoryTurns(turns, { userMessageIds: new Set(), turnIds: new Set(['fixture-report-turn']) });
  expect(visible[0].items.map(item => item.id)).toEqual(['fixture-tool', 'fixture-guidance', 'fixture-reply']);
  expect(turns[0].items).toHaveLength(4);
});

it('uses recorded message identity if a request was interrupted before its native turn could be saved', () => {
  const turns: CodexHistoryTurn[] = [{ id: 'fixture-turn', state: 'interrupted', items: [
    { id: 'fixture-internal-input', kind: 'user', text: '合成内部回传' },
    { id: 'fixture-reply', kind: 'assistant', text: '合成部分回复' },
  ] }];
  const visible = visibleNativeHistoryTurns(turns, { userMessageIds: new Set(['fixture-internal-input']), turnIds: new Set() });
  expect(visible[0].items).toEqual([turns[0].items[1]]);
});

it('keeps genuine user messages even when they quote the internal heading or the exact same text', () => {
  const turns: CodexHistoryTurn[] = [{ id: 'fixture-user-turn', state: 'completed', items: [
    { id: 'fixture-user-input', kind: 'user', text: '【星丛内部：原会话委派结果到达】\n合成内部回传资料' },
  ] }];
  expect(visibleNativeHistoryTurns(turns, { userMessageIds: new Set(['fixture-other']), turnIds: new Set(['fixture-other']) })[0]).toBe(turns[0]);
});

it('removes a previously visible native-only internal bubble on refresh without losing the partner report', () => {
  const turn: CodexHistoryTurn = { id: 'fixture-report-turn', state: 'completed', items: [
    { id: 'fixture-prompt', kind: 'user', text: '合成内部资料' }, { id: 'fixture-answer', kind: 'assistant', text: '合成汇报' },
  ] };
  const chat = { id: 'fixture-chat', partnerId: 'fixture-partner', title: '', updatedAt: '', messages: [] };
  expect(mergeNativeCodexMessages(chat, [turn]).some(message => message.authorId === ASTERIUM_USER_ID)).toBe(true);
  const refreshed = mergePage({ key: 'fixture', turns: [turn] }, 'fixture', {
    turns: visibleNativeHistoryTurns([turn], { userMessageIds: new Set(), turnIds: new Set([turn.id]) }),
  }, false);
  const visible = mergeNativeCodexMessages(chat, refreshed.turns);
  expect(visible.map(message => message.content)).toEqual(['合成汇报']);
  expect(visible[0].authorId).toBe('fixture-partner');
});
