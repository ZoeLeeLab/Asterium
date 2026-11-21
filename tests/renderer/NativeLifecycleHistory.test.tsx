import { StrictMode, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestState } from '../fixtures/applicationState';
import { prototypeReducer } from '../../src/renderer/app/PrototypeProvider';
import { prepareSingleChatProfile } from '../../src/renderer/app/persistence';
import { useSingleChatHistory } from '../../src/renderer/app/useSingleChatHistory';
import type { NativeLifecycleUpdate } from '../../src/renderer/types/domain';

afterEach(() => { window.asteriumConversations = undefined; });

it('does not persist unchanged checks, retains freshness, and writes changed conversations together', async () => {
  const seed = createTestState();
  seed.conversations = seed.conversations.slice(0, 2).map(conversation => ({
    ...conversation, sessionId: 'session:' + conversation.id, nativeThreadState: 'active',
    nativeThreadStateCheckedAt: '2026-11-21T00:00:00.000Z', messages: [],
  }));
  const write = vi.fn(async () => undefined);
  window.asteriumConversations = {
    delete: vi.fn(), listDeleted: vi.fn(async () => []),
    openHistory: vi.fn(async () => ({ generation: 'fixture-generation', profile: prepareSingleChatProfile(seed), conversations: seed.conversations })),
    migrateHistory: vi.fn(), writeHistory: write,
  };
  const { result } = renderHook(() => useSingleChatHistory(prototypeReducer), {
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
  });
  await waitFor(() => expect(result.current.ready).toBe(true));
  const original = result.current.state;
  const updates: NativeLifecycleUpdate[] = original.conversations.map(conversation => ({
    type: 'syncNativeThreadLifecycle', conversationId: conversation.id, state: 'active', checkedAt: '2026-11-21T00:02:00.000Z',
  }));
  act(() => result.current.dispatch({ type: 'syncNativeThreadLifecycles', updates }));
  expect(result.current.state).toBe(original);
  expect(write).not.toHaveBeenCalled();
  const stale: NativeLifecycleUpdate = { ...updates[0], state: 'deleted', checkedAt: '2026-11-21T00:01:00.000Z' };
  expect(result.current.isCurrentLifecycleUpdate(stale)).toBe(false);
  act(() => result.current.dispatch(stale));
  expect(result.current.state).toBe(original);
  act(() => result.current.dispatch({ type: 'syncNativeThreadLifecycles', updates: updates.map(update => ({
    ...update, state: 'archived', checkedAt: '2026-11-21T00:03:00.000Z',
  })) }));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  const [input] = write.mock.calls[0] as unknown as [{ changes: { conversationId: string }[] }];
  expect(input.changes.map(change => change.conversationId)).toEqual(original.conversations.map(conversation => conversation.id));
  expect(result.current.state.conversations.every(conversation => conversation.isArchived)).toBe(true);
});
