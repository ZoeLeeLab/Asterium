import { runAutoTest, spawnTestProcess as spawn, testRm as rm, autoTestEvidence, createTestNetServer } from './helpers/autoTest.mjs';
import { requireLiveTestSource } from './helpers/liveTestConfiguration.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';

import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

await runAutoTest(async () => {
// Self installation through the real API partner, approval cards, SDK discovery and settings UI.









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

const userData = await mkdtemp(path.join(os.tmpdir(), 'asterium-install-live-'));
const workspace = path.join(userData, 'workspace');
const control = path.join(userData, 'mcp-tools.json');
const lifecycle = path.join(userData, 'mcp-lifecycle.jsonl');
const fixture = path.join(root, 'tests', 'fixtures', 'api-mcp-server.mjs');
let extensionId;
const evidenceDirectory = autoTestEvidence('install-live-api');
const partnerId = 'install-live-api-partner';
const grantId = 'install-live-workspace';
const credentialRef = 'install-live-credential';
const partnerName = 'INSTALL 自动验收';
let child;
let browser;
let page;
let diagnostics = '';
let launchFailure;
const result = { realUiCards: true, realMcpProtocol: true, provider: settings.provider, model: settings.model, isolatedUserData: true, cases: {} };

try {
  await mkdir(workspace);
  await writeFile(control, JSON.stringify({ tools: [{ name: 'inspect', description: 'Return a synthetic fixture value. Use this MCP tool when asked to inspect.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] }));
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
  const seededState = await page.evaluate(async ({ partnerId, partnerName, grantId, workspace, credentialRef, settings }) => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    const template = state.partners.find((partner) => partner.sourceMode === 'api_partner') ?? state.partners[0];
    const partner = {
      ...template, id: partnerId, sourceMode: 'api_partner', isPrototype: false, configured: true,
      publicIdentity: { displayName: partnerName, introduction: '隔离自动测试', expertise: '工具权限验收', mentionName: 'INSTALL验收' },
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
      { id: 'install-manual', title: 'INSTALL 手动审批', permissionMode: 'manual', planMode: 'default' },
      { id: 'install-readonly', title: 'INSTALL 只读', permissionMode: 'read_only', planMode: 'default' },
      { id: 'install-plan', title: 'INSTALL Plan', permissionMode: 'full', planMode: 'plan' },
      { id: 'install-auto', title: 'INSTALL 自动审批', permissionMode: 'automatic', planMode: 'default' },
      { id: 'install-full', title: 'INSTALL 完整权限', permissionMode: 'full', planMode: 'default' },
    ].map((conversation) => ({ ...conversation, partnerId, messages: [], updatedAt: new Date().toISOString() }));
    state.activePartnerId = partnerId; state.activeConversationId = 'install-manual';
    await globalThis.asteriumAgents.syncPartnerWorkspace(partnerId, grantId, [grantId]);
    await globalThis.asteriumAgents.savePartnerProfile({
      partnerId, sourceMode: 'api_partner', publicIdentity: partner.publicIdentity, management: partner.profileManagement,
      personality: partner.personality, systemPrompt: partner.systemPrompt,
      connectionSettings: { provider: partner.provider, endpoint: partner.endpoint, configuredModel: partner.model, thinkingMode: partner.thinkingMode, reasoningEffort: partner.reasoningEffort, apiSessionHistoryEnabled: true },
    });
    return state;
  }, { partnerId, partnerName, grantId, workspace, credentialRef, settings: { endpoint: settings.endpoint, model: settings.model } });
  // Seed before React boots; asynchronous profile events from the demo must not overwrite the test fixture.
  await page.addInitScript((state) => {
    if (localStorage.getItem('asterium.install-smoke.seeded')) return;
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
    localStorage.setItem('asterium.theme.v1', 'light');
    localStorage.setItem('asterium.install-smoke.seeded', '1');
  }, seededState);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder(`给 ${partnerName} 发送消息…`).waitFor();
  await page.evaluate((id) => {
    globalThis.__installEvents = [];
    globalThis.asteriumAgents.onEvent((event) => { if (event.partnerId === id) globalThis.__installEvents.push(event); });
  }, partnerId);
  console.log('INSTALL_LIVE isolated application ready');


  const input = { name: 'INSTALL Installed Fixture', configuration: { type: 'mcp_stdio', command: process.execPath, args: [fixture, lifecycle, control] } };
  let start = await send('请为你自己安装以下 MCP，先用 asterium_mcp_list 查询，再用 asterium_mcp_install 登记。启动所需文件已准备好，不需要 run_command。登记后请在同一轮调用该服务 inspect 工具一次，value=SELF_INSTALL_OK。配置：' + JSON.stringify(input) + '。如果用户拒绝不得重试。不要写笔记或记忆。');
  const allow = page.getByRole('button', { name: '允许一次', exact: true });
  await allow.waitFor({ timeout: 90000 });
  let requested = await page.evaluate(() => globalThis.__installEvents.filter(e => e.type === 'authorization.requested'));
  assert.match(requested.at(-1).summary, /安装并/);
  assert.equal((await page.evaluate(() => globalThis.asteriumExtensions.get())).extensions.length, 0);
  assert.equal(await page.getByRole('button', { name: '允许并持续信任此 MCP', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(evidenceDirectory, 'install-approval.png') });
  await allow.click();
  await page.waitForFunction(() => globalThis.__installEvents.filter(e => e.type === 'authorization.requested').length >= 2, null, { timeout: 90000 });
  requested = await page.evaluate(() => globalThis.__installEvents.filter(e => e.type === 'authorization.requested'));
  assert.match(requested.at(-1).summary, /连接 MCP/);
  const state = await page.evaluate(() => globalThis.asteriumExtensions.get());
  assert.equal(state.extensions.length, 1);
  extensionId = state.extensions[0].id;
  assert.equal(state.extensions[0].trust, 'untrusted');
  assert.equal(state.extensions[0].configuration.cwd, workspace);
  assert.deepEqual(state.bindings, [{ partnerId, extensionIds: [extensionId] }]);
  assert.equal((await lifecycleEvents()).length, 0);
  await allow.click();
  await page.waitForFunction(() => globalThis.__installEvents.filter(e => e.type === 'authorization.requested').length >= 3, null, { timeout: 90000 });
  assert.equal(await page.getByRole('button', { name: '允许并持续信任此 MCP', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(evidenceDirectory, 'first-tool-approval.png') });
  await allow.click();
  let events = await finished(start);
  assert.equal(events.filter(e => e.type === 'authorization.requested').length, 3);
  const installation = events.find(e => e.type === 'tool.started' && e.toolName === 'asterium_mcp_install');
  assert.ok(installation && events.some(e => e.type === 'tool.completed' && e.toolCallId === installation.toolCallId && e.outcome === 'success'));
  assert.equal((await calls()).length, 1);
  assert.equal(await trust(), 'untrusted');
  result.cases.installDiscoverAndUseInOneRealRun = true;
  result.cases.threeRealApprovalsAndNoImplicitTrust = true;
  console.log('INSTALL_LIVE installDiscoverAndUseInOneRealRun passed');

  start = await send('现在再次只调用一次刚才安装的 INSTALL Installed Fixture 的 inspect 工具，value=SELF_INSTALL_REUSE。不要重新安装或用其他工具，不要写记忆。');
  await allow.click({ timeout: 90000 });
  events = await finished(start);
  assert.equal(events.filter(e => e.type === 'authorization.requested').length, 1);
  assert.equal((await calls()).length, 2);
  assert.equal((await page.evaluate(() => globalThis.asteriumExtensions.get())).extensions.length, 1);
  result.cases.reuseOnSubsequentRun = true;

  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: '管理 MCP', exact: true }).click();
  await page.getByRole('heading', { name: 'MCP 管理', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'INSTALL Installed Fixture', exact: true }).waitFor();
  assert.ok(await page.getByRole('checkbox', { name: partnerName, exact: true }).isChecked());
  await page.getByRole('button', { name: '申请持续信任', exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidenceDirectory, 'installed-in-settings.png') });
  result.cases.visibleInSettingsWithOwnBinding = true;

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
  assert.ok(path.basename(resolved).startsWith('asterium-install-live-'));
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
  const index = await page.evaluate(() => globalThis.__installEvents.length);
  await page.getByPlaceholder(`给 ${partnerName} 发送消息…`).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction((index) => {
    if (globalThis.__installEvents.length > index) return true;
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    return state.conversations.find((conversation) => conversation.id === state.activeConversationId)?.messages.at(-1)?.status === 'failed';
  }, index, { timeout: 30_000 });
  const accepted = await page.evaluate((index) => globalThis.__installEvents.length > index, index);
  assert.ok(accepted, 'UI send failed before the runtime started.');
  return index;
}
async function finished(index, expected = 'run.completed') {
  await page.waitForFunction((index) => globalThis.__installEvents.slice(index).some((e) => ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type)), index, { timeout: 90_000 });
  const events = await page.evaluate((index) => globalThis.__installEvents.slice(index), index);
  const terminal = events.find((e) => ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type));
  assert.equal(terminal.type, expected, terminal.error?.code ?? 'Unexpected run outcome');
  await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  return events;
}
async function reservePort() {
  const server = createTestNetServer();
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

async function trust() { return page.evaluate(async (id) => (await globalThis.asteriumExtensions.get()).extensions.find(e => e.id === id).trust, extensionId); }
async function lifecycleEvents() { return (await readFile(lifecycle, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
async function calls() { return (await lifecycleEvents()).filter(e => e.event === 'call'); }
});
