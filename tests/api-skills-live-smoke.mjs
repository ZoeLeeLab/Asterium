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

const userData = await mkdtemp(path.join(os.tmpdir(), 'asterium-s6-live-'));
const workspace = path.join(userData, 'workspace');
const evidenceDirectory = path.join(root, '.qa', 's6-live-api');
const partnerId = 's6-live-api-partner';
const grantId = 's6-live-workspace';
const credentialRef = 's6-live-credential';
const partnerName = 'S6 自动验收';
let child;
let browser;
let page;
let diagnostics = '';
let launchFailure;
const result = { realUiCards: true, skillReads: true, provider: settings.provider, model: settings.model, isolatedUserData: true, cases: {} };

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
    const template = state.partners.find((partner) => partner.sourceMode === 'api_partner') ?? state.partners[0];
    const partner = {
      ...template, id: partnerId, sourceMode: 'api_partner', isPrototype: false, configured: true,
      publicIdentity: { displayName: partnerName, introduction: '隔离自动测试', expertise: '工具权限验收', mentionName: 'S6验收' },
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
      { id: 's6-manual', title: 'S6 手动审批', permissionMode: 'manual', planMode: 'default' },
      { id: 's6-readonly', title: 'S6 只读', permissionMode: 'read_only', planMode: 'default' },
      { id: 's6-plan', title: 'S6 Plan', permissionMode: 'full', planMode: 'plan' },
      { id: 's6-auto', title: 'S6 自动审批', permissionMode: 'automatic', planMode: 'default' },
      { id: 's6-full', title: 'S6 完整权限', permissionMode: 'full', planMode: 'default' },
    ].map((conversation) => ({ ...conversation, partnerId, messages: [], updatedAt: new Date().toISOString() }));
    state.activePartnerId = partnerId; state.activeConversationId = 's6-manual';
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
    globalThis.__s6Events = [];
    globalThis.__s6Unsubscribe = globalThis.asteriumAgents.onEvent((event) => { if (event.partnerId === id) globalThis.__s6Events.push(event); });
  }, partnerId);
  console.log('S6_LIVE isolated application ready');

  const skillDirectory = path.join(userData, 'skill');
  await mkdir(path.join(skillDirectory, 'references'), { recursive: true });
  await writeFile(path.join(skillDirectory, 'SKILL.md'), '---\nname: s6-fixture\ndescription: Read the synthetic skill reference to find the verification token.\n---\nRead references/help.txt using this skill tool. Report its exact verification token. Do not call other tools.');
  await writeFile(path.join(skillDirectory, 'references/help.txt'), 'Verification token: S6-READ-SUCCESS');
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: '管理 Skills', exact: true }).click();
  await page.getByRole('heading', { name: 'Skills 管理', exact: true }).waitFor();
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click();
  await page.getByLabel('Skill 名称').fill('S6 Fixture');
  await page.getByLabel('Skill 文件夹').fill(skillDirectory);
  await page.getByRole('button', { name: '保存 Skill', exact: true }).click();
  await page.getByRole('heading', { name: '技能包', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: partnerName, exact: true }).click();
  await until(async () => await page.getByRole('checkbox', { name: partnerName, exact: true }).isChecked(), 10000, 'skill binding');
  await page.getByRole('button', { name: '申请脚本持续信任', exact: true }).click();
  await page.getByRole('button', { name: '取消待信任', exact: true }).waitFor();
  result.cases.uiCreateBindAndPending = true;
  await page.screenshot({ path: path.join(evidenceDirectory, 'skills-light.png') });
  await page.getByRole('button', { name: /外观/ }).click();
  await page.screenshot({ path: path.join(evidenceDirectory, 'skills-dark.png') });
  await page.setViewportSize({ width: 1050, height: 800 });
  assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await page.getByPlaceholder('给 ' + partnerName + ' 发送消息…').waitFor();
  await page.evaluate(id => { globalThis.__s6Unsubscribe?.(); globalThis.__s6Events = []; globalThis.__s6Unsubscribe = globalThis.asteriumAgents.onEvent(e => { if (e.partnerId === id) globalThis.__s6Events.push(e); }); }, partnerId);
  let index = await send('使用 s6-fixture Skill，先用 skill_read 工具读说明，再读取 references/help.txt，回复验证 token。只读这两个技能文件，不要调用其它工具。');
  const events = await finished(index);
  assert.equal(events.filter(e => e.type === 'authorization.requested').length, 0);
  assert.ok(events.filter(e => e.type === 'tool.completed').length >= 2);
  assert.ok(JSON.stringify(events).includes('S6-READ-SUCCESS'));
  const saved = await page.evaluate(() => globalThis.asteriumExtensions.get());
  assert.equal(saved.extensions[0].trust, 'pending');
  result.cases.realProviderProgressiveReadsWithoutTrustActivation = true;
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: '管理 Skills', exact: true }).click();
  await page.getByRole('button', { name: '编辑 Skill', exact: true }).click();
  await page.getByLabel('Skill 名称').fill('Uncommitted');
  await page.getByRole('button', { name: 'MCP 管理', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await page.getByLabel('Skill 名称').inputValue(), 'Uncommitted');
  result.cases.settingsUnsavedProtection = true;
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
  assert.ok(path.basename(resolved).startsWith('asterium-s6-live-'));
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
  const index = await page.evaluate(() => globalThis.__s6Events.length);
  await page.getByPlaceholder(`给 ${partnerName} 发送消息…`).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction((index) => {
    if (globalThis.__s6Events.length > index) return true;
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    return state.conversations.find((conversation) => conversation.id === state.activeConversationId)?.messages.at(-1)?.status === 'failed';
  }, index, { timeout: 30_000 });
  const accepted = await page.evaluate((index) => globalThis.__s6Events.length > index, index);
  assert.ok(accepted, 'UI send failed before the runtime started.');
  return index;
}
async function finished(index, expected = 'run.completed') {
  await page.waitForFunction((index) => globalThis.__s6Events.slice(index).some((e) => ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type)), index, { timeout: 90_000 });
  const events = await page.evaluate((index) => globalThis.__s6Events.slice(index), index);
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
