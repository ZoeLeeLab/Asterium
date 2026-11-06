import { runAutoTest, testRm as rm, autoTestEvidence, launchTestElectron, createTestNetServer } from './helpers/autoTest.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';

import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { _electron as electron } from 'playwright-core';

await runAutoTest(async () => {
// Packaged Electron/Main + real MCP client, isolated data, no model or server deployment.









const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'asterium-mcp-smoke-'));
const evidence = autoTestEvidence('studio-mcp');
await mkdir(evidence, { recursive: true });
const result = { status: 'running', isolatedUserData: true, realMcp: true, modelCalled: false, cases: [] };
const projectId = 'mcp-project', partnerId = 'mcp-partner', roomId = 'mcp-room';
const now = new Date().toISOString();
const workspace = path.join(temporary, 'project');
await mkdir(path.join(workspace, 'deliverables'), { recursive: true });
await writeFile(path.join(temporary, 'project-workspaces.v1.json'), JSON.stringify({ version: 1, projects: [{ version: 1, projectId, name: 'MCP 隔离项目', rootPath: workspace, deliverablesPath: path.join(workspace, 'deliverables'), templateFiles: [], createdAt: now, updatedAt: now }] }));
await writeFile(path.join(temporary, 'project-domain.v1.json'), JSON.stringify({ version: 1, projects: [{ version: 1, id: projectId, name: 'MCP 隔离项目', description: '', status: 'active', progress: 0, tags: [], memberIds: [partnerId], revision: 1, createdAt: now, updatedAt: now }], tasks: [] }));
const executable = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe');
result.archiveHash = createHash('sha256').update(await readFile(path.join(path.dirname(executable), 'resources', 'app.asar'))).digest('hex');
let application, client, page, wakeController, wakeReader;
let wakeBuffer = '';
const wakeDecoder = new TextDecoder();

async function launch() {
  application = await launchTestElectron(electron, { executablePath: executable, args: [`--user-data-dir=${temporary}`] });
  page = await application.firstWindow();
  await page.locator('.app-grid, .settings-shell').first().waitFor();
  page.on('pageerror', (error) => { (result.rendererErrors ??= []).push(error.message); });
}

