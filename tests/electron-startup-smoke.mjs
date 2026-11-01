import { createServer } from 'vite';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const executable = process.env.ASTERIUM_PACKAGED_EXE
  ?? path.join(root, 'out', 'Asterium-win32-x64', 'Asterium.exe');
const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'asterium-startup-smoke-'));
const claudeWorkspace = path.join(userDataDirectory, 'claude-workspace');
const projectWorkspace = path.join(userDataDirectory, 'project-workspace');
const protectedRoot = path.join(userDataDirectory, 'AsteriumData');
const protectedCanary = path.join(protectedRoot, 'permission-smoke-canary.txt');
const claudeGrantId = 'workspace-claude-smoke';
const codexExecutable = process.env.ASTERIUM_CODEX_LIVE_SMOKE === '1'
  ? (process.env.ASTERIUM_CODEX_EXE ?? execFileSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean))
  : undefined;
const codexRuntimeId = codexExecutable
  ? `codex-runtime-${createHash('sha256').update(path.resolve(codexExecutable).toLowerCase()).digest('hex').slice(0, 16)}`
  : undefined;
await Promise.all([
  mkdir(claudeWorkspace, { recursive: true }),
  mkdir(path.join(projectWorkspace, 'deliverables'), { recursive: true }),
  mkdir(protectedRoot, { recursive: true }),
]);
await writeFile(protectedCanary, 'ASTERIUM_PROTECTED_ORIGINAL', 'utf8');
await writeFile(path.join(userDataDirectory, 'workspace-grants.v1.json'), JSON.stringify({
  version: 1,
  grants: { [claudeGrantId]: claudeWorkspace },
}), 'utf8');
await writeFile(path.join(userDataDirectory, 'project-workspaces.v1.json'), JSON.stringify({
  version: 1,
  projects: [{
    version: 1,
    projectId: 'project-home',
    name: '示例项目 A',
    rootPath: projectWorkspace,
    deliverablesPath: path.join(projectWorkspace, 'deliverables'),
    templateFiles: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }],
}), 'utf8');

const fixtureLoader = await createServer({ configFile: 'vite.renderer.config.ts', server: { middlewareMode: true } });
let fixtureState;
try { const module = await fixtureLoader.ssrLoadModule(path.resolve('tests/fixtures/applicationState.ts')); fixtureState = module.createTestState(); }
finally { await fixtureLoader.close(); }

let stderr = '';
let rendererDiagnostic = '';
let port = await reservePort();
let child = launchApp(port);

