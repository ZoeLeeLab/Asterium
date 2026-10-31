import { requireLiveTestSource } from './helpers/liveTestConfiguration.mjs';
// Explicit opt-in. Real model/native CLI, synthetic messages, temporary app data and workspace.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
const userData = await mkdtemp(path.join(os.tmpdir(), 'asterium-plan-input-'));
const workspace = path.join(userData, 'workspace');
const evidence = path.join(root, '.qa', 'plan-input-s2', sourceKind); await mkdir(evidence, { recursive: true });
const partnerId = `plan-input-${sourceKind}`, conversationId = 'plan-input-chat', credentialRef = 'plan-input-credential', grantId = 'plan-input-workspace';
const result = { status: 'running', sourceKind, isolatedUserData: true, cases: {} };
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
  await page.evaluate(async ({ partnerId, conversationId, sourceKind, credentialRef, grantId, workspace, apiSettings, codexThread }) => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    const management = { userProfile: false, personality: sourceKind === 'api', memoryMode: 'none' };
    const identity = { displayName: '提问卡验收伙伴', introduction: '隔离合成测试', expertise: '', mentionName: '提问卡验收伙伴' };
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
    state.conversations = [{ id: conversationId, partnerId, title: 'Plan 自填验收', permissionMode: 'full', planMode: 'plan', messages: [], updatedAt: new Date().toISOString(), ...(codexThread ? { sessionId: codexThread.threadId } : {}), ...(sourceKind !== 'api' ? { partnerRootKind: 'imported', partnerRoot: workspace, partnerRootGrantId: grantId } : {}) }];
    state.activePartnerId = partnerId; state.activeConversationId = conversationId; state.activeProjectId = ''; state.activeGroupChatId = '';
    await globalThis.asteriumAgents.syncPartnerWorkspace(partnerId, grantId, []);
    await globalThis.asteriumAgents.savePartnerProfile({ partnerId, sourceMode: partner.sourceMode, publicIdentity: identity, management, ...(sourceKind === 'api' ? { personality: partner.personality, systemPrompt: partner.systemPrompt, connectionSettings: { provider: 'deepseek', endpoint: apiSettings.endpoint, configuredModel: apiSettings.model, thinkingMode: 'disabled', reasoningEffort: 'low', apiSessionHistoryEnabled: true } } : { connectionSettings: { adapterType: partner.adapterType, partnerRoot: workspace, partnerRootGrantId: grantId } }) });
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
  }, { partnerId, conversationId, sourceKind, credentialRef, grantId, workspace, apiSettings, codexThread });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('给 提问卡验收伙伴 发送消息…').waitFor();
  await page.evaluate((id) => { globalThis.__planEvents = []; globalThis.asteriumAgents.onEvent((event) => { if (event.partnerId === id) globalThis.__planEvents.push(event); }); }, partnerId);
  const questionTool = sourceKind === 'claude' ? 'AskUserQuestion' : 'request_user_input';
  await page.getByPlaceholder('给 提问卡验收伙伴 发送消息…').fill(`这是隔离自动测试。请计划在当前空目录创建 plan-canary.txt，内容为 S2_ONLY_AFTER_APPROVAL；但当前只做计划，绝不创建目标文件。先用 ${questionTool} 只问我一道带两个选项的格式选择题，收到答案后给出不超过三步的计划并请求开始执行确认。只使用提问和原生计划功能，不联网，不写记忆。`);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  let next = await questionAfter(0);
  assert.ok(!next.questions.some((q) => q.id === 'plan-execution'), 'The model skipped the requested native clarification');
  const firstRequestId = next.requestId;
  await fillCustom('自填 S2_CUSTOM_FORMAT，保留 recommended.md 原文');
  await page.screenshot({ path: path.join(evidence, 'custom-question.png') });
  await submit();
  next = await questionAfter(1);
  assert.ok(next.questions.some((q) => q.id === 'plan-execution'), 'Expected final plan confirmation');
  const firstPlan = next.requestId;
  await fillCustom('请增加测试步骤，并在计划末尾写 S2_REVISED；仍不允许执行或创建目标文件。');
  await submit();
  next = await questionAfter(2);
  assert.ok(next.questions.some((q) => q.id === 'plan-execution')); assert.notEqual(next.requestId, firstPlan);
  await assertStillPlan();
  await fillCustom('开始执行 (Recommended)');
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.screenshot({ path: path.join(evidence, 'custom-start-label.png') });
  await submit();
  next = await questionAfter(3);
  assert.ok(next.questions.some((q) => q.id === 'plan-execution'));
  assert.equal(new Set([firstRequestId, firstPlan, next.requestId]).size, 3);
  await assertStillPlan();
  await page.getByRole('radio', { name: /暂不执行/ }).click(); await submit();
  await page.waitForFunction(() => globalThis.__planEvents.some((e) => ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type)), null, { timeout: 60_000 });
  const events = await page.evaluate(() => globalThis.__planEvents);
  assert.deepEqual(events.filter((e) => ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type)).map((e) => e.type), ['run.cancelled']);
  assert.equal(events.filter((e) => e.type === 'user_input.requested').length, 4);
  assert.equal(new Set(events.filter((e) => e.type === 'user_input.requested').map((e) => e.requestId)).size, 4);
  const answers = events.filter((e) => e.type === 'user_input.resolved');
  assert.equal(answers.length, 4);
  assert.ok(Object.values(answers[0].answers).flat().every((text) => text.includes('S2_CUSTOM_FORMAT')));
  assert.equal(answers[2].customAnswers['plan-execution'], '开始执行 (Recommended)');
  assert.ok(!events.some((e) => e.type === 'plan.updated' && e.planMode === 'default'));
  await assertNoCanary();
  await page.screenshot({ path: path.join(evidence, 'completed.png') });
  result.cases = { nativeQuestionCustomText: true, revisionContinuesPlan: true, typedStartCannotExecute: true, newRequestIdentities: true, fullPermissionStillPlan: true, explicitStop: true, oneTerminal: true, targetFileNotCreated: true };
  result.status = 'passed';
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
  const resolved = await realpath(userData); assert.equal(path.dirname(resolved).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase()); assert.ok(path.basename(resolved).startsWith('asterium-plan-input-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  for (const original of originals) assert.equal(hash(await readFile(original.filename)), hash(original.bytes), 'Source API configuration changed');
  result.temporaryDataRemoved = true; if (originals.length) result.sourceConfigurationUnchanged = true;
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
async function questionAfter(count) {
  await page.waitForFunction((count) => {
    const events = globalThis.__planEvents;
    return events.filter((e) => e.type === 'user_input.requested').length > count || events.some((e) => ['run.completed', 'run.failed', 'run.cancelled'].includes(e.type));
  }, count, { timeout: 120_000 });
  const state = await page.evaluate((count) => ({ question: globalThis.__planEvents.filter((e) => e.type === 'user_input.requested')[count], terminal: globalThis.__planEvents.find((e) => ['run.completed', 'run.failed', 'run.cancelled'].includes(e.type)) }), count);
  assert.ok(state.question && !state.terminal, state.terminal?.error?.code ?? 'Run ended before the next question');
  await page.locator('.timeline-user-input-card').waitFor(); return state.question;
}
async function fillCustom(text) {
  const groups = page.locator('.timeline-user-input-card fieldset');
  for (let i = 0; i < await groups.count(); i++) { const group = groups.nth(i); await group.getByText('其他／自行填写', { exact: true }).click(); await group.getByRole('textbox').fill(text); }
}
async function submit() { await page.getByRole('button', { name: '提交回答', exact: true }).click(); }
async function assertNoCanary() { assert.equal(await access(path.join(workspace, 'plan-canary.txt')).then(() => true, () => false), false); }
async function assertStillPlan() { await assertNoCanary(); const events = await page.evaluate(() => globalThis.__planEvents); assert.ok(!events.some((e) => e.type === 'plan.updated' && e.planMode === 'default')); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function reservePort() { const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; }
async function until(probe, timeout, label) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 150)); } throw new Error(`Timed out: ${label}`); }
