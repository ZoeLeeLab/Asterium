import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from '../../src/renderer/components/ui/Composer';
import { StudioComposer } from '../../src/renderer/components/studio/StudioComposer';
import { DEFAULT_GENERAL_SETTINGS, type GeneralSettingsSnapshot } from '../../src/shared/generalSettings';

afterEach(() => { window.asteriumGeneralSettings = undefined; });
function mockSettings() {
  let changed!: (s: GeneralSettingsSnapshot) => void;
  const snapshot: GeneralSettingsSnapshot = { revision: 1, settings: { ...DEFAULT_GENERAL_SETTINGS, sendShortcut: 'ctrl_enter' }, startupSupported: false };
  const get = vi.fn(async () => snapshot);
  window.asteriumGeneralSettings = { get, update: vi.fn(), onChanged: listener => { changed = listener; return vi.fn(); } };
  return { get, change: () => changed({ ...snapshot, revision: 2, settings: { ...snapshot.settings, sendShortcut: 'enter' } }) };
}
it.each(['single', 'studio'])('uses the saved shortcut and changes it live in %s chat without disturbing drafts', async kind => {
  const settings = mockSettings(), send = vi.fn(async () => false);
  render(kind === 'single' ? <Composer placeholder="消息" onSend={send} /> : <StudioComposer placeholder="消息" members={[]} onSend={send} />);
  await act(async () => { await Promise.resolve(); });
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: '保留草稿' } });
  fireEvent.keyDown(input, { key: 'Enter' }); expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, keyCode: 229 });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, altKey: true });
  expect(send).not.toHaveBeenCalled(); expect(input).toHaveValue('保留草稿');
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }); await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(input).toHaveValue('保留草稿'); send.mockClear();
  act(() => settings.change()); fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); expect(send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' }); await waitFor(() => expect(send).toHaveBeenCalledOnce());
});
it('selects a mention before handling the send shortcut', async () => {
  mockSettings(); const send = vi.fn();
  render(<StudioComposer placeholder="消息" members={[{ partnerId: 'p', displayName: '伙伴', mentionName: '伙伴', expertise: '' }]} onSend={send} />);
  await act(async () => { await Promise.resolve(); });
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: '@', selectionStart: 1 } });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }); expect(send).not.toHaveBeenCalled(); expect(input).toHaveValue('@伙伴 ');
});
