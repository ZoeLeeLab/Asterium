// Offline packaged acceptance: real Main runtime/tools/Git + scripted provider SSE, isolated data only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'asterium-browser-smoke-'));
const workspace = path.join(temporary, 'project'); const projectId = 'browser-project', partnerId = 'browser-partner', roomId = 'browser-room', grantId = 'browser-workspace';
const evidence = path.join(root, '.qa', 'studio-browser'); await mkdir(evidence, { recursive: true });
const result = { status: 'running', scriptedProvider: true, realTools: true, isolatedUserData: true, cases: [] };
let application; let page;
async function until(check, label, timeout = 30000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 150)); } throw new Error(`Timed out: ${label}`); }
const git = (args) => exec('git', ['-c', `safe.directory=${workspace}`, '-C', workspace, ...args], { windowsHide: true });
try {
  await mkdir(path.join(workspace, 'src'), { recursive: true }); await mkdir(path.join(workspace, 'tests'));
  await writeFile(path.join(workspace, 'src', 'login.ts'), 'export const login = "before";\n');
  await writeFile(path.join(workspace, 'unrelated.ts'), 'old\n'); await writeFile(path.join(workspace, 'tests', 'pass.mjs'), 'console.log("BROWSER_TEST_PASSED");\n');
  await git(['init']); await git(['config', 'user.name', 'Browser Acceptance']); await git(['config', 'user.email', 'browser@example.invalid']); await git(['add', '.']); await git(['commit', '-m', '初始版本']);
  await writeFile(path.join(workspace, 'unrelated.ts'), 'pre-existing dirty\n');
  const now = new Date().toISOString();
  await writeFile(path.join(temporary, 'workspace-grants.v1.json'), JSON.stringify({ version: 1, grants: { [grantId]: workspace } }));
  await writeFile(path.join(temporary, 'project-domain.v1.json'), JSON.stringify({ version: 1, projects: [{ version: 1, id: projectId, name: '项目浏览验收', description: '隔离的文件与代码改动验收', status: 'active', progress: 0, tags: [], memberIds: [partnerId], revision: 1, createdAt: now, updatedAt: now }], tasks: [] }));
  await writeFile(path.join(temporary, 'project-workspaces.v1.json'), JSON.stringify({ version: 1, projects: [{ version: 1, projectId, name: '项目浏览验收', rootPath: workspace, deliverablesPath: path.join(workspace, 'deliverables'), templateFiles: [], createdAt: now, updatedAt: now }] }));
  const executable = process.env.ASTERIUM_PACKAGED_EXE ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe');
  result.archiveHash = createHash('sha256').update(await readFile(path.join(path.dirname(executable), 'resources', 'app.asar'))).digest('hex');
  const launch = async () => {
    application = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${temporary}`] });
    page = await application.firstWindow(); await page.locator('.app-grid, .settings-shell').first().waitFor();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => { (result.rendererErrors ??= []).push(error.message); });
  };
  await launch();
  await page.waitForFunction(() => localStorage.getItem('asterium.prototype.v7'));
  await page.evaluate(({ projectId }) => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    state.projects = []; state.groupChats = []; state.activeGroupChatId = ''; state.activeProjectId = projectId;
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
    localStorage.setItem('asterium.navigation.lastRoute', '/studio/discussion');
  }, { projectId });
  await page.reload(); await page.evaluate(() => { globalThis.location.hash = '#/studio/discussion'; });
  await page.getByRole('heading', { name: '当前项目还没有群聊', exact: true }).waitFor();
  for (const width of [1800, 1200]) {
    await application.evaluate(({ BrowserWindow }, width) => { BrowserWindow.getAllWindows()[0].setSize(width, 1000); }, width);
    await page.waitForFunction(width => globalThis.innerWidth === width, width);
    const alignment = await page.locator('.discussion-view').evaluate(region => {
      const content = region.querySelector('.friendly-empty').getBoundingClientRect(), viewport = region.getBoundingClientRect();
      const heading = region.querySelector('h2').getBoundingClientRect();
      return { empty: Math.abs(content.x + content.width / 2 - viewport.x - viewport.width / 2), heading: Math.abs(heading.x + heading.width / 2 - viewport.x - viewport.width / 2) };
    });
    assert.ok(alignment.empty < 2 && alignment.heading < 2, JSON.stringify(alignment));
  }
  await page.screenshot({ path: path.join(evidence, 'empty-project-centered.png') });
  result.cases.push('project-without-groups-empty-state-centered-wide-and-narrow');
  await page.evaluate(async ({ partnerId, projectId, roomId, grantId, workspace, now }) => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    const credential = await globalThis.asteriumAgents.saveApiCredential('isolated-scripted-provider-secret', 'browser-credential');
    const partner = { id: partnerId, sourceMode: 'api_partner', provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'scripted-model', credentialRef: credential.credentialRef, configured: true, isPrototype: false, status: 'online', accent: '#7094c7', publicIdentity: { displayName: '验收伙伴', mentionName: '验收伙伴', introduction: '合成伙伴', expertise: '代码验收' }, profileManagement: { userProfile: false, personality: false, memoryMode: 'self_managed' }, apiSessionHistoryEnabled: true, thinkingMode: 'disabled', primaryWorkspaceGrantId: grantId, workspaceGrantIds: [grantId], workingDirectories: [workspace], createdAt: now };
    state.partners = [partner]; state.projects = []; state.groupChats = [{ id: roomId, projectId, name: '代码协作验收', memberIds: [partnerId], messages: [], createdAt: now, updatedAt: now }];
    state.conversations = []; state.activePartnerId = partnerId; state.activeConversationId = ''; state.activeProjectId = projectId; state.activeGroupChatId = roomId;
    await globalThis.asteriumAgents.syncPartnerWorkspace(partnerId, grantId, []);
    await globalThis.asteriumAgents.syncPartnerProfiles({ displayName: '隔离验收', introduction: '', updatedAt: now }, [{ partnerId, sourceMode: 'api_partner', publicIdentity: partner.publicIdentity, management: partner.profileManagement, connectionSettings: { provider: partner.provider, endpoint: partner.endpoint, configuredModel: partner.model, apiSessionHistoryEnabled: true, __studioRuntime: { persist: true, available: true, runtime: { kind: 'api', connection: { provider: partner.provider, endpoint: partner.endpoint, model: partner.model, credentialRef: partner.credentialRef, thinkingMode: 'disabled', workspaceGrantIds: [] } } } } }]);
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state)); localStorage.setItem('asterium.navigation.lastRoute', '/studio/discussion'); localStorage.setItem('asterium.theme.v1', 'light'); localStorage.removeItem('asterium.appearance.v1');
  }, { partnerId, projectId, roomId, grantId, workspace, now });
  await page.reload(); await page.evaluate(() => { globalThis.location.hash = '#/studio/discussion'; }); await page.getByRole('heading', { name: '代码协作验收' }).waitFor();
  await page.evaluate(async ({ projectId, roomId, partnerId }) => {
    await globalThis.asteriumProjects.changeMembers({ projectId, projectMemberIds: [partnerId], rooms: [{ room: { roomId, projectId, name: '代码协作验收', memberIds: [partnerId] } }] });
    await globalThis.asteriumProjects.setExecutionPolicy({ projectId, permissionMode: 'full' });
    await globalThis.asteriumStudio.setSettings({ roomId, settings: { speakingMode: 'selected_partners', selectedPartnerIds: [partnerId], discussionProtectionEnabled: false } });
  }, { projectId, roomId, partnerId });
  assert.equal(await page.locator('.project-browser-pane:visible').count(), 0); assert.equal(await page.getByLabel('文件预览', { exact: true }).count(), 0);
  result.cases.push('both-panes-default-collapsed');
  const cardStyle = await page.locator('.project-browser-launchers').evaluate((card) => {
    const style = globalThis.getComputedStyle(card), reference = globalThis.getComputedStyle(globalThis.document.querySelector('.project-summary'));
    return { background: style.backgroundColor, reference: reference.backgroundColor, widths: [...card.querySelectorAll('button')].map((button) => button.getBoundingClientRect().width) };
  });
  assert.equal(cardStyle.background, cardStyle.reference);
  assert.ok(Math.max(...cardStyle.widths) - Math.min(...cardStyle.widths) < 1);
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  const projectTabs = page.getByRole('navigation', { name: '项目来源' }).getByRole('button');
  assert.deepEqual(await projectTabs.allTextContents(), ['创建新项目', '选择已有项目']);
  assert.match(await projectTabs.first().getAttribute('class'), /active/);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  result.cases.push('project-browser-card-and-project-default');
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1800, 1000); });
  await page.evaluate(() => { globalThis.location.hash = '#/chat'; });
  await page.locator('.app-grid[data-page="chat"]').waitFor();
  const gaps = await page.locator('.app-grid[data-page="chat"]').evaluate((grid) => {
    const box = (selector) => grid.querySelector(selector).getBoundingClientRect();
    return [box('.center-stage').left - box('.chat-left').right, box('.right-rail').left - box('.center-stage').right];
  });
  assert.ok(Math.abs(gaps[0] - 12) < 1 && Math.abs(gaps[1] - gaps[0]) < 1, JSON.stringify(gaps));
  result.cases.push('single-chat-symmetric-gaps');
  await page.evaluate(() => { globalThis.location.hash = '#/studio/discussion'; });
  await page.getByRole('heading', { name: '代码协作验收' }).waitFor();
  await application.evaluate(() => {
    globalThis.__browserSteps = []; globalThis.__browserProviderCalls = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://api.deepseek.com/chat/completions') throw new Error('Offline acceptance forbids network requests');
      const body = JSON.parse(init.body); const step = globalThis.__browserSteps.shift(); globalThis.__browserProviderCalls++;
      if (!step) throw new Error('Scripted provider exhausted');
      if (step.tool && !body.tools?.some((item) => item.function.name === step.tool)) throw new Error(`Tool not offered: ${step.tool}`);
      const delta = step.tool ? { tool_calls: [{ index: 0, id: `fixture-${globalThis.__browserProviderCalls}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] } : { content: step.text };
      const chunks = [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: step.tool ? 'tool_calls' : 'stop' }] }];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  await application.evaluate((_electron, { workspace }) => {
    globalThis.__browserSteps = [
      { tool: 'write_file', args: { path: 'src/login.ts', content: 'export const login = "group-completed";\n' } },
      { tool: 'write_file', args: { path: 'report.md', content: '# 项目验收报告\n\n登录页已完成。\n' } },
      { tool: 'run_command', args: { command: 'node tests/pass.mjs', cwd: workspace } },
      { tool: 'run_command', args: { command: `git -c safe.directory='${workspace.replaceAll("'", "''")}' add src/login.ts; git -c safe.directory='${workspace.replaceAll("'", "''")}' commit -m group-feature`, cwd: workspace } },
      { tool: 'deliver_file', args: { path: 'report.md' } },
      { text: '登录页修改完成，报告已交付。' },
    ];
  }, { workspace });
  await page.evaluate(async ({ projectId, partnerId, roomId }) => {
    await globalThis.asteriumStudio.startRound({ room: { roomId, projectId, name: '代码协作验收', memberIds: [partnerId] }, messageId: 'browser-user-message', content: '执行合成代码任务', authorId: 'asterium:user:local', speakerQueue: [partnerId] });
  }, { projectId, partnerId, roomId });
  await until(async () => {
    const snapshot = await page.evaluate((id) => globalThis.asteriumStudio.getRoom(id), roomId);
    if (snapshot.activeRound?.state === 'failed') throw new Error(`Group run failed: ${JSON.stringify(snapshot)}`);
    return snapshot.activeRound?.state === 'completed';
  }, 'scripted group runtime');
  const [groupChange] = await page.evaluate((id) => globalThis.asteriumProjects.listRunChanges(id), projectId);
  assert.deepEqual(groupChange.files.map((file) => file.path).sort(), ['report.md', 'src/login.ts']); assert.equal(groupChange.commits.length, 1); assert.equal(groupChange.verification[0]?.result, 'passed'); assert.equal(groupChange.complete, true);
  await page.getByRole('button', { name: '查看本次改动' }).waitFor(); result.cases.push('real-group-runtime-change-summary');
  await page.locator('.project-browser-launchers').getByRole('button', { name: '项目文件', exact: true }).click();
  await page.getByRole('button', { name: 'src', exact: true }).click(); await page.getByRole('button', { name: 'login.ts', exact: true }).waitFor();
  await page.getByRole('button', { name: '查看本次改动' }).click();
  await page.getByLabel('本次改动文件列表').getByRole('button', { name: /src\/login.ts/ }).click();
  await page.getByLabel('文件预览', { exact: true }).getByText('+export const login = "group-completed";').waitFor();
  const rows = await page.locator('.file-preview-pane .code-line').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().y));
  assert.ok(rows.length > 3 && rows.every((y, index) => index === 0 || y > rows[index - 1]), 'Diff lines must be vertically arranged');
  await page.getByRole('button', { name: '收起预览，返回浏览' }).click(); await page.getByLabel('关闭本次改动').click();
  assert.equal(await page.getByRole('button', { name: 'src', exact: true }).getAttribute('aria-expanded'), 'true'); result.cases.push('temporary-view-restores-tree');
  await page.getByLabel('关闭项目浏览').click();
  await page.locator('.project-files-list').getByRole('button', { name: /report.md/ }).click(); await page.getByLabel('文件预览', { exact: true }).getByRole('heading', { name: '项目验收报告' }).waitFor();
  assert.equal(await page.locator('.project-browser-pane:visible').count(), 0); result.cases.push('delivery-previews-without-browser');
  await page.getByLabel('关闭 report.md').click();
  await page.locator('.project-browser-launchers').getByRole('button', { name: '提交历史', exact: true }).click();
  await page.getByText('初始版本', { exact: true }).click(); await page.getByLabel('提交历史列表').getByRole('button', { name: /src\/login.ts/ }).click();
  await page.getByLabel('文件预览', { exact: true }).getByRole('button', { name: '查看源码' }).click(); await page.getByLabel('文件预览', { exact: true }).getByText('"before"', { exact: true }).waitFor(); result.cases.push('history-version-is-not-current-file');
  await page.getByRole('button', { name: '收起预览，返回浏览' }).click();
  await page.locator('.project-browser-launchers').getByRole('button', { name: '未提交', exact: true }).click(); await page.getByLabel('未提交列表').getByText('unrelated.ts', { exact: true }).waitFor(); result.cases.push('uncommitted-remains-distinct-from-task');
  await page.getByLabel('关闭项目浏览').click();
  await application.evaluate(() => { globalThis.__browserSteps = [
    { tool: 'write_file', args: { path: 'src/login.ts', content: 'export const login = "task-completed";\n' } },
    { tool: 'asterium_task', args: { action: 'submit_handoff', disposition: 'submitted', summary: '正式任务已完成', criterion_evidence: [], changed_paths: ['src/login.ts'], verification: [], delivery_refs: [], unresolved_issues: [] } },
    { text: '正式任务完成。' },
  ]; });
  const task = await page.evaluate(async ({ projectId, partnerId }) => {
    const task = await globalThis.asteriumProjects.createTask({ projectId, title: '正式代码任务', assigneeId: partnerId, execution: { completionRule: { type: 'executor_submit' } } });
    await globalThis.asteriumProjects.enqueueTaskAttempt({ projectId, taskId: task.id }); return task;
  }, { projectId, partnerId });
  await until(async () => {
    const snapshot = await page.evaluate((id) => globalThis.asteriumProjects.getTaskExecution(id), projectId); const attempt = snapshot.attempts.find((item) => item.taskId === task.id);
    if (attempt?.status === 'failed') throw new Error(`Task failed: ${JSON.stringify(attempt.failure)}`); return attempt?.status === 'succeeded';
  }, 'formal task runtime');
  await page.getByRole('button', { name: '工作区', exact: true }).click(); await page.locator('.task-stage-voices').getByText(/正式任务已完成/).waitFor(); await page.getByRole('button', { name: '查看本次改动' }).waitFor();
  const records = await page.evaluate((id) => globalThis.asteriumProjects.listRunChanges(id), projectId); assert.equal(records.length, 2);
  const taskRecord = records.find((record) => record.taskId === task.id); assert.equal(taskRecord.files.length, 1);
  const frozen = await page.evaluate((request) => globalThis.asteriumProjects.readRunChange(request), { projectId, id: groupChange.id, path: 'src/login.ts' }); assert.ok(frozen.text.includes('group-completed')); assert.ok(!frozen.text.includes('task-completed')); result.cases.push('formal-task-summary-and-frozen-earlier-run');
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(2400, 1200); });
  await page.locator('.project-browser-launchers').getByRole('button', { name: '项目文件', exact: true }).click(); await page.getByRole('button', { name: '查看本次改动' }).click(); await page.getByLabel('本次改动文件列表').getByRole('button', { name: /src\/login.ts/ }).click(); await page.getByLabel('文件预览', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'wide-light.png') });
  const bounds = await page.evaluate(() => { const selectors = ['.studio-center', '.project-browser-pane', '.file-preview-pane', '.studio-right']; return selectors.map((selector) => { const b = globalThis.document.querySelector(selector).getBoundingClientRect(); return { x: b.x, right: b.right, width: b.width }; }); });
  assert.ok(bounds.every((box) => box.width > 0)); assert.ok(bounds[0].right <= bounds[1].x + 1 && bounds[1].right <= bounds[2].x + 1 && bounds[2].right <= bounds[3].x + 1); result.cases.push('wide-nonoverlapping-layout');
  await page.getByTitle('切换到深色模式').click(); await page.reload();
  assert.equal(await page.locator('.project-browser-pane:visible').count(), 0); assert.equal(await page.getByLabel('文件预览', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '查看本次改动' }).click(); await page.getByLabel('本次改动文件列表').getByRole('button', { name: /src\/login.ts/ }).click(); await page.screenshot({ path: path.join(evidence, 'wide-dark.png') });
  await application.close(); application = undefined; await launch();
  const restarted = await page.evaluate((id) => globalThis.asteriumProjects.listRunChanges(id), projectId); assert.equal(restarted.length, 2); assert.equal(await page.locator('.project-browser-pane:visible').count(), 0); result.cases.push('restart-persistence-default-collapsed');
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1280, 800); });
  await page.locator('.project-browser-launchers').getByRole('button', { name: '项目文件', exact: true }).click(); await page.getByRole('button', { name: 'src', exact: true }).click(); await page.getByRole('button', { name: 'login.ts', exact: true }).click(); await page.getByRole('button', { name: '收起预览，返回浏览' }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'narrow-dark.png') }); await page.getByRole('button', { name: '收起预览，返回浏览' }).click(); await page.getByRole('button', { name: 'src', exact: true }).waitFor(); result.cases.push('narrow-preview-return');

  // Isolated long histories + controllable real SSE exercise both message viewports.
  await page.evaluate(({ partnerId }) => {
    const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
    state.conversations = [{ id: 'scroll-conversation', partnerId, title: '滚动验收对话', updatedAt: new Date().toISOString(), messages: Array.from({ length: 20 }, (_, i) => ({ id: `scroll-history-${i}`, authorId: i % 2 ? partnerId : 'asterium:user:local', content: `第 ${i} 条历史消息\n\n` + '这是一段用于验证滚动位置的合成历史内容。'.repeat(10), createdAt: '12:00' })) }];
    state.activeConversationId = 'scroll-conversation';
    localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
  }, { partnerId });
  await page.reload(); await page.getByLabel('主要页面').waitFor();
  await application.evaluate(() => {
    globalThis.fetch = async (url) => {
      if (String(url) !== 'https://api.deepseek.com/chat/completions') throw new Error('Offline acceptance forbids network requests');
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        const send = (delta, finish_reason = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`));
        send({ content: '正在逐段回复。\n\n' });
        globalThis.__polishReply = (content, finish = false) => {
          send({ content });
          if (finish) { send({}, 'stop'); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); globalThis.__polishReply = undefined; }
        };
      } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  for (const mode of ['studio', 'chat']) {
    await page.evaluate((mode) => { globalThis.location.hash = mode === 'studio' ? '#/studio/discussion' : '#/chat'; }, mode);
    if (mode === 'chat') await page.getByTitle('切换到浅色模式').click();
    const composer = page.locator(mode === 'studio' ? '.studio-composer' : '.composer');
    await composer.locator('textarea').fill('滚动与输出状态验收\n\n' + Array.from({ length: 45 }, (_, i) => `历史段落 ${i}：向上阅读时，应保留我的当前位置。`).join('\n\n'));
    await composer.getByRole('button', { name: '发送', exact: true }).click();
    await until(() => application.evaluate(() => typeof globalThis.__polishReply === 'function'), `${mode} provider stream`);
    const list = page.locator(mode === 'studio' ? '.studio-messages' : '.message-scroll-region .message-list');
    await list.evaluate((list) => { list.scrollTop = 0; list.dispatchEvent(new Event('scroll')); });
    const activeJump = page.getByRole('button', { name: '回到底部（伙伴正在回复）', exact: true });
    await activeJump.waitFor();
    assert.equal(await activeJump.locator('svg').evaluate((node) => globalThis.getComputedStyle(node).animationIterationCount), 'infinite');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await activeJump.locator('svg').evaluate((node) => globalThis.getComputedStyle(node).animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await application.evaluate(() => globalThis.__polishReply('阅读时追加的内容。\n\n'));
    await list.getByText(/阅读时追加的内容/).waitFor();
    assert.ok(await list.evaluate((list) => list.scrollTop < 1), 'Output must not pull a history reader down');
    await activeJump.click();
    await application.evaluate(() => globalThis.__polishReply('点击后继续输出。\n\n' + '新增内容。\n\n'.repeat(30)));
    await list.getByText(/点击后继续输出/).waitFor();
    await until(() => list.evaluate((list) => list.scrollHeight - list.scrollTop - list.clientHeight < 2), `${mode} resumed follow`);
    await list.evaluate((list) => { list.scrollTop = 0; list.dispatchEvent(new Event('scroll')); });
    await activeJump.waitFor();
    const position = await activeJump.evaluate((button) => {
      const rect = button.getBoundingClientRect(), viewport = button.closest('.discussion-view, .message-scroll-region').getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom };
    });
    assert.ok(position.top >= position.viewportTop && position.bottom <= position.viewportBottom, JSON.stringify(position));
    await until(() => activeJump.evaluate((button) => Number(globalThis.getComputedStyle(button).opacity) === 1), `${mode} visible control`);
    await page.screenshot({ path: path.join(evidence, `${mode}-jump-streaming.png`) });
    await application.evaluate(() => globalThis.__polishReply('回复完成。', true));
    const idleJump = page.getByRole('button', { name: '回到底部', exact: true });
    await idleJump.waitFor();
    assert.equal(await idleJump.locator('svg').evaluate((node) => globalThis.getComputedStyle(node).animationIterationCount), '1');
    await page.waitForTimeout(300);
    assert.equal(await idleJump.locator('svg').evaluate((node) => node.getAnimations().filter((animation) => animation.playState === 'running').length), 0);
    await page.screenshot({ path: path.join(evidence, `${mode}-jump-idle.png`) });
    await idleJump.focus(); await idleJump.press('Enter');
    await until(() => list.evaluate((list) => list.scrollHeight - list.scrollTop - list.clientHeight < 2), `${mode} keyboard jump`);
    assert.equal(await page.locator('.jump-to-latest').count(), 0);
    result.cases.push(`${mode}-jump-streaming-idle-reduced-motion-and-follow`);
    const titlebarControls = await page.locator('.window-rail-controls').evaluate((container) => {
      const buttons = [...container.querySelectorAll('button')];
      const boxes = buttons.map((button) => {
        const box = button.getBoundingClientRect(), hit = globalThis.document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { x: box.x, y: box.y, right: box.right, height: box.height, hit: hit === button || button.contains(hit), region: globalThis.getComputedStyle(button).getPropertyValue('-webkit-app-region') };
      });
      const nativeArea = globalThis.navigator.windowControlsOverlay?.getTitlebarAreaRect();
      return { boxes, nativeRight: nativeArea?.width ? nativeArea.x + nativeArea.width : globalThis.innerWidth - 142 };
    });
    assert.equal(titlebarControls.boxes[0].x, 0);
    assert.ok(titlebarControls.boxes.every((box) => box.y === 0 && box.height === 34 && box.hit && box.region === 'no-drag'));
    assert.ok(Math.abs(titlebarControls.boxes[1].right - titlebarControls.nativeRight) < 2, JSON.stringify(titlebarControls));
    await page.screenshot({ path: path.join(evidence, `${mode}-window-rail-controls.png`) });
    result.cases.push(`${mode}-window-titlebar-rail-controls`);
    const center = page.locator(mode === 'studio' ? '.studio-center' : '.center-stage');
    const before = await center.boundingBox();
    await page.getByRole('button', { name: '收起左侧栏', exact: true }).click();
    await page.getByRole('button', { name: '收起右侧栏', exact: true }).click();
    assert.equal(await page.locator('.app-grid > aside:visible').count(), 0);
    const after = await center.boundingBox();
    assert.ok(after.width > before.width + 400);
    assert.equal(await page.locator('.rail-resizer--left:visible, .rail-resizer--right:visible').count(), 0);
    await page.reload(); await page.getByRole('button', { name: '展开左侧栏', exact: true }).waitFor();
    await page.getByRole('button', { name: '展开右侧栏', exact: true }).click();
    await page.getByRole('button', { name: '展开左侧栏', exact: true }).click();
    assert.ok(Math.abs((await center.boundingBox()).width - before.width) < 1);
    result.cases.push(`${mode}-collapse-restore-persistence`);
    if (mode === 'studio') {
      await page.locator('.project-browser-launchers').getByRole('button', { name: '项目文件', exact: true }).click();
      await page.getByRole('button', { name: 'src', exact: true }).click();
      await page.getByRole('button', { name: 'login.ts', exact: true }).click();
      await page.getByLabel('文件预览', { exact: true }).waitFor();
      await page.getByRole('button', { name: '收起右侧栏', exact: true }).click();
      const previewBounds = await page.getByLabel('文件预览', { exact: true }).boundingBox();
      const gridBounds = await page.locator('.app-grid').boundingBox();
      assert.ok(Math.abs(previewBounds.x + previewBounds.width - gridBounds.x - gridBounds.width) < 2);
      await page.screenshot({ path: path.join(evidence, 'collapsed-right-preview.png') });
      await page.getByLabel('文件预览', { exact: true }).getByRole('button', { name: /^关闭 / }).click();
      await page.getByRole('button', { name: '展开右侧栏', exact: true }).click();
      result.cases.push('narrow-preview-with-right-rail-collapsed');
    }
  }
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1600, 1000); });
  await page.evaluate(() => { globalThis.location.hash = '#/settings/partners'; });
  await page.getByRole('button', { name: /^外观/ }).click();
  await page.getByRole('heading', { name: '外观', exact: true }).waitFor();
  const fontSizes = () => page.locator('.appearance-preview').evaluate((preview) => {
    const size = (selector) => Number.parseFloat(globalThis.getComputedStyle(preview.querySelector(selector)).fontSize);
    return [size('.appearance-preview__ui'), size('.message-bubble'), size('code')];
  });
  assert.deepEqual(await fontSizes(), [14, 14, 12]);
  await page.getByRole('slider', { name: '界面字号', exact: true }).press('End');
  assert.deepEqual(await fontSizes(), [18, 14, 12]);
  await page.getByRole('slider', { name: '内容字体大小', exact: true }).press('End');
  assert.deepEqual(await fontSizes(), [18, 24, 12]);
  await page.getByRole('slider', { name: '代码字体大小', exact: true }).press('End');
  assert.deepEqual(await fontSizes(), [18, 24, 22]);
  await page.getByLabel('界面与内容字体').selectOption('yahei');
  await page.getByLabel('代码字体', { exact: true }).selectOption('courier');
  const fontFamilies = await page.locator('.appearance-preview').evaluate((preview) => [globalThis.getComputedStyle(preview.querySelector('.message-bubble')).fontFamily, globalThis.getComputedStyle(preview.querySelector('code')).fontFamily]);
  assert.match(fontFamilies[0], /Microsoft YaHei/); assert.match(fontFamilies[1], /Courier New/);
  result.cases.push('appearance-independent-font-sizes-and-font-families');
  await page.getByRole('radio', { name: '随系统变化', exact: true }).click();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await until(() => page.evaluate((scheme) => globalThis.document.documentElement.dataset.theme === scheme, scheme), `system ${scheme}`);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.appearance.v1')).mode), 'system');
  }
  await page.getByRole('radio', { name: '浅色', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.dataset.theme), 'light');
  result.cases.push('appearance-system-changes-and-explicit-override');
  for (const palette of ['雨窗书房', '海风来信', '众神的后花园', '星海']) {
    await page.getByRole('button', { name: palette, exact: true }).click();
    await page.getByRole('radio', { name: '深色', exact: true }).click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(evidence, `appearance-${palette}-dark.png`) });
    await page.getByRole('radio', { name: '浅色', exact: true }).click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(evidence, `appearance-${palette}-light.png`) });
  }
  result.cases.push('appearance-available-palettes-both-color-modes');
  await application.close(); application = undefined; await launch();
  await page.evaluate(() => { globalThis.location.hash = '#/chat'; });
  await page.locator('.app-grid[data-page="chat"]').waitFor();
  assert.equal(await page.locator('.message-content--user').first().evaluate((node) => globalThis.getComputedStyle(node).fontSize), '24px');
  await page.evaluate(() => { globalThis.location.hash = '#/settings/partners?section=appearance'; });
  await page.getByRole('heading', { name: '外观', exact: true }).waitFor();
  assert.deepEqual(await fontSizes(), [18, 24, 22]);
  assert.equal(await page.getByLabel('代码字体', { exact: true }).inputValue(), 'courier');
  result.cases.push('appearance-restart-persistence');
  await page.evaluate(() => { globalThis.location.hash = '#/studio/discussion'; });
  await page.locator('.project-browser-launchers').getByRole('button', { name: '项目文件', exact: true }).click();
  await page.getByRole('button', { name: 'src', exact: true }).click();
  await page.getByRole('button', { name: 'login.ts', exact: true }).click();
  const actualCode = await page.locator('.code-preview-lines code').first().evaluate((code) => ({ size: globalThis.getComputedStyle(code).fontSize, family: globalThis.getComputedStyle(code).fontFamily }));
  assert.equal(actualCode.size, '22px'); assert.match(actualCode.family, /Courier New/);
  result.cases.push('appearance-code-font-applies-to-project-source');
  await page.evaluate(() => { globalThis.location.hash = '#/settings/partners?section=appearance'; });
  await page.getByRole('heading', { name: '外观', exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1180, 760); });
  await page.getByRole('button', { name: '海风来信', exact: true }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(evidence, 'appearance-narrow-large-fonts.png') });
  const overflow = await page.locator('.appearance-settings').evaluate((node) => node.scrollWidth - node.clientWidth);
  assert.ok(overflow < 2, `Appearance horizontal overflow ${overflow}`);
  const navBounds = await page.locator('.settings-nav nav').boundingBox();
  assert.equal(await page.getByRole('button', { name: '重置演示数据' }).count(), 0);
  assert.ok(navBounds.width > 0 && navBounds.height > 0, 'Settings navigation remains visible');
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  assert.deepEqual(await fontSizes(), [14, 14, 12]);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.appearance.v1')).mode), 'system');
  result.cases.push('appearance-narrow-layout-and-reset');
  assert.equal(await page.getByRole('button', { name: '森林', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '暮紫', exact: true }).count(), 0);
  for (const retired of ['forest', 'violet']) {
    const previous = await page.evaluate(retired => {
      const saved = JSON.parse(localStorage.getItem('asterium.appearance.v1'));
      localStorage.setItem('asterium.appearance.v1', JSON.stringify({ ...saved, theme: retired }));
      return saved;
    }, retired);
    await page.reload(); await page.getByRole('button', { name: /^外观/ }).click();
    await until(() => page.evaluate(() => globalThis.document.documentElement.dataset.colorTheme === 'asterium'), 'retired theme fallback');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.appearance.v1'))), { ...previous, theme: 'asterium' });
  }
  result.cases.push('retired-palettes-removed-and-saved-preferences-migrated');
  const sceneWallpaper = () => page.evaluate(async () => {
    const background = globalThis.getComputedStyle(globalThis.document.body).backgroundImage;
    const raw = /url\(["']?([^"')]+)["']?\)/.exec(background)?.[1];
    if (!raw) throw new Error('Scenic wallpaper is missing');
    const img = new globalThis.Image(); img.src = raw; await img.decode();
    return { background, width: img.naturalWidth, height: img.naturalHeight };
  });
  const sceneContrast = () => page.evaluate(() => {
    const root = globalThis.getComputedStyle(globalThis.document.documentElement);
    const canvas = globalThis.document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const color = token => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = root.getPropertyValue(token).trim(); context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].map(value => value / 255);
    };
    const light = values => values.slice(0, 3).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const contrast = (fg, bg) => (Math.max(light(fg), light(bg)) + .05) / (Math.min(light(fg), light(bg)) + .05);
    const background = color('--surface-strong'), code = color('--scene-code');
    return {
      text: Math.min(...[0, 1].flatMap(base => ['--text', '--text-strong', '--muted'].map(token => contrast(color(token), background.slice(0, 3).map(channel => channel * background[3] + base * (1 - background[3])))))),
      code: Math.min(...['--scene-keyword', '--scene-string', '--scene-comment', '--scene-number'].map(token => contrast(color(token), code))),
    };
  });
  for (const { id, name } of [{ id: 'rainy-study', name: '雨窗书房' }, { id: 'sea-letter', name: '海风来信' }, { id: 'olympian-garden', name: '众神的后花园' }]) {
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1800, 1000); });
    await page.waitForFunction(() => globalThis.innerWidth === 1800);
    await page.getByRole('button', { name, exact: true }).click();
    await until(() => page.evaluate(id => globalThis.document.documentElement.dataset.colorTheme === id, id), 'scenic palette selected');
    for (const mode of ['light', 'dark']) {
      await page.getByRole('radio', { name: mode === 'light' ? '浅色' : '深色', exact: true }).click();
      await until(() => page.evaluate(mode => globalThis.document.documentElement.dataset.theme === mode, mode), 'scene display mode');
      const wallpaper = await sceneWallpaper();
      assert.match(wallpaper.background, new RegExp('/' + id + '-' + mode + '-')); assert.equal(wallpaper.width, 1672); assert.equal(wallpaper.height, 941);
      const contrast = await sceneContrast(); assert.ok(contrast.text >= 4.5 && contrast.code >= 4.5, JSON.stringify({ id, mode, contrast }));
      ((result.scenePalettes ??= {})[id] ??= {})[mode] = { textContrast: contrast.text, codeContrast: contrast.code, wallpaperWidth: wallpaper.width, wallpaperHeight: wallpaper.height };
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(evidence, id + '-settings-' + mode + '.png') });
      await page.evaluate(() => { globalThis.location.hash = '#/chat'; });
      await page.locator('.app-grid[data-page="chat"]').waitFor();
      await page.locator('.message-list').first().evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: path.join(evidence, id + '-chat-' + mode + '.png') });
      await page.evaluate(() => { globalThis.location.hash = '#/studio/discussion'; });
      await page.locator('.project-browser-launchers').getByRole('button', { name: '项目文件', exact: true }).click();
      await page.getByRole('button', { name: 'src', exact: true }).waitFor();
      if (!await page.getByRole('button', { name: 'login.ts', exact: true }).isVisible()) await page.getByRole('button', { name: 'src', exact: true }).click();
      await page.getByRole('button', { name: 'login.ts', exact: true }).click();
      await page.locator('.code-preview-lines code').first().waitFor();
      assert.equal(await page.locator('.code-preview-lines code').first().evaluate(code => globalThis.getComputedStyle(code).fontSize), '12px');
      await page.screenshot({ path: path.join(evidence, id + '-studio-' + mode + '.png') });
      await page.evaluate(() => { globalThis.location.hash = '#/settings/partners?section=appearance'; });
      await page.getByRole('heading', { name: '外观', exact: true }).waitFor();
    }
    result.cases.push(id + '-local-wallpapers-chat-studio-code-and-readable-palette');
    await page.getByRole('radio', { name: '随系统变化', exact: true }).click();
    for (const mode of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: mode });
      await until(() => page.evaluate(mode => globalThis.document.documentElement.dataset.theme === mode, mode), 'scene system display mode');
      assert.match((await sceneWallpaper()).background, new RegExp('/' + id + '-' + mode + '-'));
    }
    result.cases.push(id + '-background-follows-system');
    await application.close(); application = undefined; await launch();
    await page.evaluate(() => { globalThis.location.hash = '#/settings/partners?section=appearance'; });
    await page.getByRole('button', { name: /^外观/ }).click();
    await page.getByRole('heading', { name: '外观', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name, exact: true }).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await fontSizes(), [14, 14, 12]);
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1180, 760); });
    await page.waitForFunction(() => globalThis.innerWidth === 1180);
    assert.ok(await page.locator('.appearance-settings').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: path.join(evidence, id + '-narrow.png') });
    await page.getByRole('button', { name: '星海', exact: true }).click();
    await until(() => page.evaluate(() => globalThis.document.documentElement.dataset.colorTheme === 'asterium'), 'restore original palette');
    const restoredBackground = await page.evaluate(() => globalThis.getComputedStyle(globalThis.document.body).backgroundImage);
    assert.match(restoredBackground, /\/asterium-(?:light|dark)-bg-/);
    assert.doesNotMatch(restoredBackground, /\/(?:rainy-study|sea-letter|olympian-garden)-(?:light|dark)-/);
    await page.getByRole('button', { name: '恢复默认', exact: true }).click();
    result.cases.push(id + '-restart-narrow-layout-and-original-theme-restoration');
  }

  // User customization acceptance uses real renderer storage, file inputs and native recovery.
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1600, 1000); });
  await page.getByRole('radio', { name: '浅色', exact: true }).click();
  await page.getByRole('button', { name: '简洁', exact: false }).click();
  const appearanceRoute = async () => {
    await page.evaluate(() => { globalThis.location.hash = '#/settings/partners?section=appearance'; });
    await page.getByRole('button', { name: /^外观/ }).click();
    await page.getByRole('heading', { name: '外观', exact: true }).waitFor();
  };
  for (const route of ['chat', 'studio/discussion']) {
    await page.evaluate(route => { globalThis.location.hash = '#/' + route; }, route);
    await page.locator('.message-row .message-bubble').first().waitFor();
    const plain = await page.locator('.message-row .message-bubble').first().evaluate(node => {
      const s = globalThis.getComputedStyle(node); return { background: s.backgroundColor, border: s.borderTopWidth, shadow: s.boxShadow };
    });
    assert.deepEqual(plain, { background: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none' });
    const mine = await page.locator('.message-row--mine').first().evaluate(node => {
      const avatar = node.querySelector(':scope > .avatar'), stack = node.querySelector('.message-stack');
      const meta = stack.querySelector('.message-meta'), bubble = stack.querySelector('.message-bubble');
      return avatar && avatar.getBoundingClientRect().x >= stack.getBoundingClientRect().right && globalThis.getComputedStyle(stack).alignItems === 'flex-end' && Math.abs(meta.getBoundingClientRect().right - stack.getBoundingClientRect().right) < 2 && bubble.getBoundingClientRect().right <= avatar.getBoundingClientRect().x;
    }); assert.ok(mine, 'Own avatar and message should remain on the right in plain mode');
    const partner = await page.locator('.message-row:not(.message-row--mine)').first().evaluate(node => { const avatar = node.querySelector(':scope > .avatar'), stack = node.querySelector('.message-stack'); return avatar && avatar.getBoundingClientRect().right <= stack.getBoundingClientRect().x && globalThis.getComputedStyle(stack).alignItems === 'flex-start'; }); assert.ok(partner, 'Partner messages should remain on the left');
    await page.locator('.message-list').first().evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: path.join(evidence, 'custom-plain-' + route.split('/')[0] + '.png') });
  }
  result.cases.push('custom-plain-single-and-group-message-content-and-layout');
  await appearanceRoute();
  await page.getByRole('button', { name: /^气泡/ }).click();
  const openDetail = async text => {
    const detail = page.locator('.appearance-extra > details').filter({ has: page.locator('summary').filter({ hasText: text }) });
    if (!await detail.getAttribute('open').then(value => value !== null)) await detail.locator(':scope > summary').click();
    return detail;
  };
  await openDetail('三栏与消息外观');
  const color = async (label, value) => {
    await page.getByLabel(label, { exact: true }).evaluate((input, value) => {
      Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    }, value);
  };
  for (const [label, hex] of [['左栏', '#123456'], ['中栏', '#304050'], ['右栏', '#506070']]) {
    await page.getByLabel(label + '自定义底色', { exact: true }).check();
    await color(label + '颜色', hex);
    await page.getByRole('slider', { name: label + '背景不透明度', exact: true }).press('End');
  }
  await page.getByLabel('左栏自定义磨砂', { exact: true }).check();
  await page.getByRole('slider', { name: '左栏磨砂强度', exact: true }).press('Home');
  for (const [zone, expected] of [['left', 'rgb(18, 52, 86)'], ['center', 'rgb(48, 64, 80)'], ['right', 'rgb(80, 96, 112)']]) {
    assert.equal(await page.locator('[data-appearance-panel=' + zone + ']').evaluate(node => globalThis.getComputedStyle(node).backgroundColor), expected);
  }
  await page.evaluate(() => { globalThis.location.hash = '#/chat'; });
  const panels = await page.locator('.app-grid').evaluate(node => ['.chat-left', '.center-stage', '.right-rail'].map(selector => {
    const panel = node.querySelector(selector), s = globalThis.getComputedStyle(panel); return { background: s.backgroundColor, opacity: s.opacity };
  }));
  assert.deepEqual(panels.map(item => item.background), ['rgb(18, 52, 86)', 'rgb(48, 64, 80)', 'rgb(80, 96, 112)']);
  assert.ok(panels.every(item => item.opacity === '1'));
  await appearanceRoute();
  await page.getByRole('radio', { name: '深色', exact: true }).click();
  assert.notEqual(await page.locator('[data-appearance-panel=left]').evaluate(node => globalThis.getComputedStyle(node).backgroundColor), 'rgb(18, 52, 86)');
  await page.getByRole('radio', { name: '浅色', exact: true }).click();
  await openDetail('三栏与消息外观');
  await page.getByRole('button', { name: '恢复此模式的面板与气泡', exact: true }).click();
  await page.getByLabel('伙伴的气泡自定义底色', { exact: true }).check();
  await color('伙伴的气泡颜色', '#dfe9dd');
  await page.getByRole('slider', { name: '伙伴的气泡背景不透明度', exact: true }).press('End');
  await page.getByLabel('自定义气泡圆角', { exact: true }).check();
  await page.getByRole('slider', { name: '气泡圆角', exact: true }).press('End');
  assert.equal(await page.locator('.appearance-preview .message-bubble').evaluate(node => globalThis.getComputedStyle(node).borderRadius), '32px');
  assert.equal(await page.locator('.appearance-preview .message-bubble').evaluate(node => globalThis.getComputedStyle(node).backgroundColor), 'rgb(223, 233, 221)');
  result.cases.push('custom-panels-independent-background-alpha-blur-modes-and-bubble-preview');
  await openDetail('自定义背景');
  await page.getByLabel('背景图片文件', { exact: true }).setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('<svg></svg>') });
  await page.getByText('请选择 PNG、JPEG 或 WebP 图片。', { exact: true }).waitFor();
  await page.getByLabel('背景图片文件', { exact: true }).setInputFiles(path.join(root, 'src', 'renderer', 'assets', 'sea-letter-light.png'));
  await until(() => page.evaluate(() => globalThis.document.documentElement.style.getPropertyValue('--appearance-wallpaper').includes('blob:')), 'local wallpaper loaded');
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.appearance.v1')).customization.light.background.imageId);
  const wallpaperDecoded = await page.evaluate(async () => {
    const style = globalThis.getComputedStyle(globalThis.document.body, '::before').backgroundImage;
    const src = /url\(["']?([^"')]+)["']?\)/.exec(style)?.[1];
    const image = new globalThis.Image(); image.src = src; await image.decode(); return [image.naturalWidth, image.naturalHeight];
  }); assert.deepEqual(wallpaperDecoded, [1672, 941]);
  await page.getByRole('radio', { name: '深色', exact: true }).click();
  await page.getByLabel('背景图片文件', { exact: true }).setInputFiles(path.join(root, 'src', 'renderer', 'assets', 'sea-letter-dark.png'));
  await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('asterium.appearance.v1')).customization.dark.background.imageId !== null), 'independent dark wallpaper saved');
  const darkId = await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.appearance.v1')).customization.dark.background.imageId); assert.notEqual(darkId, id);
  await page.getByRole('radio', { name: '浅色', exact: true }).click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.appearance.v1')).customization.light.background.imageId), id);
  await page.getByRole('slider', { name: '背景模糊', exact: true }).press('End');
  await page.getByRole('slider', { name: '背景遮罩不透明度', exact: true }).press('End');
  await page.getByRole('slider', { name: '背景遮罩不透明度', exact: true }).press('Home');
  await page.getByLabel('图片适配', { exact: true }).selectOption('contain');
  assert.ok(await page.evaluate(() => { const s = globalThis.getComputedStyle(globalThis.document.body, '::before'); return Number.parseFloat(s.width) === globalThis.innerWidth && Number.parseFloat(s.height) === globalThis.innerHeight; }), 'Contain backdrop should use the exact viewport without offscreen cropping');
  await page.screenshot({ path: path.join(evidence, 'custom-background-settings.png') });
  result.cases.push('custom-background-import-validation-real-decode-fit-blur-and-overlay');
  await application.close(); application = undefined; await launch(); await appearanceRoute();
  await until(() => page.evaluate(() => globalThis.document.documentElement.style.getPropertyValue('--appearance-wallpaper').includes('blob:')), 'wallpaper restored from IndexedDB');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.appearance.v1')).customization.light.background.imageId), id);
  result.cases.push('custom-background-survives-process-restart');
  await openDetail('自定义 CSS');
  await page.getByLabel('自定义 CSS', { exact: true }).fill('.message-bubble { outline:3px solid rgb(80, 110, 90) !important; }');
  assert.equal(await page.locator('.appearance-preview .message-bubble').evaluate(node => globalThis.getComputedStyle(node).outlineStyle), 'none');
  await page.getByRole('button', { name: '应用 CSS', exact: true }).click();
  assert.equal(await page.locator('.appearance-preview .message-bubble').evaluate(node => globalThis.getComputedStyle(node).outlineWidth), '3px');
  await page.getByLabel('自定义 CSS', { exact: true }).fill('.x { background: url(https://example.test/a.png); }');
  await page.getByRole('button', { name: '应用 CSS', exact: true }).click();
  await page.getByText('CSS 不支持外部导入或图片地址；背景请使用图片导入。', { exact: true }).waitFor();
  assert.equal(await page.locator('.appearance-preview .message-bubble').evaluate(node => globalThis.getComputedStyle(node).outlineWidth), '3px');
  result.cases.push('custom-css-explicit-apply-and-resource-validation');
  await openDetail('导入与导出');
  const bundlePath = path.join(temporary, 'theme.json');
  await application.evaluate(({ BrowserWindow }, bundlePath) => {
    globalThis.appearanceDownload = 'waiting';
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(bundlePath);
      item.once('done', (_event, state) => { globalThis.appearanceDownload = state; });
    });
  }, bundlePath);
  await page.getByRole('button', { name: '导出外观', exact: true }).click();
  await until(() => application.evaluate(() => globalThis.appearanceDownload === 'completed'), 'native theme export download');
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  assert.equal(bundle.format, 'asterium-appearance'); assert.ok(bundle.images[id].startsWith('data:image/png;base64,')); assert.ok(bundle.images[darkId].startsWith('data:image/png;base64,')); assert.equal(Object.keys(bundle.images).length, 2);
  assert.equal(bundle.settings.customization.cssEnabled, true);
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await openDetail('导入与导出');
  await page.getByLabel('外观配置文件', { exact: true }).setInputFiles(bundlePath);
  await page.getByRole('button', { name: '导入并应用', exact: true }).click();
  await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('asterium.appearance.v1')).customization.light.background.imageId !== null), 'bundle applied');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.appearance.v1')).customization.cssEnabled), false);
  assert.equal(await page.locator('.appearance-preview .message-bubble').evaluate(node => globalThis.getComputedStyle(node).outlineStyle), 'none');
  const savedBeforeInvalid = await page.evaluate(() => localStorage.getItem('asterium.appearance.v1'));
  await page.getByLabel('外观配置文件', { exact: true }).setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"other"}') });
  await page.getByText('主题包格式或版本不支持。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('asterium.appearance.v1')), savedBeforeInvalid);
  const invalidHash = structuredClone(bundle);
  invalidHash.settings.customization.light.background.imageId = 'a'.repeat(64);
  invalidHash.images = { ['a'.repeat(64)]: bundle.images[id] };
  await page.getByLabel('外观配置文件', { exact: true }).setInputFiles({ name: 'bad-hash.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalidHash)) });
  await page.getByText('主题包的背景校验失败。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('asterium.appearance.v1')), savedBeforeInvalid);
  await page.getByRole('button', { name: '清理未使用的背景图片', exact: true }).click();
  await page.getByText('未使用的背景图片已清理，当前深浅背景保留。', { exact: true }).waitFor();
  const storedImageCount = await page.evaluate(async id => {
    const db = await new Promise((resolve, reject) => { const r = globalThis.indexedDB.open('asterium-appearance-images', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const found = await new Promise((resolve, reject) => { const tx = db.transaction('images', 'readonly'), r = tx.objectStore('images').get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close(); return Boolean(found);
  }, id); assert.ok(storedImageCount);
  result.cases.push('custom-portable-theme-export-import-with-images-hash-validation-cleanup-and-disabled-css');
  await openDetail('自定义 CSS');
  await page.getByLabel('自定义 CSS', { exact: true }).fill('body { display:none !important; }');
  await page.getByRole('button', { name: '应用 CSS', exact: true }).click();
  await until(() => page.evaluate(() => globalThis.getComputedStyle(globalThis.document.body).display === 'none'), 'UI hidden by user CSS');
  await page.evaluate(() => { globalThis.location.hash = '#/settings/partners'; });
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'F12', modifiers: ['control', 'shift'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'F12', modifiers: ['control', 'shift'] });
  });
  await until(() => page.evaluate(() => globalThis.getComputedStyle(globalThis.document.body).display !== 'none'), 'native emergency appearance recovery');
  await page.getByRole('heading', { name: '外观', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.appearance.v1')).customization.cssEnabled), false);
  await page.screenshot({ path: path.join(evidence, 'custom-native-recovery.png') });
  result.cases.push('custom-native-recovery-shortcut-restores-hidden-ui');
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1180, 760); });
  await page.waitForFunction(() => globalThis.innerWidth === 1180);
  await openDetail('自定义背景'); await openDetail('三栏与消息外观'); await openDetail('自定义 CSS');
  assert.ok(await page.locator('.appearance-settings').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await page.getByLabel('自定义 CSS', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, 'custom-narrow-settings.png') });
  result.cases.push('custom-expanded-controls-minimum-window-no-horizontal-overflow');
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();


  await page.evaluate(() => { globalThis.location.hash = '#/settings/partners?section=automations'; });
  await page.getByRole('heading', { name: '自动化', exact: true }).waitFor();
  await page.getByRole('button', { name: '新建自动化', exact: true }).click();
  await page.getByLabel('自动化名称', { exact: true }).fill('隔离自动化验收');
  await page.getByLabel('自动化任务内容', { exact: true }).fill('只整理隔离工作区并汇报，不读取其他目录。');
  await page.getByLabel('自动化时区', { exact: true }).fill('Asia/Shanghai');
  await page.getByRole('button', { name: '保存自动化', exact: true }).click();
  await page.getByRole('heading', { name: '隔离自动化验收' }).waitFor();
  let automationView = await page.evaluate(() => globalThis.asteriumAutomations.get());
  assert.equal(automationView.automations.filter(d => !d.deletedAt).length, 1);
  assert.equal(automationView.automations[0].instructions, '只整理隔离工作区并汇报，不读取其他目录。');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await until(() => page.evaluate(async () => !(await globalThis.asteriumAutomations.get()).automations[0].enabled), 'automation paused');
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await page.reload();
  await page.getByRole('heading', { name: '自动化', exact: true }).waitFor();
  await page.getByRole('heading', { name: '隔离自动化验收' }).waitFor();
  automationView = await page.evaluate(() => globalThis.asteriumAutomations.get()); assert.equal(automationView.automations[0].enabled, true);
  await page.screenshot({ path: path.join(evidence, 'automations-management-narrow.png') });
  result.cases.push('automation-management-custom-create-pause-resume-reload-and-narrow');
  await application.evaluate(() => {
    globalThis.__automationRequests = [];
    globalThis.__automationSteps = [{ text: '自动化原线程验收已完成。' }, { text: '自动化原线程验收已完成。' }];
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://api.deepseek.com/chat/completions') throw new Error('Offline acceptance forbids network requests');
      const body = JSON.parse(init.body); globalThis.__automationRequests.push(body);
      const step = globalThis.__automationSteps.shift(); if (!step) throw Error('Automation fixture exhausted');
      if (step.tool && !body.tools?.some(t => t.function.name === step.tool)) throw Error(`Missing automation tool: ${step.tool}`);
      const delta = step.tool ? { tool_calls: [{ index: 0, id: `auto-fixture-${globalThis.__automationRequests.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] } : { content: step.text };
      const chunks = [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: step.tool ? 'tool_calls' : 'stop' }] }];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  const singleAutomation = automationView.automations[0];
  assert.equal(singleAutomation.target.roomId, undefined);
  await page.getByRole('button', { name: '立即运行', exact: true }).click();
  await until(async () => {
    const { runs } = await page.evaluate(() => globalThis.asteriumAutomations.get());
    if (runs.some(r => ['failed', 'uncertain'].includes(r.state))) throw new Error(JSON.stringify(runs));
    return runs.some(r => r.state === 'succeeded');
  }, 'single automation execution');
  let executed = await page.evaluate(() => globalThis.asteriumAutomations.get());
  assert.equal(executed.runs[0].definition.target.nativeThreadId, singleAutomation.target.nativeThreadId);
  assert.equal(executed.runs[0].summary, '自动化原线程验收已完成。');
  assert.equal(executed.runs[0].events.find(e => e.type === 'session.bound').isNew, false);
  await page.evaluate(() => { globalThis.location.hash = '#/chat'; });
  await page.getByText('自动化原线程验收已完成。', { exact: true }).waitFor();
  assert.equal(await page.locator('.message-user').getByText(/星丛自动化任务/).count(), 0);
  await page.reload();
  await page.getByText('自动化原线程验收已完成。', { exact: true }).waitFor();
  result.cases.push('automation-single-native-thread-background-reply-reload-no-fake-user');
  const groupAutomationId = await page.evaluate(async ({ roomId }) => {
    const view = await globalThis.asteriumAutomations.get();
    const target = view.targets.find(t => t.target.roomId === roomId && t.available);
    if (!target) throw new Error(`No group automation target: ${JSON.stringify(view.targets)}`);
    const next = await globalThis.asteriumAutomations.mutate({ action: 'create', requestId: 'browser-group-automation', input: {
      name: '群聊自动化验收', instructions: '只汇报隔离群聊状态。', target: target.target, schedule: { type: 'daily', time: '23:59' }, timezone: 'Asia/Shanghai', enabled: false,
    } });
    const definition = next.automations.find(d => d.name === '群聊自动化验收');
    await globalThis.asteriumAutomations.mutate({ action: 'run_now', id: definition.id, requestId: 'browser-group-run' });
    return definition.id;
  }, { roomId });
  await until(async () => {
    const { runs } = await page.evaluate(() => globalThis.asteriumAutomations.get());
    const run = runs.find(r => r.automationId === groupAutomationId);
    if (run && ['failed', 'uncertain'].includes(run.state)) throw new Error(JSON.stringify(run));
    return run?.state === 'succeeded';
  }, 'group automation execution');
  executed = await page.evaluate(() => globalThis.asteriumAutomations.get());
  const groupRun = executed.runs.find(r => r.automationId === groupAutomationId);
  const groupSnapshot = await page.evaluate(id => globalThis.asteriumStudio.getRoom(id), roomId);
  assert.equal(groupSnapshot.messages.find(m => m.messageId === `automation-trigger:${groupRun.id}`).authorType, 'system');
  assert.equal(new Set(groupSnapshot.messages.map(m => m.messageId)).size, groupSnapshot.messages.length);
  assert.equal(groupSnapshot.messages.find(m => m.messageId === `automation:${groupRun.id}`).automation.runId, groupRun.id);
  assert.equal(groupRun.events.find(e => e.type === 'session.bound').isNew, false);
  assert.equal((await application.evaluate(() => globalThis.__automationRequests)).length, 2);
  result.cases.push('automation-group-original-thread-system-source-and-single-target');
  await page.evaluate(id => globalThis.asteriumProjects.setExecutionPolicy({ projectId: id, permissionMode: 'manual' }), projectId);
  await application.evaluate(() => { globalThis.__automationSteps = [{ tool: 'run_command', args: { command: 'node --version' } }, { text: '审批后完成隔离检查。' }]; });
  await page.evaluate(id => globalThis.asteriumAutomations.mutate({ action: 'run_now', id, requestId: 'browser-group-approval' }), groupAutomationId);
  await page.evaluate(() => { globalThis.location.hash = '#/studio/discussion'; });
  await page.getByRole('button', { name: '允许一次', exact: true }).waitFor();
  const waitingRuns = (await page.evaluate(() => globalThis.asteriumAutomations.get())).runs;
  assert.ok(waitingRuns.some(r => r.state === 'waiting_approval'));
  await page.getByRole('button', { name: '允许一次', exact: true }).click();
  await until(async () => (await page.evaluate(() => globalThis.asteriumAutomations.get())).runs.filter(r => r.automationId === groupAutomationId && r.state === 'succeeded').length === 2, 'group automation approval completion');
  result.cases.push('automation-group-existing-visible-approval-preserved');
  await application.evaluate(() => {
    globalThis.__automationSteps = [
      { tool: 'asterium_automation', args: { action: 'create', requestId: 'browser-agent-create', name: '伙伴创建验收', instructions: '只检查隔离目录并汇报。\n' + '合成的长内容验收：保留原有审批，不修改其他目录。\n'.repeat(24), schedule: { type: 'daily', time: '10:00' }, timezone: 'Asia/Shanghai', notifications: 'changes_or_failure' } },
      { text: '已在你确认后保存自动化。' },
    ];
  });
  await page.evaluate(() => { const state = JSON.parse(localStorage.getItem('asterium.prototype.v7')); state.conversations.find(c => c.id === state.activeConversationId).permissionMode = 'manual'; localStorage.setItem('asterium.prototype.v7', JSON.stringify(state)); });
  await page.reload();
  await page.evaluate(() => { globalThis.location.hash = '#/chat'; });
  const automationComposer = page.locator('.composer');
  await automationComposer.locator('textarea').fill('请每天十点检查隔离目录并汇报，创建一个自动化。');
  await automationComposer.getByRole('button', { name: '发送', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '保存这项自动化？' }); await confirmation.waitFor();
  assert.ok((await page.evaluate(() => globalThis.asteriumAutomations.confirmations())).some(c => c.task.name === '伙伴创建验收'));
  assert.equal((await page.evaluate(() => globalThis.asteriumAutomations.get())).automations.some(d => d.name === '伙伴创建验收'), false);
  await confirmation.getByText('当前发起权限需要确认计划变更；完整权限下由伙伴直接保存。执行时沿用原会话权限与保护规则。', { exact: true }).waitFor();
  assert.equal(await confirmation.getByRole('button', { name: '取消', exact: true }).evaluate(node => node === globalThis.document.activeElement), true);
  assert.ok(await confirmation.locator('.automation-confirm-body').evaluate(node => node.scrollHeight > node.clientHeight));
  await page.screenshot({ path: path.join(evidence, 'automation-confirmation-light.png') });
  const firstDialogBackground = await confirmation.evaluate(node => globalThis.getComputedStyle(node).backgroundColor);
  await page.evaluate(() => globalThis.document.querySelector('.header-actions button[title^="切换到"]').click());
  await until(async () => await confirmation.evaluate(node => globalThis.getComputedStyle(node).backgroundColor) !== firstDialogBackground, 'confirmation theme follows application');
  await page.screenshot({ path: path.join(evidence, 'automation-confirmation-dark.png') });
  await page.reload(); await confirmation.waitFor();
  await confirmation.getByRole('button', { name: '确认保存', exact: true }).click();
  await page.getByText('已在你确认后保存自动化。', { exact: true }).waitFor();
  const agentCreated = (await page.evaluate(() => globalThis.asteriumAutomations.get())).automations.find(d => d.name === '伙伴创建验收'); assert.ok(agentCreated);
  await application.evaluate(() => { globalThis.__automationSteps = [{ tool: 'asterium_automation', args: { action: 'report', changed: false } }, { text: '本次检查确认没有变化。' }]; });
  await page.evaluate(id => globalThis.asteriumAutomations.mutate({ action: 'run_now', id, requestId: 'browser-no-change' }), agentCreated.id);
  await until(async () => (await page.evaluate(() => globalThis.asteriumAutomations.get())).runs.some(r => r.automationId === agentCreated.id && r.state === 'succeeded' && r.changed === false), 'automation change report');
  result.cases.push('automation-agent-manual-permission-themed-confirmation-reload-scroll-and-change-report');
  await page.evaluate(() => { const state = JSON.parse(localStorage.getItem('asterium.prototype.v7')); state.conversations.find(c => c.id === state.activeConversationId).permissionMode = 'full'; localStorage.setItem('asterium.prototype.v7', JSON.stringify(state)); });
  await page.reload();
  await application.evaluate(() => { globalThis.__automationSteps = [
    { tool: 'asterium_automation', args: { action: 'create', requestId: 'browser-agent-full-create', name: '完整权限免确认', instructions: '只回复验收完成。', schedule: { type: 'daily', time: '10:00' }, timezone: 'Asia/Shanghai' } },
    { text: '完整权限已直接保存自动化。' },
  ]; });
  await automationComposer.locator('textarea').fill('请在完整权限下创建每天十点的只回复测试任务。');
  await automationComposer.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('完整权限已直接保存自动化。', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => globalThis.asteriumAutomations.confirmations())).length, 0);
  assert.ok((await page.evaluate(() => globalThis.asteriumAutomations.get())).automations.some(d => d.name === '完整权限免确认'));
  result.cases.push('automation-agent-full-permission-creates-without-confirmation');
  const chatMenu = page.getByRole('navigation', { name: '单聊工具', exact: true });
  await chatMenu.getByRole('button', { name: '自动化', exact: true }).click(); await page.getByRole('heading', { name: '自动化', exact: true }).waitFor();
  assert.ok(page.url().includes('conversation='));
  await page.evaluate(() => { globalThis.location.hash = '#/chat'; });
  await chatMenu.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('dialog', { name: '插件', exact: true }).getByRole('button', { name: '管理 MCP', exact: true }).click();
  assert.ok(page.url().includes('section=mcp'));
  await page.evaluate(() => { globalThis.location.hash = '#/studio/discussion'; });
  const studioMenu = page.getByRole('navigation', { name: '工作室菜单', exact: true });
  assert.deepEqual(await studioMenu.getByRole('button').allTextContents(), ['新建项目', '插件', '自动化']);
  await studioMenu.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('dialog', { name: '插件', exact: true }).getByRole('button', { name: '管理 Skills', exact: true }).click();
  assert.ok(page.url().includes('section=skills'));
  await page.evaluate(() => { globalThis.location.hash = '#/studio/discussion'; });
  await page.screenshot({ path: path.join(evidence, 'studio-new-sidebar-entries.png') });
  await studioMenu.getByRole('button', { name: '自动化', exact: true }).click(); await page.getByRole('heading', { name: '自动化', exact: true }).waitFor();
  assert.ok(page.url().includes(`room=${roomId}`));
  result.cases.push('chat-and-studio-sidebar-plugins-and-contextual-automations');
  assert.deepEqual(result.rendererErrors ?? [], []); result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = String(error?.stack ?? error); if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => undefined); throw error; }
finally {
  await application?.close().catch(() => undefined);
  const resolved = await realpath(temporary); assert.equal(path.dirname(resolved).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase()); assert.ok(path.basename(resolved).startsWith('asterium-browser-smoke-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
