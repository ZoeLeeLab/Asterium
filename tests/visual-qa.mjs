import { runAutoTest, createTestViteServer as createServer, autoTestEvidence, launchTestBrowser } from './helpers/autoTest.mjs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

await runAutoTest(async () => {
/* global location, window */



const output = autoTestEvidence('visual-qa');
await mkdir(output, { recursive: true });

const browser = await launchTestBrowser(chromium, {
  headless: true,
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
});
const context = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
const page = await context.newPage();
const fixtureServer = await createServer({ configFile: 'vite.renderer.config.ts', server: { host: '127.0.0.1', port: 0 } });
await fixtureServer.listen();
const root = `http://127.0.0.1:${fixtureServer.httpServer.address().port}`;
try {
  const { createTestState } = await fixtureServer.ssrLoadModule(path.resolve('tests/fixtures/applicationState.ts'));
  await page.addInitScript(state => localStorage.setItem('asterium.prototype.v7', JSON.stringify(state)), createTestState());
} finally { /* The managed finalizer closes the fixture server after the browser. */ }
await page.addInitScript(() => {
  let webSearchCredentialConfigured = false;
  window.asteriumAgents = {
    detectClaude: async () => ({ installed: true, loggedIn: true, version: '2.1.198', authMethod: 'test', executableLabel: 'Claude Code' }),
    selectWorkspace: async () => ({ grantId: 'qa-workspace-grant', displayPath: 'C:\\fixture-workspace' }),
    importClaudeSession: async () => ({
      sessionId: '00000001-0000-4000-8000-000000000001',
      sessionFilePath: 'C:\\Users\\QA\\.claude\\projects\\session.jsonl',
      workspaceGrant: { grantId: 'qa-claude-session-grant', displayPath: 'C:\\fixture-workspace' },
    }),
    revokeWorkspaceGrants: async () => undefined,
    sendClaudeMessage: async () => ({ runId: 'qa-run', sessionId: 'qa-session' }),
    cancelRun: async () => undefined,
    resumeSession: async () => undefined,
    saveApiCredential: async () => ({ credentialRef: 'qa-credential-ref', configured: true, masked: '••••••••' }),
    apiCredentialStatus: async (credentialRef) => ({ credentialRef, configured: true, masked: '••••••••' }),
    saveApiPartnerProfile: async (profile) => ({ partnerId: profile.partnerId, directoryName: profile.partnerId, updatedAt: new Date().toISOString(), avatarAvailable: Boolean(profile.publicIdentity?.avatarDataUrl) }),
    deleteApiCredential: async () => undefined,
    saveWebSearchCredential: async () => {
      webSearchCredentialConfigured = true;
      return { configured: true, masked: '••••••••' };
    },
    webSearchCredentialStatus: async () => ({ configured: webSearchCredentialConfigured, masked: webSearchCredentialConfigured ? '••••••••' : '' }),
    deleteWebSearchCredential: async () => { webSearchCredentialConfigured = false; },
    listApiModels: async () => [
      { id: 'deepseek-chat', ownedBy: 'deepseek' },
      { id: 'deepseek-reasoner', ownedBy: 'deepseek' },
    ],
    saveBridgeCredential: async () => ({ credentialRef: 'qa-bridge-credential-ref', configured: true, masked: '••••••••' }),
    bridgeCredentialStatus: async (credentialRef) => ({ credentialRef, configured: true, masked: '••••••••' }),
    deleteBridgeCredential: async () => undefined,
    testExistingThread: async (connection) => ({
      credentialRef: connection.credentialRef,
      configured: true,
      masked: '••••••••',
      authenticated: true,
      threadId: connection.threadId || 'qa-thread-current',
      workspaceRoot: '/workspace/example-project',
      capabilities: { streamingText: true, cancellation: false, toolEvents: false, fileEvents: false, reconnect: true },
    }),
    watchExistingThread: async (_partnerId, connection) => ({
      credentialRef: connection.credentialRef, configured: true, masked: '••••••••', authenticated: true,
      threadId: connection.threadId || 'qa-thread-current', workspaceRoot: '/workspace/example-project',
      capabilities: { streamingText: true, cancellation: false, toolEvents: false, fileEvents: false, reconnect: true },
    }),
    stopExistingThreadWatch: async () => undefined,
    onEvent: () => () => undefined,
  };
  const attachment = { id: 'attachment-visual', name: '视觉附件.png', mediaType: 'image/png', sizeBytes: 68, createdAt: '2026-09-24T00:00:00.000Z', sentAt: '2026-09-24T00:00:00.000Z', sourceId: 'source-visual', sourceAvailability: 'available', sends: [{ messageId: 'message-visual', sentAt: '2026-09-24T00:00:00.000Z' }], availability: 'available' };
  const attachmentList = [attachment, ...Array.from({ length: 8 }, (_, index) => ({ ...attachment, id: `attachment-visual-${index + 2}`, name: `参考附件-${index + 2}.md`, mediaType: 'text/markdown', sourceId: `source-visual-${index + 2}` }))];
  window.asteriumAttachments = {
    choose: async () => [{ selectionId: 'pending-visual', name: attachment.name, mediaType: attachment.mediaType, sizeBytes: attachment.sizeBytes }],
    discard: async () => undefined,
    commit: async () => [{ id: attachment.id, name: attachment.name, mediaType: attachment.mediaType, sizeBytes: attachment.sizeBytes }],
    list: async () => attachmentList, inspect: async (id) => attachmentList.find((item) => item.id === id) || attachment,
    read: async () => ({ info: { ...attachment, previewKind: 'image' }, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=' }),
    open: async () => undefined, reveal: async () => undefined, copyPath: async () => undefined, exportAs: async () => true,
    saveToProject: async (_attachmentId, _conversationId, projectId) => ({ artifactId: 'visual-attachment-artifact', projectId, contentHash: 'visual-attachment-hash', sizeBytes: attachment.sizeBytes, savedAt: new Date().toISOString(), name: attachment.name, absolutePath: `C:\\QA\\${projectId}\\deliverables\\user\\${attachment.name}`, relativePath: `deliverables\\user\\${attachment.name}` }),
    deleteConversation: async () => undefined,
    thumbnail: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  };
  window.asteriumProjects = {
    chooseLocation: async () => ({ selectionId: 'qa-project-selection', path: 'C:\\QA\\Projects\\QA 新项目' }),
    create: async ({ projectId, name }) => ({ version: 1, projectId, name, rootPath: `C:\\QA\\Projects\\${name}`, deliverablesPath: `C:\\QA\\Projects\\${name}\\deliverables`, templateFiles: [
      { name: 'project-plan.md', label: '项目方案计划', relativePath: 'project-plan.md' },
      { name: 'progress.md', label: '项目进度', relativePath: 'progress.md' },
      { name: 'design-guide.md', label: '界面风格设计', relativePath: 'design-guide.md' },
    ], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
    get: async () => null,
    open: async () => undefined,
    openFile: async () => undefined,
  };
});
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(error.message));

async function capture(route, filename) {
  await page.goto(`${root}/#${route}`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
  return page.locator('body').evaluate((element) => ({
    route: location.hash,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
}

const layout = [];
layout.push(await capture('/chat', 'chat-light.png'));
await page.evaluate(() => {
  const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
  const partner = state.partners.find((item) => item.id === state.activePartnerId);
  partner.connectionKind = 'local_codex';
  partner.isPrototype = false;
  localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
});
await page.reload({ waitUntil: 'networkidle' });
const permissionButton = page.getByRole('button', { name: /权限模式：手动审批/ });
await permissionButton.click();
const permissionModesVisible = await Promise.all(['只读', '手动审批', '自动审批', '完整权限'].map((name) => page.getByRole('menuitemradio', { name: new RegExp(name) }).isVisible())).then((items) => items.every(Boolean));
await page.getByRole('menuitemradio', { name: /完整权限/ }).click();
const fullPermissionRed = await page.getByRole('button', { name: /权限模式：完整权限/ }).evaluate((element) => element.classList.contains('permission-button--full'));
await page.getByRole('button', { name: '指令' }).click();
const nativePlanCommandVisible = await page.getByRole('menuitemcheckbox', { name: /计划模式/ }).isEnabled();
await page.getByRole('menuitemcheckbox', { name: /计划模式/ }).click();
const planBannerVisible = await page.getByText(/Plan 模式/).isVisible();
await page.screenshot({ path: `${output}/plan-permission-controls-light.png`, fullPage: true });
await page.getByRole('button', { name: '添加图片或文件' }).click();
await page.getByAltText('视觉附件.png').waitFor();
const supportedImageWarningHidden = await page.getByText(/当前伙伴无法查看其中的图片/).count() === 0;
await page.screenshot({ path: `${output}/attachment-supported-light.png`, fullPage: true });
const attachmentPanel = page.getByLabel('我的附件', { exact: true });
const attachmentPanelScrollable = await attachmentPanel.evaluate((element) => element.scrollHeight > element.clientHeight);
const attachmentRevealVisible = await attachmentPanel.getByTitle('打开原文件所在文件夹').first().isVisible();
await attachmentPanel.getByText('视觉附件.png').click({ button: 'right' });
const attachmentContextOptionsVisible = await Promise.all(['复制原文件路径', '文件另存为', '保存到项目'].map((name) => page.getByRole('button', { name }).isVisible())).then((items) => items.every(Boolean));
await page.screenshot({ path: `${output}/attachment-context-menu-light.png`, fullPage: true });
await page.getByRole('button', { name: '复制原文件路径' }).click();
await page.getByRole('button', { name: '移除 视觉附件.png' }).click();
await page.getByRole('button', { name: '创建对话', exact: true }).click();
const chatDialog = page.getByRole('dialog', { name: '创建对话' });
await page.screenshot({ path: `${output}/chat-create-dialog-light.png`, fullPage: true });
await chatDialog.getByRole('radio', { name: /测试伙伴 B/ }).click();
await chatDialog.getByLabel(/对话名称/).fill('QA 指定伙伴对话');
await chatDialog.getByRole('button', { name: '创建对话' }).click();
const groupedChatVisible = await page.getByText('QA 指定伙伴对话').isVisible();
await page.getByRole('button', { name: '修改对话标题 QA 指定伙伴对话' }).click();
const renameDialog = page.getByRole('dialog', { name: '修改对话标题' });
await renameDialog.getByLabel('对话标题').fill('QA 已改名对话');
await renameDialog.getByRole('button', { name: '保存标题' }).click();
const renamedChatVisible = await page.getByText('QA 已改名对话').isVisible();
const archiveAction = page.getByRole('button', { name: '归档对话 QA 已改名对话' });
const actionOpacityBeforeHover = await archiveAction.evaluate((element) => window.getComputedStyle(element).opacity);
await archiveAction.locator('xpath=..').hover();
const actionOpacityAfterHover = await archiveAction.evaluate((element) => window.getComputedStyle(element).opacity);
await archiveAction.click();
const archiveDialog = page.getByRole('dialog', { name: '归档这段对话？' });
const archiveBoundaryVisible = await archiveDialog.getByText(/不会改变上游线程/).isVisible();
await page.screenshot({ path: `${output}/chat-archive-dialog-light.png`, fullPage: true });
await archiveDialog.getByRole('button', { name: '取消' }).click();
await page.getByRole('button', { name: '置顶 QA 已改名对话' }).click();
const pinnedChatVisible = await page.locator('.pinned-conversations').getByText('QA 已改名对话').isVisible();
await page.getByLabel('搜索聊天记录').fill('QA 已改名');
const searchResultVisible = await page.locator('.partner-groups').getByText('QA 已改名对话').isVisible();
await page.getByLabel('搜索聊天记录').fill('');
await page.getByRole('button', { name: '插件' }).click();
const pluginsPlaceholderVisible = await page.getByRole('dialog', { name: '插件' }).getByText('已启用插件').isVisible();
await page.getByRole('button', { name: '关闭' }).click();
const messagesBefore = await page.locator('.message-row').count();
await page.locator('.composer textarea').fill('视觉验收的本地消息');
await page.getByRole('button', { name: '发送', exact: true }).click();
await page.getByText('视觉验收的本地消息').waitFor();
const messagesAfter = await page.locator('.message-row').count();
await page.waitForTimeout(700);
const messagesAfterDelay = await page.locator('.message-row').count();
await page.getByRole('button', { name: /切换主题/ }).click();
await page.screenshot({ path: `${output}/chat-dark.png`, fullPage: true });
await page.getByRole('button', { name: '工作室' }).click();
await page.waitForURL(/studio\/discussion/);
layout.push(await capture('/studio/discussion', 'discussion-dark.png'));
await page.getByRole('button', { name: '新建项目', exact: true }).click();
const studioDialog = page.getByRole('dialog', { name: '新建工作室群聊' });
await page.screenshot({ path: `${output}/studio-create-dialog-dark.png`, fullPage: true });
await studioDialog.getByRole('button', { name: '创建新项目' }).click();
await page.screenshot({ path: `${output}/studio-create-project-dark.png`, fullPage: true });
await studioDialog.getByLabel(/项目名称/).fill('QA 新项目');
await studioDialog.getByLabel(/群聊名称/).fill('QA 新项目讨论组');
await studioDialog.getByRole('button', { name: '创建并进入' }).click();
await page.getByRole('heading', { name: 'QA 新项目讨论组' }).waitFor();
const newProjectVisible = await page.locator('.studio-project-select').filter({ hasText: 'QA 新项目' }).isVisible();
await page.setViewportSize({ width: 1280, height: 800 });
await page.screenshot({ path: `${output}/discussion-project-1280-dark.png`, fullPage: true });
layout.push(await page.locator('body').evaluate((element) => ({
  route: `${location.hash}:studio-project`,
  scrollWidth: element.scrollWidth,
  clientWidth: element.clientWidth,
  scrollHeight: element.scrollHeight,
  clientHeight: element.clientHeight,
})));
await page.setViewportSize({ width: 1536, height: 1024 });
await page.getByRole('button', { name: '工作区', exact: true }).click();
await page.waitForURL(/studio\/workspace/);
await page.locator('.workspace-view').waitFor();
await page.screenshot({ path: `${output}/workspace-dark.png`, fullPage: true });

await page.getByRole('button', { name: '进入设置' }).click();
await page.waitForURL(/settings\/partners/);
await page.getByRole('heading', { name: '伙伴管理' }).waitFor();
await page.screenshot({ path: `${output}/partners-dark.png`, fullPage: true });
await page.locator('.settings-partner-list > button').first().click();
await page.getByText(/正在查看/).waitFor();
await page.screenshot({ path: `${output}/partners-edit-dark.png`, fullPage: true });
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: '新增伙伴' }).click();
const fixedBridgeVisible = await page.locator('input[value="https://cyberboss.example.invalid"]').isVisible();
await page.getByLabel(/认证信息/).fill('qa-bridge-secret-never-persist');
await page.getByRole('button', { name: '测试真实连接' }).click();
await page.getByText(/星丛会动态跟随 CyberBoss 当前活跃线程/).waitFor();
const bridgeConnectedVisible = await page.getByText(/星丛会动态跟随 CyberBoss 当前活跃线程/).isVisible();
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: '新增伙伴' }).click();
await page.getByRole('button', { name: '邀请本地伙伴', exact: true }).click();
await page.getByRole('button', { name: 'Claude Code' }).click();
await page.getByRole('button', { name: '导入已有会话' }).click();
await page.getByRole('button', { name: '选择 Claude session JSONL' }).click();
await page.getByText('会话原工作目录已固定为伙伴配置来源。').waitFor();
await page.screenshot({ path: `${output}/partners-claude-import-dark.png`, fullPage: true });
const claudeImportVisible = await page.getByText('00000001-0000-4000-8000-000000000001').isVisible();
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: '新增伙伴' }).click();
await page.getByRole('button', { name: '添加新伙伴', exact: true }).click();
await page.screenshot({ path: `${output}/partners-api-dark.png`, fullPage: true });
await page.setViewportSize({ width: 1280, height: 800 });
await page.screenshot({ path: `${output}/partners-api-1280-dark.png`, fullPage: true });
layout.push(await page.locator('body').evaluate((element) => ({
  route: `${location.hash}:api-partner-form`,
  scrollWidth: element.scrollWidth,
  clientWidth: element.clientWidth,
  scrollHeight: element.scrollHeight,
  clientHeight: element.clientHeight,
})));
await page.setViewportSize({ width: 1536, height: 1024 });
await page.getByLabel(/API Key/).fill('qa-secret-never-persist');
await page.getByRole('combobox', { name: /^模型/ }).click();
await page.getByText(/已读取 2 个模型/).waitFor();
const modelOptionsLoaded = await page.getByRole('option', { name: /deepseek-chat/ }).isVisible();
await page.screenshot({ path: `${output}/partners-api-models-dark.png`, fullPage: true });
await page.getByLabel(/显示名称/).fill('视觉验收伙伴');
await page.getByLabel('称呼或 @ 名称').fill('视觉验收伙伴');
await page.getByRole('button', { name: '添加 API 伙伴' }).click();
await page.getByText('视觉验收伙伴 已加入星丛').waitFor();
const persisted = await page.evaluate(() => localStorage.getItem('asterium.prototype.v7') ?? '');
await page.getByRole('button', { name: /加入工作室/ }).click();
await page.waitForURL(/studio\/discussion/);
await page.locator('.member-picker').waitFor({ state: 'visible' });
const pickerVisible = await page.locator('.member-picker').isVisible();
await page.locator('.member-picker > button').filter({ hasText: '视觉验收伙伴' }).click();
const memberVisible = await page.getByText('视觉验收伙伴', { exact: true }).last().isVisible();

await page.evaluate(() => {
  const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
  const partner = state.partners.find((item) => item.publicIdentity?.displayName === '视觉验收伙伴');
  partner.sourceMode = 'api_partner';
  partner.isPrototype = false;
  partner.configured = true;
  const conversation = { id: 'conversation-attachment-unsupported', partnerId: partner.id, title: '附件能力视觉验收', messages: [], updatedAt: new Date().toISOString() };
  state.conversations.push(conversation);
  state.activePartnerId = partner.id;
  state.activeConversationId = conversation.id;
  localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
});
await page.goto(`${root}/#/chat`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: '添加图片或文件' }).click();
await page.getByAltText('视觉附件.png').waitFor();
const unsupportedImageWarningVisible = await page.getByText(/当前伙伴无法查看其中的图片/).isVisible();
await page.screenshot({ path: `${output}/attachment-unsupported-dark.png`, fullPage: true });
await page.getByRole('button', { name: '移除 视觉附件.png' }).click();

await page.setViewportSize({ width: 1280, height: 800 });
layout.push(await capture('/chat', 'chat-1280-dark.png'));
await page.getByRole('button', { name: '归档对话 QA 已改名对话' }).click();
await page.getByRole('dialog', { name: '归档这段对话？' }).getByRole('button', { name: '确认归档' }).click();
await page.getByRole('button', { name: '进入设置' }).click();
await page.getByRole('button', { name: /归档对话 1/ }).click();
const archiveSettingsVisible = await page.getByRole('heading', { name: '归档对话' }).isVisible();
await page.screenshot({ path: `${output}/settings-archives-dark.png`, fullPage: true });
await page.getByRole('button', { name: '权限与安全' }).click();
await page.getByRole('heading', { name: '权限与安全' }).waitFor();
const webSearchAlwaysOnVisible = await page.getByText('免 Key 搜索默认可用').isVisible();
await page.getByLabel(/Brave Search API Key/).fill('qa-brave-secret-never-persist');
await page.getByRole('button', { name: '保存 Brave Key' }).click();
await page.getByText(/Brave Key 已安全保存/).waitFor();
const braveConfiguredVisible = await page.getByText('Brave · 已配置').isVisible();
const webSearchPersisted = await page.evaluate(() => localStorage.getItem('asterium.prototype.v7') ?? '');
await page.screenshot({ path: `${output}/settings-web-security-1280-dark.png`, fullPage: true });
await page.getByRole('button', { name: /外观/ }).click();
await page.waitForTimeout(350);
await page.screenshot({ path: `${output}/settings-web-security-1280-light.png`, fullPage: true });
layout.push(await page.locator('body').evaluate((element) => ({
  route: `${location.hash}:web-security`,
  scrollWidth: element.scrollWidth,
  clientWidth: element.clientWidth,
  scrollHeight: element.scrollHeight,
  clientHeight: element.clientHeight,
})));

console.log(JSON.stringify({
  errors,
  layout,
  localMessageDelta: messagesAfter - messagesBefore,
  delayedMessageDelta: messagesAfterDelay - messagesBefore,
  groupedChatVisible,
  renamedChatVisible,
  archiveBoundaryVisible,
  actionOpacityBeforeHover,
  actionOpacityAfterHover,
  pinnedChatVisible,
  searchResultVisible,
  permissionModesVisible,
  fullPermissionRed,
  nativePlanCommandVisible,
  planBannerVisible,
  pluginsPlaceholderVisible,
  newProjectVisible,
  apiKeyPersisted: persisted.includes('qa-secret-never-persist'),
  bridgeSecretPersisted: persisted.includes('qa-bridge-secret-never-persist'),
  fixedBridgeVisible,
  bridgeConnectedVisible,
  modelOptionsLoaded,
  archiveSettingsVisible,
  webSearchAlwaysOnVisible,
  braveConfiguredVisible,
  braveKeyPersisted: webSearchPersisted.includes('qa-brave-secret-never-persist'),
  claudeImportVisible,
  pickerVisible,
  memberVisible,
  supportedImageWarningHidden,
  unsupportedImageWarningVisible,
  attachmentRevealVisible,
  attachmentPanelScrollable,
  attachmentContextOptionsVisible,
}, null, 2));
await browser.close();
});
