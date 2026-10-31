import { requireLiveTestSource } from './helpers/liveTestConfiguration.mjs';
// Explicit opt-in: real DeepSeek requests, isolated app data, synthetic UI state and temporary files.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

if (process.env.ASTERIUM_API_LIVE_SMOKE !== '1') throw new Error('Set ASTERIUM_API_LIVE_SMOKE=1 to authorize real API smoke requests.');
const root = path.resolve(import.meta.dirname, '..');
const sourceDirectory = requireLiveTestSource();
const credentialFile = path.join(sourceDirectory, 'secure-credentials.v1.json');
const settingsFile = path.join(sourceDirectory, 'memory-fallback-settings.v1.json');
const localStateFile = path.join(sourceDirectory, 'Local State');
const sourceBytes = await readFile(credentialFile);
const settingsBytes = await readFile(settingsFile);
const localStateBytes = await readFile(localStateFile);
const settings = JSON.parse(settingsBytes);
const ciphertext = JSON.parse(sourceBytes).credentials['asterium-memory-fallback-api'];
assert.equal(settings.provider, 'deepseek');
assert.equal(settings.endpoint, 'https://api.deepseek.com/chat/completions');
assert.ok(ciphertext && settings.model, 'A configured DeepSeek credential and model are required.');

const userData = await mkdtemp(path.join(os.tmpdir(), 'asterium-s1-live-'));
const workspace = path.join(userData, 'workspace');
const target = path.join(workspace, 'asterium-s1-smoke.txt');
const automaticTarget = path.join(workspace, 'asterium-s1-automatic.txt');
const evidenceDirectory = path.join(root, '.qa', 's1-live-api');
const partnerId = 's1-live-api-partner';
const grantId = 's1-live-workspace';
const credentialRef = 's1-live-credential';
const partnerName = 'S1 自动验收';
let child;
let browser;
let page;
let diagnostics = '';
let launchFailure;
const result = { provider: settings.provider, model: settings.model, isolatedUserData: true, cases: {} };

