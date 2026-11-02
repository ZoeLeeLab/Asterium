import { runAutoTest, spawnTestProcess as spawn, testRm as rm, autoTestEvidence, createTestNetServer } from './helpers/autoTest.mjs';
import { requireLiveTestSource } from './helpers/liveTestConfiguration.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';

import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { prepareCodexPlanThread } from './helpers/codexPlanThread.mjs';

await runAutoTest(async () => {
// Explicit opt-in. Real model/native CLI, synthetic messages, temporary app data and workspace.










const sourceKind = process.argv.find((arg) => arg.startsWith('--source='))?.split('=')[1] ?? 'api';
assert.equal(sourceKind, 'api', 'Studio acceptance uses the API provider; native snapshot adapters are covered by the preceding stage.');
const optIn = sourceKind === 'api' ? 'ASTERIUM_API_LIVE_SMOKE' : sourceKind === 'codex' ? 'ASTERIUM_CODEX_LIVE_SMOKE' : 'ASTERIUM_CLAUDE_LIVE_SMOKE';
if (process.env[optIn] !== '1') throw new Error(`Set ${optIn}=1 to run this real model test.`);
const root = path.resolve(import.meta.dirname, '..');
const userData = await mkdtemp(path.join(os.tmpdir(), 'asterium-studio-persona-smoke-'));
const workspace = path.join(userData, 'workspace');
const legacyRunPath = process.env.ASTERIUM_USE_LEGACY_RUN_PATH === '1';
const evidence = autoTestEvidence('studio-persona-live-smoke'); await mkdir(evidence, { recursive: true });
const partnerId = `profile-${sourceKind}`, conversationId = 'profile-chat', credentialRef = 'compact-credential', grantId = 'compact-workspace';
const result = { status: 'running', sourceKind, legacyRunPath, isolatedUserData: true, cases: {} };
await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
let child, browser, page, launchFailure; const originals = [];
try {
  await mkdir(workspace);
  await writeFile(path.join(userData, 'workspace-grants.v1.json'), JSON.stringify({ version: 1, grants: { [grantId]: workspace } }));
  let apiSettings;
  if (sourceKind === 'api') {
    const source = requireLiveTestSource();
    for (const name of ['secure-credentials.v1.json', 'memory-fallback-settings.v1.json', 'Local State']) originals.push({ filename: path.join(source, name), bytes: await readFile(path.join(source, name)) });
    const settings = JSON.parse(originals[1].bytes), cipher = JSON.parse(originals[0].bytes).credentials['asterium-memory-fallback-api'];
    const encryptionMetadata = JSON.parse(originals[2].bytes).os_crypt;
    assert.equal(settings.provider, 'deepseek'); assert.equal(settings.endpoint, 'https://api.deepseek.com/chat/completions'); assert.ok(cipher && encryptionMetadata && settings.model);
    apiSettings = { endpoint: settings.endpoint, model: settings.model };
    await writeFile(path.join(userData, 'secure-credentials.v1.json'), JSON.stringify({ version: 1, credentials: { [credentialRef]: cipher } }), { mode: 0o600 });
    await writeFile(path.join(userData, 'Local State'), JSON.stringify({ os_crypt: encryptionMetadata }), { mode: 0o600 });
  }
  const projectId = 'persona-project', roomId = 'persona-room', secondRoomId = 'persona-other-room', otherPartnerId = 'studio-other';
  const now = new Date().toISOString();
  await writeFile(path.join(userData, 'project-domain.v1.json'), JSON.stringify({ version: 1, projects: [{ version: 1, id: projectId, name: '合成人设项目', description: '', status: 'active', progress: 0, tags: [], memberIds: [partnerId, otherPartnerId], revision: 1, createdAt: now, updatedAt: now }], tasks: [] }));
  await writeFile(path.join(userData, 'project-workspaces.v1.json'), JSON.stringify({ version: 1, projects: [{ version: 1, projectId, name: '合成人设项目', rootPath: workspace, deliverablesPath: path.join(workspace, 'deliverables'), templateFiles: [], createdAt: now, updatedAt: now }] }));
  const port = await reservePort();
  const executable = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe');
  result.archiveHash = hash(await readFile(path.join(path.dirname(executable), 'resources', 'app.asar')));
  child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore' });
  child.once('error', (error) => { launchFailure = error; });
  await until(async () => { if (launchFailure) throw launchFailure; if (child.exitCode !== null) throw new Error('Isolated application exited'); return fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false); }, 30_000, 'debugger');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await until(async () => { page = browser.contexts().flatMap((context) => context.pages()).find((p) => p.url().startsWith('file:')); return Boolean(page); }, 15_000, 'application page');
  await page.getByLabel('主要页面').waitFor();
  let codexThread;
  if (sourceKind === 'codex' && process.env.ASTERIUM_CODEX_CATALOG_THREAD === '1') {
    const runtime = await page.evaluate(async () => { const d = await globalThis.asteriumAgents.detectCodex(); return d.runtimes.find((r) => r.runtimeId === d.recommendedRuntimeId && r.loggedIn) ?? d.runtimes.find((r) => r.loggedIn); });
    assert.ok(runtime, 'No signed-in Codex runtime');
    codexThread = await prepareCodexPlanThread(runtime.executablePath, workspace);
    result.threadScopedModel = codexThread.model;
  }
  const seededState = await page.evaluate(async ({ partnerId, conversationId, sourceKind, credentialRef, grantId, workspace, apiSettings, codexThread }) => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    const management = { userProfile: true, personality: true, memoryMode: sourceKind === 'api' ? 'asterium' : 'self_managed' };
    const identity = { displayName: '工作室人设验收伙伴', introduction: '隔离合成测试', expertise: '', mentionName: '工作室人设验收伙伴' };
    let partner = { id: partnerId, publicIdentity: identity, status: 'online', accent: '#55aa99', isPrototype: false, createdAt: new Date().toISOString(), profileManagement: management };
    if (sourceKind === 'api') partner = { ...partner, sourceMode: 'api_partner', provider: 'deepseek', ...apiSettings, credentialRef, configured: true, apiSessionHistoryEnabled: true, thinkingMode: 'disabled', reasoningEffort: 'low', primaryWorkspaceGrantId: grantId, workspaceGrantIds: [grantId], personality: 'PERSONA_OLD_A' , systemPrompt: '保持 Plan 模式，只有明确选择执行才执行。不要联网或写记忆。' };
    else {
      let runtime;
      if (sourceKind === 'codex') { const detection = await globalThis.asteriumAgents.detectCodex(); runtime = detection.runtimes.find((r) => r.runtimeId === detection.recommendedRuntimeId && r.loggedIn) ?? detection.runtimes.find((r) => r.loggedIn); if (!runtime) throw new Error('CODEX_NOT_LOGGED_IN'); }
      else { const detection = await globalThis.asteriumAgents.detectClaude(); if (!detection.installed || !detection.loggedIn) throw new Error('CLAUDE_NOT_LOGGED_IN'); }
      partner = { ...partner, sourceMode: 'local_cli', adapterType: sourceKind === 'codex' ? 'codex_cli' : 'claude_code', connectionKind: sourceKind === 'codex' ? 'local_codex' : 'local_claude', location: 'local', sessionMode: 'new', connectionLabel: '隔离原生验收', partnerRootKind: 'imported', partnerRoot: workspace, partnerRootGrantId: grantId, workspaceGrantIds: [], workingDirectories: [], ...(runtime ? { codexRuntimeId: runtime.runtimeId, codexRuntime: runtime } : {}) };
    }
    state.partners = [partner]; state.projects = []; state.groupChats = [];
    state.userProfile = { ...state.userProfile, displayName: '合成测试', introduction: '' };
    state.conversations = [{ id: conversationId, partnerId, title: '工作室人设验收', permissionMode: 'read_only', planMode: 'default', messages: [], updatedAt: new Date().toISOString(), ...(codexThread ? { sessionId: codexThread.threadId } : {}), ...(sourceKind !== 'api' ? { partnerRootKind: 'imported', partnerRoot: workspace, partnerRootGrantId: grantId } : {}) }];
    state.activePartnerId = partnerId; state.activeConversationId = conversationId; state.activeProjectId = ''; state.activeGroupChatId = '';
    await globalThis.asteriumAgents.syncPartnerWorkspace(partnerId, grantId, []);
    await globalThis.asteriumAgents.savePartnerProfile({ partnerId, sourceMode: partner.sourceMode, publicIdentity: identity, management, ...(sourceKind === 'api' ? { personality: partner.personality, systemPrompt: partner.systemPrompt, connectionSettings: { provider: 'deepseek', endpoint: apiSettings.endpoint, configuredModel: apiSettings.model, thinkingMode: 'disabled', reasoningEffort: 'low', apiSessionHistoryEnabled: true } } : { connectionSettings: { adapterType: partner.adapterType, partnerRoot: workspace, partnerRootGrantId: grantId }, personality: 'PERSONA_OLD_A', systemPrompt: '仅参与当前合成测试；简短回复，不执行额外任务。' }) });
    return JSON.stringify(state);
  }, { partnerId, conversationId, sourceKind, credentialRef, grantId, workspace, apiSettings, codexThread });
  // Seed before the next renderer mounts; the old renderer may still persist
  // its initial demo state while native profile IPC is completing.
  await page.addInitScript((state) => {
    if (globalThis.sessionStorage.getItem('studio-persona-fixture-seeded') === '1') return;
    localStorage.setItem('asterium.prototype.v7', state); globalThis.sessionStorage.setItem('studio-persona-fixture-seeded', '1');
  }, seededState);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('给 工作室人设验收伙伴 发送消息…').waitFor();
  await page.evaluate((id) => { globalThis.__planEvents = []; globalThis.asteriumAgents.onEvent((event) => { if (event.partnerId === id) globalThis.__planEvents.push(event); }); }, partnerId);
  await page.evaluate(async ({ otherPartnerId, partnerId }) => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7')), partner = state.partners.find((p) => p.id === partnerId);
    const other = { ...partner, id: otherPartnerId, publicIdentity: { ...partner.publicIdentity, displayName: '保留成员', mentionName: '保留成员' }, personality: 'PERSONA_OTHER_OLD' };
    state.partners.push(other); localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
    await globalThis.asteriumAgents.syncPartnerProfiles({ displayName: '合成用户', introduction: 'USER_OLD_A', updatedAt: new Date().toISOString() }, [partner, other].map((p) => ({ partnerId: p.id, sourceMode: p.sourceMode, publicIdentity: p.publicIdentity, management: { userProfile: true, personality: true, memoryMode: 'asterium' }, personality: p.personality, systemPrompt: '仅参与合成自动测试；简短回复，不用工具，不写文件或记忆。', connectionSettings: { provider: 'deepseek', endpoint: p.endpoint, configuredModel: p.model, apiSessionHistoryEnabled: true, __studioRuntime: { persist: true, available: true, runtime: { kind: 'api', connection: { provider: 'deepseek', endpoint: p.endpoint, model: p.model, credentialRef: p.credentialRef, thinkingMode: 'disabled', reasoningEffort: 'low', workspaceGrantIds: [] } } } } })));
    await globalThis.asteriumAgents.saveUserProfile({ displayName: '合成用户', introduction: 'USER_OLD_A', updatedAt: new Date().toISOString() });
  }, { otherPartnerId, partnerId });
  await send('这是隔离工作室验收，请只回复收到，不用工具。');
  const rooms = [{ roomId, projectId, name: '人设房间', memberIds: [partnerId, otherPartnerId] }, { roomId: secondRoomId, projectId, name: '其他房间', memberIds: [partnerId] }];
  await page.evaluate(async ({ rooms, projectId, partnerId, otherPartnerId }) => { await globalThis.asteriumProjects.changeMembers({ projectId, projectMemberIds: [partnerId, otherPartnerId], rooms: rooms.map((room) => ({ room })) }); }, { rooms, projectId, partnerId, otherPartnerId });
  await round(roomId, otherPartnerId, '这是合成测试，请只回复已加入，不调用工具、不写记忆。');
  await round(secondRoomId, partnerId, '这是另一房间，请仅回复收到，不调用工具、不写记忆。');
  await round(roomId, partnerId, '公开约定标记是 PUBLIC_LEDGER_742。请记住这个公开约定，并只回复收到，不调用工具、不写记忆。');
  const before = await groupBinding(roomId, partnerId), retained = await groupBinding(roomId, otherPartnerId), otherRoom = await groupBinding(secondRoomId, partnerId);
  assert.ok(before.bootstrap.content.includes('PERSONA_OLD_A')); assert.ok(before.bootstrap.content.includes('USER_OLD_A'));
  let directory; for (const name of await readdir(path.join(userData, 'AsteriumData', 'partners'))) { const folder = path.join(userData, 'AsteriumData', 'partners', name); const metadata = JSON.parse(await readFile(path.join(folder, 'partner.json'), 'utf8')); if (metadata.partnerId === partnerId) directory = folder; }
  await writeFile(path.join(userData, 'AsteriumData', 'user', 'user-profile.md'), '# 用户介绍\n\n## 名字\n\n合成新用户\n\n## 介绍\n\nUSER_NEW_B\n');
  await writeFile(path.join(directory, 'persona.md'), '# 伙伴设定\n\n## 性格与相处方式\n\nPERSONA_NEW_B\n\n## 稳定指令\n\n只参与当前自动测试；不调用工具、不写记忆。\n');
  await round(roomId, partnerId, '请只返回当前系统资料中的用户介绍及人设的英文标记，不使用工具。');
  assert.deepEqual((await groupBinding(roomId, partnerId)).bootstrap, before.bootstrap);
  await reload('reload-user'); await reload('reload-persona'); const single = await binding();
  assert.ok(single.bootstrap.content.includes('USER_NEW_B')); assert.deepEqual((await groupBinding(roomId, partnerId)).bootstrap, before.bootstrap);
  const cacheDirectory = path.join(userData, 'api-agent-sessions', 'v1');
  const oldCachePath = path.join(cacheDirectory, hash(Buffer.from(partnerId+'\0'+before.conversationId))+'.json');
  const oldCache = JSON.parse(await readFile(oldCachePath, 'utf8')); oldCache.legacyContext = 'PRIVATE_OLD_CACHE_981'; await writeFile(oldCachePath, JSON.stringify(oldCache));
  await membership([otherPartnerId]);
  assert.equal(await groupBinding(roomId, partnerId), undefined);
  assert.equal((await groupBinding(roomId, otherPartnerId)).bindingId, retained.bindingId); assert.equal((await groupBinding(secondRoomId, partnerId)).bindingId, otherRoom.bindingId); assert.equal((await binding()).bindingId, single.bindingId);
  await page.evaluate(async (room) => globalThis.asteriumStudio.syncRoom(room), rooms[0]); assert.equal(await groupBinding(roomId, partnerId), undefined);
  const stale = await page.evaluate(async (id) => globalThis.asteriumStudio.getRoom(id), roomId); assert.deepEqual(stale.metadata.memberIds, [otherPartnerId]);
  await membership([partnerId, otherPartnerId]);
  await round(roomId, partnerId, '请只返回当前系统资料中的用户介绍英文标记、伙伴人设英文标记，以及历史用户约定的公开标记。不使用工具、不读取磁盘、不写记忆。');
  const after = await groupBinding(roomId, partnerId); assert.ok(after.generation > before.generation); assert.notEqual(after.conversationId, before.conversationId); assert.notEqual(after.nativeThreadId, before.nativeThreadId); assert.ok(after.bootstrap.content.includes('USER_NEW_B')); assert.ok(after.bootstrap.content.includes('PERSONA_NEW_B'));
  const room = await page.evaluate(async (id) => globalThis.asteriumStudio.getRoom(id), roomId); const reply = room.messages.filter((m) => m.authorId === partnerId).at(-1).content;
  assert.ok(reply.includes('USER_NEW_B')); assert.ok(reply.includes('PERSONA_NEW_B')); assert.ok(reply.includes('PUBLIC_LEDGER_742'));
  const nextCache = JSON.parse(await readFile(path.join(cacheDirectory, hash(Buffer.from(partnerId+'\0'+after.conversationId))+'.json'), 'utf8'));
  assert.ok(!JSON.stringify(nextCache).includes('PRIVATE_OLD_CACHE_981')); assert.ok(nextCache.turns[0].userContent.includes('PUBLIC_LEDGER_742'));
  assert.deepEqual((await groupBinding(secondRoomId, partnerId)).bootstrap, otherRoom.bootstrap); assert.deepEqual((await groupBinding(roomId, otherPartnerId)).bootstrap, retained.bootstrap);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByPlaceholder('给 工作室人设验收伙伴 发送消息…').waitFor(); assert.equal((await groupBinding(roomId, partnerId)).nativeThreadId, after.nativeThreadId);
  await page.screenshot({ path: path.join(evidence, 'completed.png') });
  result.cases = { fixedUntilRejoin: true, singleReloadDoesNotPropagate: true, targetedInvalidation: true, staleMetadataCannotReadd: true, newGenerationAndThread: true, latestProfiles: true, publicHistoryPreserved: true, privateCacheIsolated: true, otherMembersRoomsAndSinglePreserved: true }; result.status = 'passed';
  async function membership(memberIds) { await page.evaluate(async ({ rooms, projectId, partnerId, otherPartnerId, memberIds }) => globalThis.asteriumProjects.changeMembers({ projectId, projectMemberIds: [partnerId, otherPartnerId], rooms: rooms.map((room, index) => ({ room: index === 0 ? { ...room, memberIds } : room })) }), { rooms, projectId, partnerId, otherPartnerId, memberIds }); }
  async function round(room, speaker, content) {
    await page.evaluate(async ({ room, speaker, content }) => {
      const snapshot = await globalThis.asteriumStudio.getRoom(room);
      await globalThis.asteriumStudio.setSettings({ roomId: room, settings: { speakingMode: 'selected_partners', selectedPartnerIds: [speaker], discussionProtectionEnabled: false } });
      await globalThis.asteriumStudio.startRound({ room: snapshot.metadata, messageId: 'm-'+globalThis.crypto.randomUUID(), content, authorId: 'asterium:user:local', speakerQueue: [speaker] });
    }, { room, speaker, content });
    await until(async () => { const snapshot = await page.evaluate(async (id) => globalThis.asteriumStudio.getRoom(id), room); if (snapshot.activeRound?.state === 'failed') throw new Error('STUDIO_ROUND_FAILED'); return snapshot.activeRound?.state === 'completed'; }, 120_000, 'studio-round');
  }

} catch (error) {
  result.status = 'failed'; if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => undefined);
  if (page) {
    const failures = await page.evaluate(() => (globalThis.__planEvents ?? []).filter((event) => event.type === 'run.failed').map((event) => ({ code: event.error.code, message: event.error.message }))).catch(() => []);
    result.runtimeErrors = failures.map(({ code, message }) => ({ code, message: message.replace(/(?:sk-|Bearer\s+)[^\s"']+/gi, '[redacted]').slice(0, 700) }));
    if (failures.length) console.log(JSON.stringify({ runtimeErrors: result.runtimeErrors }));
  }
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  if (child?.pid && child.exitCode === null) {
    await new Promise((resolve) => { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('exit', resolve); killer.once('error', resolve); });
    await until(async () => child.exitCode !== null || child.signalCode !== null, 10_000, 'process exit');
  }
  const resolved = await realpath(userData); assert.equal(path.dirname(resolved).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase()); assert.ok(path.basename(resolved).startsWith('asterium-studio-persona-smoke-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  for (const original of originals) assert.equal(hash(await readFile(original.filename)), hash(original.bytes), 'Source API configuration changed');
  result.temporaryDataRemoved = true; if (originals.length) result.sourceConfigurationUnchanged = true;
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
async function snapshot() { return page.evaluate((id) => JSON.parse(localStorage.getItem('asterium.prototype.v7')).conversations.find((conversation) => conversation.id === id), conversationId); }
async function send(text) {
  const prior = await page.evaluate(() => globalThis.__planEvents.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)).length);
  await page.getByPlaceholder('给 工作室人设验收伙伴 发送消息…').fill(text); await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction((count) => globalThis.__planEvents.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)).length > count, prior, { timeout: 120_000 });
  const events = await page.evaluate(() => globalThis.__planEvents); const terminal = events.filter((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)).at(-1); assert.equal(terminal.type, 'run.completed', terminal.error?.message);
  await page.waitForFunction((id) => { const c = JSON.parse(localStorage.getItem('asterium.prototype.v7')).conversations.find((c) => c.id === id); return c && !c.activeRun && !c.awaitingFirstResponse; }, conversationId);
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function reservePort() { const server = createTestNetServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; }
async function until(probe, timeout, label) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 150)); } throw new Error(`Timed out: ${label}`); }

