import { requireLiveTestSource } from './helpers/liveTestConfiguration.mjs';
// Explicit opt-in. Real model/native CLI, synthetic messages, temporary app data and workspace.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { prepareCodexPlanThread } from './helpers/codexPlanThread.mjs';

const sourceKind = process.argv.find((arg) => arg.startsWith('--source='))?.split('=')[1] ?? 'api';
assert.ok(['api', 'codex', 'claude'].includes(sourceKind));
const optIn = sourceKind === 'api' ? 'ASTERIUM_API_LIVE_SMOKE' : sourceKind === 'codex' ? 'ASTERIUM_CODEX_LIVE_SMOKE' : 'ASTERIUM_CLAUDE_LIVE_SMOKE';
if (process.env[optIn] !== '1') throw new Error(`Set ${optIn}=1 to run this real model test.`);
const root = path.resolve(import.meta.dirname, '..');
const userData = await mkdtemp(path.join(os.tmpdir(), 'asterium-profile-smoke-'));
const workspace = path.join(userData, 'workspace');
const legacyRunPath = process.env.ASTERIUM_USE_LEGACY_RUN_PATH === '1';
const evidence = path.join(root, '.qa', 'profile-reload-s4', legacyRunPath ? `${sourceKind}-legacy` : sourceKind); await mkdir(evidence, { recursive: true });
const partnerId = `profile-${sourceKind}`, conversationId = 'profile-chat', credentialRef = 'compact-credential', grantId = 'compact-workspace';
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
    const management = { userProfile: true, personality: true, memoryMode: sourceKind === 'api' ? 'asterium' : 'self_managed' };
    const identity = { displayName: '资料重读验收伙伴', introduction: '隔离合成测试', expertise: '', mentionName: '资料重读验收伙伴' };
    let partner = { id: partnerId, publicIdentity: identity, status: 'online', accent: '#55aa99', isPrototype: false, createdAt: new Date().toISOString(), profileManagement: management };
    if (sourceKind === 'api') partner = { ...partner, sourceMode: 'api_partner', provider: 'deepseek', ...apiSettings, credentialRef, configured: true, apiSessionHistoryEnabled: true, thinkingMode: 'disabled', reasoningEffort: 'low', primaryWorkspaceGrantId: grantId, workspaceGrantIds: [grantId], personality: 'PERSONA_OLD_A' , systemPrompt: '保持 Plan 模式，只有明确选择执行才执行。不要联网或写记忆。' };
    else {
      let runtime;
      if (sourceKind === 'codex') { const detection = await globalThis.asteriumAgents.detectCodex(); runtime = detection.runtimes.find((r) => r.runtimeId === detection.recommendedRuntimeId && r.loggedIn) ?? detection.runtimes.find((r) => r.loggedIn); if (!runtime) throw new Error('CODEX_NOT_LOGGED_IN'); }
      else { const detection = await globalThis.asteriumAgents.detectClaude(); if (!detection.installed || !detection.loggedIn) throw new Error('CLAUDE_NOT_LOGGED_IN'); }
      partner = { ...partner, sourceMode: 'local_cli', adapterType: sourceKind === 'codex' ? 'codex_cli' : 'claude_code', connectionKind: sourceKind === 'codex' ? 'local_codex' : 'local_claude', location: 'local', sessionMode: 'new', connectionLabel: '隔离原生验收', partnerRootKind: 'imported', partnerRoot: workspace, partnerRootGrantId: grantId, workspaceGrantIds: [], workingDirectories: [], ...(runtime ? { codexRuntimeId: runtime.runtimeId, codexRuntime: runtime } : {}) };
    }
    state.partners = [partner]; state.projects = []; state.groupChats = [];
    state.userProfile = { ...state.userProfile, displayName: '合成测试', introduction: '' };
    state.conversations = [{ id: conversationId, partnerId, title: '资料重读验收', permissionMode: 'read_only', planMode: 'default', messages: [], updatedAt: new Date().toISOString(), ...(codexThread ? { sessionId: codexThread.threadId } : {}), ...(sourceKind !== 'api' ? { partnerRootKind: 'imported', partnerRoot: workspace, partnerRootGrantId: grantId } : {}) }];
    state.activePartnerId = partnerId; state.activeConversationId = conversationId; state.activeProjectId = ''; state.activeGroupChatId = '';
    await globalThis.asteriumAgents.syncPartnerWorkspace(partnerId, grantId, []);
    await globalThis.asteriumAgents.savePartnerProfile({ partnerId, sourceMode: partner.sourceMode, publicIdentity: identity, management, ...(sourceKind === 'api' ? { personality: partner.personality, systemPrompt: partner.systemPrompt, connectionSettings: { provider: 'deepseek', endpoint: apiSettings.endpoint, configuredModel: apiSettings.model, thinkingMode: 'disabled', reasoningEffort: 'low', apiSessionHistoryEnabled: true } } : { connectionSettings: { adapterType: partner.adapterType, partnerRoot: workspace, partnerRootGrantId: grantId }, personality: 'PERSONA_OLD_A', systemPrompt: '仅参与当前合成测试；简短回复，不执行额外任务。' }) });
    return JSON.stringify(state);
  }, { partnerId, conversationId, sourceKind, credentialRef, grantId, workspace, apiSettings, codexThread });
  // Seed before the next renderer mounts; the old renderer may still persist
  // its initial demo state while native profile IPC is completing.
  await page.addInitScript((state) => {
    if (globalThis.sessionStorage.getItem('profile-fixture-seeded') === '1') return;
    localStorage.setItem('asterium.prototype.v7', state); globalThis.sessionStorage.setItem('profile-fixture-seeded', '1');
  }, seededState);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('给 资料重读验收伙伴 发送消息…').waitFor();
  await page.evaluate((id) => { globalThis.__planEvents = []; globalThis.asteriumAgents.onEvent((event) => { if (event.partnerId === id) globalThis.__planEvents.push(event); }); }, partnerId);
  await page.evaluate(async () => globalThis.asteriumAgents.saveUserProfile({ displayName: '合成用户', introduction: 'USER_OLD_A', updatedAt: new Date().toISOString() }));
  await send('这是隔离资料重读验收。仅回复“收到”，不要使用工具、创建文件或记录记忆。');
  if (sourceKind === 'codex' && codexThread) { await reload('reload-user'); await reload('reload-persona'); }
  const original = await binding(); assert.ok(original.bootstrap.content.includes('USER_OLD_A')); assert.ok(original.bootstrap.content.includes('PERSONA_OLD_A'));
  const directories = await readdir(path.join(userData, 'AsteriumData', 'partners'));
  let directory;
  for (const name of directories) { const folder = path.join(userData, 'AsteriumData', 'partners', name); const metadata = JSON.parse(await readFile(path.join(folder, 'partner.json'), 'utf8')); if (metadata.partnerId === partnerId) directory = folder; }
  assert.ok(directory);
  await writeFile(path.join(userData, 'AsteriumData', 'user', 'user-profile.md'), '# 用户介绍\n\n## 名字\n\n合成新用户\n\n## 介绍\n\nUSER_NEW_B\n');
  await writeFile(path.join(directory, 'persona.md'), '# 伙伴设定\n\n## 性格与相处方式\n\nPERSONA_NEW_B\n\n## 稳定指令\n\n仅参与合成自动测试，保持简短，不调用工具。\n');
  await send('请只返回你当前已应用的用户资料里的英文标记，以及伙伴人设里的英文标记。不要使用工具，不要读磁盘，不要写文件。');
  let current = await snapshot(); assert.ok(current.messages.at(-1).content.includes('USER_OLD_A')); assert.ok(current.messages.at(-1).content.includes('PERSONA_OLD_A')); assert.deepEqual((await binding()).bootstrap, original.bootstrap);
  const beforeUser = await snapshot(); await reload('reload-user');
  let applied = await binding(); assert.ok(applied.bootstrap.content.includes('USER_NEW_B')); assert.ok(applied.bootstrap.content.includes('PERSONA_OLD_A')); assert.ok(!applied.bootstrap.content.includes('PERSONA_NEW_B'));
  const afterUser = await snapshot(); assert.equal(afterUser.sessionId, beforeUser.sessionId); assert.deepEqual(afterUser.messages, beforeUser.messages); assert.equal(afterUser.permissionMode, beforeUser.permissionMode); assert.equal(afterUser.planMode, beforeUser.planMode);
  await send('请只返回当前已应用用户资料及伙伴人设中的两个英文标记，不调用工具。'); current = await snapshot(); assert.ok(current.messages.at(-1).content.includes('USER_NEW_B')); assert.ok(current.messages.at(-1).content.includes('PERSONA_OLD_A'));
  const beforePersona = await snapshot(); await reload('reload-persona'); applied = await binding(); assert.ok(applied.bootstrap.content.includes('USER_NEW_B')); assert.ok(applied.bootstrap.content.includes('PERSONA_NEW_B')); assert.deepEqual((await snapshot()).messages, beforePersona.messages);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByPlaceholder('给 资料重读验收伙伴 发送消息…').waitFor();
  await page.evaluate((id) => { globalThis.__planEvents = []; globalThis.asteriumAgents.onEvent((event) => { if (event.partnerId === id) globalThis.__planEvents.push(event); }); }, partnerId);
  await send('请只返回当前已应用用户资料及伙伴人设中的两个英文标记，不调用工具。'); current = await snapshot(); assert.ok(current.messages.at(-1).content.includes('USER_NEW_B')); assert.ok(current.messages.at(-1).content.includes('PERSONA_NEW_B')); assert.equal(current.sessionId, beforeUser.sessionId);
  if (sourceKind === 'api') { const dir = path.join(userData, 'api-agent-sessions', 'v1'); const names = (await readdir(dir)).filter((name) => name !== 'index.json' && name.endsWith('.json')); const session = JSON.parse(await readFile(path.join(dir, names[0]), 'utf8')); assert.equal(session.bootstrapSystemPrompt, applied.bootstrap.content); }
  assert.deepEqual(await readdir(workspace), []); await page.screenshot({ path: path.join(evidence, 'continued.png') });
  if (sourceKind === 'api' && process.argv.includes('--compact-after-reload')) {
    for (let i = 0; i < 4; i++) await send('维持当前已应用资料，仅回复收到，不使用工具。');
    const before = await snapshot(), profilesBefore = (await binding()).bootstrap;
    await until(async () => (await page.evaluate(async (target) => globalThis.asteriumAgents.getSessionStatus(target), { partnerId, conversationId, source: 'api_partner', sessionId: before.sessionId })).capabilities.compact.available, 10_000, 'compact-ready');
    await page.locator('.composer textarea').fill('/compact'); await page.locator('.composer textarea').press('Enter');
    await page.waitForFunction(() => { const node = globalThis.document.querySelector('[aria-label="会话指令结果"]'); return node && node.textContent.includes('保留最近六轮'); }, null, { timeout: 200_000 });
    assert.deepEqual((await snapshot()).messages, before.messages); assert.deepEqual((await binding()).bootstrap, profilesBefore);
    await send('请只返回当前系统资料中的用户介绍和伙伴人设英文标记，不使用工具。');
    const final = await snapshot(); assert.ok(final.messages.at(-1).content.includes('USER_NEW_B')); assert.ok(final.messages.at(-1).content.includes('PERSONA_NEW_B'));
    result.compactionAfterReload = true;
  }
  if (sourceKind === 'api') {
    await page.evaluate(() => { globalThis.location.hash = '/profile'; });
    const introduction = page.getByRole('textbox', { name: '个人介绍' }); await introduction.waitFor();
    await until(async () => await introduction.inputValue() === 'USER_NEW_B', 10_000, 'profile-page-refresh');
    await introduction.fill('UNSAVED_DRAFT');
    const profilePath = path.join(userData, 'AsteriumData', 'user', 'user-profile.md');
    await writeFile(profilePath, '# 用户介绍\n\n## 名字\n\n外部用户\n\n## 介绍\n\nUSER_EXTERNAL_C\n');
    await page.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
    await page.getByText('磁盘资料已变化，未保存的草稿已保留。可重新载入后编辑。').waitFor().catch(() => undefined);
    assert.equal(await introduction.inputValue(), 'UNSAVED_DRAFT');
    await page.getByRole('button', { name: '保存资料' }).click();
    await page.getByText('磁盘资料已变化，未覆盖外部修改；草稿已保留，请重新载入后编辑。').waitFor();
    assert.ok((await readFile(profilePath, 'utf8')).includes('USER_EXTERNAL_C'));
    await page.screenshot({ path: path.join(evidence, 'profile-conflict.png') });
    await page.getByRole('button', { name: '重新载入并放弃草稿' }).click();
    await until(async () => await introduction.inputValue() === 'USER_EXTERNAL_C', 10_000, 'explicit-profile-reload');
    assert.ok((await binding()).bootstrap.content.includes('USER_NEW_B'));
  }
  result.cases = { noAutomaticApplication: true, userOnlyReload: true, personaOnlyReload: true, sameSession: true, historyAndModesPreserved: true, persistedAfterRefresh: true, noWorkspaceWrites: true }; result.status = 'passed';

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
  const resolved = await realpath(userData); assert.equal(path.dirname(resolved).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase()); assert.ok(path.basename(resolved).startsWith('asterium-profile-smoke-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  for (const original of originals) assert.equal(hash(await readFile(original.filename)), hash(original.bytes), 'Source API configuration changed');
  result.temporaryDataRemoved = true; if (originals.length) result.sourceConfigurationUnchanged = true;
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
async function snapshot() { return page.evaluate((id) => JSON.parse(localStorage.getItem('asterium.prototype.v7')).conversations.find((conversation) => conversation.id === id), conversationId); }
async function send(text) {
  const prior = await page.evaluate(() => globalThis.__planEvents.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)).length);
  await page.getByPlaceholder('给 资料重读验收伙伴 发送消息…').fill(text); await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction((count) => globalThis.__planEvents.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)).length > count, prior, { timeout: 120_000 });
  const events = await page.evaluate(() => globalThis.__planEvents); const terminal = events.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)).at(-1); assert.equal(terminal.type, 'run.completed', terminal.error?.message);
  await page.waitForFunction((id) => { const c = JSON.parse(localStorage.getItem('asterium.prototype.v7')).conversations.find((c) => c.id === id); return c && !c.activeRun && !c.awaitingFirstResponse; }, conversationId);
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function reservePort() { const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; }
async function until(probe, timeout, label) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 150)); } throw new Error(`Timed out: ${label}`); }

