import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it } from 'vitest';
import { WorkspaceShortcuts } from '../../src/renderer/components/layout/WorkspaceShortcuts';
import { PrototypeProvider } from '../../src/renderer/app/PrototypeProvider';

function Harness({ studio }: { studio: boolean }) { const location = useLocation(); return <><nav aria-label="侧栏入口"><WorkspaceShortcuts studio={studio} /></nav><output data-testid="route">{location.pathname}{location.search}</output><output data-testid="from">{location.state?.from}</output></>; }
it.each([false, true])('opens plugins and keeps the original %s route when entering settings', async studio => {
  const original = studio ? '/studio/discussion' : '/chat';
  render(<MemoryRouter initialEntries={[original]}><PrototypeProvider><Harness studio={studio} /></PrototypeProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '插件' }));
  expect(screen.getByRole('dialog', { name: '插件' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '管理 Skills' }));
  expect(screen.getByTestId('route')).toHaveTextContent('/settings/partners?section=skills');
  expect(screen.getByTestId('from')).toHaveTextContent(original);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it.each([false, true])('opens automation with the active conversation/room context for studio=%s', studio => {
  render(<MemoryRouter initialEntries={[studio ? '/studio/discussion' : '/chat']}><PrototypeProvider><Harness studio={studio} /></PrototypeProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '自动化' }));
  expect(screen.getByTestId('route').textContent).toContain(studio ? 'section=automations&room=' : 'section=automations&conversation=');
});
