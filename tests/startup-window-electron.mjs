/* global window, document, getComputedStyle */
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Script } from 'node:vm';
import { createPackage } from '@electron/asar';
import electronPath from 'electron';
import { _electron as electron } from 'playwright-core';
import { build } from 'vite';
import { autoTestEvidence, autoTestOutput, launchTestElectron, runAutoTest } from './helpers/autoTest.mjs';

// Real Main, both preloads and both renderer entries; no daily profile or model.
await runAutoTest(async () => {
  const evidence = autoTestEvidence('startup-window-electron');
  const output = autoTestOutput(), source = path.join(output, 'app'), runtime = path.join(output, 'runtime');
  const buildDir = path.join(source, '.vite/build');
  await mkdir(buildDir, { recursive: true });
  await build({ configFile: 'vite.renderer.config.ts', base: './', logLevel: 'error', cacheDir: autoTestOutput(), build: { outDir: path.join(source, '.vite/renderer/main_window') } });
  for (const [entry, fileName] of [['src/main/main.ts', 'main.js'], ['src/preload/preload.ts', 'preload.js'], ['src/preload/startupPreload.ts', 'startupPreload.js']]) {
    await build({ configFile: false, logLevel: 'error', cacheDir: autoTestOutput(),
      define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: 'false', MAIN_WINDOW_VITE_NAME: '"main_window"' },
      build: { target: 'node22', outDir: buildDir, emptyOutDir: false, minify: false,
        lib: { entry: path.resolve(entry), formats: ['cjs'], fileName: () => fileName },
        rollupOptions: { external: ['electron', ...builtinModules, /^node:/] } },
    });
  }
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'synthetic-startup-window-test', version: '0.0.0', main: 'harness.cjs' }));
  const inspectDom = () => ({ navigation: Boolean(document.querySelector('[aria-label="主要页面"]')), fullScreenAnimation: Boolean(document.querySelector('.startup-view')) });
  const harness = `
    const { app, ipcMain } = require('electron');
    const path = require('node:path');
    process.on('uncaughtException', error => { console.error('SYNTHETIC_HARNESS_FAILED', error); app.exit(1); });
    process.on('unhandledRejection', error => { console.error('SYNTHETIC_HARNESS_FAILED', error); app.exit(1); });
    const scenario = process.argv.find(value => value.startsWith('--fixture-case=')).slice('--fixture-case='.length);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const state = globalThis.startupFixture = { released: scenario === 'fast', calls: 0, showChecks: [], windowsCreated: 0, release: () => { state.released = true; release(); } };
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, handler) => handle(channel, async (event, ...args) => {
      if (channel === 'asterium:conversation:open-history') {
        state.calls++;
        if (scenario !== 'fast' && state.calls === 1) await gate;
        if ((scenario === 'retry' || scenario === 'quit') && state.calls === 1) throw Error('SYNTHETIC_HISTORY_FAILURE');
      }
      return handler(event, ...args);
    });
    app.on('browser-window-created', (_event, window) => {
      state.windowsCreated++;
      window.on('show', () => {
        if (window.webContents.getURL().includes('/startup.html')) return;
        state.showChecks.push(window.webContents.executeJavaScript(${JSON.stringify('(' + inspectDom.toString() + ')()')}).then(dom => ({ released: state.released, ...dom })));
      });
    });
    require('./.vite/build/main.js');
  `;
  // Validate generated JavaScript before any native process can display it.
  new Script(harness, { filename: 'synthetic-startup-harness.cjs' });
  await writeFile(path.join(source, 'harness.cjs'), harness);
  // Keep the test runtime independent; the standard harness verifies the ASAR
  // has the real profile-isolation implementation before allowing a launch.
  await cp(path.dirname(electronPath), runtime, { recursive: true });
  await createPackage(source, path.join(runtime, 'resources/app.asar'));
  const results = [];
  for (const scenario of ['fast', 'slow', 'retry', 'quit']) {
    const application = await launchTestElectron(electron, { executablePath: path.join(runtime, path.basename(electronPath)),
      args: [`--user-data-dir=${autoTestOutput()}`, `--fixture-case=${scenario}`], timeout: 20000 });
    try {
      const deadline = Date.now() + 15000;
      let main, splash;
      while (Date.now() < deadline) {
        main = application.windows().find(page => page.url().includes('/index.html'));
        splash = application.windows().find(page => page.url().includes('/startup.html'));
        if (main && (scenario === 'fast' || splash)) break;
        await delay(30);
      }
      assert.ok(main, 'Main document must load');
      if (scenario !== 'fast') {
        assert.ok(splash, 'Independent splash must load');
        await splash.getByRole('status').filter({ hasText: '伙伴们正在归来' }).waitFor();
        const pending = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
          visible: window.isVisible(), size: window.getSize(), splash: window.webContents.getURL().includes('/startup.html'),
        })));
        assert.equal(pending.find(window => !window.splash).visible, false);
        assert.deepEqual(pending.find(window => window.splash).size, [520, 450]);
        const bridge = await splash.evaluate(() => ({ splash: !!window.asteriumSplash, agents: !!window.asteriumAgents, history: !!window.asteriumConversations,
          shape: getComputedStyle(document.querySelector('.startup-character--hero .startup-star-body')).clipPath }));
        assert.equal(bridge.splash, true); assert.equal(bridge.agents, false); assert.equal(bridge.history, false); assert.ok(bridge.shape.startsWith('shape('));
        const caption = await splash.evaluate(() => {
          const envelope = document.querySelector('.startup-envelope');
          return { opacity: Number(getComputedStyle(envelope).opacity), gap: document.querySelector('.startup-status p').getBoundingClientRect().top - envelope.getBoundingClientRect().bottom };
        });
        if (caption.opacity > .5) assert.ok(caption.gap >= 12, JSON.stringify(caption));
        await splash.screenshot({ path: path.join(evidence, `${scenario}-loading.png`) });
        await application.evaluate(async ({ app }) => { app.emit('second-instance'); await new Promise(resolve => setImmediate(resolve)); });
        assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('/startup.html')).isVisible()), false);
        await application.evaluate(() => globalThis.startupFixture.release());
      }
      if (scenario === 'retry' || scenario === 'quit') {
        await splash.getByRole('alert').waitFor();
        await splash.screenshot({ path: path.join(evidence, `${scenario}-failed.png`) });
        assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('/startup.html')).isVisible()), false);
        if (scenario === 'quit') {
          const closed = application.waitForEvent('close');
          await splash.getByRole('button', { name: '退出', exact: true }).click();
          await closed;
          results.push({ scenario, passed: true, mainShown: false });
          continue;
        }
        await splash.getByRole('button', { name: '重试', exact: true }).click();
      }
      await main.getByLabel('主要页面').waitFor({ timeout: 5000 });
      await application.evaluate(({ BrowserWindow }) => new Promise((resolve, reject) => {
        const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/index.html'));
        if (window.isVisible()) { resolve(); return; }
        const timeout = setTimeout(() => reject(Error('MAIN_NATIVE_HANDOFF_TIMEOUT')), 2000);
        window.once('show', () => { clearTimeout(timeout); resolve(); });
      }));
      const state = await application.evaluate(async ({ BrowserWindow }) => ({
        checks: await Promise.all(globalThis.startupFixture.showChecks), created: globalThis.startupFixture.windowsCreated,
        windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), url: window.webContents.getURL() })),
      }));
      assert.equal(state.created, 2); assert.equal(state.windows.length, 1); assert.equal(state.windows[0].visible, true);
      assert.equal(state.checks.length, 1); assert.deepEqual(state.checks[0], { released: true, navigation: true, fullScreenAnimation: false });
      await main.screenshot({ path: path.join(evidence, `${scenario}-main-ready.png`) });
      results.push({ scenario, passed: true, mainFirstShowHasContent: true, created: state.created });
    } catch (error) {
      const diagnostic = await application.evaluate(async ({ BrowserWindow }) => ({
        calls: globalThis.startupFixture.calls, released: globalThis.startupFixture.released,
        checks: await Promise.all(globalThis.startupFixture.showChecks),
        windows: await Promise.all(BrowserWindow.getAllWindows().map(async window => ({
          visible: window.isVisible(), url: window.webContents.getURL(), loading: window.webContents.isLoadingMainFrame(),
          page: await window.webContents.executeJavaScript('({ ready: document.readyState, visibility: document.visibilityState, body: document.body.innerText, root: document.getElementById("root").innerHTML.slice(0,1500), startup: !!window.asteriumStartup, splash: !!window.asteriumSplash })').catch(failure => ({ error: failure.message })),
        }))),
      })).catch(failure => ({ error: failure.message }));
      await writeFile(path.join(evidence, `${scenario}-diagnostic.json`), JSON.stringify(diagnostic, null, 2));
      console.error(JSON.stringify(diagnostic));
      throw error;
    } finally { await application.close().catch(() => undefined); }
  }
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ status: 'passed', results, realModel: false, dailyProfileUsed: false }, null, 2));
  console.log(`STARTUP_WINDOW_EVIDENCE ${evidence}`);
});
