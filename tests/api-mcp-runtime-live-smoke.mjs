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

const userData = await mkdtemp(path.join(os.tmpdir(), 'asterium-s4-live-'));
const workspace = path.join(userData, 'workspace');
const control = path.join(userData, 'mcp-tools.json');
const lifecycle = path.join(userData, 'mcp-lifecycle.jsonl');
const fixture = path.join(root, 'tests', 'fixtures', 'api-mcp-server.mjs');
let extensionId;
const evidenceDirectory = path.join(root, '.qa', 's4-live-api');
const partnerId = 's4-live-api-partner';
const grantId = 's4-live-workspace';
const credentialRef = 's4-live-credential';
const partnerName = 'S4 自动验收';
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
  await page.evaluate(async ({ partnerId, partnerName, grantId, workspace, credentialRef, settings }) => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    const template = state.partners.find((partner) => partner.sourceMode === 'api_partner') ?? state.partners[0];
    const partner = {
      ...template, id: partnerId, sourceMode: 'api_partner', isPrototype: false, configured: true,
      publicIdentity: { displayName: partnerName, introduction: '隔离自动测试', expertise: '工具权限验收', mentionName: 'S4验收' },
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
      { id: 's4-manual', title: 'S4 手动审批', permissionMode: 'manual', planMode: 'default' },
      { id: 's4-readonly', title: 'S4 只读', permissionMode: 'read_only', planMode: 'default' },
      { id: 's4-plan', title: 'S4 Plan', permissionMode: 'full', planMode: 'plan' },
      { id: 's4-auto', title: 'S4 自动审批', permissionMode: 'automatic', planMode: 'default' },
      { id: 's4-full', title: 'S4 完整权限', permissionMode: 'full', planMode: 'default' },
    ].map((conversation) => ({ ...conversation, partnerId, messages: [], updatedAt: new Date().toISOString() }));
    state.activePartnerId = partnerId; state.activeConversationId = 's4-manual';
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
    globalThis.__s4Events = [];
    globalThis.asteriumAgents.onEvent((event) => { if (event.partnerId === id) globalThis.__s4Events.push(event); });
  }, partnerId);
  console.log('S4_LIVE isolated application ready');


  extensionId = await page.evaluate(async ({ partnerId, fixture, lifecycle, control, workspace, node }) => {
    const api = globalThis.asteriumExtensions;
    let state = await api.get();
    state = await api.upsert({ expectedVersion: state.version, name: 'S4 Fixture', enabled: true, configuration: { type: 'mcp_stdio', command: node, args: [fixture, lifecycle, control], cwd: workspace }, secrets: { FIXTURE_TOKEN: 's4-private-test-token' } });
    const id = state.extensions[0].id;
    state = await api.setBinding({ expectedVersion: state.version, partnerId, extensionIds: [id] });
    await api.setTrust({ expectedVersion: state.version, id, action: 'request' });
    return id;
  }, { partnerId, fixture, lifecycle, control, workspace, node: process.execPath });
  const inspect = (value) => '请只调用一次 MCP 服务 S4 Fixture 的 inspect 工具，value=' + value + '。不要用其他工具，不写文件，不写记忆，不用命令。若工具被拒绝不得重试。完成后只回复 S4_DONE。';
  let start = await send(inspect('allow_once'));
  await page.getByRole('button', { name: '允许一次', exact: true }).waitFor({ timeout: 90000 });
  assert.equal(await page.getByRole('button', { name: '允许并持续信任此 MCP', exact: true }).count(), 0, 'Startup approval cannot grant trust before discovery.');
  await page.screenshot({ path: path.join(evidenceDirectory, 'startup-approval.png') });
  await page.getByRole('button', { name: '允许一次', exact: true }).click();
  await page.getByRole('button', { name: '允许并持续信任此 MCP', exact: true }).waitFor({ timeout: 90000 });
  await page.screenshot({ path: path.join(evidenceDirectory, 'pending-trust-approval.png') });
  await page.getByRole('button', { name: '允许一次', exact: true }).click();
  let events = await finished(start);
  assert.equal(events.filter(e => e.type === 'authorization.requested').length, 2);
  assert.equal(await trust(), 'pending');
  assert.equal((await calls()).length, 1);
  result.cases.startupAndAllowOnce = true;
  console.log('S4_LIVE startupAndAllowOnce passed');

  start = await send(inspect('persist'));
  await page.getByRole('button', { name: '允许并持续信任此 MCP', exact: true }).click({ timeout: 90000 });
  events = await finished(start);
  assert.equal(events.filter(e => e.type === 'authorization.requested').length, 1);
  assert.ok(events.some(e => e.type === 'authorization.resolved' && e.extensionTrustGranted));
  assert.equal(await trust(), 'trusted');
  assert.equal((await calls()).length, 2);
  await page.screenshot({ path: path.join(evidenceDirectory, 'trust-granted.png') });
  result.cases.explicitPersistentTrust = true;
  console.log('S4_LIVE explicitPersistentTrust passed');

  start = await send(inspect('trusted'));
  events = await finished(start);
  assert.ok(!events.some(e => e.type === 'authorization.requested'));
  assert.equal((await calls()).length, 3);
  result.cases.trustedNoRepeatedApproval = true;

  await page.getByText('S4 自动审批', { exact: true }).click();
  start = await send(inspect('cross_conversation'));
  events = await finished(start);
  assert.ok(!events.some(e => e.type === 'authorization.requested'));
  assert.equal((await calls()).length, 4);
  result.cases.trustedAcrossConversations = true;
  console.log('S4_LIVE trustedAcrossConversations passed');

  await page.getByText('S4 只读', { exact: true }).click();
  const beforeRestricted = await calls();
  const startsBefore = (await lifecycleEvents()).filter(e => e.event === 'start').length;
  start = await send('当前只读模式。请查看工具清单并说明 MCP inspect 是否可用，不要调用任何工具，一句回答即可。');
  events = await finished(start);
  assert.ok(!events.some(e => e.type === 'authorization.requested'));
  assert.deepEqual(await calls(), beforeRestricted);
  assert.equal((await lifecycleEvents()).filter(e => e.event === 'start').length, startsBefore);
  result.cases.readOnlyCannotUseTrustedMcp = true;

  await page.getByText('S4 Plan', { exact: true }).click();
  start = await send('现在只调查和规划，用一句话计划以后调用 MCP inspect。本轮不要调用工具，计划完成后结束。');
  await page.getByRole('radio', { name: /暂不执行/ }).check({ timeout: 90000 });
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  events = await finished(start, 'run.cancelled');
  assert.ok(!events.some(e => e.type === 'authorization.requested'));
  assert.deepEqual(await calls(), beforeRestricted);
  assert.equal((await lifecycleEvents()).filter(e => e.event === 'start').length, startsBefore);
  result.cases.planCannotUseTrustedMcp = true;
  console.log('S4_LIVE readOnlyAndPlan passed');

  await page.evaluate(async (id) => {
    const api = globalThis.asteriumExtensions, state = await api.get();
    await api.setTrust({ expectedVersion: state.version, id, action: 'revoke' });
  }, extensionId);
  await page.getByText('S4 手动审批', { exact: true }).click();
  start = await send(inspect('revoked'));
  await page.getByRole('button', { name: '允许一次', exact: true }).click({ timeout: 90000 });
  await page.getByRole('button', { name: '拒绝', exact: true }).click({ timeout: 90000 });
  events = await finished(start);
  assert.equal(events.filter(e => e.type === 'authorization.requested').length, 2);
  assert.ok(!events.some(e => e.type === 'authorization.requested' && e.extensionTrust));
  assert.equal(await trust(), 'untrusted');
  assert.deepEqual(await calls(), beforeRestricted);
  result.cases.revokeRequiresApprovalAgain = true;
  console.log('S4_LIVE revokeRequiresApprovalAgain passed');
  assert.ok(!(await page.evaluate(() => JSON.stringify(globalThis.__s4Events))).includes('s4-private-test-token'));
  result.cases.credentialRedaction = true;
  result.cases.realUiToModelToMcp = true;
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
  assert.ok(path.basename(resolved).startsWith('asterium-s4-live-'));
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
  const index = await page.evaluate(() => globalThis.__s4Events.length);
  await page.getByPlaceholder(`给 ${partnerName} 发送消息…`).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction((index) => {
    if (globalThis.__s4Events.length > index) return true;
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    return state.conversations.find((conversation) => conversation.id === state.activeConversationId)?.messages.at(-1)?.status === 'failed';
  }, index, { timeout: 30_000 });
  const accepted = await page.evaluate((index) => globalThis.__s4Events.length > index, index);
  assert.ok(accepted, 'UI send failed before the runtime started.');
  return index;
}
async function finished(index, expected = 'run.completed') {
  await page.waitForFunction((index) => globalThis.__s4Events.slice(index).some((e) => ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type)), index, { timeout: 90_000 });
  const events = await page.evaluate((index) => globalThis.__s4Events.slice(index), index);
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

async function trust() { return page.evaluate(async (id) => (await globalThis.asteriumExtensions.get()).extensions.find(e => e.id === id).trust, extensionId); }
async function lifecycleEvents() { return (await readFile(lifecycle, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
async function calls() { return (await lifecycleEvents()).filter(e => e.event === 'call'); }
