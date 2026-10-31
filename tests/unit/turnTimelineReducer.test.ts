import { describe, expect, it } from 'vitest';
import { prototypeReducer } from '../../src/renderer/app/PrototypeProvider';
import { createTestState } from '../fixtures/applicationState';
import type { PartnerEvent } from '../../src/shared/agentProtocol';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';

describe('assistant turn timeline reducer', () => {
  it('merges streamed reasoning by id and keeps it separate from answer text', () => {
    let state = createTestState();
    const conversation = state.conversations[0];
    state.conversations[0] = { ...conversation, sessionId: 'session-reasoning', activeRun: { runId: 'run-reasoning', clientMessageId: 'client-reasoning' }, messages: [...conversation.messages, { id: 'user-reasoning', authorId: ASTERIUM_USER_ID, content: '请思考', createdAt: '12:00', clientMessageId: 'client-reasoning' }] };
    const base = {
      protocolVersion: 2 as const,
      partnerId: conversation.partnerId,
      conversationId: conversation.id,
      connectionSource: 'local_cli' as const,
      clientMessageId: 'client-reasoning',
      sessionId: 'session-reasoning',
      runId: 'run-reasoning',
      occurredAt: new Date().toISOString(),
    };
    const events: PartnerEvent[] = [
      { ...base, eventId: 'reasoning-start', sequence: 1, type: 'reasoning.started', reasoningId: 'reasoning-1', summary: '测试伙伴正在思考…' },
      { ...base, eventId: 'reasoning-a', sequence: 2, type: 'reasoning.delta', reasoningId: 'reasoning-1', text: '先分析' },
      { ...base, eventId: 'reasoning-b', sequence: 3, type: 'reasoning.delta', reasoningId: 'reasoning-1', text: '再回答' },
      { ...base, eventId: 'reasoning-end', sequence: 4, type: 'reasoning.completed', reasoningId: 'reasoning-1', outcome: 'completed', truncated: false },
      { ...base, eventId: 'answer', sequence: 5, type: 'text.delta', text: '最终正文' },
      { ...base, eventId: 'done', sequence: 6, type: 'run.completed', finishReason: 'completed' },
    ];
    for (const event of events) state = prototypeReducer(state, { type: 'agentEvent', event });
    const assistant = state.conversations.find((item) => item.id === conversation.id)!.messages.find((message) => message.runId === 'run-reasoning')!;
    expect(assistant.content).toBe('最终正文');
    expect(assistant.timeline).toEqual([
      expect.objectContaining({ kind: 'reasoning', reasoningId: 'reasoning-1', detail: '先分析再回答', state: 'success' }),
      expect.objectContaining({ kind: 'text', text: '最终正文' }),
    ]);
  });

  it('keeps every observed status and tool event in sequence', () => {
    let state = createTestState();
    const conversation = state.conversations[0];
    state.conversations[0] = { ...conversation, sessionId: 'session-1', activeRun: { runId: 'run-1', clientMessageId: 'client-1' }, messages: [...conversation.messages, { id: 'user-1', authorId: ASTERIUM_USER_ID, content: '请处理', createdAt: '12:00', clientMessageId: 'client-1' }] };
    const base = {
      protocolVersion: 2 as const,
      partnerId: conversation.partnerId,
      conversationId: conversation.id,
      connectionSource: 'local_cli' as const,
      clientMessageId: 'client-1',
      sessionId: 'session-1',
      runId: 'run-1',
      occurredAt: new Date().toISOString(),
    };
    const events: PartnerEvent[] = [
      { ...base, eventId: 'event-1', sequence: 1, type: 'work.status', state: 'thinking', summary: '第一段思考', detail: '第一段可展示思考' },
      { ...base, eventId: 'event-2', sequence: 2, type: 'tool.started', toolCallId: 'tool-1', toolName: 'Read', summary: '读取文件', mutatesExternalState: false },
      { ...base, eventId: 'event-3', sequence: 3, type: 'tool.progress', toolCallId: 'tool-1', summary: '读取一半' },
      { ...base, eventId: 'event-4', sequence: 4, type: 'tool.progress', toolCallId: 'tool-1', summary: '读取完成' },
      { ...base, eventId: 'event-5', sequence: 5, type: 'tool.completed', toolCallId: 'tool-1', outcome: 'success', summary: '文件已读取' },
      { ...base, eventId: 'event-6', sequence: 6, type: 'work.status', state: 'thinking', summary: '第二段思考', detail: '第二段可展示思考' },
      { ...base, eventId: 'event-7', sequence: 7, type: 'text.delta', text: '**完成**' },
      { ...base, eventId: 'event-8', sequence: 8, type: 'file.produced', artifactId: 'artifact-1', name: 'result.md', artifactRef: 'artifact-1' },
      { ...base, eventId: 'event-9', sequence: 9, type: 'run.completed', finishReason: 'completed' },
    ];
    for (const event of events) state = prototypeReducer(state, { type: 'agentEvent', event });
    const updated = state.conversations.find((item) => item.id === conversation.id)!;
    const assistant = updated.messages.find((message) => message.runId === 'run-1')!;
    expect(assistant.timeline?.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(assistant.timeline?.filter((item) => item.kind === 'tool')).toHaveLength(4);
    expect(assistant.timeline?.find((item) => item.kind === 'tool')).toMatchObject({ category: 'file_read' });
    expect(assistant.timeline?.some((item) => 'state' in item && item.state === 'running')).toBe(false);
    expect(updated.artifacts).toEqual([expect.objectContaining({ id: 'artifact-1', artifactRef: 'artifact-1' })]);
  });

  it('does not persist typing or completed-reply statuses as turn content', () => {
    let state = createTestState();
    const conversation = state.conversations[0];
    state.conversations[0] = { ...conversation, sessionId: 'session-transient', activeRun: { runId: 'run-transient', clientMessageId: 'client-transient' }, messages: [...conversation.messages, { id: 'user-transient', authorId: ASTERIUM_USER_ID, content: '请回复', createdAt: '12:00', clientMessageId: 'client-transient' }] };
    const base = {
      protocolVersion: 2 as const,
      partnerId: conversation.partnerId,
      conversationId: conversation.id,
      connectionSource: 'local_cli' as const,
      clientMessageId: 'client-transient',
      sessionId: 'session-transient',
      runId: 'run-transient',
      occurredAt: new Date().toISOString(),
    };
    const events: PartnerEvent[] = [
      { ...base, eventId: 'event-1', sequence: 1, type: 'work.status', state: 'thinking', summary: '外部伙伴正在输入…' },
      { ...base, eventId: 'event-2', sequence: 2, type: 'text.delta', text: '正常正文' },
      { ...base, eventId: 'event-3', sequence: 3, type: 'work.status', state: 'idle', summary: '外部伙伴已完成回复。' },
      { ...base, eventId: 'event-4', sequence: 4, type: 'run.completed', finishReason: 'completed' },
    ];
    for (const event of events) state = prototypeReducer(state, { type: 'agentEvent', event });
    const updated = state.conversations.find((item) => item.id === conversation.id)!;
    const assistant = updated.messages.find((message) => message.runId === 'run-transient')!;
    expect(assistant.timeline).toEqual([
      expect.objectContaining({ kind: 'text', text: '正常正文' }),
    ]);
  });

  it('restores the previous turn when a regenerated run fails', () => {
    let state = createTestState();
    const conversation = state.conversations[0];
    const originalMessages = structuredClone(conversation.messages);
    const history = originalMessages.slice(0, -2);
    state = prototypeReducer(state, { type: 'replaceLastTurn', conversationId: conversation.id, messages: history, restoreOnFailure: true });
    state = prototypeReducer(state, {
      type: 'sendChatMessage',
      conversationId: conversation.id,
      message: { id: 'retry-user', authorId: ASTERIUM_USER_ID, content: '重新提问', createdAt: '10:00', clientMessageId: 'retry-client', status: 'sending' },
    });
    state = prototypeReducer(state, { type: 'agentEvent', event: {
      protocolVersion: 2,
      eventId: 'failed-event',
      sequence: 1,
      type: 'run.failed',
      partnerId: conversation.partnerId,
      conversationId: conversation.id,
      connectionSource: 'local_cli',
      clientMessageId: 'retry-client',
      sessionId: 'session-fork',
      runId: 'run-failed',
      occurredAt: new Date().toISOString(),
      error: { code: 'FAILED', message: '重新生成失败', stage: 'adapter', retryable: true },
    } });

    const restored = state.conversations.find((item) => item.id === conversation.id)!;
    expect(restored.messages).toEqual(originalMessages);
    expect(restored.regenerationBackup).toBeUndefined();
    expect(restored.runNotice).toEqual({ state: 'failed', message: '重新生成失败', restored: true });
  });
});
