/* global window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
  const content = '# Windows 交付样例\r\n更新后的文件内容。\r\n';
  const registryPath = path.join(profile, 'artifacts.v1.json');
  const loader = await createTestViteServer({
    configFile: 'vite.renderer.config.ts',
    server: { middlewareMode: true },
  });
  const { createTestState } = await loader.ssrLoadModule(path.resolve('tests/fixtures/applicationState.ts'));
  const { ArtifactRegistry } = await loader.ssrLoadModule(path.resolve('src/main/security/ArtifactRegistry.ts'));
  const { ConversationAttachmentStore } = await loader.ssrLoadModule(path.resolve('src/main/security/ConversationAttachmentStore.ts'));
  const { SingleChatHistoryStore } = await loader.ssrLoadModule(path.resolve('src/main/conversation/SingleChatHistoryStore.ts'));
  const { prepareSingleChatProfile } = await loader.ssrLoadModule(path.resolve('src/renderer/app/persistence.ts'));
  const { DESKTOP_IPC } = await loader.ssrLoadModule(path.resolve('src/shared/desktopIpc.ts'));
  await loader.close();
  const fixture = createTestState();
  const conversation = fixture.conversations.find((item) => item.id === fixture.activeConversationId);
  const registry = new ArtifactRegistry({
    storePath: registryPath,
    cacheDirectory: path.join(profile, 'artifact-cache-v2'),
  });
  let info;
  const context = { conversationId: conversation.id, partnerId: conversation.partnerId, method: 'automatic' };
  for (let revision = 1; revision <= 100; revision++) {
    await writeFile(original, '合成交付'.repeat(revision));
    info = await registry.register({ kind: 'local_path', path: original }, {
      ...context, id: revision === 1 ? id : 'fixture-artifact-' + revision, runId: 'fixture-run-' + revision,
    });
  }
  const readRegistry = async () => JSON.parse(await readFile(registryPath, 'utf8'));
  assert.equal((await readRegistry()).localFiles.length, 1);
  assert.equal((await readRegistry()).localLinks.length, 100);
  await writeFile(original, content);
  const latest = await registry.register({ kind: 'local_path', path: './交付样例.md' }, {
    ...context, id: 'fixture-artifact-latest', baseDirectory: output, runId: 'fixture-run-latest',
  });
  assert.equal((await readRegistry()).localFiles.length, 1);
  assert.equal((await readRegistry()).localFiles[0].sizeBytes, Buffer.byteLength(content));
  const other = path.join(output, 'other', path.basename(original));
  await mkdir(path.dirname(other));
  await writeFile(other, '# 同名文件在另一目录');
  const otherInfo = await registry.register({ kind: 'local_path', path: other }, { ...context, id: 'fixture-artifact-other' });
  assert.equal((await readRegistry()).localFiles.length, 2);
  console.log('PASS: 100 deliveries share one disk entity, an updated delivery retains one entity, and same-name paths stay separate');
  await registry.register({ kind: 'content', transport: 'base64', value: Buffer.from('fixture cache').toString('base64') },
    { id: 'fixture-cache', name: 'cache.txt', method: 'automatic' });
  const href = pathToFileURL(original).href;
  conversation.artifacts = [{ ...latest, artifactRef: latest.id }, { ...otherInfo, artifactRef: otherInfo.id }];
  conversation.messages[0].content = `[查看合成交付](${href})`;
  const attachments = new ConversationAttachmentStore({ rootDirectory: path.join(profile, 'conversation-attachments', 'v2') });
  const attachmentSources = ['用户附件甲.txt', '用户附件乙.txt'].map(name => path.join(output, name));
  const attachmentContent = '两份内容相同的合成附件';
  for (const file of attachmentSources) await writeFile(file, attachmentContent);
  const userMessage = conversation.messages.find(message => message.authorId !== conversation.partnerId && message !== conversation.messages[0]);
  assert.ok(userMessage);
  const staged = await attachments.stage(attachmentSources);
  const sent = await attachments.commit(conversation.id, staged.map(item => item.selectionId), userMessage.id);
  userMessage.attachments = sent;
  const snapshotPaths = await Promise.all(sent.map(item => attachments.pathFor(item.id, conversation.id)));
  const history = new SingleChatHistoryStore(profile);
  await history.initialize(async () => ({
    profile: prepareSingleChatProfile(fixture), conversations: fixture.conversations, deletedConversationIds: [],
  }));
  const logPath = path.join(profile, 'single-chat-history.v2', 'conversations',
    createHash('sha256').update(conversation.id).digest('hex'), 'events.jsonl');
  const metadata = { ...conversation };
  delete metadata.messages;
  const checkpoint = artifacts => JSON.stringify({ type: 'checkpoint', metadata: { ...metadata, artifacts }, upsert: [], remove: [] }) + '\n';
  await appendFile(logPath, checkpoint([{ ...info, artifactRef: info.id }]) + checkpoint(conversation.artifacts));

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
    await writeFile(path.join(appDirectory, 'package.json'), JSON.stringify({ name: 'asterium-artifact-smoke', version: '0.0.0', main: 'smoke-entry.cjs' }));
    await writeFile(path.join(appDirectory, 'smoke-entry.cjs'), `
      const { app, ipcMain } = require('electron');
      app.artifactSmokeIpc = {};
      app.artifactSmokeHistoryWrites = [];
      const handle = ipcMain.handle.bind(ipcMain);
      ipcMain.handle = (channel, handler) => handle(channel, async (...args) => {
        if (channel === ${JSON.stringify(DESKTOP_IPC.conversationWriteHistory)}) app.artifactSmokeHistoryWrites.push(structuredClone(args[1]));
        const result = await handler(...args);
        app.artifactSmokeIpc[channel] = (app.artifactSmokeIpc[channel] ?? 0) + 1;
        return result;
      });
      require('./main.js');
    `);

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
      await verifyFocusWithoutWrites(app, page);
      await verifySnapshotCleanup(app, page);

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
      assert.equal(result.resolved.artifact.id, latest.id);
      assert.equal(result.resolved.action, 'preview');
      assert.equal(result.foreignLink, null);
      assert.equal(result.cancelled, false);
      assert.equal(result.saved, true);
      assert.deepEqual(await readFile(exported), Buffer.from(content));
      assert.deepEqual(await readFile(result.delivery.absolutePath), Buffer.from(content));
      assert.equal(result.inspection.canDelete, true);
      assert.equal(result.cacheBefore.itemCount, 1);
      assert.equal(result.cacheAfter.itemCount, 0);
      const currentFiles = await page.evaluate(async ({ conversationId, otherId }) => ({
        sameName: (await window.asteriumArtifacts.listLatestConversation(conversationId)).length,
        other: (await window.asteriumArtifacts.read(otherId)).text,
      }), { conversationId: conversation.id, otherId: otherInfo.id });
      assert.deepEqual(currentFiles, { sameName: 2, other: '# 同名文件在另一目录' });
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

  async function verifyFocusWithoutWrites(app, page) {
    // Playwright enables focus emulation on Chromium pages by default.
    const devtools = await page.context().newCDPSession(page);
    await devtools.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    const ipcCount = channel => app.evaluate(({ app }, name) => app.artifactSmokeIpc[name] ?? 0, channel);
    const refresh = DESKTOP_IPC.artifactListLatestConversation;
    const historyWrite = DESKTOP_IPC.conversationWriteHistory;
    const savedProfile = path.join(profile, 'single-chat-history.v2', 'profile.json');
    // Hydration and initial profile seeding precede the steady-state focus measurement.
    const startupDeadline = Date.now() + 3000;
    while (!(JSON.parse(await readFile(savedProfile, 'utf8')).userProfile.revision) && Date.now() < startupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(JSON.parse(await readFile(savedProfile, 'utf8')).userProfile.revision);
    const before = await ipcCount(historyWrite);
    const observed = [registryPath, logPath, savedProfile];
    const original = await Promise.all(observed.map(file => readFile(file)));
    const diskTimes = () => Promise.all(observed.map(async file => (await stat(file, { bigint: true })).mtimeNs));
    const originalDiskTimes = await diskTimes();
    const writes = [];
    const watchers = observed.map(file => watch(path.dirname(file), (_event, name) => {
      if (name?.startsWith(path.basename(file))) writes.push(name);
    }));
    try {
      await app.evaluate(({ app, BrowserWindow }) => {
        app.artifactSmokeFocusWindow = new BrowserWindow({ show: false, width: 100, height: 100, skipTaskbar: true });
      });
      for (let iteration = 0; iteration < 100; iteration++) {
        await app.evaluate(({ app }) => {
          app.artifactSmokeFocusWindow.show();
          app.artifactSmokeFocusWindow.focus();
        });
        await page.waitForFunction(() => !window.document.hasFocus(), undefined, { polling: 20, timeout: 3000 });
        const count = await ipcCount(refresh);
        await app.evaluate(({ app, BrowserWindow }) => {
          const chat = BrowserWindow.getAllWindows().find(win => win !== app.artifactSmokeFocusWindow);
          chat.focus();
        });
        await page.waitForFunction(() => window.document.hasFocus(), undefined, { polling: 20, timeout: 3000 });
        const deadline = Date.now() + 3000;
        while (await ipcCount(refresh) === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(await ipcCount(refresh), count + 1, 'refresh after native focus ' + (iteration + 1));
      }
      const historyCalls = await app.evaluate(({ app }) => app.artifactSmokeHistoryWrites);
      if (historyCalls.length !== before) console.log('HISTORY_TRACE', JSON.stringify(historyCalls));
      assert.equal(historyCalls.length, before);
      assert.deepEqual(await Promise.all(observed.map(file => readFile(file))), original);
      assert.deepEqual(await diskTimes(), originalDiskTimes);
      assert.deepEqual(writes, []);
      console.log('PASS: 100 native focus events, 100 refreshes, 0 history calls and 0 observed disk writes');
    } finally {
      for (const watch of watchers) watch.close();
      await app.evaluate(({ app }) => app.artifactSmokeFocusWindow?.destroy());
      await devtools.detach();
    }
  }

  async function verifySnapshotCleanup(app, page) {
    const beforeLog = await readFile(logPath, 'utf8');
    let afterHistoryCleanup;
    const attachedMessage = await page.evaluate(async ({ conversationId, ids }) => {
      const { conversations } = await window.asteriumConversations.openHistory();
      const messages = conversations.find(item => item.id === conversationId).messages;
      return { messages, attachments: await Promise.all(ids.map(id => window.asteriumAttachments.read(id, conversationId))) };
    }, { conversationId: conversation.id, ids: sent.map(item => item.id) });
    await page.evaluate(() => { window.location.hash = '/settings'; });
    await page.getByRole('button', { name: '文件缓存', exact: true }).click();
    for (const [label, channel] of [
      ['清除 AI 过期快照', DESKTOP_IPC.conversationClearSnapshots],
      ['清除用户重复快照', DESKTOP_IPC.attachmentClearSnapshots],
    ]) {
      const button = page.getByRole('button', { name: label });
      const dialog = page.getByRole('dialog', { name: label });
      await button.click();
      await dialog.getByRole('button', { name: '取消' }).click();
      assert.equal(await app.evaluate(({ app }, name) => app.artifactSmokeIpc[name] ?? 0, channel), 0);
      assert.equal(await readFile(logPath, 'utf8'), label.includes('AI') ? beforeLog : afterHistoryCleanup);
      assert.deepEqual(await Promise.all(snapshotPaths.map(async file => (await stat(file)).nlink)), [1, 1]);
      await button.click();
      await dialog.getByRole('button', { name: '确认清理' }).click();
      await button.locator('..').getByRole('status').filter({ hasText: '已处理 1 项' }).waitFor();
      assert.equal(await app.evaluate(({ app }, name) => app.artifactSmokeIpc[name] ?? 0, channel), 1);
      if (label.includes('AI')) afterHistoryCleanup = await readFile(logPath, 'utf8');
    }
    assert.ok(afterHistoryCleanup.length < beforeLog.length);
    assert.equal(afterHistoryCleanup.match(/"artifacts":/g).length, 1);
    assert.deepEqual(await Promise.all(snapshotPaths.map(async file => (await stat(file)).nlink)), [2, 2]);
    assert.deepEqual(await Promise.all(attachmentSources.map(file => readFile(file, 'utf8'))), [attachmentContent, attachmentContent]);
    const after = await page.evaluate(async ({ conversationId, ids }) => {
      const { conversations } = await window.asteriumConversations.openHistory();
      const messages = conversations.find(item => item.id === conversationId).messages;
      return { messages, attachments: await Promise.all(ids.map(id => window.asteriumAttachments.read(id, conversationId))) };
    }, { conversationId: conversation.id, ids: sent.map(item => item.id) });
    assert.deepEqual(after, attachedMessage);
    await page.evaluate(() => { window.location.hash = '/chat'; });
    await page.getByRole('link', { name: '查看合成交付' }).click();
    await page.getByRole('heading', { name: 'Windows 交付样例' }).waitFor();
    assert.equal(await page.evaluate(async artifactId => (await window.asteriumArtifacts.read(artifactId)).text, id), content);
    assert.equal((await readRegistry()).localFiles.length, 2);
    console.log('PASS: both cleanup controls cancel safely, run once after confirmation, and preserve history, attachments and current delivery');
  }
});