async function binding() { const data = JSON.parse(await readFile(path.join(userData, 'native-thread-bindings.v1.json'), 'utf8')); return data.bindings.find((b) => b.scope === 'single' && b.partnerId === partnerId && b.conversationId === conversationId && b.state === 'active'); }
async function reload(command) {
  const before = await snapshot();
  const target = { partnerId, conversationId, source: sourceKind === 'api' ? 'api_partner' : 'local_cli', sessionId: before.sessionId };
  await until(async () => { const status = await page.evaluate(async (target) => globalThis.asteriumAgents.getSessionStatus(target), target); return status.state === 'idle'; }, 10_000, 'writer release');
  if (command === 'reload-user') { await page.getByRole('button', { name: '指令', exact: true }).click(); await page.getByRole('menuitem', { name: /重读用户资料/ }).click(); }
  else { await page.locator('.composer textarea').fill('/reload-persona'); await page.locator('.composer textarea').press('Enter'); }
  await page.waitForFunction(() => { const node = globalThis.document.querySelector('[aria-label="会话指令结果"]'); return node && !node.textContent.includes('正在'); }, null, { timeout: 200_000 });
  const message = await page.getByLabel('会话指令结果').innerText(); assert.ok(message.includes('已重读'), message); await page.screenshot({ path: path.join(evidence, command+'.png') });
}

async function groupBinding(room, partner) { const data = JSON.parse(await readFile(path.join(userData, 'native-thread-bindings.v1.json'), 'utf8')); return data.bindings.find((b) => b.scope === 'group' && b.roomId === room && b.partnerId === partner && b.state === 'active'); }
});
