import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const evidence = path.resolve('.qa/empty-start');
await mkdir(evidence, { recursive: true });
const server = await createServer({ configFile: 'vite.renderer.config.ts', server: { host: '127.0.0.1', port: 0 } });
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.ASTERIUM_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/#/chat`);
  await page.getByRole('heading', { name: '添加你的第一位伙伴' }).waitFor();
  const initial = await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.prototype.v7')));
  for (const key of ['partners', 'conversations', 'projects', 'groupChats']) assert.deepEqual(initial[key], []);
  assert.equal(initial.userProfile.displayName, '用户');
  await page.screenshot({ path: path.join(evidence, 'empty-chat.png'), fullPage: true });
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    state.userProfile.displayName = 'Test user';
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
  });
  await page.reload();
  await page.getByRole('heading', { name: '添加你的第一位伙伴' }).waitFor();
  const reloaded = await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.prototype.v7')));
  assert.equal(reloaded.userProfile.displayName, 'Test user');
  assert.deepEqual(reloaded.partners, []);
  await page.getByRole('button', { name: '添加伙伴', exact: true }).click();
  await page.getByRole('heading', { name: '伙伴管理', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '重置演示数据' }).count(), 0);
  await page.screenshot({ path: path.join(evidence, 'empty-partners.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const result = { status: 'passed', mode: 'renderer-only', realApiCalled: false, cases: ['empty-first-start', 'empty-restart-preserves-user', 'add-partner-navigation', 'no-demo-reset', 'no-renderer-errors'] };
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await server.close();
}
