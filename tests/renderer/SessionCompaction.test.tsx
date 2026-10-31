import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from '../../src/renderer/components/ui/Composer';
import { PrototypeProvider, usePrototype } from '../../src/renderer/app/PrototypeProvider';
import { createTestState } from '../fixtures/applicationState';
import { STATE_KEY } from '../../src/renderer/app/persistence';

let controls: ReturnType<typeof usePrototype>;
function Probe() { const value = usePrototype(); useEffect(() => { controls = value; }, [value]); return null; }
afterEach(() => { window.asteriumAgents = undefined; });
it('invokes compact from the command menu without sending or clearing the draft and shows unsupported reasons', () => {
  const compact = vi.fn(), send = vi.fn(); const view = render(<Composer placeholder="消息" onSend={send} onCompactSession={compact} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '未发送的草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '指令' })); fireEvent.click(screen.getByRole('menuitem', { name: /压缩当前对话/ }));
  expect(compact).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled(); expect(screen.getByRole('textbox')).toHaveValue('未发送的草稿');
  view.rerender(<Composer placeholder="消息" onSend={send} compactDisabledReason="接回伙伴暂不支持" />);
  fireEvent.click(screen.getByRole('button', { name: '指令' })); expect(screen.getByRole('menuitem', { name: /压缩当前对话/ })).toBeDisabled(); expect(screen.getByText('接回伙伴暂不支持')).toBeInTheDocument();
  view.rerender(<Composer placeholder="消息" onSend={send} busy disabled />);
  expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled(); expect(screen.queryByRole('button', { name: '停止当前任务' })).not.toBeInTheDocument();
});
it('keeps maintenance scoped to the original conversation, preserves history/modes and prevents concurrent sends or duplicate requests', async () => {
  const state = createTestState(); const chat = state.conversations[0]; const partner = state.partners.find((item) => item.id === chat.partnerId)!;
  partner.isPrototype = false; if (partner.sourceMode === 'local_cli') partner.connectionKind = 'local_codex'; chat.sessionId = 's'; chat.planMode = 'plan'; chat.permissionMode = 'read_only';
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  let finish!: (result: { status: 'compacted'; message: string }) => void;
  const compactSession = vi.fn(() => new Promise<{ status: 'compacted'; message: string }>((resolve) => { finish = resolve; }));
  window.asteriumAgents = { detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(), compactSession, onEvent: () => () => undefined };
  render(<MemoryRouter><PrototypeProvider><Probe /></PrototypeProvider></MemoryRouter>);
  await waitFor(() => expect(controls).toBeDefined()); const messages = structuredClone(controls.state.conversations[0].messages);
  let running!: Promise<void>;
  await act(async () => { running = controls.compactChatContext(chat.id); });
  await act(async () => { controls.dismissChatCompaction(chat.id, controls.chatCompactions[chat.id]); });
  expect(controls.chatCompactions[chat.id].state).toBe('running');
  expect(compactSession).toHaveBeenCalledWith(expect.objectContaining({ partnerId: partner.id, conversationId: chat.id, sessionId: 's' }));
  await act(async () => { await controls.compactChatContext(chat.id); }); expect(compactSession).toHaveBeenCalledOnce();
  expect(await controls.sendChatMessage(chat.id, '不应发送')).toBe(false);
  await act(async () => { controls.selectConversation(state.conversations[1].id); finish({ status: 'compacted', message: '完成' }); await running; });
  expect(controls.chatCompactions[chat.id].state).toBe('success'); expect(controls.chatCompactions[state.conversations[1].id]).toBeUndefined();
  expect(controls.state.conversations[0]).toMatchObject({ sessionId: 's', planMode: 'plan', permissionMode: 'read_only', messages });
  await act(async () => { controls.dismissChatCompaction(chat.id, controls.chatCompactions[chat.id]); });
  expect(controls.chatCompactions[chat.id]).toBeUndefined();
  expect(controls.state.conversations[0].messages).toEqual(messages);
});

it('dismisses only the intended command result without removing a newer notice or another conversation', async () => {
  const state = createTestState(); const [first, second] = state.conversations;
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  window.asteriumAgents = { detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(), executeSessionCommand: vi.fn(async () => ({ status: 'success' as const, message: '会话状态已更新' })), onEvent: () => () => undefined };
  render(<MemoryRouter><PrototypeProvider><Probe /></PrototypeProvider></MemoryRouter>);
  await waitFor(() => expect(controls.state.activeConversationId).toBe(state.activeConversationId));
  await act(async () => { await controls.executeChatCommand(first.id, 'status'); });
  const old = controls.chatCommandResults[first.id];
  await act(async () => { await controls.executeChatCommand(first.id, 'status'); await controls.executeChatCommand(second.id, 'status'); });
  const latest = controls.chatCommandResults[first.id], other = controls.chatCommandResults[second.id];
  await act(async () => { controls.dismissChatCommandResult(first.id, old); });
  expect(controls.chatCommandResults[first.id]).toBe(latest);
  await act(async () => { controls.dismissChatCommandResult(first.id, latest); controls.selectConversation(second.id); controls.selectConversation(first.id); });
  expect(controls.chatCommandResults[first.id]).toBeUndefined();
  expect(controls.chatCommandResults[second.id]).toBe(other);
});
