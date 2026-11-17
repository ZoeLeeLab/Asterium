import { EventEmitter } from 'node:events';
import type { BrowserWindow, Input } from 'electron';
import { expect, it, vi } from 'vitest';
import { installWindowsScreenshotShortcut } from '../../src/main/settings/windowsScreenshotShortcut';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), showMessageBox: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process') & { default: typeof import('node:child_process') }>();
  return { ...original, spawn: mocks.spawn, default: { ...original.default, spawn: mocks.spawn } };
});
vi.mock('electron', () => {
  const electron = { app: { getPath: () => 'test-appdata' }, dialog: { showMessageBox: mocks.showMessageBox } };
  return { ...electron, default: electron };
});

it.runIf(process.platform === 'win32')('only handles Ctrl+Shift+A in the focused app window and skips repeated launches', async () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  mocks.spawn.mockReturnValue(child);
  const isFocused = vi.fn(() => false);
  const webContents = new EventEmitter();
  const window = { webContents, isFocused } as unknown as BrowserWindow;
  installWindowsScreenshotShortcut(window);
  const event = { preventDefault: vi.fn() };
  const input = { key: 'A', code: 'KeyA', type: 'keyDown', control: true, shift: true, alt: false, meta: false, isAutoRepeat: false } satisfies Partial<Input>;

  webContents.emit('before-input-event', event, input);
  isFocused.mockReturnValue(true);
  webContents.emit('before-input-event', event, { ...input, key: 'S', code: 'KeyS' });
  webContents.emit('before-input-event', event, { ...input, key: 'S', code: 'KeyS', control: false, meta: true });
  webContents.emit('before-input-event', event, { ...input, shift: false });
  webContents.emit('before-input-event', event, { ...input, isComposing: true });
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();

  webContents.emit('before-input-event', event, input);
  webContents.emit('before-input-event', event, { ...input, isAutoRepeat: true });
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/SnippingTool\.exe$/i), ['/clip'], expect.objectContaining({ shell: false }));
  child.emit('spawn');
  expect(child.unref).toHaveBeenCalledOnce();
  await new Promise(resolve => setImmediate(resolve));

  webContents.emit('before-input-event', event, { ...input, key: 'a' });
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
  child.emit('spawn');
  expect(mocks.showMessageBox).not.toHaveBeenCalled();
});
