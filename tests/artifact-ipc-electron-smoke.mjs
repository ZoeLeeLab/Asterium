/* global window */
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';
import { _electron as electron } from 'playwright-core';
import { build, preview } from 'vite';
import { autoTestOutput, createTestViteServer, runAutoTest } from './helpers/autoTest.mjs';

await runAutoTest(async () => {
  assert.equal(process.platform, 'win32');
  const output = autoTestOutput();
  const appDirectory = path.join(output, 'app');
  const profile = path.join(output, 'profile');
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, '.asterium-profile.v1.json'), JSON.stringify({ version: 1, profile: 'autotest' }));
  const original = path.join(output, '交付样例.md');
  const exported = path.join(output, 'exported.md');
  const id = 'fixture-artifact';
  const content = '# Windows 交付样例\r\n';
  const loader = await createTestViteServer({
    configFile: 'vite.renderer.config.ts',
    server: { middlewareMode: true },
  });
  const { createTestState } = await loader.ssrLoadModule(path.resolve('tests/fixtures/applicationState.ts'));
  const { ArtifactRegistry } = await loader.ssrLoadModule(path.resolve('src/main/security/ArtifactRegistry.ts'));
  await loader.close();
  const fixture = createTestState();
  const conversation = fixture.conversations.find((item) => item.id === fixture.activeConversationId);
  const registry = new ArtifactRegistry({
    storePath: path.join(profile, 'artifacts.v1.json'),
    cacheDirectory: path.join(profile, 'artifact-cache-v2'),
  });
  await writeFile(original, content);
  const info = await registry.register({ kind: 'local_path', path: original }, {
    id, conversationId: conversation.id, partnerId: conversation.partnerId, method: 'automatic',
  });
  await registry.register({ kind: 'content', transport: 'base64', value: Buffer.from('fixture cache').toString('base64') },
    { id: 'fixture-cache', name: 'cache.txt', method: 'automatic' });
  const href = pathToFileURL(original).href;
  conversation.artifacts = [{ ...info, artifactRef: id }];
  conversation.messages[0].content = `[查看合成交付](${href})`;

  const rendererConfig = {
    configFile: 'vite.renderer.config.ts', logLevel: 'error', cacheDir: autoTestOutput(),
    build: { outDir: path.join(output, 'renderer') },
  };
  await build(rendererConfig);
  const server = await preview({
    ...rendererConfig,
    preview: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'synthetic-artifact-chat',
      configurePreviewServer(instance) {
        instance.middlewares.use((request, response, next) => {
          if (request.url !== '/') { next(); return; }
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end('<script>localStorage.setItem("asterium.prototype.v7",'
            + JSON.stringify(JSON.stringify(fixture)).replaceAll('<', '\\u003c') + ');location.replace("/index.html#/chat");</script>');
        });
      },
    }],
  });
  try {
    await verifyElectron(server);
  } finally {
    await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
  }

  async function verifyElectron(server) {
    const url = 'http://127.0.0.1:' + server.httpServer.address().port + '/';
    for (const [entry, name] of [['src/main/main.ts', 'main.js'], ['src/preload/preload.ts', 'preload.js']]) {
      await build({
        configFile: false, logLevel: 'error', cacheDir: autoTestOutput(),
        define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(url), MAIN_WINDOW_VITE_NAME: '"main_window"' },
        build: {
          target: 'node22', outDir: appDirectory, emptyOutDir: false, minify: false,
          lib: { entry: path.resolve(entry), formats: ['cjs'], fileName: () => name },
          rollupOptions: { external: ['electron', ...builtinModules, /^node:/] },
        },
      });
    }
    await writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'asterium-artifact-smoke', version: '0.0.0', main: 'main.js' }));

    const app = await electron.launch({
      executablePath: electronPath, cwd: appDirectory,
      args: [appDirectory, '--asterium-profile=autotest', '--user-data-dir=' + profile],
    });
    try {
      const page = await app.firstWindow();
      const bodyLink = page.getByRole('link', { name: '查看合成交付' });
      try {
        await bodyLink.click({ timeout: 20_000 });
      } catch (error) {
        const body = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
        throw new Error(`Fixture link missing at ${page.url()}: ${body.slice(0, 1000)}`, { cause: error });
      }
      await page.getByRole('heading', { name: 'Windows 交付样例' }).waitFor();
      console.log('PASS: chat link opens the delivered Markdown in the real Windows UI');

      // Keep external apps and native dialogs under test control; the IPC and file services are real.
      const osCalls = await app.evaluate(({ app, shell, dialog, clipboard }, destination) => {
        app.artifactSmokeCalls = { open: [], reveal: [], browser: [], save: [], clipboard: [] };
        const calls = app.artifactSmokeCalls;
        shell.openPath = async (file) => { calls.open.push(file); return ''; };
        shell.showItemInFolder = (file) => { calls.reveal.push(file); };
        shell.openExternal = async (url) => { calls.browser.push(url); };
        clipboard.writeText = (text) => { calls.clipboard.push(text); };
        dialog.showSaveDialog = async (_window, options) => {
          calls.save.push(options.defaultPath);
          return { canceled: calls.save.length === 1, filePath: destination };
        };
        return { platform: process.platform, profile: app.getPath('userData') };
      }, exported);
      assert.equal(osCalls.platform, 'win32');
      assert.equal(osCalls.profile, profile);

      const result = await page.evaluate(async ({ id, href, conversationId }) => {
        const artifacts = window.asteriumArtifacts;
        const info = await artifacts.inspect(id);
        const resolved = await artifacts.resolveConversationLink(conversationId, href);
        const foreignLink = await artifacts.resolveConversationLink('fixture-other-chat', href);
        const read = await artifacts.read(id);
        await artifacts.open(id);
        await artifacts.openInBrowser(id);
        await artifacts.reveal(id);
        await artifacts.copyPath(id);
        const cancelled = await artifacts.saveAs(id);
        const saved = await artifacts.exportAs(id);
        const project = { projectId: 'fixture-artifact-project', name: '样例交付项目' };
        const confirmedRoot = await window.asteriumProjects.previewCreateLocation(project);
        await window.asteriumProjects.create({ ...project, confirmedRoot });
        const delivery = await artifacts.saveToProject(id, project.projectId);
        const inspection = await artifacts.inspectDeletion(id);
        const cacheBefore = await artifacts.cacheStats();
        const cacheAfter = await artifacts.clearCache();
        return { info, resolved, foreignLink, read, cancelled, saved, delivery, inspection, cacheBefore, cacheAfter };
      }, { id, href, conversationId: conversation.id });

      assert.equal(result.info.id, id);
      assert.equal(result.read.text, content);
      assert.equal(result.resolved.artifact.id, id);
      assert.equal(result.resolved.action, 'preview');
      assert.equal(result.foreignLink, null);
      assert.equal(result.cancelled, false);
      assert.equal(result.saved, true);
      assert.deepEqual(await readFile(exported), Buffer.from(content));
      assert.deepEqual(await readFile(result.delivery.absolutePath), Buffer.from(content));
      assert.equal(result.inspection.canDelete, true);
      assert.equal(result.cacheBefore.itemCount, 1);
      assert.equal(result.cacheAfter.itemCount, 0);
      const calls = await app.evaluate(({ app }) => app.artifactSmokeCalls);
      assert.deepEqual(calls.open, [original]);
      assert.deepEqual(calls.reveal, [original]);
      assert.deepEqual(calls.save, ['交付样例.md', '交付样例.md']);
      assert.deepEqual(calls.clipboard, [original]);
      assert.equal(calls.browser.length, 1);
      const response = await fetch(calls.browser[0]);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), content);
      console.log('PASS: real preload, OS call arguments, browser loopback, exact-byte export and project save');

      // Exercise the missing-source deletion branch without leaving a synthetic file in the real Recycle Bin.
      await rename(original, path.join(output, 'moved.md'));
      const deleted = await page.evaluate(async (artifactId) => {
        const result = await window.asteriumArtifacts.delete(artifactId);
        return { result, removed: await window.asteriumArtifacts.inspect(artifactId) };
      }, id);
      assert.deepEqual(deleted.result.target, { kind: 'artifact', artifactId: id });
      assert.equal(deleted.removed, null);
      assert.deepEqual(await readFile(result.delivery.absolutePath), Buffer.from(content));
      console.log('PASS: all 13 artifact IPC channels invoked through real Electron on Windows');
    } finally {
      await app.close();
    }
  }
});
