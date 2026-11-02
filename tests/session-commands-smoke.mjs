import { runAutoTest, testRm as rm, autoTestEvidence, launchTestElectron } from './helpers/autoTest.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron as electron } from 'playwright-core';

await runAutoTest(async () => {
// Offline packaged IPC/UI acceptance. Uses only synthetic isolated application data.






const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'asterium-commands-smoke-'));
const evidence = autoTestEvidence('session-commands-s3'); await mkdir(evidence, { recursive: true });
let app;
try {
  app = await launchTestElectron(electron, { executablePath: process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe'), args: [`--user-data-dir=${temporary}`] });
  const page = await app.firstWindow(); await page.getByLabel('主要页面').waitFor();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('asterium.prototype.v7') ?? '{}').conversations?.length);
  const input = page.locator('.composer textarea'); await input.fill('保留这段未发送草稿');
  await page.getByRole('button', { name: '指令', exact: true }).click();
  await page.getByRole('menuitem', { name: /查看会话状态/ }).click();
  const notice = page.getByLabel('会话指令结果'); await notice.getByText('会话状态已更新').waitFor();
  assert.equal(await input.inputValue(), '保留这段未发送草稿');
  await notice.getByText('尚未建立').waitFor();
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.prototype.v7')).conversations[0].messages.length);
  await input.fill('/status'); await input.press('Enter'); await notice.getByText('会话状态已更新').waitFor();
  await page.waitForFunction(() => globalThis.document.querySelector('.composer textarea').value === '');
  const result = await page.evaluate(async () => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    const conversation = state.conversations.find((c) => c.id === state.activeConversationId);
    const partner = state.partners.find((p) => p.id === conversation.partnerId);
    const target = { partnerId: partner.id, conversationId: conversation.id, source: partner.sourceMode };
    const status = await globalThis.asteriumAgents.getSessionStatus(target);
    let mismatch = false;
    try { await globalThis.asteriumAgents.getSessionStatus({ ...target, sessionId: 'forged-thread' }); } catch (error) { mismatch = String(error).includes('MISMATCH'); }
    return { status, mismatch, messages: conversation.messages.length };
  });
  assert.equal(result.status.sessionId, undefined); assert.equal(result.status.state, 'idle'); assert.equal(result.mismatch, true); assert.equal(result.messages, before);
  await page.screenshot({ path: path.join(evidence, 'status.png') });
  await notice.getByRole('button', { name: '收起会话指令结果' }).click();
  await notice.waitFor({ state: 'detached' });
  await page.reload(); await page.getByLabel('主要页面').waitFor();
  assert.equal(await page.getByLabel('会话指令结果').count(), 0);
  const bindings = await readFile(path.join(temporary, 'native-thread-bindings.v1.json'), 'utf8').catch(() => '{"bindings":[]}');
  assert.equal(JSON.parse(bindings).bindings.length, 0);
  console.log(JSON.stringify({ status: 'passed', cases: ['menu-and-typed-status', 'draft-preserved', 'empty-thread-not-created', 'forged-thread-rejected', 'history-unchanged', 'status-dismiss-and-reopen', 'packaged-ipc'], result: result.status }, null, 2));
} finally {
  if (app) await app.close();
  const resolved = path.resolve(temporary);
  assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('asterium-commands-smoke-'), 'UNSAFE_CLEANUP_PATH');
  await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
});