try {
  await launch();
  assert.equal((await page.evaluate(() => globalThis.asteriumStudioMcp.status())).running, false);
  assert.deepEqual(await page.evaluate(() => globalThis.asteriumStudioWake.status()), { entries: [] });
  result.cases.push('packaged-bridge-default-off');
  await page.waitForFunction(() => localStorage.getItem('asterium.prototype.v7'));
  await page.evaluate(async ({ partnerId, projectId, roomId, now }) => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    const partner = { id: partnerId, sourceMode: 'existing_thread', serviceType: 'cyberboss_server', serviceUrl: 'https://offline.invalid',
      threadId: 'original-thread-fixture', configured: true, credentialRef: 'missing-isolated-fixture', connectionStatus: 'untested', connectionLabel: '隔离验收',
      isPrototype: false, status: 'offline', accent: '#7094c7', createdAt: now,
      publicIdentity: { displayName: 'MCP 验收伙伴', mentionName: 'MCP 验收伙伴', introduction: '', expertise: '文字接入验收' },
      profileManagement: { userProfile: false, personality: false, memoryMode: 'self_managed' } };
    state.partners = [partner]; state.projects = []; state.conversations = [];
    state.groupChats = [{ id: roomId, projectId, name: 'MCP 文字验收群', memberIds: [partnerId], messages: [], createdAt: now, updatedAt: now }];
    state.activePartnerId = partnerId; state.activeConversationId = ''; state.activeProjectId = projectId; state.activeGroupChatId = roomId;
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
    localStorage.setItem('asterium.navigation.lastRoute', '/settings/partners?section=mcp');
  }, { partnerId, projectId, roomId, now });
  await page.reload();
  await page.evaluate(() => { globalThis.location.hash = '#/settings/partners?section=mcp'; });
  assert.equal(await page.locator('.studio-wake-settings').getAttribute('open'), null);
  await page.locator('.studio-wake-settings > summary').click();
  await page.locator('.studio-wake-settings').screenshot({ path: path.join(evidence, 'group-wake-unconfigured.png') });
  await page.locator('.studio-wake-settings > summary').click();
  result.cases.push('wake-preload-local-status-default-empty-folded-no-auto-request');
  await page.locator('.studio-mcp-settings > summary').click();
  await page.getByRole('button', { name: '开启群聊接入', exact: true }).waitFor();
  assert.equal(await page.getByLabel('群聊接入绑定伙伴').inputValue(), partnerId);
  const port = await freePort();
  await page.getByLabel('本地服务端口').fill(String(port));
  await page.getByLabel('私网 HTTPS 地址').fill('https://isolated.tail-test.ts.net');
  await page.getByRole('button', { name: '开启群聊接入', exact: true }).click();
  await page.getByRole('button', { name: '停止群聊接入', exact: true }).waitFor();
  await page.getByRole('button', { name: '生成伙伴接入凭据', exact: true }).click();
  const token = await page.getByLabel('新接入凭据（仅显示一次）').inputValue();
  assert.match(token, /^asterium_/);
  assert.equal(await page.evaluate((token) => JSON.stringify(localStorage).includes(token), token), false);
  await page.getByRole('button', { name: '隐藏接入凭据', exact: true }).click();
  await page.locator('.studio-mcp-settings').screenshot({ path: path.join(evidence, 'group-mcp-settings.png') });
  result.cases.push('ui-enable-issue-hide-no-localstorage-secret');
  await page.locator('.studio-wake-settings > summary').click();
  await page.getByLabel('服务器连接绑定 ID').fill('isolated-binding');
  await page.getByLabel('星丛启动后连接一次').uncheck();
  await page.getByRole('button', { name: '保存唤醒绑定', exact: true }).click();
  await page.getByRole('button', { name: '重新连接群唤醒', exact: true }).waitFor();
  await page.waitForFunction(() => globalThis.asteriumStudioWake.status().then((value) => value.entries[0]?.ready));
  await page.getByRole('button', { name: '重新连接群唤醒', exact: true }).click();
  await page.locator('.studio-wake-settings').getByRole('alert').waitFor();
  const wakeStatus = await page.evaluate(() => globalThis.asteriumStudioWake.status());
  assert.equal(wakeStatus.entries[0].state, 'waiting');
  assert.equal(wakeStatus.entries[0].error, 'STUDIO_WAKE_PARTNER_UNAVAILABLE');
  assert.deepEqual(JSON.parse(await readFile(path.join(temporary, 'studio-wake-settings.v1.json'), 'utf8')), {
    version: 1, bindings: [{ partnerId, connectionBindingId: 'isolated-binding', connectOnLaunch: false }],
  });
  await page.locator('.studio-wake-settings').screenshot({ path: path.join(evidence, 'group-wake-explicit-control.png') });
  await page.locator('.studio-wake-settings > summary').click();
  result.cases.push('wake-ui-save-binding-explicit-control-missing-secret-fails-before-network');
  await page.evaluate(async ({ partnerId, projectId, roomId }) => {
    await globalThis.asteriumAgents.syncPartnerProfiles({ displayName: '隔离验收', introduction: '', updatedAt: new Date().toISOString() }, [{ partnerId, sourceMode: 'existing_thread', publicIdentity: { displayName: 'MCP 验收伙伴', introduction: '', expertise: '', mentionName: 'MCP 验收伙伴' }, management: { userProfile: false, personality: false, memoryMode: 'self_managed' }, connectionSettings: {} }]);
    await globalThis.asteriumStudio.syncRoom({ roomId, projectId, name: 'MCP 文字验收群', memberIds: [partnerId] });
  }, { partnerId, projectId, roomId });
  client = new Client({ name: 'packaged-acceptance', version: '1.0.0' });
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.equal((await client.listTools()).tools.length, 5);
  const listing = await client.callTool({ name: 'asterium_list_rooms', arguments: {} });
  const scope = { roomId, membershipGeneration: listing.structuredContent.rooms[0].membershipGeneration };
  result.cases.push('real-client-initialize-and-tools');
  wakeController = new AbortController();
  const wakeResponse = await fetch(`http://127.0.0.1:${port}/wake/events`, { headers: { Authorization: `Bearer ${token}` }, signal: wakeController.signal });
  assert.equal(wakeResponse.status, 200);
  wakeReader = wakeResponse.body.getReader();
  await page.evaluate(() => { globalThis.location.hash = '#/studio/discussion'; });
  await page.getByRole('heading', { name: 'MCP 文字验收群', exact: true }).waitFor();
  const composer = page.locator('.studio-composer textarea');
  await composer.fill(Array.from({ length: 10 }, (_value, index) => `第${index + 1}行：输入框滚动验收`).join('\n') + '\n');
  await composer.press('Control+End');
  result.editorSnapshot = await composer.evaluate((input) => {
    const highlights = globalThis.document.querySelector('.studio-composer__highlights');
    const measure = (item) => ({ top: item.scrollTop, height: item.clientHeight, scrollHeight: item.scrollHeight, font: globalThis.getComputedStyle(item).font, padding: globalThis.getComputedStyle(item).padding });
    return { input: measure(input), highlights: measure(highlights) };
  });
  await page.waitForFunction(() => {
    const input = globalThis.document.querySelector('.studio-composer textarea'), highlights = globalThis.document.querySelector('.studio-composer__highlights');
    return input.scrollTop > 0 && Math.abs(input.scrollTop - highlights.scrollTop) <= 1;
  });
  const editor = await composer.evaluate((input) => ({ scrollHeight: input.scrollHeight, height: input.clientHeight,
    color: globalThis.getComputedStyle(input).color, backgroundText: globalThis.getComputedStyle(globalThis.document.querySelector('.studio-composer__highlights')).color }));
  assert.ok(editor.scrollHeight > editor.height && editor.height <= 144);
  assert.notEqual(editor.color, 'rgba(0, 0, 0, 0)'); assert.equal(editor.backgroundText, 'rgba(0, 0, 0, 0)');
  await composer.press('Shift+ArrowUp');
  await page.locator('.studio-composer').screenshot({ path: path.join(evidence, 'multiline-composer-scroll-selection.png') });
  await composer.press('Control+Home');
  result.editorHome = await composer.evaluate((input) => ({ top: input.scrollTop, selectionStart: input.selectionStart,
    highlightsTop: globalThis.document.querySelector('.studio-composer__highlights').scrollTop }));
  await page.waitForFunction(() => {
    const input = globalThis.document.querySelector('.studio-composer textarea'), highlights = globalThis.document.querySelector('.studio-composer__highlights');
    // Chromium may retain a few pixels of padding when revealing the first caret.
    return input.selectionStart === 0 && input.scrollTop < parseFloat(globalThis.getComputedStyle(input).lineHeight)
      && Math.abs(input.scrollTop - highlights.scrollTop) <= 1;
  });
  result.cases.push('multiline-composer-native-text-scroll-selection-and-trailing-newline-aligned');
  await composer.fill('请读取这条隔离的公开群消息');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('.studio-messages').getByText('请读取这条隔离的公开群消息', { exact: true }).waitFor();
  const wake = await nextWakeEvent('wake', (value) => value.wakeReason === 'user_message');
  assert.equal(wake.roomId, roomId); assert.equal(wake.membershipGeneration, scope.membershipGeneration);
  assert.equal(wake.wakeEligible, true); assert.equal(wake.cursor, 1);
  assert.equal(JSON.stringify(wake).includes('请读取'), false);
  result.cases.push('packaged-main-live-wake-no-body-no-model');
  const history = await client.callTool({ name: 'asterium_read_history', arguments: scope });
  assert.equal(history.structuredContent.messages.at(-1).content, '请读取这条隔离的公开群消息');
  const reply = { ...scope, requestId: 'packaged-reply-one', content: 'MCP 公开回复已收到' };
  const sent = await client.callTool({ name: 'asterium_send_message', arguments: reply });
  assert.deepEqual((await client.callTool({ name: 'asterium_send_message', arguments: reply })).structuredContent, sent.structuredContent);
  await page.locator('.studio-messages').getByText('MCP 公开回复已收到', { exact: true }).waitFor();
  const ack = await client.callTool({ name: 'asterium_acknowledge', arguments: { ...scope, readId: history.structuredContent.readId } });
  assert.equal(ack.structuredContent.processedThroughSeq, history.structuredContent.throughSeq);
  const processedWake = await nextWakeEvent('wake', (value) => value.wakeReason === 'processed');
  assert.equal(processedWake.cursor, history.structuredContent.throughSeq);
  const ownIncrement = await client.callTool({ name: 'asterium_read_history', arguments: { ...scope, afterSeq: history.structuredContent.throughSeq } });
  assert.deepEqual(ownIncrement.structuredContent.messages, []);
  assert.equal(ownIncrement.structuredContent.throughSeq, sent.structuredContent.seq);
  assert.equal(ownIncrement.structuredContent.hasNewer, false);
  const completeHistory = await client.callTool({ name: 'asterium_read_history', arguments: scope });
  assert.ok(completeHistory.structuredContent.messages.some((message) => message.messageId === sent.structuredContent.messageId));
  result.cases.push('mcp-increment-omits-own-output-advances-cursor-bootstrap-keeps-public-history');
  const snapshot = await page.evaluate((roomId) => globalThis.asteriumStudio.getRoom(roomId), roomId);
  assert.equal(snapshot.activeRound, undefined);
  assert.equal(snapshot.messages.filter((message) => message.content === reply.content).length, 1);
  await page.locator('.app-grid').screenshot({ path: path.join(evidence, 'external-group-text.png') });
  result.cases.push('external-only-ui-send-mcp-read-reply-deduplicate-ack-no-native-round');
  await page.evaluate(() => { globalThis.location.hash = '#/settings/partners?section=mcp'; });
  await page.locator('.studio-mcp-settings > summary').click();
  await page.getByRole('button', { name: /^撤销群聊凭据 / }).click();
  await nextWakeEvent('access_revoked');
  wakeController.abort(); wakeController = undefined;
  result.cases.push('packaged-ui-revocation-closes-wake-stream');
  await page.getByText('MCP 验收伙伴 · 已撤销', { exact: true }).waitFor();
  const revoked = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(revoked.status, 401);
  result.cases.push('ui-revocation-immediately-denies-http');
  await client.close(); client = undefined;
  await application.close(); application = undefined;
  await assert.rejects(fetch(endpoint));
  await launch();
  const restarted = await page.evaluate(() => globalThis.asteriumStudioMcp.status());
  assert.equal(restarted.running, true);
  assert.ok(restarted.credentials.every((credential) => credential.revokedAt));
  assert.equal((await readFile(path.join(temporary, 'studio-mcp-access.v1.json'), 'utf8')).includes(token), false);
  const saved = await page.evaluate((roomId) => globalThis.asteriumStudio.getRoom(roomId), roomId);
  assert.equal(saved.messages.filter((message) => message.content === reply.content).length, 1);
  const restoredDenied = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(restoredDenied.status, 401);
  result.cases.push('shutdown-closes-service-restart-auto-restores-listener-ledger-and-revocation-no-plaintext');
  await page.evaluate((configuration) => globalThis.asteriumStudioMcp.configure({ ...configuration, enabled: false }), restarted.configuration);
  await application.close(); application = undefined;
  await launch();
  assert.equal((await page.evaluate(() => globalThis.asteriumStudioMcp.status())).running, false);
  await assert.rejects(fetch(endpoint));
  result.cases.push('manual-stop-remains-off-after-another-restart');
  assert.deepEqual(result.rendererErrors ?? [], []);
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.error = error.message; process.exitCode = 1;
} finally {
  wakeController?.abort();
  await client?.close().catch(() => undefined);
  await application?.close().catch(() => undefined);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  const resolved = await realpath(temporary);
  assert.ok(resolved.startsWith(`${await realpath(os.tmpdir())}${path.sep}`));
  await rm(resolved, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 2));
}

async function nextWakeEvent(type, predicate = () => true) {
  const timeout = setTimeout(() => wakeController?.abort(), 10_000);
  try {
    for (;;) {
      const boundary = wakeBuffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = wakeBuffer.slice(0, boundary); wakeBuffer = wakeBuffer.slice(boundary + 2);
        if (frame.includes(`event: ${type}\n`)) {
          const value = JSON.parse(frame.split('\n').find((line) => line.startsWith('data: ')).slice(6));
          if (predicate(value)) return value;
        }
      } else {
        const chunk = await wakeReader.read(); assert.equal(chunk.done, false, `Wake ended before ${type}`);
        wakeBuffer += wakeDecoder.decode(chunk.value, { stream: true });
      }
    }
  } finally { clearTimeout(timeout); }
}

async function freePort() {
  const server = createTestNetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
});
