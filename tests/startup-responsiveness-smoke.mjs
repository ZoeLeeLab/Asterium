/* global window, document, requestAnimationFrame, getComputedStyle */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import electronPath from 'electron';
import { chromium } from 'playwright-core';
import { build } from 'vite';
import { autoTestEvidence, autoTestOutput, createTestViteServer, launchTestBrowser, runAutoTest, spawnTestProcess } from './helpers/autoTest.mjs';

// Synthetic data only. This measures one history operation, not cold boot time.
await runAutoTest(async () => {
  const evidence = autoTestEvidence('startup-responsiveness');
  const server = await createTestViteServer({ configFile: 'vite.renderer.config.ts', server: { host: '127.0.0.1', port: 0 } });
  let browser;
  try {
    const { createTestState } = await server.ssrLoadModule(path.resolve('tests/fixtures/applicationState.ts'));
    const { SingleChatHistoryStore } = await server.ssrLoadModule(path.resolve('src/main/conversation/SingleChatHistoryStore.ts'));
    const { conversations, ...profile } = createTestState();
    const selected = { ...conversations[0], messages: Array.from({ length: 256 }, (_, index) => ({
      id: `fixture-message-${index}`, authorId: conversations[0].partnerId, content: '合成正文', createdAt: '00:00',
    })) };
    const directory = autoTestOutput();
    const history = new SingleChatHistoryStore(directory);
    await history.initialize(async () => ({ profile, conversations: [selected], deletedConversationIds: [] }));
    await history.openRecent();
    const database = new DatabaseSync(path.join(directory, 'single-chat-history.v2', 'history-index.v1.sqlite'));
    const payload = JSON.stringify({ ...selected.messages[0], timeline: [{ detail: 'x'.repeat(1024 * 1024) }] });
    try {
      database.prepare("UPDATE messages SET payload = json_set(?, '$.id', id)").run(payload);
      async function measure(operation) {
        let previous = performance.now(), maxGapMs = 0, ticks = 0;
        const timer = setInterval(() => {
          const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now; ticks++;
        }, 10);
        try {
          await delay(30);
          const beforeTicks = ticks, start = performance.now();
          const result = await operation();
          const elapsedMs = performance.now() - start, operationTicks = ticks - beforeTicks;
          await delay(30);
          return { elapsedMs, maxGapMs, operationTicks, count: result };
        } finally { clearInterval(timer); }
      }
      const baseline = await measure(() => database.prepare("SELECT json_remove(payload, '$.timeline', '$.toolEvents', '$.attachments', '$.quote') AS data FROM messages WHERE chat_id = ? ORDER BY position").all(selected.id).map(row => JSON.parse(row.data)).length);
      const worker = await measure(async () => (await history.readProjection(selected.id)).conversations[0].messages.length);
      const metadata = await measure(async () => (await history.readProjection(undefined, undefined, { metadataOnly: true })).conversations.length);
      assert.equal(baseline.count, 256); assert.equal(worker.count, 256); assert.equal(metadata.count, 1);
      assert.ok(worker.operationTicks > 0, 'Main heartbeat must continue during the worker query');
      assert.ok(worker.maxGapMs < baseline.maxGapMs, 'Worker must reduce Main blocking on the same synthetic projection');
      await writeFile(path.join(evidence, 'history-heartbeat.json'), JSON.stringify({ synthetic: true, richPayloadMiB: 256, baseline, worker, metadata }, null, 2));
    } finally { database.close(); }

    // Exercise the embedded worker in the actual Electron Main runtime as well
    // as Node/Vitest. No network, daily profile or installed app is involved.
    const electronOutput = autoTestOutput();
    await mkdir(electronOutput, { recursive: true });
    await build({
      configFile: false, logLevel: 'error', cacheDir: autoTestOutput(),
      build: {
        target: 'node22', outDir: electronOutput, emptyOutDir: false,
        lib: { entry: path.resolve('src/main/conversation/SingleChatHistoryStore.ts'), formats: ['cjs'], fileName: () => 'history.cjs' },
        rollupOptions: { external: [...builtinModules, /^node:/] },
      },
    });
    await writeFile(path.join(electronOutput, 'fixture.json'), JSON.stringify({ profile, conversation: selected }));
    await writeFile(path.join(electronOutput, 'main.cjs'), `
      const { app } = require('electron');
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const { DatabaseSync } = require('node:sqlite');
      const { SingleChatHistoryStore } = require('./history.cjs');
      const directory = process.argv.find(value => value.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
      app.setPath('userData', directory);
      app.disableHardwareAcceleration();
      app.whenReady().then(async () => {
        const { profile, conversation } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
        const history = new SingleChatHistoryStore(directory);
        await history.initialize(async () => ({ profile, conversations: [conversation], deletedConversationIds: [] }));
        await history.openRecent();
        const database = new DatabaseSync(path.join(directory, 'single-chat-history.v2', 'history-index.v1.sqlite'));
        try {
          const payload = JSON.stringify({ ...conversation.messages[0], timeline: [{ detail: 'x'.repeat(262144) }] });
          database.prepare("UPDATE messages SET payload = json_set(?, '$.id', id)").run(payload);
        } finally { database.close(); }
        let ticks = 0;
        const timer = setInterval(() => ticks++, 10);
        try {
          const result = await history.readProjection(conversation.id);
          assert.equal(result.conversations[0].messages.length, 256);
          assert.equal(result.conversations[0].messages[0].id, 'fixture-message-0');
          assert.equal(result.conversations[0].messages[0].timeline, undefined);
          assert.ok(ticks > 0, 'Electron Main must keep processing timers');
          fs.writeFileSync(process.argv.find(value => value.startsWith('--result=')).slice('--result='.length), JSON.stringify({ status: 'passed', mainHeartbeatTicks: ticks, node: process.versions.node, electron: process.versions.electron }));
        } finally { clearInterval(timer); }
        app.quit();
      }).catch(error => { console.error(error); app.exit(1); });
    `);
    const child = spawnTestProcess(electronPath, [path.join(electronOutput, 'main.cjs'), `--user-data-dir=${path.join(electronOutput, 'profile')}`, `--result=${path.join(evidence, 'electron-worker.json')}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
    child.stdout.on('data', () => undefined);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('ELECTRON_WORKER_TIMEOUT')), 20_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(Error(`ELECTRON_WORKER_FAILED: ${diagnostics}`));
      });
    });

    await server.listen();
    browser = await launchTestBrowser(chromium, { executablePath: process.env.ASTERIUM_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const scenarios = [
      { name: 'light-early', width: 1280, height: 800, mode: 'light', motion: 'no-preference', finishTime: 0 },
      { name: 'dark-middle', width: 1280, height: 800, mode: 'dark', motion: 'no-preference', finishTime: 4000 },
      { name: 'narrow-idle', width: 420, height: 740, mode: 'light', motion: 'no-preference', finishTime: 20000 },
      { name: 'small-reduced', width: 320, height: 480, mode: 'dark', motion: 'reduce', finishTime: 0 },
    ];
    const results = [];
    for (const scenario of scenarios) {
      const page = await browser.newPage({ viewport: { width: scenario.width, height: scenario.height }, colorScheme: scenario.mode, reducedMotion: scenario.motion });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ fixture, mode }) => {
        localStorage.setItem('asterium.theme.v1', mode);
        const { conversations, ...profile } = fixture;
        let fulfill;
        let reject;
        let opens = 0;
        const pending = () => new Promise((yes, no) => { fulfill = yes; reject = no; });
        window.startupFixture = {
          finish: () => fulfill({ generation: 'fixture-generation', profile, conversations }),
          fail: () => reject(Error('fixture-storage-unavailable')),
          opens: () => opens,
        };
        window.asteriumConversations = {
          openHistory: () => { opens++; return pending(); },
          migrateHistory: async () => { throw Error('UNEXPECTED_MIGRATION'); },
          writeHistory: async () => undefined, listDeleted: async () => [],
        };
      }, { fixture: createTestState(), mode: scenario.mode });
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/chat`);
      await page.getByRole('status').filter({ hasText: '伙伴们正在归来' }).waitFor();
      const initial = await page.evaluate(() => ({
        drag: getComputedStyle(document.querySelector('.window-drag-strip')).getPropertyValue('-webkit-app-region'),
        animation: getComputedStyle(document.querySelector('.startup-hero')).animationName,
        idle: getComputedStyle(document.querySelector('.startup-character--hero')).animationIterationCount,
        shape: getComputedStyle(document.querySelector('.startup-character--hero .startup-star-body')).clipPath,
        text: document.querySelector('.startup-view').innerText,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        theme: document.documentElement.dataset.theme,
      }));
      assert.equal(initial.drag, 'drag'); assert.equal(initial.overflow, false); assert.equal(initial.theme, scenario.mode);
      assert.equal(initial.animation, scenario.motion === 'reduce' ? 'none' : 'startup-wake');
      if (scenario.motion !== 'reduce') assert.equal(initial.idle, 'infinite');
      assert.ok(initial.shape.startsWith('shape('));
      assert.equal(/Asterium|星丛/.test(initial.text), false);
      // Rendering continues while history is pending; no timeout-based loading fiction.
      await page.evaluate(() => new Promise(resolve => { let frames = 0; function tick() { if (++frames === 5) resolve(); else requestAnimationFrame(tick); } requestAnimationFrame(tick); }));
      if (scenario.motion !== 'reduce') {
        for (const [name, time] of [['awake', 1320], ['gather', 4400], ['idle', 20000]]) {
          const spacing = await page.evaluate(time => {
            const scene = document.querySelector('.startup-scene');
            for (const animation of scene.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = time; }
            const text = scene.querySelector('.startup-status p').getBoundingClientRect();
            const envelope = scene.querySelector('.startup-envelope').getBoundingClientRect();
            return { gap: text.top - envelope.bottom, bottom: scene.getBoundingClientRect().bottom - text.bottom };
          }, time);
          if (name === 'awake') assert.ok(spacing.gap >= 12 && spacing.bottom >= 12, JSON.stringify(spacing));
          await page.screenshot({ path: path.join(evidence, `${scenario.name}-${name}.png`) });
        }
      }
      await page.screenshot({ path: path.join(evidence, `${scenario.name}-loading.png`) });
      await page.evaluate(() => window.startupFixture.fail());
      await page.getByRole('alert').filter({ hasText: '单聊资料暂时无法打开' }).waitFor();
      assert.equal(await page.locator('.startup-scene').evaluate(scene => scene.getAnimations({ subtree: true }).length), 0);
      const retryBounds = await page.getByRole('button', { name: '重试', exact: true }).boundingBox();
      assert.ok(retryBounds.y + retryBounds.height <= scenario.height);
      await page.screenshot({ path: path.join(evidence, `${scenario.name}-failed.png`) });
      assert.equal(await page.evaluate(() => window.startupFixture.opens()), 1);
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '伙伴们正在归来' }).waitFor();
      await page.locator('.startup-scene').evaluate((scene, time) => {
        for (const animation of scene.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = time; }
      }, scenario.finishTime);
      const readyAt = performance.now();
      await page.evaluate(() => window.startupFixture.finish());
      await page.getByRole('textbox', { name: '给 测试伙伴 A 发送消息…' }).waitFor({ timeout: 2000 });
      const readyLatencyMs = performance.now() - readyAt;
      assert.ok(readyLatencyMs < 2000);
      assert.equal(await page.locator('.startup-view').count(), 0);
      assert.equal(await page.evaluate(() => window.startupFixture.opens()), 2);
      assert.deepEqual(errors, []);
      results.push({ scenario: scenario.name, finishTime: scenario.finishTime, readyLatencyMs, ...initial, passed: true });
      await page.close();
    }
    await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, 'browser-results.json'), JSON.stringify(results, null, 2));
    console.log(`STARTUP_EVIDENCE ${evidence}`);
  } finally {
    await browser?.close();
    await server.close();
  }
});
