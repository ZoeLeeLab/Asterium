import { describe, expect, it } from 'vitest';
import { assertSingleChatConversationSnapshots, isMessageTimestamp } from '../../src/shared/singleChatMessages';
import { createSingleChatMessage } from '../../src/renderer/app/singleChatRuntime';

describe('real single-chat event time', () => {
  it('keeps the display clock separate from an ISO event timestamp', () => {
    const message = createSingleChatMessage('hello');
    expect(isMessageTimestamp(message.occurredAt)).toBe(true);
    expect(message.createdAt).toMatch(/^\d\d:\d\d$/u);
  });
  it('accepts old undated messages without inventing dates', () => {
    const snapshots = [{ conversationId: 'c', partnerId: 'p', messages: [{ messageId: 'm', authorType: 'user', authorId: 'u', content: 'old', createdAt: '12:30' }] }];
    expect(() => assertSingleChatConversationSnapshots(snapshots)).not.toThrow();
    expect(snapshots[0].messages[0]).not.toHaveProperty('occurredAt');
    expect(() => assertSingleChatConversationSnapshots([{ ...snapshots[0], messages: [{ ...snapshots[0].messages[0], occurredAt: '12:30' }] }])).toThrow();
  });
});
