// Real packaged Main + UI + PowerShell, synthetic loopback model only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'asterium-native-command-')));
const workspace = path.join(temporary, 'workspace'), target = path.join(temporary, 'outside-native.txt');
const skillDirectory = path.join(temporary, 'skill');
const evidence = path.resolve(root, process.env.ASTERIUM_NATIVE_APPROVAL_EVIDENCE ?? '.qa/native-command-approval/packaged');
const executable = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out/native-command-approval/Asterium-win32-x64/Asterium.exe');
const literal = value => `'${value.replaceAll("'", "''")}'`;
const nativeCommand = `[IO.File]::AppendAllText(${literal(target)}, 'NATIVE_ONCE'); Write-Output 'NATIVE_COMMAND_OK'`;
const fixtureArgs = { command: nativeCommand, cwd: workspace, sandbox_permissions: 'require_escalated', justification: '仅测试本次无沙箱审批，不改变权限。' };
const result = { status: 'running', realModelCalls: false, privateCredentialsUsed: false, cases: [], events: [] };
await mkdir(workspace); await mkdir(evidence, { recursive: true });
await mkdir(path.join(skillDirectory, 'scripts'), { recursive: true });
await writeFile(path.join(skillDirectory, 'SKILL.md'), '---\nname: approval-fixture\ndescription: Approval display test only\n---\nNever execute this rejected fixture.\n');
await writeFile(path.join(skillDirectory, 'scripts/probe.ps1'), "throw 'REJECTED_SKILL_MUST_NOT_RUN'\n");
await writeFile(path.join(temporary, 'workspace-grants.v1.json'), JSON.stringify({ version: 1, grants: { 'native-fixture': workspace } }));
result.appArchiveSha256 = createHash('sha256').update(await readFile(path.join(path.dirname(executable), 'resources/app.asar'))).digest('hex');
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, 'Bearer synthetic-native-key');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), last = body.messages.at(-1);
    const tool = last.role === 'user';
    const skill = tool && last.content.includes('SKILL_APPROVAL_ONLY');
    const name = skill ? body.tools.find(t => t.function?.name?.startsWith('skill_run_')).function.name : 'run_command';
    const args = skill ? { script: 'scripts/probe.ps1', args: [] } : last.content.includes('DEFAULT_SANDBOX') ? { command: 'Write-Output DEFAULT_SANDBOX', cwd: workspace } : fixtureArgs;
    const data = { choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'native-fixture-call', function: { name, arguments: JSON.stringify(args) } }] } : { content: 'FIXTURE_DONE' }, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`);
  } catch { response.writeHead(500).end('synthetic fixture error'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
let application, page;
try {
  application = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${temporary}`] });
  page = await application.firstWindow(); page.setDefaultTimeout(20000);
  await page.waitForFunction(() => localStorage.getItem('asterium.prototype.v7'));
  await page.evaluate(async ({ endpoint, workspace }) => {
    const api = globalThis.asteriumAgents, credential = await api.saveApiCredential('synthetic-native-key');
    let config = await api.apiConnectionsGet();
    config = await api.apiConnectionsMutate({ action: 'service', expectedRevision: config.revision, value: { id: 'native-service', name: '本地模拟', protocol: 'chat_completions', endpoint, credentialRef: credential.credentialRef } });
    config = await api.apiConnectionsMutate({ action: 'model', expectedRevision: config.revision, value: { id: 'native-model', serviceId: 'native-service', model: 'synthetic-native', name: '本地模拟', tools: true, images: false, settings: { autoCompact: false } } });
    await api.apiConnectionsMutate({ action: 'bind', expectedRevision: config.revision, partnerId: 'native-partner', modelId: 'native-model' });
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    const partner = { ...state.partners.find(p => p.sourceMode === 'api_partner'), id: 'native-partner', sourceMode: 'api_partner', configured: true, isPrototype: false,
      publicIdentity: { displayName: 'Native 审批测试', mentionName: 'Native测试', introduction: '隔离测试', expertise: '' },
      provider: 'openai', endpoint, model: 'synthetic-native', modelId: 'native-model', credentialRef: credential.credentialRef,
      personality: '', systemPrompt: '', thinkingMode: 'disabled', apiSessionHistoryEnabled: true,
      profileManagement: { userProfile: false, personality: false, memoryMode: 'asterium' },
      primaryWorkspaceGrantId: 'native-fixture', workspaceGrantIds: ['native-fixture'], workingDirectories: [workspace], defaultPermissionMode: 'manual' };
    state.partners = [partner]; state.projects = []; state.groupChats = [];
    state.conversations = ['manual', 'full'].map(mode => ({ id: `native-${mode}`, title: `Native ${mode}`, partnerId: partner.id, permissionMode: mode, planMode: 'default', messages: [], updatedAt: new Date().toISOString() }));
    state.activePartnerId = partner.id; state.activeConversationId = 'native-manual'; state.activeProjectId = ''; state.activeGroupChatId = '';
    await api.syncPartnerWorkspace(partner.id, 'native-fixture', ['native-fixture']);
    await api.savePartnerProfile({ partnerId: partner.id, sourceMode: 'api_partner', publicIdentity: partner.publicIdentity, management: partner.profileManagement, personality: '', systemPrompt: '', connectionSettings: { provider: 'openai', endpoint, configuredModel: partner.model, thinkingMode: 'disabled', apiSessionHistoryEnabled: true } });
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
    await globalThis.asteriumGeneralSettings.update({ sandboxEnabled: true, sandboxAllowNetwork: false });
  }, { endpoint, workspace });
  await page.reload(); await page.getByPlaceholder('给 Native 审批测试 发送消息…').waitFor();
  await page.evaluate(() => { globalThis.__nativeEvents = []; globalThis.asteriumAgents.onEvent(event => globalThis.__nativeEvents.push(event)); });
  const before = await page.evaluate(() => globalThis.asteriumGeneralSettings.get());
  let start, events;
  if (process.env.ASTERIUM_SKILL_ONLY_SMOKE !== '1') {
  start = await send('NATIVE_DENY');
  await page.getByRole('button', { name: '仅本次无沙箱运行', exact: true }).waitFor();
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  assert.match(await page.locator('.timeline-authorization-card').innerText(), /不受沙箱工作区和联网开关限制/);
  await page.screenshot({ path: path.join(evidence, 'approval.png') });
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  events = await finished(start); assert.ok(events.some(e => e.type === 'tool.completed' && e.detail.includes('USER_DENIED')));
  await assert.rejects(readFile(target), { code: 'ENOENT' }); result.cases.push('UI-deny-no-process-effect');
  start = await send('NATIVE_ALLOW');
  await page.getByRole('button', { name: '仅本次无沙箱运行', exact: true }).waitFor();
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  await page.getByRole('button', { name: '仅本次无沙箱运行', exact: true }).click();
  events = await finished(start);
  const completed = events.find(e => e.type === 'tool.completed');
  assert.equal(completed.outcome, 'success'); assert.deepEqual(JSON.parse(completed.detail).execution, { backend: 'native', sandboxed: false });
  assert.equal(await readFile(target, 'utf8'), 'NATIVE_ONCE'); result.cases.push('UI-allow-exactly-once-real-Native-PowerShell');
  start = await send('DEFAULT_SANDBOX');
  await page.getByRole('button', { name: '允许一次', exact: true }).click();
  events = await finished(start);
  assert.ok(events.some(e => e.type === 'tool.completed' && e.outcome === 'failure' && /SANDBOX_(?:ELEVATED_HOST|HOST_IDENTITY)_REFUSED/.test(e.detail)));
  assert.equal(await readFile(target, 'utf8'), 'NATIVE_ONCE'); result.cases.push('next-default-command-still-Sandbox-elevated-host-refused');
  await page.getByText('Native full', { exact: true }).click();
  start = await send('FULL_NATIVE'); events = await finished(start);
  assert.ok(!events.some(e => e.type === 'authorization.requested'));
  assert.equal(await readFile(target, 'utf8'), 'NATIVE_ONCENATIVE_ONCE'); result.cases.push('Full-remains-Native-without-approval');
  assert.deepEqual((await page.evaluate(() => globalThis.asteriumGeneralSettings.get())).settings, before.settings);
  result.cases.push('settings-unchanged');
  }
  await page.evaluate(async directory => {
    const api = globalThis.asteriumExtensions; let state = await api.get();
    state = await api.upsert({ expectedVersion: state.version, name: 'Skill 审批展示测试', enabled: true, configuration: { type: 'skill', directory } });
    await api.setBinding({ expectedVersion: state.version, partnerId: 'native-partner', extensionIds: [state.extensions.find(e => e.kind === 'skill').id] });
  }, skillDirectory);
  await page.getByText('Native manual', { exact: true }).click();
  start = await send('SKILL_APPROVAL_ONLY');
  await page.getByRole('button', { name: '允许一次', exact: true }).waitFor();
  await page.locator('.timeline-authorization-card summary').click();
  const card = await page.locator('.timeline-authorization-card').innerText();
  assert.match(card, /执行后端跟随当前权限与全局沙箱设置/); assert.ok(!card.includes('当前为原生、未沙箱隔离'));
  assert.ok(card.includes(workspace));
  await page.screenshot({ path: path.join(evidence, 'skill-approval.png') });
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  events = await finished(start); assert.ok(events.some(e => e.type === 'tool.completed' && e.detail.includes('USER_DENIED')));
  result.cases.push('Skill-approval-shows-fixed-primary-workspace-and-no-static-Native-claim');
  if (process.env.ASTERIUM_SKILL_ONLY_SMOKE === '1') {
    start = await send('SKILL_APPROVAL_ONLY');
    await page.getByRole('button', { name: '允许一次', exact: true }).click();
    events = await finished(start);
    assert.ok(events.some(e => e.type === 'tool.completed' && e.outcome === 'failure' && /SANDBOX_(?:ELEVATED_HOST|HOST_IDENTITY)_REFUSED/.test(e.detail)));
    assert.deepEqual((await page.evaluate(() => globalThis.asteriumGeneralSettings.get())).settings, before.settings);
    result.cases.push('Skill-real-elevated-host-refused-no-fallback-settings-unchanged');
  }
  result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = String(error); if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => undefined); throw error; }
finally {
  if (page) result.events = await page.evaluate(() => globalThis.__nativeEvents ?? []).catch(() => []);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  await application?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const resolved = await realpath(temporary), tempRoot = await realpath(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), tempRoot.toLowerCase(), 'CLEANUP_PATH_REFUSED');
  assert.ok(path.basename(resolved).startsWith('asterium-native-command-'), 'CLEANUP_PATH_REFUSED');
  await rm(resolved, { recursive: true, force: true });
}
async function send(text) {
  const index = await page.evaluate(() => globalThis.__nativeEvents.length);
  await page.getByPlaceholder('给 Native 审批测试 发送消息…').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click(); return index;
}
async function finished(index) {
  await page.waitForFunction(i => globalThis.__nativeEvents.slice(i).some(e => ['run.completed', 'run.failed', 'run.cancelled'].includes(e.type)), index);
  const events = await page.evaluate(i => globalThis.__nativeEvents.slice(i), index);
  assert.equal(events.at(-1).type, 'run.completed'); await page.getByRole('button', { name: '发送', exact: true }).waitFor(); return events;
}
