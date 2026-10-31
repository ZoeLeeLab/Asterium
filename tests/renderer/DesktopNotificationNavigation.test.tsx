import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopNotificationNavigation } from '../../src/renderer/app/DesktopNotificationNavigation';
import { PrototypeProvider, usePrototype } from '../../src/renderer/app/PrototypeProvider';
import { createTestState } from '../fixtures/applicationState';
import { STATE_KEY } from '../../src/renderer/app/persistence';
import type { DesktopNavigationTarget } from '../../src/shared/desktopNotifications';

afterEach(() => { window.asteriumDesktopNavigation = undefined; });
function Probe() {
  const location = useLocation(), { state } = usePrototype();
  return <output data-testid="route">{JSON.stringify({ path: location.pathname, search: location.search, routeState: location.state, conversation: state.activeConversationId, project: state.activeProjectId, group: state.activeGroupChatId })}</output>;
}
function setup(target: DesktopNavigationTarget) {
  const state = createTestState(); localStorage.setItem(STATE_KEY, JSON.stringify(state));
  const pending = [target]; let ready!: () => void;
  const take = vi.fn(async () => pending.shift());
  window.asteriumDesktopNavigation = { take, onReady: listener => { ready = listener; return vi.fn(); } };
  render(<StrictMode><MemoryRouter initialEntries={['/chat']}><PrototypeProvider><DesktopNotificationNavigation /><Probe /></PrototypeProvider></MemoryRouter></StrictMode>);
  return { state, take, ready: () => ready() };
}
it('retains the pending click through StrictMode and selects the intended chat', async () => {
  const state = createTestState(), target = state.conversations[1];
  const t = setup({ kind: 'conversation', conversationId: target.id });
  await waitFor(() => expect(JSON.parse(screen.getByTestId('route').textContent!).conversation).toBe(target.id));
  expect(t.take).toHaveBeenCalledOnce();
  await act(async () => { t.ready(); }); expect(JSON.parse(screen.getByTestId('route').textContent!).conversation).toBe(target.id);
});
it('routes a missing group to the discussion list without selecting an invalid member or group', async () => {
  const t = setup({ kind: 'group', roomId: 'deleted' });
  await waitFor(() => expect(JSON.parse(screen.getByTestId('route').textContent!).path).toBe('/studio/discussion'));
  expect(JSON.parse(screen.getByTestId('route').textContent!).group).toBe(t.state.activeGroupChatId);
});
it('opens the task in its project workspace and passes a scroll target', async () => {
  const state = createTestState(), project = state.projects.find(p => p.tasks.length)!;
  setup({ kind: 'project', projectId: project.id, taskId: project.tasks[0].id });
  await waitFor(() => expect(JSON.parse(screen.getByTestId('route').textContent!)).toMatchObject({ path: '/studio/workspace', project: project.id, routeState: { notificationTaskId: project.tasks[0].id } }));
});
it('opens automation history with an encoded selection', async () => {
  setup({ kind: 'automations', automationId: 'a&b' });
  await waitFor(() => expect(JSON.parse(screen.getByTestId('route').textContent!).search).toBe('?section=automations&automation=a%26b'));
});
