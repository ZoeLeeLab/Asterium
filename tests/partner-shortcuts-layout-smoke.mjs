// Renderer-only fixtures; no real IPC, user data or model/API requests.
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';

const server = await createServer({ configFile: 'vite.renderer.config.ts', server: { host: '127.0.0.1', port: 0 } });
await server.listen(); let browser;
try {
  const { createTestState } = await server.ssrLoadModule(path.resolve('tests/fixtures/applicationState.ts')); const state = createTestState();
  state.partners[1].profileManagement = { userProfile: false, personality: false, memoryMode: 'asterium' };
  browser = await chromium.launch({ executablePath: process.env.ASTERIUM_BROWSER_EXE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await page.addInitScript((state) => {
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state)); localStorage.setItem('asterium.theme.v1', 'light');
    globalThis.asteriumMemory = { query: async ({ partnerId }) => ({ partnerId, archiveVersion: 'fixture', records: [] }),
      briefing: async (partnerId) => ({ schemaVersion: 1, partnerId, archiveVersion: 'fixture', logicalDate: '2026-10-21', generatedAt: '2026-10-21T00:00:00.000Z', content: '自我认知与关系优先的测试简报。' }), onChanged: () => () => {} };
    const settings = { provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', intervalMinutes: 20, credentialConfigured: true, partners: {} };
    globalThis.asteriumMemoryFallback = { get: async () => ({ settings: structuredClone(settings), jobs: [] }), listModels: async () => [],
      configure: async () => { throw new Error('Fixture must not save API settings'); }, setPartner: async ({ partnerId, enabled }) => { settings.partners[partnerId] = { enabled, enabledAt: '2026-10-21T00:00:00.000Z', history: 'from_now' }; return { settings: structuredClone(settings), jobs: [] }; } };
  }, state);
  const address = server.httpServer.address(); await page.goto(`http://127.0.0.1:${address.port}/#/chat`);
  await page.locator('[data-partner-id="fixture-local-b"]').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑伙伴' }).click();
  await page.waitForFunction(() => [...globalThis.document.querySelectorAll('input')].some((input) => input.value === '测试伙伴 B' && !input.disabled));
  await page.locator('.settings-partner-list [data-partner-id="fixture-local-b"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '记忆管理' }).click();
  await page.locator('.memory-partner-item.active').filter({ hasText: '测试伙伴 B' }).waitFor();
  await page.locator('summary', { hasText: '星丛记忆兜底' }).click();
  if (await page.locator('summary', { hasText: '星丛记忆兜底' }).innerText() !== '星丛记忆兜底') throw new Error('Fallback summary contains removed text');
  const dimensions = await page.locator('.memory-fallback-actions').evaluate((footer) => {
    const controls = [...footer.querySelectorAll('button')].map((button) => { const rect = button.getBoundingClientRect(); return { text: button.textContent, center: rect.top + rect.height / 2 }; });
    return { controls, spread: Math.max(...controls.map((item) => item.center)) - Math.min(...controls.map((item) => item.center)) };
  });
  if (dimensions.spread > 1) throw new Error(`Fallback actions are not aligned: ${JSON.stringify(dimensions)}`);
  const toggle = page.getByRole('button', { name: '开启此伙伴兜底', exact: true });
  await toggle.click(); await page.getByRole('button', { name: '从现在开始', exact: true }).click();
  await page.getByRole('button', { name: '关闭此伙伴兜底', exact: true, pressed: true }).waitFor();
  const light = path.join(os.tmpdir(), 'asterium-partner-shortcuts-light.png'); await page.locator('.memory-content-panel').screenshot({ path: light });
  await page.getByRole('button', { name: /外观/ }).click();
  const dark = path.join(os.tmpdir(), 'asterium-partner-shortcuts-dark.png'); await page.locator('.memory-content-panel').screenshot({ path: dark });
  await page.evaluate(() => { globalThis.location.hash = '/studio/workspace'; }); await page.getByRole('button', { name: '工作区', exact: true }).waitFor();
  if (await page.locator('.composer').count()) throw new Error('Workspace composer remained');
  await page.getByRole('button', { name: '讨论区', exact: true }).click(); await page.locator('.studio-composer').waitFor();
  console.log(JSON.stringify({ alignment: dimensions, partnerShortcuts: true, workspaceComposerHidden: true, discussionComposerRetained: true, screenshots: [light, dark] }, null, 2));
} finally { await browser?.close(); await server.close(); }
