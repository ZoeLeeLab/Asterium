import { requireLiveTestSource } from './helpers/liveTestConfiguration.mjs';
// Opt-in live model test. Only synthetic messages and a temporary Electron profile are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

if (process.env.ASTERIUM_API_LIVE_SMOKE !== '1') throw new Error('Set ASTERIUM_API_LIVE_SMOKE=1 to run the real API guidance test.');
const root = path.resolve(import.meta.dirname, '..');
const source = requireLiveTestSource();
const originals = await Promise.all(['secure-credentials.v1.json', 'memory-fallback-settings.v1.json', 'Local State'].map(async (name) => ({ name, bytes: await readFile(path.join(source, name)) })));
const settings = JSON.parse(originals[1].bytes);
const cipher = JSON.parse(originals[0].bytes).credentials['asterium-memory-fallback-api'];
const encryptionMetadata = JSON.parse(originals[2].bytes).os_crypt;
assert.equal(settings.provider, 'deepseek'); assert.ok(settings.model && cipher && encryptionMetadata);
assert.equal(settings.endpoint, 'https://api.deepseek.com/chat/completions');
const userData = await mkdtemp(path.join(os.tmpdir(), 'asterium-guidance-live-'));
const pipeline = process.env.ASTERIUM_USE_LEGACY_RUN_PATH === '1' ? 'legacy' : 'coordinator';
const evidence = path.join(root, '.qa', 'chat-guidance-s1', pipeline); await mkdir(evidence, { recursive: true });
const partnerId = 'guidance-live', conversationId = 'guidance-live-chat', credentialRef = 'guidance-live-credential';
const result = { status: 'running', pipeline, isolatedUserData: true, realModel: settings.model, cases: {} };
await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
let child, browser, page, launchFailure;
try {
  // Reuse only the known provider's still-encrypted credential and encryption metadata.
  await writeFile(path.join(userData, 'secure-credentials.v1.json'), JSON.stringify({ version: 1, credentials: { [credentialRef]: cipher } }), { mode: 0o600 });
  await writeFile(path.join(userData, 'Local State'), JSON.stringify({ os_crypt: encryptionMetadata }), { mode: 0o600 });
  const port = await reservePort();
  const executable = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe');
  result.archiveHash = hash(await readFile(path.join(path.dirname(executable), 'resources', 'app.asar')));
  child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore' });
  child.once('error', (error) => { launchFailure = error; });
  await until(async () => {
    if (launchFailure) throw launchFailure;
    if (child.exitCode !== null) throw new Error('Isolated application exited before startup');
    return fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false);
  }, 30_000, 'debugger');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await until(async () => { page = browser.contexts().flatMap((context) => context.pages()).find((p) => p.url().startsWith('file:')); return Boolean(page); }, 15_000, 'application page');
  await page.getByLabel('主要页面').waitFor();
  await page.evaluate(async ({ partnerId, conversationId, credentialRef, endpoint, model }) => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    const partner = {
      id: partnerId, sourceMode: 'api_partner', isPrototype: false, configured: true, status: 'online', accent: '#55aa99', createdAt: new Date().toISOString(),
      publicIdentity: { displayName: '引导验收伙伴', introduction: '隔离自动测试', expertise: '', mentionName: '引导验收伙伴' },
      provider: 'deepseek', endpoint, model, credentialRef, personality: '只执行当前合成测试。', systemPrompt: '不要调用工具，不读写文件、不联网、不写记忆；收到中途更正后遵循最新用户要求。',
      apiSessionHistoryEnabled: true, thinkingMode: 'disabled', reasoningEffort: 'low', profileManagement: { userProfile: false, personality: true, memoryMode: 'none' },
    };
    state.partners = [partner]; state.projects = []; state.groupChats = [];
    state.userProfile = { ...state.userProfile, displayName: '合成测试', introduction: '' };
    state.conversations = [{ id: conversationId, partnerId, title: '运行中追问验收', messages: [], permissionMode: 'manual', planMode: 'default', updatedAt: new Date().toISOString() }];
    state.activePartnerId = partnerId; state.activeConversationId = conversationId; state.activeProjectId = ''; state.activeGroupChatId = '';
    await globalThis.asteriumAgents.savePartnerProfile({ partnerId, sourceMode: 'api_partner', publicIdentity: partner.publicIdentity, management: partner.profileManagement, personality: partner.personality, systemPrompt: partner.systemPrompt, connectionSettings: { provider: partner.provider, endpoint, configuredModel: model, thinkingMode: 'disabled', reasoningEffort: 'low', apiSessionHistoryEnabled: true } });
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
  }, { partnerId, conversationId, credentialRef, endpoint: settings.endpoint, model: settings.model });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('给 引导验收伙伴 发送消息…').waitFor();
  await page.evaluate((id) => { globalThis.__guidanceEvents = []; globalThis.asteriumAgents.onEvent((event) => { if (event.partnerId === id) globalThis.__guidanceEvents.push(event); }); }, partnerId);
  await page.getByPlaceholder('给 引导验收伙伴 发送消息…').fill('请直接输出一个 1 到 200 的编号列表，每项用一句中文描述一种不同的星空。不调用任何工具，逐行输出。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => globalThis.__guidanceEvents.some((e) => e.type === 'text.delta'), null, { timeout: 90_000 });
  const initial = await page.evaluate(() => globalThis.__guidanceEvents.find((e) => e.type === 'session.bound'));
  const correction = '停止列表。请只回复 ASTERIUM_GUIDANCE_OK，不要添加其他文字。';
  const guidanceInput = page.getByPlaceholder('输入补充要求，Enter 后暂存…');
  await guidanceInput.fill(correction); await guidanceInput.press('Enter');
  const card = page.getByLabel('待发送的中途消息'); await card.waitFor();
  await page.screenshot({ path: path.join(evidence, 'staged.png') });
  await card.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => globalThis.__guidanceEvents.some((e) => ['run.completed', 'run.failed', 'run.cancelled'].includes(e.type)), null, { timeout: 90_000 });
  const events = await page.evaluate(() => globalThis.__guidanceEvents.filter((event) => event.runId));
  assert.equal(events.filter((e) => e.type === 'session.bound').length, 1);
  assert.ok(events.every((e) => e.runId === initial.runId && e.sessionId === initial.sessionId));
  assert.equal(events.filter((e) => e.type === 'guidance.applied').length, 1);
  assert.deepEqual(events.filter((e) => ['run.completed', 'run.failed', 'run.cancelled'].includes(e.type)).map((e) => e.type), ['run.completed']);
  const boundary = events.findIndex((e) => e.type === 'guidance.applied');
  assert.ok(events.slice(boundary + 1).filter((e) => e.type === 'text.delta').map((e) => e.text).join('').includes('ASTERIUM_GUIDANCE_OK'));
  await card.waitFor({ state: 'hidden' });
  await page.waitForFunction((id) => {
    const chat = JSON.parse(localStorage.getItem('asterium.prototype.v7')).conversations.find((c) => c.id === id);
    return !chat.activeRun && chat.messages.some((m) => m.guidanceState === 'applied');
  }, conversationId);
  const saved = await page.evaluate((id) => JSON.parse(localStorage.getItem('asterium.prototype.v7')).conversations.find((c) => c.id === id), conversationId);
  const applied = saved.messages.find((m) => m.isGuidance);
  assert.equal(applied.guidanceState, 'applied'); assert.equal(applied.status, 'delivered');
  assert.equal(saved.messages.filter((m) => m.isGuidance).length, 1);
  const guidanceIndex = saved.messages.findIndex((m) => m.isGuidance);
  assert.ok(guidanceIndex > 0 && guidanceIndex < saved.messages.length - 1);
  assert.ok(saved.messages.slice(guidanceIndex + 1).some((m) => m.content.includes('ASTERIUM_GUIDANCE_OK')));
  const key = hash(Buffer.from(`${partnerId}\0${conversationId}`));
  const session = JSON.parse(await readFile(path.join(userData, 'api-agent-sessions', 'v1', `${key}.json`), 'utf8'));
  assert.equal(session.turns.length, 1);
  assert.ok(session.turns[0].messages.some((m) => m.role === 'user' && m.content === correction));
  assert.ok(events[boundary].sourceMessage.messageId === applied.id);
  await page.screenshot({ path: path.join(evidence, 'completed.png') });
  result.cases = { uiStageAndSend: true, sameTaskAndSession: true, modelFollowsGuidance: true, oneTerminal: true, visibleOrderingAndDelivery: true, historyPersisted: true, sourceIdentity: true };
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => undefined);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  if (child?.pid && child.exitCode === null) {
    await new Promise((resolve) => { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('exit', resolve); killer.once('error', resolve); });
    await until(async () => child.exitCode !== null || child.signalCode !== null, 10_000, 'process exit');
  }
  const resolved = await realpath(userData);
  assert.equal(path.dirname(resolved).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('asterium-guidance-live-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  for (const original of originals) assert.equal(hash(await readFile(path.join(source, original.name))), hash(original.bytes), 'Source configuration changed');
  result.sourceConfigurationUnchanged = true; result.temporaryDataRemoved = true;
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function reservePort() { const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; }
async function until(probe, timeout, label) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 150)); } throw new Error(`Timed out: ${label}`); }
