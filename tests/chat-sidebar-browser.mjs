/* global window, document */
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
  const file = { id: 'fixture-context-file', name: 'report.md', extension: '.md', mediaType: 'text/markdown', previewKind: 'markdown',
    sourceKind: 'local_path', registrationMethod: 'automatic', availability: 'available', cached: false,
    sizeBytes: 42, createdAt: '2026-11-21T00:00:00.000Z' };
  template.artifacts = [{ ...file, artifactRef: file.id }];
  template.messages.push({ id: 'fixture-file-reply', authorId: template.partnerId, createdAt: '00:00',
    content: '[合成文档](C:/Fixtures/report.md)', runState: 'completed' });
  const browser = await launchTestBrowser(chromium, { headless: true,
    executablePath: process.env.ASTERIUM_BROWSER_EXE ?? path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe') });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(({ fixture, file }) => {
      window.localStorage.setItem('asterium.prototype.v7', JSON.stringify(fixture));
      window.fixtureFileActions = [];
      window.asteriumArtifacts = {
        inspect: async () => file,
        resolveConversationLink: async (conversationId, href) => conversationId === fixture.activeConversationId && href === 'C:/Fixtures/report.md'
          ? { artifact: file, action: 'preview' } : null,
        read: async id => { window.fixtureFileActions.push(['read', id]); return { info: file, text: '合成文件预览' }; },
        copyPath: async id => { window.fixtureFileActions.push(['copyPath', id]); },
        openInBrowser: async () => undefined, reveal: async () => undefined,
      };
    }, { fixture: state, file });
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
    await text.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await text.click({ button: 'right' });
    await page.getByRole('menu', { name: '引用选中内容' }).waitFor();
    await page.getByRole('menuitem', { name: '引用选中内容', exact: true }).click();
    await page.getByRole('button', { name: '移除引用', exact: true }).waitFor();
    const fileLink = page.getByRole('link', { name: '合成文档', exact: true });
    await fileLink.click({ button: 'right' });
    const menu = page.getByLabel('交付文件操作', { exact: true });
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole('button').allTextContents(), [
      '用默认浏览器打开', '打开文件所在文件夹', '在文件与交付中定位', '复制路径', '文件另存为', '保存到项目',
    ]);
    await menu.getByRole('button', { name: '复制路径', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.fixtureFileActions), [['copyPath', file.id]]);
    await fileLink.click();
    await page.getByText('合成文件预览', { exact: true }).waitFor();
    console.log(JSON.stringify({ sidebarContentBefore: before, sidebarContentHovered: hovered, collapse: 'passed', selectedTextQuote: 'passed', fileLinkMenu: 'passed' }));
  } finally {
    await browser.close();
    await loader.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
});