try {
  await mkdir(workspace);
  await mkdir(evidenceDirectory, { recursive: true });
  // Copy only the known provider's encrypted entry; never decrypt, print, or copy user conversations/personas.
  await writeFile(path.join(userData, 'secure-credentials.v1.json'), JSON.stringify({ version: 1, credentials: { [credentialRef]: ciphertext } }), { mode: 0o600 });
  // Chromium's Windows encrypted key is profile-specific. Copy only its still-encrypted key metadata.
  const encryptionMetadata = JSON.parse(localStateBytes).os_crypt;
  assert.ok(encryptionMetadata, 'The source profile has no OS encryption metadata.');
  await writeFile(path.join(userData, 'Local State'), JSON.stringify({ os_crypt: encryptionMetadata }), { mode: 0o600 });
  await writeFile(path.join(userData, 'workspace-grants.v1.json'), JSON.stringify({ version: 1, grants: { [grantId]: workspace } }));
  const port = await reservePort();
  const executable = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe');
  child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: path.dirname(executable), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.once('error', (error) => { launchFailure = error; });
  child.stderr.on('data', (bytes) => { diagnostics = `${diagnostics}${bytes}`.slice(-12_000); });
  await until(async () => {
    if (launchFailure) throw launchFailure;
    if (child.exitCode !== null) throw new Error('The isolated application exited before startup.');
    return fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false);
  }, 30_000, 'Electron debugger');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await until(async () => {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:'));
    return Boolean(page);
  }, 15_000, 'application page');
  await page.getByLabel('主要页面').waitFor();
  await page.evaluate(async ({ partnerId, partnerName, grantId, workspace, credentialRef, settings }) => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    const template = state.partners.find((partner) => partner.sourceMode === 'api_partner');
    const partner = {
      ...template, id: partnerId, isPrototype: false, configured: true,
      publicIdentity: { displayName: partnerName, introduction: '隔离自动测试', expertise: '工具权限验收', mentionName: 'S1验收' },
      provider: 'deepseek', endpoint: settings.endpoint, model: settings.model, credentialRef,
      personality: '你是自动测试伙伴。只执行当前测试指令，回复尽量简短。',
      systemPrompt: '当前仅为隔离测试。用户指定工具时只调用指定工具；工具被拒绝后不得重试或改用其他工具。不要写记忆或笔记，不要联网。',
      apiSessionHistoryEnabled: true, thinkingMode: 'disabled', reasoningEffort: 'low',
      primaryWorkspaceGrantId: grantId, workspaceGrantIds: [grantId], workingDirectories: [workspace],
      profileManagement: { userProfile: false, personality: true, memoryMode: 'asterium' },
    };
    state.partners = [partner];
    state.userProfile = { ...state.userProfile, displayName: '自动测试', introduction: '' };
    state.projects = []; state.groupChats = []; state.activeProjectId = ''; state.activeGroupChatId = '';
    state.conversations = [
      { id: 's1-manual', title: 'S1 手动审批', permissionMode: 'manual', planMode: 'default' },
      { id: 's1-readonly', title: 'S1 只读', permissionMode: 'read_only', planMode: 'default' },
      { id: 's1-plan', title: 'S1 Plan', permissionMode: 'full', planMode: 'plan' },
      { id: 's1-auto', title: 'S1 自动审批', permissionMode: 'automatic', planMode: 'default' },
      { id: 's1-full', title: 'S1 完整权限', permissionMode: 'full', planMode: 'default' },
    ].map((conversation) => ({ ...conversation, partnerId, messages: [], updatedAt: new Date().toISOString() }));
    state.activePartnerId = partnerId; state.activeConversationId = 's1-manual';
    await globalThis.asteriumAgents.syncPartnerWorkspace(partnerId, grantId, [grantId]);
    await globalThis.asteriumAgents.savePartnerProfile({
      partnerId, sourceMode: 'api_partner', publicIdentity: partner.publicIdentity, management: partner.profileManagement,
      personality: partner.personality, systemPrompt: partner.systemPrompt,
      connectionSettings: { provider: partner.provider, endpoint: partner.endpoint, configuredModel: partner.model, thinkingMode: partner.thinkingMode, reasoningEffort: partner.reasoningEffort, apiSessionHistoryEnabled: true },
    });
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
    localStorage.setItem('asterium.theme.v1', 'light');
  }, { partnerId, partnerName, grantId, workspace, credentialRef, settings: { endpoint: settings.endpoint, model: settings.model } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder(`给 ${partnerName} 发送消息…`).waitFor();
  await page.evaluate((id) => {
    globalThis.__s1Events = [];
    globalThis.asteriumAgents.onEvent((event) => { if (event.partnerId === id) globalThis.__s1Events.push(event); });
  }, partnerId);
  console.log('S1_LIVE isolated application ready');

  // Interact with the real Composer and approval cards, not the IPC resolution methods.
  let start = await send(`请只调用一次 write_file，在 ${target} 创建文件，内容只能是 S1_OK。需要审批时发起审批。若被拒绝，不得重试或改用其他工具。最后只回复 S1_DENY_DONE。`);
  await page.getByRole('button', { name: '拒绝', exact: true }).waitFor({ timeout: 90_000 });
  await page.screenshot({ path: path.join(evidenceDirectory, 'manual-approval.png') });
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  let events = await finished(start);
  assert.ok(events.some((e) => e.type === 'authorization.resolved' && e.decision === 'deny'));
  assert.equal(events.filter((e) => e.type === 'authorization.requested' && e.action === 'write_file').length, 1);
  assert.ok(events.some((e) => e.type === 'tool.completed' && e.outcome === 'failure' && e.detail.includes('USER_DENIED')));
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  result.cases.manualDeny = true;
  console.log('S1_LIVE manualDeny passed');

  start = await send(`这次请重新只调用一次 write_file，在 ${target} 创建文件，内容只能是 S1_OK。请发起工具审批，我将允许这次操作。不得改用命令。最后只回复 S1_ALLOW_DONE。`);
  await page.getByRole('button', { name: '允许一次', exact: true }).click({ timeout: 90_000 });
  events = await finished(start);
  assert.ok(events.some((e) => e.type === 'authorization.resolved' && e.decision === 'allow_once'));
  assert.ok(toolOutcome(events, 'write_file', 'success'));
  assert.equal(await readFile(target, 'utf8'), 'S1_OK');
  result.cases.manualAllowOnce = true;
  console.log('S1_LIVE manualAllowOnce passed');

  await page.getByText('S1 只读', { exact: true }).click();
  await page.getByRole('button', { name: '权限模式：只读', exact: true }).waitFor();
  start = await send(`请调用 read_file 读取 ${target}，然后尝试用 write_file 将它改为 S1_CHANGED。不得改用命令或其他工具；若权限不允许修改，保留原文件。最后只回复 S1_READONLY_DONE。`);
  events = await finished(start);
  assert.ok(toolOutcome(events, 'read_file', 'success'));
  assert.ok(!events.some((e) => e.type === 'authorization.requested' || e.type === 'file.produced'));
  assert.equal(await readFile(target, 'utf8'), 'S1_OK');
  await page.screenshot({ path: path.join(evidenceDirectory, 'readonly-result.png') });
  result.cases.readOnly = true;
  result.readOnlyAttemptedWrite = events.some((e) => e.type === 'tool.started' && e.toolName === 'write_file');
  console.log('S1_LIVE readOnly passed');

  await page.getByText('S1 Plan', { exact: true }).click();
  await page.locator('.plan-mode-banner').waitFor();
  start = await send(`请先调用 read_file 读取 ${target}，再制定将内容改成 S1_CHANGED 的计划。本轮只调查和规划，禁止修改文件或运行命令。计划用一句话写完。`);
  const stopOption = page.getByRole('radio', { name: /暂不执行/ });
  await stopOption.waitFor({ timeout: 90_000 });
  await page.screenshot({ path: path.join(evidenceDirectory, 'plan-confirmation.png') });
  await stopOption.check();
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  events = await finished(start, 'run.cancelled');
  assert.ok(toolOutcome(events, 'read_file', 'success'));
  assert.ok(events.some((e) => e.type === 'user_input.resolved' && e.answers['plan-execution'].includes('暂不执行')));
  assert.ok(!events.some((e) => e.type === 'authorization.requested' || e.type === 'file.produced'));
  assert.equal(await readFile(target, 'utf8'), 'S1_OK');
  result.cases.planReadAndStop = true;
  result.planPermissionMode = 'full';
  console.log('S1_LIVE planReadAndStop passed');

  await page.getByText('S1 自动审批', { exact: true }).click();
  await page.getByRole('button', { name: '权限模式：自动审批', exact: true }).waitFor();
  start = await send(`请只调用一次 write_file 在 ${automaticTarget} 创建文件，内容只能是 S1_AUTO。不要调用其他工具。最后只回复 S1_AUTO_DONE。`);
  events = await finished(start);
  assert.ok(toolOutcome(events, 'write_file', 'success'));
  assert.ok(!events.some((e) => e.type === 'authorization.requested'));
  assert.equal(await readFile(automaticTarget, 'utf8'), 'S1_AUTO');
  result.cases.automaticWriteWithoutApproval = true;
  console.log('S1_LIVE automaticWriteWithoutApproval passed');

  start = await send(`请只调用一次 delete_path 删除 ${automaticTarget}。需要审批时发起审批；若被拒绝不得重试或改用其他工具。最后只回复 S1_DELETE_DENY_DONE。`);
  await page.getByRole('button', { name: '拒绝', exact: true }).click({ timeout: 90_000 });
  events = await finished(start);
  assert.equal(events.filter((e) => e.type === 'authorization.requested' && e.action === 'delete_file').length, 1);
  assert.ok(toolOutcome(events, 'delete_path', 'failure'));
  assert.equal(await readFile(automaticTarget, 'utf8'), 'S1_AUTO');
  result.cases.automaticDeleteStillRequiresApproval = true;
  console.log('S1_LIVE automaticDeleteStillRequiresApproval passed');

  await page.getByText('S1 完整权限', { exact: true }).click();
  await page.getByRole('button', { name: '权限模式：完整权限', exact: true }).waitFor();
  start = await send(`请只调用一次 delete_path 删除 ${automaticTarget}，不要调用其他工具。最后只回复 S1_FULL_DONE。`);
  events = await finished(start);
  assert.ok(toolOutcome(events, 'delete_path', 'success'));
  assert.ok(!events.some((e) => e.type === 'authorization.requested'));
  await assert.rejects(readFile(automaticTarget), { code: 'ENOENT' });
  result.cases.fullPermissionDeleteWithoutApproval = true;
  console.log('S1_LIVE fullPermissionDeleteWithoutApproval passed');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(evidenceDirectory, 'failure.png') }).catch(() => {});
  const codes = [...new Set(diagnostics.match(/(?:API|ASTERIUM|PARTNER|PROFILE|INVALID|CREDENTIAL|SQLITE|MEMORY|WORKSPACE)_[A-Z0-9_:]+/g) ?? [])];
  if (codes.length) console.log(JSON.stringify({ diagnosticCodes: codes }));
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (child?.pid && child.exitCode === null) {
    if (process.platform === 'win32') await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', resolve); killer.once('error', resolve);
    });
    else child.kill('SIGTERM');
    await until(async () => child.exitCode !== null || child.signalCode !== null, 10_000, 'isolated process exit');
  }
  const tempRoot = await realpath(os.tmpdir());
  const resolved = await realpath(userData);
  assert.equal(path.dirname(resolved).toLowerCase(), tempRoot.toLowerCase());
  assert.ok(path.basename(resolved).startsWith('asterium-s1-live-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  assert.equal(hash(await readFile(credentialFile)), hash(sourceBytes), 'The source credential file changed.');
  assert.equal(hash(await readFile(settingsFile)), hash(settingsBytes), 'The source API configuration changed.');
  assert.equal(hash(await readFile(localStateFile)), hash(localStateBytes), 'The source encryption metadata changed.');
}
result.sourceConfigurationUnchanged = true;
result.temporaryDataRemoved = true;
await writeFile(path.join(evidenceDirectory, 'result.json'), JSON.stringify(result, null, 2));
await rm(path.join(evidenceDirectory, 'failure.png'), { force: true });
console.log(JSON.stringify(result, null, 2));

async function send(text) {
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  const index = await page.evaluate(() => globalThis.__s1Events.length);
  await page.getByPlaceholder(`给 ${partnerName} 发送消息…`).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction((index) => {
    if (globalThis.__s1Events.length > index) return true;
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    return state.conversations.find((conversation) => conversation.id === state.activeConversationId)?.messages.at(-1)?.status === 'failed';
  }, index, { timeout: 30_000 });
  const accepted = await page.evaluate((index) => globalThis.__s1Events.length > index, index);
  assert.ok(accepted, 'UI send failed before the runtime started.');
  return index;
}
async function finished(index, expected = 'run.completed') {
  await page.waitForFunction((index) => globalThis.__s1Events.slice(index).some((e) => ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type)), index, { timeout: 90_000 });
  const events = await page.evaluate((index) => globalThis.__s1Events.slice(index), index);
  const terminal = events.find((e) => ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type));
  assert.equal(terminal.type, expected, terminal.error?.code ?? 'Unexpected run outcome');
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  return events;
}
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(probe, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 150)); }
  throw new Error(`Timed out waiting for ${label}`);
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function toolOutcome(events, name, outcome) {
  const ids = new Set(events.filter((event) => event.type === 'tool.started' && event.toolName === name).map((event) => event.toolCallId));
  return events.some((event) => event.type === 'tool.completed' && ids.has(event.toolCallId) && event.outcome === outcome);
}
