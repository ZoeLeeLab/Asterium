/* global window */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import electronPath from 'electron';
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';
import { autoTestOutput, createTestNetServer, createTestViteServer, runAutoTest, spawnTestProcess } from './helpers/autoTest.mjs';

const execute = promisify(execFile);
const stateKey = 'asterium.prototype.v7';
await runAutoTest(async () => {
  const output = autoTestOutput();
  const profile = path.join(output, 'profile');
  const appDirectory = path.join(output, 'app');
  const renderer = path.join(output, 'renderer');
  await mkdir(profile, { recursive: true });
  await mkdir(appDirectory, { recursive: true });
  const loader = await createTestViteServer({ configFile: 'vite.renderer.config.ts', server: { middlewareMode: true } });
  const { createTestState } = await loader.ssrLoadModule(path.resolve('tests/fixtures/applicationState.ts'));
  const fixture = createTestState();
  await loader.close();
  const conversationId = fixture.activeConversationId;
  const original = fixture.conversations.find(chat => chat.id === conversationId);
  const legacyFile = path.join(profile, 'single-chat-messages.v1.json');
  const projected = {
    version: 1,
    conversations: {
      [conversationId]: {
        conversationId, partnerId: original.partnerId,
        messages: [{ messageId: 'main-projection-only', authorId: original.partnerId, authorType: 'partner', content: '旧投影补回记录', createdAt: '10:33' }],
      },
    },
  };
  const legacyBytes = JSON.stringify(projected);
  await writeFile(legacyFile, legacyBytes);
  await writeFile(path.join(profile, '.asterium-profile.v1.json'), JSON.stringify({ version: 1, profile: 'autotest' }));

  const rendererConfig = { configFile: 'vite.renderer.config.ts', logLevel: 'error', cacheDir: autoTestOutput(), build: { outDir: renderer } };
  await build(rendererConfig);
  let starts = 0;
  const server = await preview({
    ...rendererConfig,
    preview: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'synthetic-beta-storage',
      configurePreviewServer(instance) {
        instance.middlewares.use((request, response, next) => {
          if (request.url !== '/') { next(); return; }
          const source = starts++ === 0 ? JSON.stringify(fixture) : '{"stale":true}';
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end('<!doctype html><script>localStorage.setItem(' + JSON.stringify(stateKey) + ','
            + JSON.stringify(source).replaceAll('<', '\\u003c') + ');location.replace("/index.html#/chat");</script>');
        });
      },
    }],
  });
  const url = 'http://127.0.0.1:' + server.httpServer.address().port + '/';
  try {
    const external = ['electron', ...builtinModules, /^node:/];
    for (const [entry, name] of [['src/main/main.ts', 'main.js'], ['src/preload/preload.ts', 'preload.js']]) {
      await build({
        configFile: false, logLevel: 'error', cacheDir: autoTestOutput(),
        define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(url), MAIN_WINDOW_VITE_NAME: '"main_window"' },
        build: {
          target: 'node22', outDir: appDirectory, emptyOutDir: false, minify: false,
          lib: { entry: path.resolve(entry), formats: ['cjs'], fileName: () => name }, rollupOptions: { external },
        },
      });
    }
    await writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'asterium-history-smoke', version: '0.0.0', main: 'main.js' }));

    const launch = async () => {
      const port = await reservePort();
      const child = spawnTestProcess(electronPath, [
        appDirectory, '--asterium-profile=autotest', '--user-data-dir=' + profile,
        '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
      ], { cwd: appDirectory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      const endpoint = 'http://127.0.0.1:' + port;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('Isolated Electron exited: ' + stderr);
        if (await fetch(endpoint + '/json/version').then(response => response.ok, () => false)) {
          const browser = await chromium.connectOverCDP(endpoint);
          const context = browser.contexts()[0];
          const page = context.pages()[0] ?? await context.waitForEvent('page');
          try {
            await page.getByLabel('主要页面').waitFor({ timeout: 15_000 });
            return { child, browser, page };
          } catch (error) {
            const alert = await page.getByRole('alert').first().textContent({ timeout: 500 }).catch(() => '');
            throw new Error('Isolated Electron UI unavailable at ' + page.url() + ': ' + (alert || stderr), { cause: error });
          }
        }
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      throw new Error('Isolated Electron did not start: ' + stderr);
    };
    const first = await launch();
    let generation;
    try {
      await first.page.getByText('旧投影补回记录', { exact: true }).waitFor();
      const snapshot = await first.page.evaluate(() => window.asteriumConversations.openHistory());
      generation = snapshot.generation;
      assert.equal(snapshot.conversations.find(chat => chat.id === conversationId).messages[0].id, original.messages[0].id);
      const pageAndSearch = await first.page.evaluate(async id => {
        const bridge = window.asteriumConversations;
        return {
          page: await bridge.readHistoryPage({ conversationId: id, around: 'main-projection-only' }),
          search: await bridge.searchHistory({ conversationId: id, query: '投影补回' }),
        };
      }, conversationId);
      assert.ok(pageAndSearch.page.messages.some(message => message.id === 'main-projection-only'));
      assert.deepEqual(pageAndSearch.search.messageIds, ['main-projection-only']);
      const editor = first.page.getByRole('textbox', { name: /给 测试伙伴 A 发送消息/ });
      await editor.fill('强退前已保存的合成消息');
      await first.page.getByRole('button', { name: '发送', exact: true }).click();
      await first.page.getByText('强退前已保存的合成消息', { exact: true }).waitFor();
      const disk = await first.page.evaluate(() => window.asteriumConversations.openHistory());
      assert.ok(disk.conversations.find(chat => chat.id === conversationId).messages.some(message => message.content === '强退前已保存的合成消息'));
      assert.equal(await readFile(legacyFile, 'utf8'), legacyBytes);
      const stale = await first.page.evaluate(() => window.asteriumConversations.migrateHistory({ stale: true }));
      assert.equal(stale.generation, generation);
    } finally {
      const exit = once(first.child, 'exit');
      if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(first.child.pid), '/T', '/F'], { windowsHide: true });
      else first.child.kill('SIGKILL');
      await exit;
      await first.browser.close();
    }

    const staleProjection = JSON.stringify({ version: 1, conversations: {} });
    await writeFile(legacyFile, staleProjection);
    const second = await launch();
    try {
      await second.page.getByText('强退前已保存的合成消息', { exact: true }).waitFor();
      const old = await second.page.evaluate(key => localStorage.getItem(key), stateKey);
      assert.equal(old, '{"stale":true}');
      const active = await second.page.evaluate(() => window.asteriumConversations.openHistory());
      assert.equal(active.generation, generation);
      assert.ok(active.conversations.find(chat => chat.id === conversationId).messages.some(message => message.id === 'main-projection-only'));
      assert.equal(await readFile(legacyFile, 'utf8'), staleProjection);
      console.log('Isolated Electron migrated both legacy sources, saved before display and recovered the same generation after forced exit.');
    } finally {
      await second.browser.close();
    }
  } finally {
    await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  }
});

async function reservePort() {
  const server = createTestNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
