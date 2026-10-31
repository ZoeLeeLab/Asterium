import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { GeneralSettingsStore } from '../../src/main/settings/GeneralSettingsStore';
import { windowsStartupRegistration } from '../../src/main/settings/windowsStartup';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() { const dir = await mkdtemp(path.join(os.tmpdir(), 'asterium-general-unit-')); directories.push(dir); const file = path.join(dir, 'general.json'); return { file, store: new GeneralSettingsStore(file) }; }
it('uses defaults, merges independent edits serially and reloads saved settings', async () => {
  const { store, file } = await setup(); const listener = vi.fn(); store.subscribe(listener);
  expect((await store.get()).settings).toMatchObject({ closeAction: 'tray', sendShortcut: 'enter', launchAtLogin: false });
  await Promise.all([store.update({ closeAction: 'quit' }), store.update({ notifications: { approval: false } })]);
  const reloaded = await new GeneralSettingsStore(file).get();
  expect(reloaded.revision).toBe(2); expect(reloaded.settings).toMatchObject({ closeAction: 'quit', notifications: { approval: false, completed: true, automationFailed: true } });
  expect(listener).toHaveBeenCalledTimes(2);
});
it('rejects unknown settings and unavailable startup without changing stored state', async () => {
  const { store } = await setup();
  await expect(store.update({ shell: 'anything' })).rejects.toThrow();
  await expect(store.update({ launchAtLogin: true })).rejects.toThrow('STARTUP_UNAVAILABLE');
  expect((await store.get()).revision).toBe(0);
});
it('does not silently replace damaged storage with defaults', async () => {
  const { store, file } = await setup(); await writeFile(file, '{bad');
  await expect(store.get()).rejects.toThrow(); await expect(store.update({ closeAction: 'quit' })).rejects.toThrow();
});
it('adds disabled sandbox defaults to old files and preserves enabled sandbox on unrelated updates', async () => {
  const { store, file } = await setup();
  const old = (await store.get()).settings;
  const { sandboxEnabled: _enabled, sandboxAllowNetwork: _network, ...legacy } = old;
  void _enabled; void _network;
  await writeFile(file, JSON.stringify({ version: 1, revision: 0, settings: legacy }));
  expect((await store.get()).settings).toMatchObject({ sandboxEnabled: false, sandboxAllowNetwork: false });
  await store.update({ sandboxEnabled: true, sandboxAllowNetwork: true });
  await store.update({ sendShortcut: 'ctrl_enter' });
  expect((await store.get()).settings).toMatchObject({ sandboxEnabled: true, sandboxAllowNetwork: true });
});
it('does not commit sandbox settings when affected resources cannot be closed', async () => {
  const { store } = await setup();
  store.setSandboxTransition(async () => { throw new Error('cleanup failed'); });
  await expect(store.update({ sandboxEnabled: true })).rejects.toThrow('cleanup failed');
  expect((await store.get()).settings.sandboxEnabled).toBe(false);
  expect((await store.get()).revision).toBe(0);
});
it('reads actual Windows startup registration and verifies mutations', async () => {
  const { file } = await setup(); let enabled = false;
  const store = new GeneralSettingsStore(file, { get: () => enabled, set: value => { enabled = value; } });
  expect((await store.get()).startupSupported).toBe(true);
  await store.update({ launchAtLogin: true }); expect(enabled).toBe(true);
  enabled = false; expect((await store.get()).settings.launchAtLogin).toBe(false);
  await store.update({ closeAction: 'quit' }); expect((await store.get()).settings.launchAtLogin).toBe(false);
});
it('rejects unconfirmed OS writes and restores registration if persistence fails', async () => {
  const { file } = await setup();
  const ignored = new GeneralSettingsStore(file, { get: () => false, set: () => undefined });
  await expect(ignored.update({ launchAtLogin: true })).rejects.toThrow('STARTUP_REGISTRATION_FAILED');
  let enabled = false;
  const broken = new GeneralSettingsStore(file, { get: () => enabled, set: value => { enabled = value; if (value) mkdirSync(file); } });
  await expect(broken.update({ launchAtLogin: true })).rejects.toThrow(); expect(enabled).toBe(false);
});
it('does not report a Windows-disabled startup entry as enabled', () => {
  const getLoginItemSettings = vi.fn(() => ({ openAtLogin: true, executableWillLaunchAtLogin: false })), setLoginItemSettings = vi.fn();
  const port = windowsStartupRegistration({ getLoginItemSettings, setLoginItemSettings } as unknown as Parameters<typeof windowsStartupRegistration>[0], 'C:\\test\\Asterium.exe');
  expect(port.get()).toBe(false); getLoginItemSettings.mockReturnValue({ openAtLogin: true, executableWillLaunchAtLogin: true }); expect(port.get()).toBe(true);
  port.set(true); expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, enabled: true, path: 'C:\\test\\Asterium.exe', args: [] });
});
