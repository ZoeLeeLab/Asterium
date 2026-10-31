import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrototypeProvider, usePrototype } from '../../src/renderer/app/PrototypeProvider';
import { ChatPage } from '../../src/renderer/pages/ChatPage';
import { STATE_KEY } from '../../src/renderer/app/persistence';
import { createTestState } from '../fixtures/applicationState';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';
import { ApiAgentRuntime } from '../../src/main/api/ApiAgentRuntime';
import { RunCoordinator } from '../../src/main/runtime/RunCoordinator';
import { AdapterHost } from '../../src/main/AdapterHost';
import type { ApiProviderAdapter, ApiProviderRequest } from '../../src/main/api/ApiProviderAdapter';
import { AGENT_PROTOCOL_VERSION, type RendererAgentEvent, type SendGuidanceCommand } from '../../src/shared/agentProtocol';
import type { ApiPartner, Conversation } from '../../src/renderer/types/domain';

let latest: Conversation | undefined;
function Probe() {
  const conversation = usePrototype().state.conversations.find((c) => c.id === 'guidance-chat');
  useEffect(() => { latest = conversation; }, [conversation]);
  return null;
}
afterEach(() => { window.asteriumAgents = undefined; latest = undefined; });

function seed() {
  const state = createTestState();
  const partner: ApiPartner = { id: 'guidance-api', publicIdentity: { displayName: '测试伙伴', introduction: '', expertise: '', mentionName: '测试伙伴' }, status: 'online', accent: '#558899', createdAt: new Date().toISOString(), sourceMode: 'api_partner', isPrototype: false, provider: 'deepseek', endpoint: 'https://fixture.invalid', model: 'fixture', personality: '', systemPrompt: '', credentialRef: 'fixture', configured: true, apiSessionHistoryEnabled: true, thinkingMode: 'auto', reasoningEffort: 'high' };
  state.partners = [partner];
  state.conversations = [{ id: 'guidance-chat', partnerId: partner.id, title: '引导测试', messages: [], updatedAt: new Date().toISOString() }];
  state.activePartnerId = partner.id; state.activeConversationId = 'guidance-chat';
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}
function fixture(delayAcknowledgement = false, failFirst = false) {
  let listener: (event: RendererAgentEvent) => void = () => undefined;
  const requests: ApiProviderRequest[] = [];
  let finish!: () => void; const finished = new Promise<void>((resolve) => { finish = resolve; });
  const provider: ApiProviderAdapter = {
    provider: 'fixture', capabilities: { streamingText: true, reasoning: false, toolCalls: true, attachments: { supportsImageInput: false, acceptedMimeTypes: [], maxImageBytes: 0, attachmentTransport: 'metadata_only' } },
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: 'text.delta', text: '初始回复正文' };
        await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        request.signal.throwIfAborted();
      } else { yield { type: 'text.delta', text: '已按补充要求继续' }; yield { type: 'finish', reason: 'stop' }; }
    },
  };
  const sourceApplied = vi.fn();
  const runtime = new ApiAgentRuntime({ provider });
  const coordinator = new RunCoordinator(new AdapterHost(), { deliver: () => undefined, emit: (event) => { listener(event); if (event.type === 'run.completed') finish(); }, observe: async () => undefined, onEvent: async (event) => { if (event.type === 'guidance.applied') sourceApplied(event.sourceMessage); } });
  let calls = 0;
  const sendGuidance = vi.fn(async (command: SendGuidanceCommand) => {
    if (failFirst && ++calls === 1) throw new Error('synthetic failure');
    const result = await coordinator.sendGuidance(command);
    if (delayAcknowledgement) await finished;
    return result;
  });
  const sendApiMessage = vi.fn(async (_connection, command) => coordinator.start(runtime, command));
  window.asteriumAgents = { detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: (command) => coordinator.cancel(command), resumeSession: vi.fn(), sendApiMessage, sendGuidance, onEvent: (callback) => { listener = callback; return () => { listener = () => undefined; }; } };
  seed();
  render(<MemoryRouter initialEntries={['/chat']}><PrototypeProvider><Probe /><ChatPage /></PrototypeProvider></MemoryRouter>);
  return { sendApiMessage, sendGuidance, requests, sourceApplied, finished };
}

async function startAndStage() {
  const input = await screen.findByRole('textbox', { name: /给 测试伙伴 发送消息/ });
  fireEvent.change(input, { target: { value: '开始任务' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('初始回复正文');
  const guidance = screen.getByRole('textbox', { name: /输入补充要求/ });
  fireEvent.change(guidance, { target: { value: '补充：请调整方向' } });
  fireEvent.keyDown(guidance, { key: 'Enter' });
  return screen.getByLabelText('待发送的中途消息');
}

describe('API guidance through the actual chat page and run coordinator', () => {
  it.each([false, true])('stages then steers the same task, including events before IPC acknowledgement (%s)', async (delayAck) => {
    const f = fixture(delayAck);
    const card = await startAndStage();
    expect(f.requests).toHaveLength(1);
    expect(f.sendGuidance).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: '发送' }));
    await screen.findByText('已按补充要求继续');
    await waitFor(() => expect(screen.queryByLabelText('待发送的中途消息')).not.toBeInTheDocument());
    expect(f.sendApiMessage).toHaveBeenCalledOnce(); expect(f.sendGuidance).toHaveBeenCalledOnce();
    expect(f.requests).toHaveLength(2);
    expect(latest?.messages.map((m) => m.content)).toEqual(['开始任务', '初始回复正文', '补充：请调整方向', '已按补充要求继续']);
    const g = latest?.messages.find((m) => m.isGuidance);
    expect(g).toMatchObject({ status: 'delivered', guidanceState: 'applied', authorId: ASTERIUM_USER_ID });
    expect(latest?.activeRun).toBeUndefined();
    expect(f.sourceApplied).toHaveBeenCalledWith(expect.objectContaining({ messageId: g?.id, content: g?.content }));
  });

  it('retains failed guidance for retry using the same identity and never duplicates its visible message', async () => {
    const f = fixture(false, true); const card = await startAndStage();
    fireEvent.click(within(card).getByRole('button', { name: '发送' }));
    await screen.findByText('未能发送，请重试。');
    await waitFor(() => expect(latest?.messages.some((m) => m.isGuidance)).toBe(false));
    fireEvent.click(within(screen.getByLabelText('待发送的中途消息')).getByRole('button', { name: '发送' }));
    await screen.findByText('已按补充要求继续');
    expect(f.sendGuidance.mock.calls[0][0].clientMessageId).toBe(f.sendGuidance.mock.calls[1][0].clientMessageId);
    expect(latest?.messages.filter((m) => m.isGuidance)).toHaveLength(1);
  });

  it('can discard staged guidance without changing or interrupting the active request', async () => {
    const f = fixture(); const card = await startAndStage();
    fireEvent.click(within(card).getByRole('button', { name: '取消待发送消息' }));
    expect(f.sendGuidance).not.toHaveBeenCalled(); expect(f.requests[0].signal.aborted).toBe(false);
    await act(async () => {
      const run = latest!.activeRun!;
      await window.asteriumAgents!.cancelRun({ protocolVersion: AGENT_PROTOCOL_VERSION, type: 'run.cancel', commandId: 'cancel', partnerId: latest!.partnerId, conversationId: latest!.id, connectionSource: 'api_partner', clientMessageId: run.clientMessageId, runId: run.runId, sessionId: latest!.sessionId! });
    });
    await waitFor(() => expect(latest?.activeRun).toBeUndefined());
  });
});
