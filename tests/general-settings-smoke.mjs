// Isolated packaged acceptance. Does not change Windows login registration or call models.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'asterium-general-smoke-'));
const evidence = path.resolve(process.env.ASTERIUM_UI_EVIDENCE_DIR ?? path.join(root, '.qa', 'general-settings')); await mkdir(evidence, { recursive: true });
const executablePath = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe');
// Product startup is empty. Keyboard checks deliberately load this source-owned,
// synthetic fixture into this process only; nothing is added to the application.
const compiled = await build({ configFile: false, logLevel: 'error', build: { write: false, minify: false, lib: { entry: path.join(root, 'tests/fixtures/applicationState.ts'), formats: ['cjs'] } } });
const code = (Array.isArray(compiled) ? compiled[0] : compiled).output.find(item => item.type === 'chunk' && item.isEntry).code;
const fixtureModule = new Module(path.join(temporary, 'fixture.cjs')); fixtureModule.filename = path.join(temporary, 'fixture.cjs'); fixtureModule.paths = Module._nodeModulePaths(root); fixtureModule._compile(code, fixtureModule.filename);
const fixture = fixtureModule.exports.createTestState();
fixture.partners = fixture.partners.filter(partner => partner.sourceMode === 'api_partner');
fixture.projects = [fixture.projects[0]]; fixture.projects[0].memberIds = [fixture.partners[0].id]; fixture.projects[0].files = []; fixture.projects[0].tasks = [];
fixture.groupChats = [{ ...fixture.groupChats[0], memberIds: [fixture.partners[0].id] }];
fixture.conversations = [{ ...fixture.conversations[0], id: 'settings-test-conversation', partnerId: fixture.partners[0].id, messages: [] }];
fixture.activePartnerId = fixture.partners[0].id; fixture.activeConversationId = fixture.conversations[0].id;
const workspace = path.join(temporary, 'synthetic-project'); await mkdir(path.join(workspace, 'deliverables'), { recursive: true });
const { files, tasks, ...project } = fixture.projects[0]; void files; void tasks;
await writeFile(path.join(temporary, 'project-domain.v1.json'), JSON.stringify({ version: 1, projects: [project], tasks: [] }));
await writeFile(path.join(temporary, 'project-workspaces.v1.json'), JSON.stringify({ version: 1, projects: [{ version: 1, projectId: project.id, name: project.name, rootPath: workspace, deliverablesPath: path.join(workspace, 'deliverables'), templateFiles: [], createdAt: project.createdAt, updatedAt: project.updatedAt }] }));
let app;
try {
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${temporary}`] });
  const page = await app.firstWindow(); await page.getByLabel('主要页面').waitFor();
  await page.evaluate(state => { localStorage.setItem('asterium.prototype.v7', JSON.stringify(state)); }, fixture);
  await page.reload(); await page.getByLabel('主要页面').waitFor();
  await page.evaluate(() => { globalThis.location.hash = '#/settings'; });
  await page.getByRole('heading', { name: '通用', exact: true }).waitFor();
  const shortcut = page.getByLabel('发送快捷键'); await shortcut.waitFor();
  await page.waitForFunction(() => !globalThis.document.querySelector('select[aria-label="发送快捷键"]').disabled);
  await page.getByRole('navigation', { name: '设置菜单' }).getByRole('button', { name: '关于', exact: true }).click();
  await page.getByRole('heading', { name: '星丛 Asterium', exact: true }).waitFor();
  assert.equal(await page.getByRole('status').textContent(), '更新源待配置');
  await page.waitForFunction(async () => (await globalThis.asteriumUpdates.get()).configured === true);
  assert.equal(await page.getByRole('checkbox', { name: /启动时自动检查更新/ }).isDisabled(), false);
  assert.equal(await page.evaluate(async () => (await globalThis.asteriumUpdates.get()).repository), 'ZoeLeeLab/Asterium');
  assert.equal(await page.getByRole('button', { name: 'ZoeLeeLab/Asterium', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: '更新历史', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: '下载新版本', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '退出并安装', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(evidence, 'about.png') });
  await page.getByRole('navigation', { name: '设置菜单' }).getByRole('button', { name: '通用', exact: true }).click();
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
  const result = { status: 'passed', syntheticFixtureSha256: createHash('sha256').update(code).digest('hex'), realModelCalled: false, realAccountUsed: false, cases: ['general-menu', 'save-reload', 'about-and-configured-public-updates', 'single-chat-keyboard', 'studio-keyboard', 'tray-retains-window', 'second-instance-restores', 'explicit-close-exits'], manual: ['Windows login autostart', 'OS notification policies', 'real update download and upgrade after a published release exists'] };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (app) await app.close();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('asterium-general-smoke-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
