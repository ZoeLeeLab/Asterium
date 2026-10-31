import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/app/App';
import { LAST_ROUTE_KEY, LAST_STUDIO_ROUTE_KEY } from '../../src/renderer/app/navigationPersistence';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';
import { STATE_KEY } from '../../src/renderer/app/persistence';
import { createTestState } from '../fixtures/applicationState';

function LocationProbe() {
  return <output aria-label="current route">{useLocation().pathname}</output>;
}

function renderApp(entry: string, state = createTestState()) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  return render(<MemoryRouter initialEntries={[entry]}><PrototypeProvider><App /><LocationProbe /></PrototypeProvider></MemoryRouter>);
}

describe('app navigation persistence', () => {
  beforeEach(() => localStorage.clear());

  it('records the current page and restores it from an otherwise unknown startup route', async () => {
    const first = renderApp('/profile');
    await waitFor(() => expect(localStorage.getItem(LAST_ROUTE_KEY)).toBe('/profile'));
    first.unmount();

    renderApp('/startup');
    await waitFor(() => expect(screen.getByLabelText('current route')).toHaveTextContent('/profile'));
  });

  it('can restore the workspace page before a project execution policy exists', async () => {
    const emptyState = { ...createTestState(), projects: [], groupChats: [], activeProjectId: '', activeGroupChatId: '' };
    localStorage.setItem(LAST_ROUTE_KEY, '/studio/workspace');

    renderApp('/startup', emptyState);

    await waitFor(() => expect(screen.getByLabelText('current route')).toHaveTextContent('/studio/workspace'));
    expect(screen.getAllByText('还没有项目').length).toBeGreaterThan(0);
  });

  it('returns from single chat to the last studio section', async () => {
    localStorage.setItem(LAST_STUDIO_ROUTE_KEY, '/studio/workspace');
    renderApp('/chat');

    screen.getByRole('button', { name: '工作室' }).click();

    await waitFor(() => expect(screen.getByLabelText('current route')).toHaveTextContent('/studio/workspace'));
  });
  it('returns old standalone diary routes to single chat without losing stored diaries', async () => {
    localStorage.setItem(LAST_ROUTE_KEY, '/diary');
    renderApp('/diary');
    await waitFor(() => expect(screen.getByLabelText('current route')).toHaveTextContent('/chat'));
    expect(screen.getByRole('button', { name: '打开测试伙伴 A的日记本' })).toBeInTheDocument();
  });
});
