/* global window */
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';
import { autoTestOutput, createTestViteServer, launchTestBrowser, runAutoTest } from './helpers/autoTest.mjs';

await runAutoTest(async () => {
  const output = autoTestOutput();
  const config = { configFile: 'vite.renderer.config.ts', logLevel: 'error', build: { outDir: output, emptyOutDir: false } };
  await build(config);
  const server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } });
  const loader = await createTestViteServer({ configFile: 'vite.renderer.config.ts', server: { middlewareMode: true } });
  const { createTestState } = await loader.ssrLoadModule(path.resolve('tests/fixtures/applicationState.ts'));
  const state = createTestState();
  const template = state.conversations[0];
  state.conversations.push(...Array.from({ length: 45 }, (_, index) => ({
    ...template, id: `fixture-sidebar-${index}`, title: `合成历史对话 ${index}`, messages: [],
  })));
  const browser = await launchTestBrowser(chromium, { headless: true,
    executablePath: process.env.ASTERIUM_BROWSER_EXE ?? path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe') });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(fixture => {
      window.localStorage.setItem('asterium.prototype.v7', JSON.stringify(fixture));
    }, state);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/chat`);
    const sidebar = page.locator('.partner-groups');
    const row = sidebar.locator('.partner-heading').first();
    const metrics = async () => row.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, width: bounds.width };
    });
    await sidebar.waitFor();
    assert.ok(await sidebar.evaluate(element => element.scrollHeight > element.clientHeight));
    await page.mouse.move(1000, 100);
    const before = await metrics();
    await sidebar.hover();
    const hovered = await metrics();
    assert.ok(Math.abs(before.x - hovered.x) < 0.5 && Math.abs(before.width - hovered.width) < 0.5,
      JSON.stringify({ before, hovered }));
    await page.getByRole('button', { name: '收起 测试伙伴 A 的对话', exact: true }).click();
    await page.getByRole('button', { name: '展开 测试伙伴 A 的对话', exact: true }).waitFor();
    await page.getByRole('button', { name: '展开 测试伙伴 A 的对话', exact: true }).click();
    const text = page.getByText(template.messages[0].content, { exact: true });
    await text.click({ button: 'right' });
    await page.getByRole('menu', { name: '回复内容操作' }).waitFor();
    await page.getByRole('menuitem', { name: '引用回复', exact: true }).click();
    await page.getByRole('button', { name: '移除引用', exact: true }).waitFor();
    console.log(JSON.stringify({ sidebarContentBefore: before, sidebarContentHovered: hovered, collapse: 'passed', replyContextMenu: 'passed' }));
  } finally {
    await browser.close();
    await loader.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
});
