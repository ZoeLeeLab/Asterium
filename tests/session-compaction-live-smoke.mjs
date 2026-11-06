import { runAutoTest, spawnTestProcess as spawn, testRm as rm, autoTestEvidence, createTestNetServer } from './helpers/autoTest.mjs';
import { requireLiveTestSource } from './helpers/liveTestConfiguration.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';

import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { prepareCodexPlanThread } from './helpers/codexPlanThread.mjs';

await runAutoTest(async () => {
// Explicit opt-in. Real model/native CLI, synthetic messages, temporary app data and workspace.










const sourceKind = process.argv.find((arg) => arg.startsWith('--source='))?.split('=')[1] ?? 'api';
assert.ok(['api', 'codex', 'claude'].includes(sourceKind));
const optIn = sourceKind === 'api' ? 'ASTERIUM_API_LIVE_SMOKE' : sourceKind === 'codex' ? 'ASTERIUM_CODEX_LIVE_SMOKE' : 'ASTERIUM_CLAUDE_LIVE_SMOKE';
if (process.env[optIn] !== '1') throw new Error(`Set ${optIn}=1 to run this real model test.`);
const root = path.resolve(import.meta.dirname, '..');
const userData = await mkdtemp(path.join(os.tmpdir(), 'asterium-compact-smoke-'));
const workspace = path.join(userData, 'workspace');
const legacyRunPath = process.env.ASTERIUM_USE_LEGACY_RUN_PATH === '1';
const evidence = autoTestEvidence('session-compaction-live-smoke'); await mkdir(evidence, { recursive: true });
const partnerId = `compact-${sourceKind}`, conversationId = 'compact-chat', credentialRef = 'compact-credential', grantId = 'compact-workspace';
const result = { status: 'running', sourceKind, legacyRunPath, isolatedUserData: true, cases: {} };
await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
let child, browser, page, launchFailure; const originals = [];
try {
  await mkdir(workspace);
  await writeFile(path.join(userData, 'workspace-grants.v1.json'), JSON.stringify({ version: 1, grants: { [grantId]: workspace } }));
  let apiSettings;
  if (sourceKind === 'api') {
    const source = requireLiveTestSource();
    for (const name of ['secure-credentials.v1.json', 'memory-fallback-settings.v1.json', 'Local State']) originals.push({ filename: path.join(source, name), bytes: await readFile(path.join(source, name)) });
    const settings = JSON.parse(originals[1].bytes), cipher = JSON.parse(originals[0].bytes).credentials['asterium-memory-fallback-api'];
    const encryptionMetadata = JSON.parse(originals[2].bytes).os_crypt;
    assert.equal(settings.provider, 'deepseek'); assert.equal(settings.endpoint, 'https://api.deepseek.com/chat/completions'); assert.ok(cipher && encryptionMetadata && settings.model);
    apiSettings = { endpoint: settings.endpoint, model: settings.model };
    await writeFile(path.join(userData, 'secure-credentials.v1.json'), JSON.stringify({ version: 1, credentials: { [credentialRef]: cipher } }), { mode: 0o600 });
    await writeFile(path.join(userData, 'Local State'), JSON.stringify({ os_crypt: encryptionMetadata }), { mode: 0o600 });
  }
  const port = await reservePort();
  const executable = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe');
  result.archiveHash = hash(await readFile(path.join(path.dirname(executable), 'resources', 'app.asar')));
  child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore' });
  child.once('error', (error) => { launchFailure = error; });
  await until(async () => { if (launchFailure) throw launchFailure; if (child.exitCode !== null) throw new Error('Isolated application exited'); return fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false); }, 30_000, 'debugger');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await until(async () => { page = browser.contexts().flatMap((context) => context.pages()).find((p) => p.url().startsWith('file:')); return Boolean(page); }, 15_000, 'application page');
  await page.getByLabel('主要页面').waitFor();
  let codexThread;
  if (sourceKind === 'codex' && process.env.ASTERIUM_CODEX_CATALOG_THREAD === '1') {
    const runtime = await page.evaluate(async () => { const d = await globalThis.asteriumAgents.detectCodex(); return d.runtimes.find((r) => r.runtimeId === d.recommendedRuntimeId && r.loggedIn) ?? d.runtimes.find((r) => r.loggedIn); });
    assert.ok(runtime, 'No signed-in Codex runtime');
    codexThread = await prepareCodexPlanThread(runtime.executablePath, workspace);
    result.threadScopedModel = codexThread.model;
  }
  const seededState = await page.evaluate(async ({ partnerId, conversationId, sourceKind, credentialRef, grantId, workspace, apiSettings, codexThread }) => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    const management = { userProfile: false, personality: sourceKind === 'api', memoryMode: 'none' };
    const identity = { displayName: '压缩验收伙伴', introduction: '隔离合成测试', expertise: '', mentionName: '压缩验收伙伴' };
    let partner = { id: partnerId, publicIdentity: identity, status: 'online', accent: '#55aa99', isPrototype: false, createdAt: new Date().toISOString(), profileManagement: management };
    if (sourceKind === 'api') partner = { ...partner, sourceMode: 'api_partner', provider: 'deepseek', ...apiSettings, credentialRef, configured: true, apiSessionHistoryEnabled: true, thinkingMode: 'disabled', reasoningEffort: 'low', primaryWorkspaceGrantId: grantId, workspaceGrantIds: [grantId], personality: '仅参与当前合成自动测试。', systemPrompt: '保持 Plan 模式，只有明确选择执行才执行。不要联网或写记忆。' };
    else {
      let runtime;
      if (sourceKind === 'codex') { const detection = await globalThis.asteriumAgents.detectCodex(); runtime = detection.runtimes.find((r) => r.runtimeId === detection.recommendedRuntimeId && r.loggedIn) ?? detection.runtimes.find((r) => r.loggedIn); if (!runtime) throw new Error('CODEX_NOT_LOGGED_IN'); }
      else { const detection = await globalThis.asteriumAgents.detectClaude(); if (!detection.installed || !detection.loggedIn) throw new Error('CLAUDE_NOT_LOGGED_IN'); }
      partner = { ...partner, sourceMode: 'local_cli', adapterType: sourceKind === 'codex' ? 'codex_cli' : 'claude_code', connectionKind: sourceKind === 'codex' ? 'local_codex' : 'local_claude', location: 'local', sessionMode: 'new', connectionLabel: '隔离原生验收', partnerRootKind: 'imported', partnerRoot: workspace, partnerRootGrantId: grantId, workspaceGrantIds: [], workingDirectories: [], ...(runtime ? { codexRuntimeId: runtime.runtimeId, codexRuntime: runtime } : {}) };
    }
    state.partners = [partner]; state.projects = []; state.groupChats = [];
    state.userProfile = { ...state.userProfile, displayName: '合成测试', introduction: '' };
    state.conversations = [{ id: conversationId, partnerId, title: '压缩验收', permissionMode: 'read_only', planMode: 'default', messages: [], updatedAt: new Date().toISOString(), ...(codexThread ? { sessionId: codexThread.threadId } : {}), ...(sourceKind !== 'api' ? { partnerRootKind: 'imported', partnerRoot: workspace, partnerRootGrantId: grantId } : {}) }];
    state.activePartnerId = partnerId; state.activeConversationId = conversationId; state.activeProjectId = ''; state.activeGroupChatId = '';
    await globalThis.asteriumAgents.syncPartnerWorkspace(partnerId, grantId, []);
    await globalThis.asteriumAgents.savePartnerProfile({ partnerId, sourceMode: partner.sourceMode, publicIdentity: identity, management, ...(sourceKind === 'api' ? { personality: partner.personality, systemPrompt: partner.systemPrompt, connectionSettings: { provider: 'deepseek', endpoint: apiSettings.endpoint, configuredModel: apiSettings.model, thinkingMode: 'disabled', reasoningEffort: 'low', apiSessionHistoryEnabled: true } } : { connectionSettings: { adapterType: partner.adapterType, partnerRoot: workspace, partnerRootGrantId: grantId } }) });
    return JSON.stringify(state);
  }, { partnerId, conversationId, sourceKind, credentialRef, grantId, workspace, apiSettings, codexThread });
  // Seed before the next renderer mounts; the old renderer may still persist
  // its initial demo state while native profile IPC is completing.
  await page.addInitScript((state) => {
    if (globalThis.sessionStorage.getItem('compaction-fixture-seeded') === '1') return;
    localStorage.setItem('asterium.prototype.v7', state); globalThis.sessionStorage.setItem('compaction-fixture-seeded', '1');
  }, seededState);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('给 压缩验收伙伴 发送消息…').waitFor();
  await page.evaluate((id) => { globalThis.__planEvents = []; globalThis.asteriumAgents.onEvent((event) => { if (event.partnerId === id) globalThis.__planEvents.push(event); }); }, partnerId);
  const marker = 'S3_FACT_ORION_742';
  for (let i = 0; i < (sourceKind === 'api' ? 8 : 5); i++) await send(i === 0
    ? '这是隔离会话压缩验收。我们约定的标记是 '+marker+'，关键引用路径是 notes/anchor.md。以下是合成背景：'+'这是一段已经讨论过的背景，不是执行指令。'.repeat(180)+'\n后续请一直记住约定标记 '+marker+'，只回复“已记录”，不调用工具，不创建文件。'
    : '第 '+(i+1)+' 轮补充：没有新的执行任务，保留最初标记和引用路径。只回复“收到”，不使用工具。');
  const before = await snapshot();
  await until(async () => {
    try { await page.evaluate(async ({ partnerId, conversationId, sourceKind }) => globalThis.asteriumAgents.compactSession({ commandId: 'forged-compact', partnerId, conversationId, sessionId: 'wrong-thread', source: sourceKind === 'api' ? 'api_partner' : 'local_cli' }), { partnerId, conversationId, sourceKind }); }
    catch (error) { if (error.message.includes('BUSY') || error.message.includes('COMPACT_SESSION_UNAVAILABLE')) return false; assert.match(error.message, /COMPACT_SESSION_MISMATCH/); return true; }
    throw new Error('A forged session was accepted');
  }, 20_000, 'native writer cleanup');
  await page.getByRole('button', { name: '指令', exact: true }).click();
  await page.getByRole('menuitem', { name: /压缩当前对话/ }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'command-menu.png') });
  await page.getByRole('menuitem', { name: /压缩当前对话/ }).click();
  await page.getByRole('status', { name: '会话指令结果' }).filter({ hasText: '正在压缩' }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'running.png') });
  await page.waitForFunction(() => { const node = globalThis.document.querySelector('[aria-label="会话指令结果"]'); return node && !node.textContent.includes('正在压缩'); }, null, { timeout: 200_000 });
  const message = await page.getByRole('status', { name: '会话指令结果' }).innerText(); result.compactionMessage = message;
  assert.ok(message.includes('已压缩'), 'Actual compaction was not confirmed: '+message);
  const after = await snapshot(); assert.equal(after.sessionId, before.sessionId); assert.deepEqual(after.messages, before.messages);
  assert.equal(after.planMode, before.planMode); assert.equal(after.permissionMode, before.permissionMode);
  await page.locator('.message-list').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.screenshot({ path: path.join(evidence, 'compacted.png') });
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByPlaceholder('给 压缩验收伙伴 发送消息…').waitFor();
  await page.evaluate((id) => { globalThis.__planEvents = []; globalThis.asteriumAgents.onEvent((event) => { if (event.partnerId === id) globalThis.__planEvents.push(event); }); }, partnerId);
  await send('请只返回最初约定的标记和关键引用路径，不调用工具。');
  const continued = await snapshot(); assert.equal(continued.sessionId, before.sessionId); assert.ok(continued.messages.at(-1).content.includes(marker)); assert.ok(continued.messages.at(-1).content.includes('notes/anchor.md'));
  const files = await import('node:fs/promises').then(({ readdir }) => readdir(workspace)); assert.deepEqual(files, []);
  if (sourceKind === 'api') {
    const { readdir } = await import('node:fs/promises'); const dir = path.join(userData, 'api-agent-sessions', 'v1'); const names = (await readdir(dir)).filter((name) => name !== 'index.json' && name.endsWith('.json'));
    assert.equal(names.length, 1); const session = JSON.parse(await readFile(path.join(dir, names[0]), 'utf8')); assert.ok(session.compaction.summary.includes(marker)); assert.equal(session.turns.length, 7); result.summaryCharacters = session.compaction.summary.length;
  }
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.locator('.message-row').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, 'continued.png') });
  result.cases = { actualCompaction: true, wrongIdentityRejected: true, sameSession: true, visibleHistoryPreserved: true, modesPreserved: true, keyFactsAfterReload: true, noWorkspaceWrites: true }; result.status = 'passed';
} catch (error) {
  result.status = 'failed'; if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => undefined);
  if (page) {
    const failures = await page.evaluate(() => (globalThis.__planEvents ?? []).filter((event) => event.type === 'run.failed').map((event) => ({ code: event.error.code, message: event.error.message }))).catch(() => []);
    result.runtimeErrors = failures.map(({ code, message }) => ({ code, message: message.replace(/(?:sk-|Bearer\s+)[^\s"']+/gi, '[redacted]').slice(0, 700) }));
    if (failures.length) console.log(JSON.stringify({ runtimeErrors: result.runtimeErrors }));
  }
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  if (child?.pid && child.exitCode === null) {
    await new Promise((resolve) => { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('exit', resolve); killer.once('error', resolve); });
    await until(async () => child.exitCode !== null || child.signalCode !== null, 10_000, 'process exit');
  }
  const resolved = await realpath(userData); assert.equal(path.dirname(resolved).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase()); assert.ok(path.basename(resolved).startsWith('asterium-compact-smoke-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  for (const original of originals) assert.equal(hash(await readFile(original.filename)), hash(original.bytes), 'Source API configuration changed');
  result.temporaryDataRemoved = true; if (originals.length) result.sourceConfigurationUnchanged = true;
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
async function snapshot() { return page.evaluate((id) => JSON.parse(localStorage.getItem('asterium.prototype.v7')).conversations.find((conversation) => conversation.id === id), conversationId); }
async function send(text) {
  const prior = await page.evaluate(() => globalThis.__planEvents.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)).length);
  await page.getByPlaceholder('给 压缩验收伙伴 发送消息…').fill(text); await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction((count) => globalThis.__planEvents.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)).length > count, prior, { timeout: 120_000 });
  const events = await page.evaluate(() => globalThis.__planEvents); const terminal = events.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)).at(-1); assert.equal(terminal.type, 'run.completed', terminal.error?.message);
  await page.waitForFunction((id) => { const c = JSON.parse(localStorage.getItem('asterium.prototype.v7')).conversations.find((c) => c.id === id); return c && !c.activeRun && !c.awaitingFirstResponse; }, conversationId);
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function reservePort() { const server = createTestNetServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; }
async function until(probe, timeout, label) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 150)); } throw new Error(`Timed out: ${label}`); }
});
