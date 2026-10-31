import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { withMemoryMaintenance } from '../scripts/memory-sqlite-maintenance.mjs';

const executable = process.env.ASTERIUM_PACKAGED_EXE ?? path.resolve('out/Asterium-win32-x64/Asterium.exe');
const userData = await mkdtemp(path.join(os.tmpdir(), 'asterium-sqlite-smoke-'));
const profileRoot = path.join(userData, 'AsteriumData');
const legacyBytes = Buffer.from('\ufeff# 测试记忆\r\n\r\n不导入。');
let child; let browser; let stderr = '';
const seed = (id, name = id) => ({ partnerId: id, sourceMode: 'local_cli', publicIdentity: { displayName: name, introduction: '', expertise: '', mentionName: name },
  management: { userProfile: false, personality: false, memoryMode: 'asterium' }, connectionSettings: { adapterType: 'codex_cli' } });
try {
  for (const id of ['sqlite-p', 'sqlite-q']) {
    const directory = path.join(profileRoot, 'partners', id);
    await mkdir(path.join(directory, 'private-memory'), { recursive: true });
    await writeFile(path.join(directory, 'partner.json'), JSON.stringify({ version: 2, ...seed(id), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    await writeFile(path.join(directory, 'profile.md'), `# 伙伴介绍\n\n## 名字\n\n${id}\n\n## 简短介绍\n\n\n## 长期擅长\n\n\n## @称呼\n\n${id}\n`);
    await writeFile(path.join(directory, 'private-memory', 'memory.md'), legacyBytes);
  }
  let page = await launch();
  const initial = await page.evaluate(async () => ({ p: await globalThis.asteriumMemory.query({ partnerId: 'sqlite-p' }), q: await globalThis.asteriumMemory.query({ partnerId: 'sqlite-q' }) }));
  if (initial.p.records.length || initial.q.records.length) throw new Error('Legacy test memories must not be imported');
  const record = await page.evaluate(async () => {
    const api = globalThis.asteriumMemory;
    let record = await api.create({ partnerId: 'sqlite-p', type: 'preference_and_collaboration', body: 'SQLite 验收偏好：先给结论', weight: 3 });
    record = await api.comment({ partnerId: 'sqlite-p', memoryId: record.memoryId, content: '再给细节', expectedUpdatedAt: record.updatedAt });
    record = await api.update({ partnerId: 'sqlite-p', memoryId: record.memoryId, weight: 4, expectedUpdatedAt: record.updatedAt });
    const briefing = await api.briefing('sqlite-p');
    if (!briefing.content.includes('先给结论') || !briefing.content.includes('再给细节')) throw new Error('SQLite briefing content missing');
    if ((await api.query({ partnerId: 'sqlite-q' })).records.length) throw new Error('Partner isolation failed');
    return record;
  });
  await page.evaluate(async (profile) => { await globalThis.asteriumAgents.savePartnerProfile(profile); }, seed('sqlite-p', 'SQLite 改名'));
  await stop();
  page = await launch();
  const restored = await page.evaluate(async () => (await globalThis.asteriumMemory.query({ partnerId: 'sqlite-p' })).records);
  if (restored.length !== 1 || restored[0].memoryId !== record.memoryId || restored[0].weight !== 4 || restored[0].comments.length !== 1) throw new Error('Restart reset or lost SQLite memory');
  await page.evaluate(async (record) => {
    const api = globalThis.asteriumMemory; const partnerId = 'sqlite-p';
    let changed = await api.softDelete({ partnerId, memoryId: record.memoryId, expectedUpdatedAt: record.updatedAt });
    if ((await api.query({ partnerId })).records.length) throw new Error('Soft-deleted record remained visible');
    changed = await api.restore({ partnerId, memoryId: record.memoryId, expectedUpdatedAt: changed.updatedAt });
    changed = await api.softDelete({ partnerId, memoryId: record.memoryId, expectedUpdatedAt: changed.updatedAt });
    await api.purge({ partnerId, memoryId: record.memoryId, expectedUpdatedAt: changed.updatedAt });
    if ((await api.query({ partnerId, includeDeleted: true })).records.length) throw new Error('Purge failed');
  }, restored[0]);
  await stop();
  const current = await partnerDirectory('sqlite-p');
  if ((await readdir(path.join(current, 'private-memory'))).some((name) => name.endsWith('.md'))) throw new Error('Active memory Markdown was recreated');
  if ((await readFile(path.join(current, 'private-memory', 'memory.sqlite'))).subarray(0, 15).toString() !== 'SQLite format 3') throw new Error('Database header missing');
  await withMemoryMaintenance(userData, async (coordinator) => {
    const manifest = await coordinator.status();
    if (manifest.state !== 'complete' || manifest.partners.length !== 2 || manifest.files.length !== 2) throw new Error('Cutover manifest invalid');
    await coordinator.rollback(true);
    if (!(await readFile(path.join(current, 'private-memory', 'memory.md'))).equals(legacyBytes)) throw new Error('Rollback lost original bytes or restored the wrong renamed directory');
    if (!(await readdir(path.join(coordinator.backupDirectory(manifest), 'rollback-sqlite'))).includes('sqlite-p.sqlite')) throw new Error('Rollback SQLite snapshot missing');
  });
  console.log(JSON.stringify({ sqlitePackagedStartup: true, legacyDiscard: true, restart: true, partnerIsolation: true, rename: true, recycle: true, noMemoryMarkdown: true, rollback: true, realModelRequests: 0 }, null, 2));
} catch (error) {
  console.error(stderr.slice(-8000)); throw error;
} finally {
  await stop(); await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
async function partnerDirectory(id) {
  for (const entry of await readdir(path.join(profileRoot, 'partners'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(profileRoot, 'partners', entry.name);
    if (JSON.parse(await readFile(path.join(directory, 'partner.json'), 'utf8')).partnerId === id) return directory;
  }
  throw new Error('Partner directory missing');
}
async function launch() {
  const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve));
  child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: path.dirname(executable), env: { ...process.env, ASTERIUM_STARTUP_SMOKE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-10000); });
  let connected = false; const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited ${child.exitCode}`);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); connected = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
  }
  if (!connected) throw new Error('Packaged app debugger did not start');
  let page;
  while (Date.now() < deadline) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes('index.html'));
    if (page) break; await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!page) throw new Error('Packaged renderer missing');
  await page.waitForFunction(() => Boolean(globalThis.asteriumMemory && globalThis.asteriumAgents));
  await page.getByLabel('主要页面').waitFor(); return page;
}
async function stop() {
  if (browser) { for (const context of browser.contexts()) for (const page of context.pages()) await page.close().catch(() => {}); await browser.close().catch(() => {}); browser = undefined; }
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => { const timer = setTimeout(() => { child.kill(); resolve(); }, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
  child = undefined;
}
