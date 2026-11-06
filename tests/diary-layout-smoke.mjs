import { runAutoTest, createTestViteServer as createServer, launchTestBrowser } from './helpers/autoTest.mjs';
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';

await runAutoTest(async () => {
// Isolated renderer-only fixtures: no real user data, IPC, model calls or diary generation.





const server = await createServer({ configFile: 'vite.renderer.config.ts', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
let browser;
try {
  const { createTestState } = await server.ssrLoadModule(path.resolve('tests/fixtures/applicationState.ts'));
  const state = createTestState();
  const entries = [21, 20, 19].map((day) => ({ partnerId: 'fixture-local-a', date: `2026-10-${day}`, generationId: `fixture-${day}`, conversationId: 'conversation-a-1', state: 'completed', attemptedAt: `2026-10-${day}T13:00:00.000Z`, finishedAt: `2026-10-${day}T13:00:05.000Z` }));
  browser = await launchTestBrowser(chromium, { executablePath: process.env.ASTERIUM_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await page.addInitScript(({ state, entries }) => {
    globalThis.localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
    globalThis.localStorage.setItem('asterium.theme.v1', 'light');
    globalThis.diaryFixtureReads = [];
    globalThis.asteriumPartnerDiary = {
      get: async () => ({ configs: [{ partnerId: 'fixture-local-a', enabled: true, conversationId: 'conversation-a-1', time: '21:00', revision: 1 }], entries }),
      read: async ({ date }) => { globalThis.diaryFixtureReads.push(date); return { entry: entries.find((entry) => entry.date === date), content: `# ${date}\n\n今天，我和用户一起讨论了书架的整理方式。我们决定先把正在读的书放在最顺手的位置，再慢慢整理旧笔记。\n\n## 变化与思考\n\n这次对话让我更清楚，合作不必一次安排得很满；先完成一件小事，也是一种可靠的进展。\n\n## 明天的计划\n\n继续核对书单，给尚未整理的笔记留出时间。` }; },
      configure: async () => { throw new Error('Fixture must not save settings'); },
      exportMarkdown: async () => false,
    };
  }, { state, entries });
  const port = server.httpServer.address().port;
  await page.goto(`http://127.0.0.1:${port}/#/chat`);
  const opener = page.getByRole('button', { name: '打开测试伙伴 A的日记本' });
  await opener.scrollIntoViewIfNeeded();
  const ordering = await page.evaluate(() => {
    const project = [...globalThis.document.querySelectorAll('.right-rail .side-section')].find((section) => section.textContent.includes('参与中的项目'));
    return project?.nextElementSibling?.classList.contains('diary-launcher');
  });
  if (!ordering) throw new Error('Diary must immediately follow participating projects');
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '测试伙伴 A的日记本' });
  await dialog.waitFor();
  await page.getByText('这次对话让我更清楚，合作不必一次安排得很满；先完成一件小事，也是一种可靠的进展。', { exact: true }).waitFor();
  if (await page.evaluate(() => globalThis.diaryFixtureReads.length) !== 1) throw new Error('Only the expanded diary may be read');
  await dialog.screenshot({ path: path.join(os.tmpdir(), 'asterium-diary-paper-light.png') });
  const close = page.getByRole('button', { name: '关闭', exact: true });
  await close.focus(); await page.keyboard.press('Shift+Tab');
  if (!await page.getByRole('button', { name: '阅读 2026-10-19 日记' }).evaluate((button) => globalThis.document.activeElement === button)) throw new Error('Diary focus must remain inside modal');
  await page.keyboard.press('Tab');
  if (!await close.evaluate((button) => globalThis.document.activeElement === button)) throw new Error('Diary tab wrap failed');
  await page.evaluate(() => { globalThis.document.documentElement.dataset.theme = 'dark'; });
  await page.waitForFunction(() => globalThis.getComputedStyle(globalThis.document.querySelector('.diary-paper')).color === 'rgb(233, 216, 189)');
  await dialog.screenshot({ path: path.join(os.tmpdir(), 'asterium-diary-paper-dark.png') });
  await page.setViewportSize({ width: 480, height: 760 });
  await page.waitForFunction(() => globalThis.document.querySelector('.diary-modal-host .modal-card').getBoundingClientRect().width <= 440);
  const box = await dialog.boundingBox();
  await dialog.screenshot({ path: path.join(os.tmpdir(), 'asterium-diary-paper-narrow.png') });
  if (!box || box.x < 0 || box.x + box.width > 481) throw new Error(`Diary modal overflows narrow viewport: ${JSON.stringify(box)}`);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  if (!await opener.evaluate((button) => globalThis.document.activeElement === button)) throw new Error('Opener focus was not restored');
  console.log('Diary fixture layout passed: paper cards, on-demand reads, light/dark, narrow viewport, focus trap and Escape.');
} finally { await browser?.close(); await server.close(); }
});
