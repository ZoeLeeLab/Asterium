// Packaged Electron/Main/HTTP acceptance. Only synthetic data and loopback fixtures; no real model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { AGENT_PROTOCOL_VERSION } from '../src/shared/contracts/core.ts';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'asterium-api-providers-'));
const workspace = path.join(temporary, 'workspace'), evidence = path.join(root, '.qa', 'api-providers');
await mkdir(workspace); await mkdir(evidence, { recursive: true }); await writeFile(path.join(workspace, 'fixture.txt'), 'fixture-content');
await writeFile(path.join(temporary, 'workspace-grants.v1.json'), JSON.stringify({ version: 1, grants: { 'fixture-root': workspace } }));
const protocols = ['chat_completions', 'responses', 'anthropic_messages', 'gemini'];
const providers = ['openai', 'responses', 'anthropic', 'gemini'];
const requests = [], result = { status: 'running', isolatedUserData: true, realModelCalled: false, cases: [] };
const executable = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out/Asterium-win32-x64/Asterium.exe');
result.archiveHash = createHash('sha256').update(await readFile(path.join(path.dirname(executable), 'resources/app.asar'))).digest('hex');
const server = createServer(async (req, res) => {
  try {
    const protocol = req.url.split('/')[1];
    assert.ok(protocols.includes(protocol));
    assert.equal(protocol === 'gemini' ? req.headers['x-goog-api-key'] : protocol === 'anthropic_messages' ? req.headers['x-api-key'] : req.headers.authorization, protocol === 'gemini' || protocol === 'anthropic_messages' ? 'synthetic-provider-key' : 'Bearer synthetic-provider-key');
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(protocol === 'gemini' ? { models: [{ name: 'models/fixture-model' }] } : { data: [{ id: 'fixture-model' }] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ protocol, model: body.model ?? req.url.match(/\/models\/([^:]+)/)?.[1], raw });
    if (body.model === 'hang') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); return; }
    const probe = raw.includes('asterium_connection_probe');
    const automation = protocol === 'chat_completions' && raw.includes('[fixture:automation-list]') && !body.messages.some(m => m.role === 'tool');
    const tool = probe || automation || (raw.includes('[fixture:tool]') && !raw.includes('fixture-content'));
    const name = probe ? 'asterium_connection_probe' : automation ? 'asterium_automation' : 'read_file'; const args = probe ? { value: 'ok' } : automation ? { action: 'list' } : { path: 'fixture.txt' };
    const text = raw.includes('[fixture:xml-tools]') && !raw.includes('[fixture:automation-list]') ? '<asterium_status key="time" />' : 'FIXTURE_OK';
    let events;
    if (protocol === 'chat_completions') events = [{ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'call', function: { name, arguments: JSON.stringify(args) } }] } : { content: text }, finish_reason: tool ? 'tool_calls' : 'stop' }] }];
    else if (protocol === 'responses') events = [{ type: 'response.completed', response: { status: 'completed', output: tool ? [{ type: 'reasoning', id: 'r', summary: [], encrypted_content: 'opaque-fixture' }, { type: 'function_call', call_id: 'call', name, arguments: JSON.stringify(args) }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FIXTURE_OK' }] }] } }];
    else if (protocol === 'anthropic_messages') {
      assert.equal(body.max_tokens, 512);
      const blocks = tool ? [{ type: 'thinking', thinking: '公开测试摘要', signature: 'opaque-fixture' }, { type: 'tool_use', id: 'call', name, input: args }] : [{ type: 'text', text: 'FIXTURE_OK' }];
      events = [...blocks.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]), { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' }];
    } else events = [{ candidates: [{ content: { role: 'model', parts: tool ? [{ functionCall: { id: 'call', name, args }, thoughtSignature: 'opaque-fixture' }] : [{ text: 'FIXTURE_OK' }] }, finishReason: 'STOP' }] }];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(events.map(data => `data: ${JSON.stringify(data)}\n\n`).join(''));
  } catch { res.writeHead(500); res.end('Fixture assertion failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let application, page;
async function launch() {
  application = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${temporary}`] });
  page = await application.firstWindow(); await page.locator('.app-grid, .settings-shell').first().waitFor();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { (result.rendererErrors ??= []).push(error.message); });
  page.on('dialog', dialog => { void dialog.accept().catch(() => undefined); });
}
async function run(index, conversationId, text, sessionId) {
  const clientMessageId = `fixture-${crypto.randomUUID()}`;
  await page.evaluate(async ({ index, conversationId, text, clientMessageId, origin, providers, protocolVersion, sessionId }) => {
    globalThis.__apiEvents ??= [];
    globalThis.__apiSubscription ??= globalThis.asteriumAgents.onEvent(event => globalThis.__apiEvents.push(event));
    await globalThis.asteriumAgents.sendApiMessage({ provider: providers[index], endpoint: `${origin}/${['chat_completions', 'responses', 'anthropic_messages', 'gemini'][index]}/v1`, model: 'fixture-model', credentialRef: 'unused-fallback', primaryWorkspaceGrantId: 'fixture-root', workspaceGrantIds: ['fixture-root'] }, {
      protocolVersion, type: 'message.send', commandId: clientMessageId, partnerId: `fixture-${index}`, conversationId, clientMessageId, ...(sessionId ? { sessionId } : {}),
      connectionSource: 'api_partner', content: { type: 'text', text }, execution: { permissionMode: 'manual', planMode: 'default' },
      apiContext: { history: [], apiSessionHistoryEnabled: true },
    });
  }, { index, conversationId, text, clientMessageId, origin, providers, protocolVersion: AGENT_PROTOCOL_VERSION, sessionId });
  await page.waitForFunction(id => globalThis.__apiEvents.some(event => event.clientMessageId === id && ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)), clientMessageId, { timeout: 20000 });
  const events = await page.evaluate(id => globalThis.__apiEvents.filter(event => event.clientMessageId === id), clientMessageId);
  assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
  assert.ok(!JSON.stringify(events).includes('opaque-fixture'));
  return events;
}
try {
  await launch(); await page.waitForFunction(() => localStorage.getItem('asterium.prototype.v7'));
  await page.evaluate(async ({ origin, protocols, providers, workspace }) => {
    const api = globalThis.asteriumAgents; const credential = await api.saveApiCredential('synthetic-provider-key');
    let config = await api.apiConnectionsGet();
    for (const [index, protocol] of protocols.entries()) {
      config = await api.apiConnectionsMutate({ action: 'service', expectedRevision: config.revision, value: { id: `service-${index}`, name: protocol, protocol, endpoint: `${origin}/${protocol}/v1`, credentialRef: credential.credentialRef } });
      config = await api.apiConnectionsMutate({ action: 'model', expectedRevision: config.revision, value: { id: `model-${index}`, serviceId: `service-${index}`, name: 'fixture-model', model: 'fixture-model', tools: true, images: false, settings: { autoCompact: false, maxOutputTokens: 512 } } });
      config = await api.apiConnectionsMutate({ action: 'bind', expectedRevision: config.revision, partnerId: `fixture-${index}`, modelId: `model-${index}` });
    }
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    state.partners = protocols.map((protocol, index) => ({ id: `fixture-${index}`, publicIdentity: { displayName: `API 测试 ${index}`, mentionName: `API测试${index}`, introduction: '隔离验收', expertise: '' }, sourceMode: 'api_partner', provider: providers[index], endpoint: `${origin}/${protocol}/v1`, model: 'fixture-model', modelId: `model-${index}`, credentialRef: credential.credentialRef, configured: true, isPrototype: false, status: 'online', accent: '#7094c7', createdAt: new Date().toISOString(), personality: '', thinkingMode: 'auto', reasoningEffort: 'high', apiSessionHistoryEnabled: true, profileManagement: { userProfile: false, personality: false, memoryMode: 'asterium' }, primaryWorkspaceGrantId: 'fixture-root', workspaceGrantIds: ['fixture-root'], workingDirectories: [workspace] }));
    state.projects = []; state.groupChats = []; state.conversations = []; state.activePartnerId = 'fixture-0'; state.activeConversationId = ''; state.activeProjectId = ''; state.activeGroupChatId = '';
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
  }, { origin, protocols, providers, workspace });
  await page.reload(); await page.waitForFunction(async () => (await globalThis.asteriumAgents.refreshPartnerProfiles()).partners.filter(p => p.partnerId.startsWith('fixture-')).length === 4);
  result.cases.push('packaged-main-configurations-and-credentials');
  const modelDefault = await page.evaluate(async () => {
    const api = globalThis.asteriumAgents, config = await api.apiConnectionsGet();
    const next = await api.apiConnectionsMutate({ action: 'model', expectedRevision: config.revision, value: { id: 'default-tools-model', serviceId: 'service-0', name: '默认工具', model: 'fixture-model', images: false } });
    return next.models.find(m => m.id === 'default-tools-model').tools;
  });
  assert.equal(modelDefault, true); result.cases.push('new-api-model-defaults-tools-enabled-in-main');
  for (const [index, protocol] of protocols.entries()) {
    const check = await page.evaluate(async ({ index, protocol, origin, providers }) => {
      const api = globalThis.asteriumAgents;
      const models = await api.listApiModels(providers[index], `${origin}/${protocol}/v1`, undefined, undefined, `service-${index}`);
      const text = await api.apiConnectionsProbe(`model-${index}`); const tool = await api.apiConnectionsProbe(`model-${index}`, true);
      return { models, text, tool };
    }, { index, protocol, origin, providers });
    assert.equal(check.models.length, 1); assert.equal(check.text.text, 'FIXTURE_OK'); assert.equal(check.tool.toolCall, true);
    const events = await run(index, `conversation-${index}`, '[fixture:tool] read fixture file');
    assert.equal(events.filter(e => e.type === 'tool.completed' && e.outcome === 'success').length, 1);
    result.cases.push(`${protocol}-models-text-tool-roundtrip`);
  }
  await page.evaluate(async () => { const api = globalThis.asteriumAgents; const config = await api.apiConnectionsGet(); await api.apiConnectionsMutate({ action: 'bind', expectedRevision: config.revision, partnerId: 'fixture-1', modelId: 'model-0' }); });
  await run(1, 'conversation-1', 'continue portable history');
  assert.equal(requests.at(-1).protocol, 'chat_completions'); assert.ok(requests.at(-1).raw.includes('fixture-content')); assert.ok(!requests.at(-1).raw.includes('opaque-fixture'));
  result.cases.push('shared-binding-portable-history');
  await page.evaluate(async () => {
    const api = globalThis.asteriumAgents, config = await api.apiConnectionsGet();
    await api.apiConnectionsMutate({ action: 'model', expectedRevision: config.revision, value: { ...config.models.find(m => m.id === 'model-0'), tools: false } });
  });
  const disabled = await run(0, 'tools-state-conversation', '[fixture:xml-tools]');
  const disabledBody = JSON.parse(requests.at(-1).raw);
  assert.equal(disabledBody.tools, undefined);
  assert.ok(disabledBody.messages.some(m => m.role === 'system' && m.content.includes('本轮没有提供任何可调用工具')));
  assert.equal(disabled.filter(e => e.type === 'tool.started' || e.type === 'tool.completed').length, 0);
  assert.ok(disabled.some(e => e.type === 'text.delta' && e.text.includes('<asterium_status')));
  result.cases.push('disabled-tools-with-old-bootstrap-xml-text-never-executes');
  await page.evaluate(async () => {
    const api = globalThis.asteriumAgents, config = await api.apiConnectionsGet();
    await api.apiConnectionsMutate({ action: 'model', expectedRevision: config.revision, value: { ...config.models.find(m => m.id === 'model-0'), tools: true } });
  });
  const nativeSessionId = disabled.find(e => e.type === 'session.bound').sessionId;
  const enabled = await run(0, 'tools-state-conversation', '[fixture:automation-list]', nativeSessionId);
  const enabledBody = JSON.parse(requests.at(-1).raw);
  assert.ok(enabledBody.tools.some(t => t.function.name === 'asterium_automation'));
  assert.ok(enabledBody.messages.some(m => m.role === 'system' && m.content.includes('本轮提供 asterium_automation')));
  assert.equal(enabled.filter(e => e.type === 'tool.completed' && e.outcome === 'success').length, 1);
  assert.equal(enabled.find(e => e.type === 'session.bound').sessionId, nativeSessionId);
  assert.equal(enabled.find(e => e.type === 'session.bound').isNew, false);
  result.cases.push('explicit-tool-opt-in-discovers-automation-on-original-thread');
  await page.evaluate(async () => { const api = globalThis.asteriumAgents; let config = await api.apiConnectionsGet(); await api.apiConnectionsMutate({ action: 'model', expectedRevision: config.revision, value: { id: 'hang-model', serviceId: 'service-0', model: 'hang', name: '取消测试', tools: false, images: false } }); globalThis.__cancelledProbe = api.apiConnectionsProbe('hang-model').then(() => false, () => true); });
  await page.waitForFunction(() => globalThis.document.readyState === 'complete');
  for (let attempt = 0; attempt < 50 && !requests.some(r => r.model === 'hang'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests.filter(r => r.model === 'hang').length, 1);
  await page.evaluate(() => globalThis.asteriumAgents.apiConnectionsCancelProbe('hang-model'));
  assert.equal(await page.evaluate(() => globalThis.__cancelledProbe), true);
  result.cases.push('probe-cancellation-without-retry');
  await page.evaluate(() => { globalThis.location.hash = '/settings/partners'; });
  assert.equal(await page.getByRole('button', { name: 'API 连接', exact: true }).count(), 0);
  await page.getByRole('button', { name: '新增伙伴', exact: true }).click();
  await page.getByRole('button', { name: '添加新伙伴', exact: true }).click();
  await page.getByLabel('API 站点', { exact: true }).waitFor();
  assert.equal(await page.locator('.api-partner-connection details[open]').count(), 0);
  assert.equal(await page.getByLabel('完整 API 端点', { exact: true }).count(), 0);
  for (const name of ['DeepSeek', 'Kimi', 'OpenAI', 'Anthropic', '硅基流动']) assert.equal(await page.getByRole('option', { name, exact: true }).count(), 1);
  await page.screenshot({ path: path.join(evidence, 'settings.png') });
  await page.getByLabel('API 站点', { exact: true }).selectOption('custom');
  let dialog = page.getByRole('dialog', { name: '新增自定义站点' });
  await dialog.getByLabel('名称', { exact: true }).fill('自定义验收站点');
  await dialog.getByLabel('地址', { exact: true }).fill(origin + '/chat_completions/v1');
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-provider-key');
  await page.screenshot({ path: path.join(evidence, 'custom-site.png') });
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '拉取模型', exact: true }).click();
  await page.getByRole('option', { name: 'fixture-model', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: '模型', exact: true }).inputValue(), 'fixture-model');
  await page.getByRole('button', { name: '编辑自定义站点', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '编辑自定义站点' });
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('option', { name: '自定义验收站点', exact: true }).count(), 0);
  result.cases.push('partner-presets-custom-site-crud-and-selectable-models');
  await page.getByLabel('API 站点', { exact: true }).selectOption('service-0');
  await page.getByRole('button', { name: '拉取模型', exact: true }).click();
  await page.getByRole('option', { name: 'fixture-model', exact: true }).click();
  await page.getByLabel('显示名称').fill('界面保存验收');
  await page.getByLabel('称呼或 @ 名称', { exact: true }).fill('界面验收');
  await page.getByRole('button', { name: '添加 API 伙伴', exact: true }).click();
  await page.getByRole('heading', { name: '界面保存验收 已加入星丛' }).waitFor();
  const savedBinding = await page.evaluate(async () => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    const partner = state.partners.find(p => p.publicIdentity.displayName === '界面保存验收');
    const config = await globalThis.asteriumAgents.apiConnectionsGet();
    return { modelId: partner?.modelId, binding: config.bindings.find(b => b.partnerId === partner?.id) };
  });
  assert.equal(savedBinding.modelId, 'model-0'); assert.equal(savedBinding.binding?.modelId, 'model-0');
  result.cases.push('partner-form-persists-authoritative-binding-without-reentering-key');
  await page.locator('.settings-partner-list button').filter({ hasText: '界面保存验收' }).click();
  const scroll = page.getByLabel('伙伴资料', { exact: true });
  await scroll.waitFor();
  assert.equal(await scroll.getAttribute('inert'), null);
  assert.equal(await scroll.locator(':scope > [inert]').count(), 1);
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await scroll.hover(); await page.mouse.wheel(0, 500);
  await page.waitForFunction(() => globalThis.document.querySelector('.form-scroll').scrollTop > 0);
  result.cases.push('locked-partner-form-wheel-scrolls-with-controls-inert');
  const before = await page.evaluate(() => globalThis.asteriumAgents.apiConnectionsGet());
  await application.close(); application = undefined; await launch();
  await page.waitForFunction(async () => (await globalThis.asteriumAgents.refreshPartnerProfiles()).partners.filter(p => p.partnerId.startsWith('fixture-')).length === 4);
  const after = await page.evaluate(() => globalThis.asteriumAgents.apiConnectionsGet());
  assert.deepEqual(after, before);
  await run(1, 'conversation-1', 'continue after restart');
  assert.ok(requests.at(-1).raw.includes('fixture-content')); result.cases.push('restart-binding-and-session-preserved');
  assert.ok(!(await readFile(path.join(temporary, 'api-connections.v1.json'), 'utf8')).includes('synthetic-provider-key'));
  assert.ok(!(await readFile(path.join(temporary, 'secure-credentials.v1.json'), 'utf8')).includes('synthetic-provider-key'));
  assert.deepEqual(result.rendererErrors ?? [], []);
  result.status = 'passed'; console.log(`API_PROVIDERS_ACCEPTANCE_PASSED ${result.cases.length}`);
} catch (error) { result.status = 'failed'; result.failure = error.message; await page?.screenshot({ path: path.join(evidence, 'failure.png'), timeout: 5000 }).catch(() => undefined); result.failureUi = await page?.locator('.partner-workflow').innerText({ timeout: 1000 }).catch(() => undefined); throw error; }
finally {
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  await application?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const resolved = await realpath(temporary), tempRoot = await realpath(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() === tempRoot.toLowerCase()) await rm(resolved, { recursive: true, force: true });
}
