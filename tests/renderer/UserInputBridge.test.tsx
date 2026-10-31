import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { PrototypeProvider, usePrototype } from '../../src/renderer/app/PrototypeProvider';
import { createTestState } from '../fixtures/applicationState';
import { STATE_KEY } from '../../src/renderer/app/persistence';
import { AGENT_PROTOCOL_VERSION, type RendererAgentEvent } from '../../src/shared/agentProtocol';
import { ASTERIUM_USER_ID } from '../../src/shared/identity';

let controls: ReturnType<typeof usePrototype> | undefined;
function Probe() { const value = usePrototype(); useEffect(() => { controls = value; }, [value]); return null; }
afterEach(() => { controls = undefined; window.asteriumAgents = undefined; });

it('preserves custom-answer metadata and exact request identities in single-chat and Studio IPC', async () => {
  const state = createTestState(); const chat = state.conversations[0]; const partner = state.partners.find((p) => p.id === chat.partnerId)!;
  chat.messages = [{ id: 'user', authorId: ASTERIUM_USER_ID, content: 'plan', createdAt: '12:00', clientMessageId: 'original' }];
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  let listener!: (event: RendererAgentEvent) => void;
  const resolveUserInput = vi.fn(async () => undefined);
  window.asteriumAgents = { detectClaude: vi.fn(), selectWorkspace: vi.fn(), sendClaudeMessage: vi.fn(), cancelRun: vi.fn(), resumeSession: vi.fn(), resolveUserInput, onEvent: (callback) => { listener = callback; return () => undefined; } };
  render(<MemoryRouter initialEntries={['/chat']}><PrototypeProvider><Probe /></PrototypeProvider></MemoryRouter>);
  await waitFor(() => expect(controls).toBeDefined());
  const base = { protocolVersion: AGENT_PROTOCOL_VERSION, partnerId: partner.id, conversationId: chat.id, connectionSource: partner.sourceMode, clientMessageId: 'original', sessionId: 'session', runId: 'run', occurredAt: new Date().toISOString() };
  const questions = [{ id: 'format', prompt: '格式', options: [{ label: 'A' }] }];
  await act(async () => {
    listener({ ...base, type: 'session.bound', eventId: 'bound', sequence: 1, isNew: true });
    listener({ ...base, type: 'user_input.requested', eventId: 'single-question', sequence: 2, requestId: 'single', questions });
  });
  await act(async () => { await controls!.resolveChatUserInput(chat.id, { format: ['自填 JSON'] }, { format: '自填 JSON' }, 'single'); });
  expect(resolveUserInput).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'single', clientMessageId: 'original', answers: { format: ['自填 JSON'] }, customAnswers: { format: '自填 JSON' } }));
  await expect(controls!.resolveChatUserInput(chat.id, { format: ['stale'] }, undefined, 'old')).rejects.toThrow('USER_INPUT_NOT_PENDING');
  const route = { scope: 'group' as const, roomId: 'room', roundId: 'round', bindingGeneration: 2, inputThroughSeq: 3 };
  await act(async () => { listener({ ...base, route, type: 'user_input.requested', eventId: 'group-question', sequence: 3, requestId: 'studio', questions }); });
  await act(async () => { await controls!.resolveStudioUserInput('room', { format: ['自填 XML'] }, { format: '自填 XML' }, 'studio'); });
  expect(resolveUserInput).toHaveBeenLastCalledWith(expect.objectContaining({ route, requestId: 'studio', answers: { format: ['自填 XML'] }, customAnswers: { format: '自填 XML' } }));
  expect(resolveUserInput).toHaveBeenCalledTimes(2);
});