try {
  await waitForDebugger(port, child);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const page = await waitForAsteriumPage(browser);
    await page.waitForLoadState('domcontentloaded');
    await page.getByLabel('主要页面').waitFor({ state: 'visible' });
    const initial = await page.evaluate(() => JSON.parse(localStorage.getItem('asterium.prototype.v7')));
    if (initial.partners.length || initial.conversations.length) throw new Error('Fresh application must not contain preloaded partners or chats');
    await page.evaluate(state => localStorage.setItem('asterium.prototype.v7', JSON.stringify(state)), fixtureState);
    await page.reload();
    await page.getByLabel('主要页面').waitFor({ state: 'visible' });
    const fallbackDefaults = await page.evaluate(async () => globalThis.asteriumMemoryFallback?.get());
    if (!fallbackDefaults || fallbackDefaults.settings.intervalMinutes !== 20 || fallbackDefaults.settings.credentialConfigured
      || Object.keys(fallbackDefaults.settings.partners).length !== 0 || JSON.stringify(fallbackDefaults).includes('apiKey')) {
      throw new Error('Memory fallback bridge/default-off isolation check failed');
    }
    const diaryDefaults = await page.evaluate(async () => globalThis.asteriumPartnerDiary?.get());
    if (!diaryDefaults || diaryDefaults.configs.length || diaryDefaults.entries.length) throw new Error('Diary bridge/default-off check failed');
    if (process.env.ASTERIUM_DIARY_LAYOUT_SMOKE === '1') {
      const opener = page.getByRole('button', { name: '打开测试伙伴 A的日记本' });
      await opener.click();
      await page.getByRole('dialog', { name: '测试伙伴 A的日记本' }).waitFor({ state: 'visible' });
      if (await page.getByLabel('主要页面').getByRole('button').count() !== 2) throw new Error('Diary must not be a top-level navigation tab');
      await page.locator('.diary-config > summary').click();
      if (await page.getByLabel('开启伙伴日记').isChecked()) throw new Error('Diary must be disabled by default');
      const spacing = await page.locator('.diary-config .memory-fallback-content').evaluate((content) => {
        const box = content.parentElement.getBoundingClientRect();
        const controls = [...content.querySelectorAll('input, select, button')].map((node) => node.getBoundingClientRect());
        return { left: Math.min(...controls.map((rect) => rect.left - box.left)), right: Math.min(...controls.map((rect) => box.right - rect.right)), bottom: box.bottom - Math.max(...controls.map((rect) => rect.bottom)) };
      });
      if (spacing.left < 16 || spacing.right < 16 || spacing.bottom < 16) throw new Error(`Diary layout regression: ${JSON.stringify(spacing)}`);
      await page.locator('.diary-modal-host .modal-card').screenshot({ path: path.join(os.tmpdir(), 'asterium-diary-layout.png') });
      console.log(JSON.stringify({ diaryLayout: spacing }));
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      if (!await opener.evaluate((button) => globalThis.document.activeElement === button)) throw new Error('Diary opener focus was not restored');
    }
    if (process.env.ASTERIUM_MEMORY_LAYOUT_SMOKE === '1') {
      await page.evaluate(() => { globalThis.location.hash = '/settings/partners'; });
      await page.getByRole('button', { name: '记忆管理', exact: true }).click();
      await page.locator('summary', { hasText: '星丛记忆兜底' }).click();
      await page.getByLabel('兜底模型', { exact: true }).waitFor({ state: 'visible' });
      const spacing = await page.locator('.memory-fallback-content').evaluate((content) => {
        const card = content.parentElement.getBoundingClientRect();
        const controls = [...content.querySelectorAll('input, select, button')].map((node) => node.getBoundingClientRect());
        const model = content.querySelector('[aria-label="兜底模型"]');
        const endpoint = content.querySelector('[aria-label="兜底 API 地址"]');
        return { left: Math.min(...controls.map((rect) => rect.left - card.left)), right: Math.min(...controls.map((rect) => card.right - rect.right)), bottom: card.bottom - Math.max(...controls.map((rect) => rect.bottom)), modelTag: model.tagName, firstRowAligned: Math.abs(model.getBoundingClientRect().top - endpoint.getBoundingClientRect().top) <= 1 };
      });
      if (spacing.left < 16 || spacing.right < 16 || spacing.bottom < 16 || spacing.modelTag !== 'SELECT' || !spacing.firstRowAligned) throw new Error(`Memory fallback layout regression: ${JSON.stringify(spacing)}`);
      await page.locator('.memory-content-panel').screenshot({ path: path.join(os.tmpdir(), 'asterium-memory-fallback-layout.png') });
      console.log(JSON.stringify({ memoryFallbackLayout: spacing }));
      await page.evaluate(() => { globalThis.location.hash = '/chat'; });
      await page.getByLabel('主要页面').waitFor({ state: 'visible' });
    }
    await page.evaluate(({ workspace, grantId, runtimeId }) => {
      const state = JSON.parse(globalThis.localStorage.getItem('asterium.prototype.v7'));
      const partner = state.partners.find((item) => item.id === 'fixture-local-b');
      partner.isPrototype = false;
      partner.connectionKind = 'local_claude';
      partner.connectionLabel = '本机 Claude Code';
      partner.partnerRootKind = 'imported';
      partner.partnerRoot = workspace;
      partner.partnerRootGrantId = grantId;
      const conversation = state.conversations.find((item) => item.id === 'conversation-b-1');
      conversation.partnerRootKind = 'imported';
      conversation.partnerRoot = workspace;
      conversation.partnerRootGrantId = grantId;
      conversation.messages = [];
      delete conversation.sessionId;
      delete conversation.nativeThreadState;
      delete conversation.nativeThreadStateCheckedAt;
      delete conversation.nativeThreadNotice;
      if (runtimeId) {
        const codexPartner = state.partners.find((item) => item.id === 'fixture-local-a');
        codexPartner.isPrototype = false;
        codexPartner.location = 'local';
        codexPartner.connectionKind = 'local_codex';
        codexPartner.connectionLabel = '本机 Codex';
        codexPartner.codexRuntimeId = runtimeId;
        codexPartner.partnerRootKind = 'imported';
        codexPartner.partnerRoot = workspace;
        codexPartner.partnerRootGrantId = grantId;
        const codexConversation = state.conversations.find((item) => item.id === 'conversation-a-1');
        codexConversation.partnerRootKind = 'imported';
        codexConversation.partnerRoot = workspace;
        codexConversation.partnerRootGrantId = grantId;
        codexConversation.messages = [];
        delete codexConversation.sessionId;
        delete codexConversation.nativeThreadState;
        delete codexConversation.nativeThreadStateCheckedAt;
        delete codexConversation.nativeThreadNotice;
      }
      globalThis.localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
    }, { workspace: claudeWorkspace, grantId: claudeGrantId, runtimeId: codexRuntimeId });
    await page.reload({ waitUntil: 'domcontentloaded' });

    const claudePartner = page.getByRole('button', { name: '展开 测试伙伴 B 的对话' });
    await claudePartner.click();
    const claudeConversation = page.getByText('交互复核', { exact: true });
    await claudeConversation.click();
    await page.getByPlaceholder(/给 测试伙伴 B 发送消息/).waitFor({ state: 'visible' });
    const permissionControl = page.getByRole('button', { name: '权限模式：手动审批' });

    let claudeLiveReply = false;
    let claudeApprovalCompleted = false;
    let claudeReadOnlyBlockedWrite = false;
    let claudeFullPermissionWrite = false;
    let claudeProtectedCommandBlocked = false;
    let codexLiveReply = false;
    let codexApprovalCompleted = false;
    let codexStatusToolCompleted = false;
    let codexReadOnlyBlockedWrite = false;
    let codexFullPermissionWrite = false;
    let codexProtectedCommandBlocked = false;
    let permissionRecoveryCompleted = false;
    let projectDomainRecoveryCompleted = false;
    let taskExecutionRecoveryCompleted = false;
    if (process.env.ASTERIUM_CLAUDE_LIVE_SMOKE === '1') {
      await permissionControl.click({ trial: true, timeout: 10_000 });
      const input = page.getByPlaceholder(/给 测试伙伴 B 发送消息/);
      const manualFile = path.join(claudeWorkspace, 'asterium-claude-manual-smoke.txt');
      await input.fill(`请使用 Write 文件工具在 ${manualFile} 创建文件，内容只能是 ASTERIUM_CLAUDE_MANUAL_OK。需要审批时发起审批。完成后只回复 ASTERIUM_CLAUDE_OK。`);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByRole('button', { name: '允许一次', exact: true }).waitFor({ state: 'visible', timeout: 90_000 }).catch(async (error) => {
        rendererDiagnostic = `Claude manual renderer:\n${(await page.locator('body').innerText()).slice(-8_000)}`;
        throw error;
      });
      await page.getByRole('button', { name: '允许一次', exact: true }).click();
      await page.locator('.message-row:not(.message-row--mine) .turn-text-segment', { hasText: 'ASTERIUM_CLAUDE_OK' }).last().waitFor({ state: 'visible', timeout: 90_000 });
      claudeLiveReply = true;
      claudeApprovalCompleted = await waitForFileContent(manualFile, 'ASTERIUM_CLAUDE_MANUAL_OK', 60_000);
      if (!claudeApprovalCompleted) throw new Error('Claude approval completed without the expected file contents');

      await selectPermissionMode(page, '手动审批', '只读');
      const readOnlyFile = path.join(claudeWorkspace, 'asterium-claude-readonly-smoke.txt');
      await input.fill(`请尝试使用 Write 文件工具在 ${readOnlyFile} 创建文件，内容为 SHOULD_NOT_EXIST。无论工具是否被拒绝，最后只回复 ASTERIUM_CLAUDE_READONLY_DONE。`);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.locator('.message-row:not(.message-row--mine) .turn-text-segment', { hasText: 'ASTERIUM_CLAUDE_READONLY_DONE' }).last().waitFor({ state: 'visible', timeout: 90_000 });
      claudeReadOnlyBlockedWrite = !(await fileExists(readOnlyFile));
      if (!claudeReadOnlyBlockedWrite) throw new Error('Claude read-only mode allowed a workspace write');

      await selectPermissionMode(page, '只读', '完整权限');
      const fullFile = path.join(userDataDirectory, 'asterium-claude-full-smoke.txt');
      await input.fill(`请直接使用 Write 文件工具在 ${fullFile} 创建文件，内容只能是 ASTERIUM_CLAUDE_FULL_OK；不要请求用户确认。完成后只回复 ASTERIUM_CLAUDE_FULL_DONE。`);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      claudeFullPermissionWrite = await waitForFileContent(fullFile, 'ASTERIUM_CLAUDE_FULL_OK', 90_000);
      if (!claudeFullPermissionWrite) throw new Error('Claude full permission mode did not write outside the workspace');
      await waitForComposerReady(page, input, 90_000);

      await input.fill(`请使用 Bash 或 PowerShell 执行命令，尝试把 ${protectedCanary} 覆盖为 MUTATED。路径必须在命令中原样写出。工具被拒绝后只回复 ASTERIUM_CLAUDE_PROTECTED_DONE。`);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await waitForComposerReady(page, input, 90_000);
      claudeProtectedCommandBlocked = (await readFile(protectedCanary, 'utf8')).trim() === 'ASTERIUM_PROTECTED_ORIGINAL';
      if (!claudeProtectedCommandBlocked) throw new Error('Claude full mode changed the protected AsteriumData canary');
    }

    if (process.env.ASTERIUM_CODEX_LIVE_SMOKE === '1') {
      const codexGroup = page.getByRole('button', { name: /^(展开|收起) 测试伙伴 A 的对话$/ });
      if ((await codexGroup.getAttribute('aria-expanded')) !== 'true') await codexGroup.click();
      await page.getByText('测试对话', { exact: true }).click();
      const input = page.getByPlaceholder(/给 测试伙伴 A 发送消息/);
      await input.fill('请调用 asterium_status，key 使用 permissions。只有当返回的 permissionMode 是 manual 时，才只回复 ASTERIUM_CODEX_STATUS_OK。');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.locator('.message-row:not(.message-row--mine) .turn-text-segment', { hasText: 'ASTERIUM_CODEX_STATUS_OK' }).last().waitFor({ state: 'visible', timeout: 90_000 });
      codexStatusToolCompleted = true;

      const outsideFile = path.join(userDataDirectory, 'asterium-codex-approval-smoke.txt');
      await input.fill(`请在 ${outsideFile} 创建文件，内容只能是 ASTERIUM_CODEX_APPROVAL_OK。这个路径在当前工作区之外，需要时请发起原生权限审批。完成后只回复 ASTERIUM_CODEX_OK。`);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      const allow = page.getByRole('button', { name: '允许一次', exact: true });
      await allow.waitFor({ state: 'visible', timeout: 90_000 });
      const approvalSummary = await allow.locator('xpath=ancestor::section[contains(@class,"timeline-authorization-card")]').innerText();
      codexApprovalCompleted = await approveUntilFile(page, outsideFile, 'ASTERIUM_CODEX_APPROVAL_OK', 90_000);
      if (!codexApprovalCompleted) {
        rendererDiagnostic = `Codex approval:\n${approvalSummary}\n\nRenderer:\n${(await page.locator('body').innerText()).slice(-8_000)}`;
        throw new Error('Codex approval was accepted but the expected file was not created');
      }
      await page.locator('.message-row:not(.message-row--mine) .turn-text-segment', { hasText: 'ASTERIUM_CODEX_OK' }).last().waitFor({ state: 'visible', timeout: 60_000 });
      codexLiveReply = true;

      await selectPermissionMode(page, '手动审批', '只读');
      const readOnlyFile = path.join(claudeWorkspace, 'asterium-codex-readonly-smoke.txt');
      await input.fill(`请尝试在 ${readOnlyFile} 创建文件，内容为 SHOULD_NOT_EXIST。完成尝试后只回复 ASTERIUM_CODEX_READONLY_DONE。`);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.locator('.message-row:not(.message-row--mine) .turn-text-segment', { hasText: 'ASTERIUM_CODEX_READONLY_DONE' }).last().waitFor({ state: 'visible', timeout: 90_000 });
      codexReadOnlyBlockedWrite = !(await fileExists(readOnlyFile));
      if (!codexReadOnlyBlockedWrite) throw new Error('Codex read-only mode allowed a workspace write');

      await selectPermissionMode(page, '只读', '完整权限');
      const fullFile = path.join(userDataDirectory, 'asterium-codex-full-smoke.txt');
      await input.fill(`请直接在 ${fullFile} 创建文件，内容只能是 ASTERIUM_CODEX_FULL_OK。完成后只回复 ASTERIUM_CODEX_FULL_DONE。`);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      codexFullPermissionWrite = await waitForFileContent(fullFile, 'ASTERIUM_CODEX_FULL_OK', 90_000);
      if (!codexFullPermissionWrite) throw new Error('Codex full permission mode did not write outside the workspace');
      await waitForComposerReady(page, input, 90_000);

      await input.fill(`请使用 PowerShell 命令尝试把 ${protectedCanary} 覆盖为 MUTATED。路径必须在命令中原样写出。命令被拒绝后只回复 ASTERIUM_CODEX_PROTECTED_DONE。`);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await waitForComposerReady(page, input, 90_000);
      codexProtectedCommandBlocked = (await readFile(protectedCanary, 'utf8')).trim() === 'ASTERIUM_PROTECTED_ORIGINAL';
      if (!codexProtectedCommandBlocked) throw new Error('Codex full mode changed the protected AsteriumData canary');
    }

    const windowVisible = await page.evaluate(() => globalThis.document.visibilityState === 'visible');
    const title = await page.title();
    const url = page.url();
    const permissionRecoveryRequested = process.env.ASTERIUM_PERMISSION_RECOVERY_SMOKE === '1';
    const projectDomainRecoveryRequested = process.env.ASTERIUM_PROJECT_DOMAIN_RECOVERY_SMOKE === '1';
    const taskExecutionRecoveryRequested = process.env.ASTERIUM_TASK_EXECUTION_RECOVERY_SMOKE === '1';
    if (permissionRecoveryRequested || projectDomainRecoveryRequested || taskExecutionRecoveryRequested) {
      if (permissionRecoveryRequested) {
        await page.waitForFunction(() => {
          const state = JSON.parse(globalThis.localStorage.getItem('asterium.prototype.v7'));
          const conversations = state.conversations.filter((item) => item.id === 'conversation-a-1' || item.id === 'conversation-b-1');
          return conversations.length === 2 && conversations.every((item) => item.permissionMode === 'full');
        }, undefined, { timeout: 10_000 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByLabel('主要页面').waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
          const state = JSON.parse(globalThis.localStorage.getItem('asterium.prototype.v7'));
          const conversations = state.conversations.filter((item) => item.id === 'conversation-a-1' || item.id === 'conversation-b-1');
          return conversations.length === 2 && conversations.every((item) => item.permissionMode === 'full');
        }, undefined, { timeout: 10_000 });
        const saved = await page.evaluate(() => globalThis.asteriumProjects.setExecutionPolicy({ projectId: 'project-home', permissionMode: 'read_only' }));
        if (saved.permissionMode !== 'read_only') throw new Error('Project permission was not saved before restart');
      }
      let recoveryTaskId;
      let recoveryAttemptId;
      if (projectDomainRecoveryRequested) {
        recoveryTaskId = await page.evaluate(async () => {
          const snapshot = await globalThis.asteriumProjects.initializeDomain({ legacyProjects: [] });
          const project = snapshot.projects.find((item) => item.id === 'project-home');
          if (!project) throw new Error('Project domain was not initialized before restart');
          await globalThis.asteriumProjects.update({
            projectId: project.id,
            expectedRevision: project.revision,
            name: project.name,
            description: 'PROJECT_DOMAIN_RESTART_DESCRIPTION',
            status: 'paused',
            progress: 73,
            tags: ['restart-smoke'],
          });
          const task = await globalThis.asteriumProjects.createTask({
            projectId: project.id,
            title: 'PROJECT_DOMAIN_RESTART_TASK',
            description: 'persisted by packaged smoke',
            assigneeId: project.memberIds[0],
            status: 'blocked',
            dependencyIds: [],
            acceptanceCriteria: ['survives app restart'],
            note: 'restart pending',
          });
          return task.id;
        });
      }
      if (taskExecutionRecoveryRequested) {
        recoveryAttemptId = await page.evaluate(async () => {
          const snapshot = await globalThis.asteriumProjects.initializeDomain({ legacyProjects: [] });
          const task = snapshot.tasks.find((item) => item.projectId === 'project-home' && item.id === 't2');
          if (!task) throw new Error('Task execution recovery fixture is missing');
          const attempt = await globalThis.asteriumProjects.enqueueTaskAttempt({ projectId: task.projectId, taskId: task.id });
          if (attempt.status !== 'queued') throw new Error(`Unexpected queued attempt state: ${attempt.status}`);
          return attempt.id;
        });
      }
      await page.close();
      await browser.close();
      await waitForProcessExit(child, 10_000);
      if (child.exitCode === null) await stopProcessTree(child);
      if (taskExecutionRecoveryRequested) await markTaskExecutionInterrupted(userDataDirectory, recoveryAttemptId);
      port = await reservePort();
      child = launchApp(port);
      await waitForDebugger(port, child);
      const restartedBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      try {
        const restartedPage = await waitForAsteriumPage(restartedBrowser);
        await restartedPage.waitForLoadState('domcontentloaded');
        await restartedPage.getByLabel('主要页面').waitFor({ state: 'visible' });
        const recovered = await restartedPage.evaluate(async ({ checkPermission, checkProjectDomain, checkTaskExecution, taskId, attemptId }) => ({
          projectPolicy: checkPermission ? await globalThis.asteriumProjects.getExecutionPolicy('project-home') : undefined,
          conversations: checkPermission ? JSON.parse(globalThis.localStorage.getItem('asterium.prototype.v7')).conversations
            .filter((item) => item.id === 'conversation-a-1' || item.id === 'conversation-b-1')
            .map((item) => ({ id: item.id, permissionMode: item.permissionMode })) : [],
          domain: checkProjectDomain ? await globalThis.asteriumProjects.initializeDomain({ legacyProjects: [] }) : undefined,
          taskExecution: checkTaskExecution ? await globalThis.asteriumProjects.getTaskExecution('project-home') : undefined,
          taskId,
          attemptId,
        }), { checkPermission: permissionRecoveryRequested, checkProjectDomain: projectDomainRecoveryRequested, checkTaskExecution: taskExecutionRecoveryRequested, taskId: recoveryTaskId, attemptId: recoveryAttemptId });
        if (permissionRecoveryRequested) {
          permissionRecoveryCompleted = recovered.projectPolicy.permissionMode === 'read_only'
            && recovered.conversations.length === 2
            && recovered.conversations.every((item) => item.permissionMode === 'full');
          if (!permissionRecoveryCompleted) throw new Error(`Permission recovery mismatch: ${JSON.stringify(recovered)}`);
        }
        if (projectDomainRecoveryRequested) {
          const project = recovered.domain.projects.find((item) => item.id === 'project-home');
          const task = recovered.domain.tasks.find((item) => item.id === recovered.taskId);
          projectDomainRecoveryCompleted = project?.description === 'PROJECT_DOMAIN_RESTART_DESCRIPTION'
            && project.status === 'paused'
            && project.progress === 73
            && project.tags.includes('restart-smoke')
            && task?.title === 'PROJECT_DOMAIN_RESTART_TASK'
            && task.status === 'blocked'
            && task.acceptanceCriteria.includes('survives app restart');
          if (!projectDomainRecoveryCompleted) throw new Error(`Project domain recovery mismatch: ${JSON.stringify(recovered)}`);
        }
        if (taskExecutionRecoveryRequested) {
          const attempt = recovered.taskExecution.attempts.find((item) => item.id === recovered.attemptId);
          const events = recovered.taskExecution.events.filter((item) => item.attemptId === recovered.attemptId);
          taskExecutionRecoveryCompleted = attempt?.status === 'paused'
            && attempt.runtimeRunId === undefined
            && events.at(-1)?.type === 'recovered_paused';
          if (!taskExecutionRecoveryCompleted) throw new Error(`Task execution recovery mismatch: ${JSON.stringify(recovered)}`);
        }
      } finally {
        await restartedBrowser.close();
      }
    }

    const result = {
      windowVisible,
      title,
      url,
      claudeCliRuntimeLoaded: true,
      memoryFallbackBridgeVerified: true,
      diaryBridgeVerified: true,
      claudeConversationEntered: true,
      claudeLiveReply,
      claudeApprovalCompleted,
      claudeReadOnlyBlockedWrite,
      claudeFullPermissionWrite,
      claudeProtectedCommandBlocked,
      codexLiveReply,
      codexApprovalCompleted,
      codexStatusToolCompleted,
      codexReadOnlyBlockedWrite,
      codexFullPermissionWrite,
      codexProtectedCommandBlocked,
      permissionRecoveryCompleted,
      projectDomainRecoveryCompleted,
      taskExecutionRecoveryCompleted,
    };
    if (!result.windowVisible) throw new Error('Packaged Electron renderer is not visible');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  throw new Error(`${detail}${rendererDiagnostic ? `\n${rendererDiagnostic}` : ''}\nPackaged stderr:\n${stderr || '(empty)'}`, { cause: error });
} finally {
  await stopProcessTree(child);
  await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function launchApp(debugPort) {
  const processHandle = spawn(executable, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDirectory}`,
  ], {
    cwd: path.dirname(executable),
    env: { ...process.env, ASTERIUM_STARTUP_SMOKE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  processHandle.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  return processHandle;
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a debugger port');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForFileContent(filePath, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(filePath, 'utf8')).trim() === expected) return true;
    } catch {
      // The approved tool has not created the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function approveUntilFile(page, filePath, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await waitForFileContent(filePath, expected, 200)) return true;
    const buttons = page.getByRole('button', { name: '允许一次', exact: true });
    const count = await buttons.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const button = buttons.nth(index);
      if (await button.isVisible()) {
        await button.click();
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function markTaskExecutionInterrupted(userDataRoot, attemptId) {
  const filePath = path.join(userDataRoot, 'project-task-executions.v1.json');
  const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
  const attempt = snapshot.attempts.find((item) => item.id === attemptId);
  if (!attempt) throw new Error('Queued task attempt was not persisted before restart');
  const now = new Date().toISOString();
  attempt.status = 'running';
  attempt.runtimeRunId = 'simulated-interrupted-runtime';
  attempt.startedAt = now;
  attempt.updatedAt = now;
  const sequence = snapshot.events.filter((item) => item.attemptId === attemptId).reduce((max, item) => Math.max(max, item.sequence), 0);
  snapshot.events.push(
    { version: 1, id: `startup-starting-${attemptId}`, projectId: attempt.projectId, taskId: attempt.taskId, attemptId, sequence: sequence + 1, type: 'runtime_starting', occurredAt: now },
    { version: 1, id: `startup-started-${attemptId}`, projectId: attempt.projectId, taskId: attempt.taskId, attemptId, sequence: sequence + 2, type: 'runtime_started', occurredAt: now },
  );
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function selectPermissionMode(page, currentLabel, nextLabel) {
  await page.getByRole('button', { name: `权限模式：${currentLabel}` }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${nextLabel}`) }).click();
  await page.getByRole('button', { name: `权限模式：${nextLabel}` }).waitFor({ state: 'visible' });
}

async function waitForDebugger(port, processHandle) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Packaged Electron exited early with code ${processHandle.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // The packaged main process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for the packaged Electron debugger');
}

async function waitForAsteriumPage(browser) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url().startsWith('file:'));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Packaged Electron did not expose its renderer page');
}

async function waitForComposerReady(page, input, timeoutMs) {
  await page.getByRole('button', { name: '发送', exact: true }).waitFor({ state: 'visible', timeout: timeoutMs });
  await input.waitFor({ state: 'visible', timeout: timeoutMs });
}

async function stopProcessTree(processHandle) {
  if (!processHandle.pid || processHandle.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
    return;
  }
  processHandle.kill('SIGTERM');
}

async function waitForProcessExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => processHandle.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
