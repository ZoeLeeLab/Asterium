import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AutomationConfirmationHost } from '../../src/renderer/components/settings/AutomationConfirmationDialog';
import type { AutomationConfirmation } from '../../src/shared/automations';

const proposal: AutomationConfirmation = { id: 'proposal', action: 'create', partnerName: '本地伙伴', targetLabel: '本地伙伴 · 原对话', task: { name: '自动化验收', instructions: '只回复验收完成。', schedule: { type: 'once', at: '2026-10-25T07:00:00Z' }, timezone: 'Asia/Shanghai', catchUp: 'skip', notifications: 'always', enabled: true } };
afterEach(() => vi.unstubAllGlobals());
it('shows a themed readable proposal even after mounting mid-request, focuses cancel and sends only a decision', async () => {
  const resolveConfirmation = vi.fn(async () => undefined);
  vi.stubGlobal('asteriumAutomations', { confirmations: async () => [proposal], onConfirmationsChanged: () => () => undefined, resolveConfirmation });
  render(<AutomationConfirmationHost />);
  const dialog = await screen.findByRole('dialog', { name: '保存这项自动化？' });
  expect(dialog).toHaveTextContent('2026年10月25日 15:00'); expect(dialog).toHaveTextContent('Asia/Shanghai');
  expect(dialog).toHaveTextContent('错过时跳过'); expect(dialog).toHaveTextContent('当前发起权限需要确认计划变更；完整权限下由伙伴直接保存');
  expect(dialog).not.toHaveTextContent('"type":"once"'); await waitFor(() => expect(screen.getByRole('button', { name: '取消' })).toHaveFocus());
  fireEvent.click(screen.getByRole('button', { name: '确认保存' }));
  await waitFor(() => expect(resolveConfirmation).toHaveBeenCalledWith({ id: proposal.id, approved: true }));
});
it('Escape rejects rather than saving and pending queue updates close the modal', async () => {
  let pending = [proposal]; let refresh!: () => void;
  const resolveConfirmation = vi.fn(async () => { pending = []; refresh(); });
  vi.stubGlobal('asteriumAutomations', { confirmations: async () => pending, onConfirmationsChanged: (fn: () => void) => { refresh = fn; return () => undefined; }, resolveConfirmation });
  render(<AutomationConfirmationHost />); await screen.findByRole('dialog');
  fireEvent.keyDown(screen.getByRole('button', { name: '取消' }), { key: 'Escape' });
  await waitFor(() => expect(resolveConfirmation).toHaveBeenCalledWith({ id: proposal.id, approved: false }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
