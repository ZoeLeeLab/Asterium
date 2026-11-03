import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { runAutoTest, createTestViteServer, launchTestBrowser, autoTestEvidence } from './helpers/autoTest.mjs';

await runAutoTest(async () => {
  const evidence = autoTestEvidence('avatar-layout');
  const server = await createTestViteServer({ configFile: 'vite.renderer.config.ts', server: { host: '127.0.0.1', port: 0 } });
  let browser;
  try {
    await server.listen();
    browser = await launchTestBrowser(chromium, { executablePath: process.env.ASTERIUM_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/#/studio/discussion`);
    await page.waitForFunction(() => localStorage.getItem('asterium.prototype.v7'));
    await page.evaluate(() => {
      const canvas = globalThis.document.createElement('canvas'); canvas.width = 120; canvas.height = 360;
      const context = canvas.getContext('2d');
      for (const [index, color] of ['#e46c68', '#65ac84', '#6b99d0'].entries()) { context.fillStyle = color; context.fillRect(0, index * 120, 120, 120); }
      const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
      const now = new Date().toISOString();
      state.projects = [{ id: 'avatar-project', name: '竖图头像验收', avatarDataUrl: canvas.toDataURL(), description: '仅使用合成图片', status: 'active', progress: 0, tags: [], memberIds: [], revision: 1, createdAt: now, updatedAt: now, files: [], tasks: [] }];
      state.activeProjectId = 'avatar-project'; state.activeGroupChatId = '';
      localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
    });
    await page.reload();
    const selectors = ['.studio-project-select .avatar', '.project-summary .avatar'];
    const measurements = async () => Promise.all(selectors.map(async selector => {
      const avatar = page.locator(selector).first(); await avatar.waitFor();
      await avatar.locator('img').evaluate(image => image.decode());
      return avatar.evaluate(element => {
        const image = element.querySelector('img'), frame = element.getBoundingClientRect(), pixels = image.getBoundingClientRect();
        return { width: frame.width, height: frame.height, imageWidth: pixels.width, imageHeight: pixels.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, objectFit: globalThis.getComputedStyle(image).objectFit, objectPosition: globalThis.getComputedStyle(image).objectPosition };
      });
    }));
    // Reproduce the original grid sizing defect without changing the source stylesheet.
    const oldStyle = await page.addStyleTag({ content: '.avatar img { position: static; inset: auto; }' });
    const before = await measurements();
    assert.ok(before.every(frame => frame.imageHeight > frame.imageWidth * 1.5), JSON.stringify({ before }));
    await oldStyle.evaluate(element => element.remove());
    const after = await measurements();
    for (const frame of after) {
      assert.ok(Math.abs(frame.width - frame.height) < 1, JSON.stringify(frame));
      assert.ok(Math.abs(frame.imageWidth - frame.imageHeight) < 1, JSON.stringify(frame));
      assert.equal(frame.naturalHeight, frame.naturalWidth * 3);
      assert.equal(frame.objectFit, 'cover'); assert.equal(frame.objectPosition, '50% 50%');
    }
    await page.screenshot({ path: path.join(evidence, 'portrait-project-avatar.png') });
    assert.deepEqual(errors, []);
    const result = { status: 'passed', cases: ['original-grid-overflow-reproduced', 'sidebar-square-avatar', 'summary-square-avatar', 'portrait-centre-cover-with-original-data'], before, after, mode: 'renderer-only', realApiCalled: false };
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await browser?.close(); await server.close();
  }
});
