import { describe, expect, it } from 'vitest';
import { apiHistory } from '../../src/renderer/app/apiContext';
import { assistantMessageText, formatMessageWithQuote, messageTextForRuntime } from '../../src/renderer/app/messageQuote';
import type { Message, MessageQuote } from '../../src/renderer/types/domain';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';

const quote: MessageQuote = {
  sourceMessageId: 'assistant-source',
  sourcePartnerId: 'partner-co',
  sourcePartnerName: '测试助手',
  kind: 'selection',
  text: '只引用这一段。',
};

describe('message quotes', () => {
  it('extracts only visible assistant text blocks in timeline order', () => {
    const message: Message = {
      id: 'assistant-source', authorId: 'partner-co', content: '重复正文', createdAt: '12:00', runState: 'completed',
      timeline: [
        { id: 'reasoning', sequence: 1, kind: 'reasoning', summary: '想好了', state: 'success', detail: '不能引用的思考' },
        { id: 'text-1', sequence: 2, kind: 'text', text: '第一段' },
        { id: 'text-1-delta', sequence: 3, kind: 'text', text: '正文' },
        { id: 'tool', sequence: 4, kind: 'tool', toolCallId: 'tool-1', summary: '处理好了', state: 'success' },
        { id: 'text-2', sequence: 5, kind: 'text', text: '第二段正文' },
      ],
    };
    expect(assistantMessageText(message)).toBe('第一段正文\n\n第二段正文');
  });

  it('keeps renderer content structured and formats one shared runtime prompt', () => {
    expect(formatMessageWithQuote('请继续说明', quote)).toBe('[引用内容 · 测试助手 · 选中片段]\n只引用这一段。\n[引用结束]\n\n[用户本轮消息]\n请继续说明');
    expect(messageTextForRuntime({ id: 'user', authorId: ASTERIUM_USER_ID, content: '请继续说明', quote, createdAt: '12:01' })).toContain('只引用这一段。');
  });

  it('includes the quote in API history without mutating the stored user body', () => {
    const message: Message = { id: 'user', authorId: ASTERIUM_USER_ID, content: '请继续说明', quote, createdAt: '12:01' };
    expect(apiHistory([message])).toEqual([{ role: 'user', content: formatMessageWithQuote('请继续说明', quote) }]);
    expect(message.content).toBe('请继续说明');
  });
});
