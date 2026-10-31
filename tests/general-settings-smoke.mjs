// Isolated packaged acceptance. Does not change Windows login registration or call models.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'asterium-general-smoke-'));
const evidence = path.join(root, '.qa', 'general-settings'); await mkdir(evidence, { recursive: true });
const executablePath = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe');
let app;
try {
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${temporary}`] });
  const page = await app.firstWindow(); await page.getByLabel('主要页面').waitFor();
  await page.evaluate(() => { globalThis.location.hash = '#/settings'; });
  await page.getByRole('heading', { name: '通用', exact: true }).waitFor();
  const shortcut = page.getByLabel('发送快捷键'); await shortcut.waitFor();
  await page.waitForFunction(() => !globalThis.document.querySelector('select[aria-label="发送快捷键"]').disabled);
  assert.equal(await page.getByRole('checkbox', { name: /启动时自动检查更新/ }).isDisabled(), true);
  await shortcut.selectOption('ctrl_enter');
  await page.waitForFunction(async () => (await globalThis.asteriumGeneralSettings.get()).settings.sendShortcut === 'ctrl_enter');
  await page.reload(); await page.getByRole('heading', { name: '通用', exact: true }).waitFor();
  await page.waitForFunction(() => globalThis.document.querySelector('select[aria-label="发送快捷键"]').value === 'ctrl_enter');
  await page.screenshot({ path: path.join(evidence, 'general.png') });
  assert.equal(await shortcut.evaluate(element => globalThis.getComputedStyle(element).height), '40px');
  await page.setViewportSize({ width: 1180, height: 720 });
  await page.getByRole('navigation', { name: '设置菜单' }).getByRole('button', { name: /外观/ }).click();
  await page.getByRole('radio', { name: '深色', exact: true }).click();
  await page.getByRole('navigation', { name: '设置菜单' }).getByRole('button', { name: '通用', exact: true }).click();
  await page.getByRole('heading', { name: '通用', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  await page.screenshot({ path: path.join(evidence, 'general-dark-compact.png') });
  // Intercept form submission so real keyboard interaction never invokes a model.
  await page.evaluate(() => {
    globalThis.__sendCount = 0;
    globalThis.document.addEventListener('submit', event => { event.preventDefault(); event.stopImmediatePropagation(); globalThis.__sendCount++; }, true);
    globalThis.location.hash = '#/chat';
  });
  const singleInput = page.locator('.composer textarea'); await singleInput.fill('快捷键隔离测试');
  await singleInput.press('Enter'); assert.equal(await page.evaluate(() => globalThis.__sendCount), 0);
  await singleInput.press('Control+Enter'); await page.waitForFunction(() => globalThis.__sendCount === 1);
  await singleInput.press('Shift+Enter'); assert.equal(await page.evaluate(() => globalThis.__sendCount), 1);
  await page.evaluate(() => { globalThis.location.hash = '#/studio/discussion'; });
  const groupInput = page.locator('.studio-composer textarea'); await groupInput.fill('群聊快捷键隔离测试');
  await groupInput.press('Enter'); assert.equal(await page.evaluate(() => globalThis.__sendCount), 1);
  await groupInput.press('Control+Enter'); await page.waitForFunction(() => globalThis.__sendCount === 2);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).length), 1);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  const secondary = spawn(executablePath, [`--user-data-dir=${temporary}`], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { secondary.kill(); reject(Error('SECOND_INSTANCE_TIMEOUT')); }, 15_000);
    secondary.once('error', error => { clearTimeout(timer); reject(error); });
    secondary.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(Error('SECOND_INSTANCE_EXIT_' + code)); });
  });
  await page.waitForFunction(() => globalThis.document.visibilityState === 'visible');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await page.evaluate(() => globalThis.asteriumGeneralSettings.update({ closeAction: 'quit' }));
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].close(), 50); });
  await closed; app = undefined;
  console.log(JSON.stringify({ status: 'passed', cases: ['general-menu', 'save-reload', 'update-unavailable', 'single-chat-keyboard', 'studio-keyboard', 'tray-retains-window', 'second-instance-restores', 'explicit-close-exits'], manual: ['Windows login autostart', 'OS notification policies'] }));
} finally {
  if (app) await app.close();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('asterium-general-smoke-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