async function binding() { const data = JSON.parse(await readFile(path.join(userData, 'native-thread-bindings.v1.json'), 'utf8')); return data.bindings.find((b) => b.scope === 'single' && b.partnerId === partnerId && b.conversationId === conversationId && b.state === 'active'); }
async function reload(command) {
  const before = await snapshot();
  const target = { partnerId, conversationId, source: sourceKind === 'api' ? 'api_partner' : 'local_cli', sessionId: before.sessionId };
  await until(async () => { const status = await page.evaluate(async (target) => globalThis.asteriumAgents.getSessionStatus(target), target); return status.state === 'idle'; }, 10_000, 'writer release');
  if (command === 'reload-user') { await page.getByRole('button', { name: '指令', exact: true }).click(); await page.getByRole('menuitem', { name: /重读用户资料/ }).click(); }
  else { await page.locator('.composer textarea').fill('/reload-persona'); await page.locator('.composer textarea').press('Enter'); }
  await page.waitForFunction(() => { const node = globalThis.document.querySelector('[aria-label="会话指令结果"]'); return node && !node.textContent.includes('正在'); }, null, { timeout: 200_000 });
  const message = await page.getByLabel('会话指令结果').innerText(); assert.ok(message.includes('已重读'), message); await page.screenshot({ path: path.join(evidence, command+'.png') });
}
