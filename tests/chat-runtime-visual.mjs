import { createServer } from 'vite';
import path from 'node:path';
/* global window, document, HTMLElement, getComputedStyle */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = path.resolve('.qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const context = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
const page = await context.newPage();
const fixtureServer = await createServer({ configFile: 'vite.renderer.config.ts', server: { middlewareMode: true } });
try {
  const { createTestState } = await fixtureServer.ssrLoadModule(path.resolve('tests/fixtures/applicationState.ts'));
  await page.addInitScript(state => localStorage.setItem('asterium.prototype.v7', JSON.stringify(state)), createTestState());
} finally { await fixtureServer.close(); }
await page.addInitScript(() => {
  const artifactNames = ['runtime-notes.md', '界面检查.html', '需求说明.docx', '测试数据.xlsx', '演示文稿.pptx', '交付截图.png', '构建记录.txt', '最终清单.pdf'];
  const artifactName = (id) => artifactNames[id === 'visual-artifact' ? 0 : Number(id.split('-').at(-1))] ?? '交付文件.txt';
  window.asteriumAgents = {
    onEvent: (listener) => {
      window.__asteriumVisualEventListener = listener;
      return () => { window.__asteriumVisualEventListener = undefined; };
    },
    resolveAuthorization: async () => undefined,
  };
  window.asteriumArtifacts = {
    read: async (id) => ({ info: { id, name: artifactName(id), extension: '.md', mediaType: 'text/markdown', sizeBytes: 384, previewKind: 'markdown', sourceKind: 'local_path', registrationMethod: 'automatic', availability: 'available', cached: false, createdAt: new Date().toISOString() }, text: '# Runtime 交付\n\n- 所有事件按顺序保留\n- 文件预览位于聊天区右侧\n\n```ts\nconst status = "ready";\n```' }),
    inspect: async (id) => ({ id, name: artifactName(id), extension: artifactName(id).slice(artifactName(id).lastIndexOf('.')), mediaType: 'application/octet-stream', sizeBytes: 384, previewKind: 'text', sourceKind: 'local_path', registrationMethod: 'automatic', availability: 'available', cached: false, createdAt: new Date().toISOString() }),
    open: async () => undefined, reveal: async () => undefined, copyPath: async () => undefined, saveAs: async () => true, exportAs: async () => true,
  };
});
await page.goto('http://localhost:5173/#/chat', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.setItem('asterium.chat.previewWidth', '420');
  const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
  const conversation = state.conversations.find((item) => item.partnerId === state.activePartnerId) ?? state.conversations[0];
  const visualPartner = state.partners.find((item) => item.id === conversation.partnerId);
  Object.assign(visualPartner, { sourceMode: 'local_cli', connectionKind: 'local_codex', adapterType: 'codex_cli', location: 'local' });
  state.activeConversationId = conversation.id;
  state.activePartnerId = conversation.partnerId;
  conversation.title = 'Runtime 视觉验收';
  conversation.isPinned = true;
  conversation.unreadCompletedAt = '2026-09-30T12:00:00.000Z';
  conversation.messages = [
    { id: 'visual-user', authorId: 'asterium:user:local', content: '请检查这个项目，\n并把结果整理成 **Markdown 文件**。', createdAt: '10:14', status: 'delivered' },
    { id: 'visual-agent', authorId: conversation.partnerId, content: '## 检查完成\n\n项目已经通过类型检查与测试，可以继续下一阶段。', createdAt: '10:15', startedAt: '2026-09-14T10:12:00.000Z', completedAt: '2026-09-14T10:14:36.000Z', runId: 'visual-run', runState: 'completed', timeline: [
      { id: 'e1', sequence: 1, kind: 'reasoning', summary: 'Codex 正在思考…', state: 'success', detail: '先确认项目结构，再依次检查依赖、类型和测试。' },
      { id: 'e2-start', sequence: 2, kind: 'tool', toolCallId: 't1', toolName: 'Read', category: 'file_read', summary: '正在读取 package.json…', state: 'success', detail: '{\n  "path": "package.json"\n}' },
      { id: 'e2-end', sequence: 3, kind: 'tool', toolCallId: 't1', toolName: 'Read', category: 'file_read', summary: '读取 package.json 完成', state: 'success', detail: '读取 42 行。' },
      { id: 'e2-text', sequence: 3.5, kind: 'text', text: '我先看完项目结构和依赖，接下来跑类型检查。' },
      { id: 'e3-start', sequence: 4, kind: 'tool', toolCallId: 't2', toolName: 'Bash', category: 'command', summary: '正在运行 npm run typecheck…', state: 'success', detail: '> npm run typecheck' },
      { id: 'e3-progress', sequence: 5, kind: 'tool', toolCallId: 't2', toolName: 'Bash', category: 'command', summary: '命令正在运行…', state: 'success', detail: '> tsc --noEmit' },
      { id: 'e3-end', sequence: 6, kind: 'tool', toolCallId: 't2', toolName: 'Bash', category: 'command', summary: '类型检查通过', state: 'success', detail: 'Found 0 errors.' },
      { id: 'e4-start', sequence: 7, kind: 'tool', toolCallId: 't3', toolName: 'mcp__ombre_brain__remember', category: 'mcp', summary: '正在调用 MCP ombre_brain…', state: 'success', detail: '{\n  "tool": "remember"\n}' },
      { id: 'e4-end', sequence: 8, kind: 'tool', toolCallId: 't3', toolName: 'mcp__ombre_brain__remember', category: 'mcp', summary: 'MCP ombre_brain 调用完成', state: 'success', detail: '记忆检索完成。' },
      { id: 'e5', sequence: 9, kind: 'reasoning', summary: 'Codex 进入第 2 段思考…', state: 'success', detail: '检查已经通过，接下来整理交付文件。' },
      { id: 'e5-text', sequence: 9.5, kind: 'text', text: '类型和测试都通过了，现在整理交付文件。' },
      { id: 'e6-start', sequence: 10, kind: 'tool', toolCallId: 't4', toolName: 'fileChange', category: 'file_write', summary: '正在写 runtime-notes.md…', state: 'success', detail: '写入检查结果。' },
      { id: 'e6-end', sequence: 11, kind: 'tool', toolCallId: 't4', toolName: 'fileChange', category: 'file_write', summary: '写入 runtime-notes.md 完成', state: 'success', detail: '+8' },
      { id: 'e7-start', sequence: 12, kind: 'computer', toolCallId: 'computer-1', summary: '正在操作电脑', state: 'success' },
      { id: 'e7-end', sequence: 13, kind: 'computer', toolCallId: 'computer-1', summary: '操作电脑成功', state: 'success' },
      { id: 'e8', sequence: 14, kind: 'file', toolCallId: 't4', artifactId: 'visual-artifact', name: 'runtime-notes.md', summary: '产出文件：runtime-notes.md', state: 'success', mediaType: 'text/markdown', sizeBytes: 384, changeKind: 'create' },
      { id: 'e9', sequence: 15, kind: 'text', text: '## 检查完成\n\n项目已经通过类型检查与测试，可以继续下一阶段。\n\n```mermaid\nflowchart LR\n  检查 --> 测试 --> 完成\n```' },
    ] },
  ];
  state.conversations.push({
    id: 'visual-long-scroll', partnerId: conversation.partnerId, title: '长对话滚动验收', updatedAt: new Date().toISOString(),
    messages: Array.from({ length: 80 }, (_, index) => ({ id: `long-${index}`, authorId: index % 2 ? conversation.partnerId : 'asterium:user:local', content: `第 ${index + 1} 条长对话滚动验收消息。`.repeat(4), createdAt: '10:16', status: 'delivered' })),
  });
  conversation.artifacts = ['runtime-notes.md', '界面检查.html', '需求说明.docx', '测试数据.xlsx', '演示文稿.pptx', '交付截图.png', '构建记录.txt', '最终清单.pdf'].map((name, index) => ({ id: index ? `visual-artifact-${index}` : 'visual-artifact', name, artifactRef: index ? `visual-artifact-${index}` : 'visual-artifact', mediaType: index === 5 ? 'image/png' : 'application/octet-stream', sizeBytes: 384 + index * 128, createdAt: new Date().toISOString(), runId: 'visual-run', availability: 'available', sourceKind: 'local_path' }));
  localStorage.setItem('asterium.prototype.v7', JSON.stringify(state));
});
await page.reload({ waitUntil: 'networkidle' });
if (await page.locator('.conversation-unread').count() < 2) throw new Error('Unread completion star is missing from the pinned or grouped title');
await page.getByRole('button', { name: '长对话滚动验收', exact: true }).click();
const conversationSwitchScroll = await page.locator('.message-list').evaluate((list) => ({ distanceFromBottom: list.scrollHeight - list.scrollTop - list.clientHeight, scrollHeight: list.scrollHeight }));
if (conversationSwitchScroll.scrollHeight <= 1_000 || conversationSwitchScroll.distanceFromBottom > 2) throw new Error('Long conversation did not open directly at the latest message');
await page.locator('.pinned-conversations button').filter({ hasText: 'Runtime 视觉验收' }).first().click();
await page.locator('.message-canvas > .composer .composer-toolbar').waitFor();
await page.getByRole('img', { name: 'Mermaid 流程图' }).locator('svg').waitFor();
if (!(await page.getByRole('button', { name: '复制代码' }).count())) throw new Error('Mermaid copy control is unavailable');
const composerMetrics = await page.evaluate(() => {
  const composer = document.querySelector('.message-canvas > .composer');
  const textarea = composer?.querySelector('textarea');
  const toolbar = composer?.querySelector('.composer-toolbar');
  const send = composer?.querySelector('.composer-submit');
  if (!(composer instanceof HTMLElement) || !(textarea instanceof HTMLElement) || !(toolbar instanceof HTMLElement) || !(send instanceof HTMLElement)) throw new Error('Layered composer is unavailable');
  return {
    textareaBottom: textarea.getBoundingClientRect().bottom,
    textareaHeight: textarea.getBoundingClientRect().height,
    textareaRows: textarea.getAttribute('rows'),
    toolbarTop: toolbar.getBoundingClientRect().top,
    sendText: send.textContent?.trim() ?? '',
    hasVoice: Boolean(composer.querySelector('[title="语音功能将在后续接入"]')),
  };
});
if (composerMetrics.toolbarTop < composerMetrics.textareaBottom - 1 || composerMetrics.sendText !== '发送' || composerMetrics.hasVoice) throw new Error('Full composer did not keep the intended two-layer controls');
if (composerMetrics.textareaRows !== '2' || composerMetrics.textareaHeight < 50 || composerMetrics.textareaHeight > 54) throw new Error('Full composer did not keep a compact two-line initial editor height');
await page.getByRole('button', { name: /权限模式：/ }).click();
const permissionPopoverAlignment = await page.locator('.composer-permission-menu').evaluate((menu) => {
  const button = menu.parentElement?.querySelector('button');
  if (!(button instanceof HTMLElement)) throw new Error('Permission anchor is unavailable');
  return { menuLeft: menu.getBoundingClientRect().left, buttonLeft: button.getBoundingClientRect().left, backgroundColor: getComputedStyle(menu).backgroundColor };
});
if (Math.abs(permissionPopoverAlignment.menuLeft - permissionPopoverAlignment.buttonLeft) > 1) throw new Error('Permission popover is not left-aligned to its trigger');
if (/rgba\([^)]*,\s*(?:0|0?\.\d+)\s*\)$/.test(permissionPopoverAlignment.backgroundColor)) throw new Error('Permission popover background is translucent');
await page.screenshot({ path: `${output}/composer-permission-popover-light.png`, fullPage: true });
await page.getByRole('button', { name: /权限模式：/ }).click();
await page.getByRole('button', { name: '指令' }).click();
const commandPopoverAlignment = await page.locator('.composer-command-menu').evaluate((menu) => {
  const button = menu.parentElement?.querySelector('button');
  if (!(button instanceof HTMLElement)) throw new Error('Command anchor is unavailable');
  return { menuLeft: menu.getBoundingClientRect().left, buttonLeft: button.getBoundingClientRect().left };
});
if (Math.abs(commandPopoverAlignment.menuLeft - commandPopoverAlignment.buttonLeft) > 1) throw new Error('Command popover is not left-aligned to its trigger');
await page.getByRole('button', { name: '指令' }).click();
if (!(await page.getByText(/把 runtime-notes\.md 写好了$/).count())) throw new Error('Created file was presented as a modification');
const bubbleMetrics = await page.evaluate(() => {
  const userContent = document.querySelector('.message-row--mine .message-content--user');
  const messageList = document.querySelector('.message-list');
  if (!(userContent instanceof HTMLElement) || !(messageList instanceof HTMLElement)) throw new Error('Message presentation sample is unavailable');
  const row = document.createElement('article');
  row.className = 'message-row';
  row.innerHTML = '<div class="message-stack"><div class="message-bubble-row"><div class="message-bubble"><div class="turn-timeline"><div class="turn-text-segment"><div class="markdown-content"><p>好。</p></div></div></div></div></div></div>';
  messageList.append(row);
  const shortBubble = row.querySelector('.message-bubble');
  const longBubble = document.querySelector('.message-row:not(.message-row--mine) .message-bubble');
  const longText = '这是一段用于测量双方最大宽度的长消息。'.repeat(80);
  const maxAssistantRow = document.createElement('article');
  maxAssistantRow.className = 'message-row';
  maxAssistantRow.innerHTML = `<div class="message-stack"><div class="message-bubble-row"><div class="message-bubble">${longText}</div></div></div>`;
  const maxUserRow = document.createElement('article');
  maxUserRow.className = 'message-row message-row--mine';
  maxUserRow.innerHTML = `<div class="message-stack"><div class="message-bubble-row message-bubble-row--mine"><small class="delivery-state">已送达</small><div class="message-bubble">${longText}</div></div></div>`;
  messageList.append(maxAssistantRow, maxUserRow);
  const result = {
    userWhiteSpace: getComputedStyle(userContent).whiteSpace,
    userText: userContent.textContent ?? '',
    shortWidth: shortBubble?.getBoundingClientRect().width ?? 0,
    longWidth: longBubble?.getBoundingClientRect().width ?? 0,
    maxAssistantWidth: maxAssistantRow.querySelector('.message-bubble')?.getBoundingClientRect().width ?? 0,
    maxUserWidth: maxUserRow.querySelector('.message-bubble')?.getBoundingClientRect().width ?? 0,
    messageStackMaxWidth: getComputedStyle(maxAssistantRow.querySelector('.message-stack')).maxWidth,
  };
  row.remove();
  maxAssistantRow.remove();
  maxUserRow.remove();
  return result;
});
if (bubbleMetrics.userWhiteSpace !== 'pre-wrap' || !bubbleMetrics.userText.includes('\n')) throw new Error('User-authored line breaks are not preserved');
if (!(bubbleMetrics.shortWidth > 0 && bubbleMetrics.longWidth > bubbleMetrics.shortWidth * 2)) throw new Error('Assistant bubbles do not size naturally with their content');
if (Math.abs(bubbleMetrics.maxAssistantWidth - bubbleMetrics.maxUserWidth) > 1) throw new Error('User and assistant bubbles do not share the same maximum width');
if (!bubbleMetrics.messageStackMaxWidth.includes('920px')) throw new Error('Chat bubbles did not receive the widened maximum width');
await page.evaluate(() => {
  const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
  const partner = state.partners.find((item) => item.id === state.activePartnerId);
  const base = {
    protocolVersion: 2,
    partnerId: partner.id,
    conversationId: state.activeConversationId,
    connectionSource: partner.sourceMode,
    clientMessageId: 'visual-authorization-message',
    sessionId: 'visual-authorization-session',
    runId: 'visual-authorization-run',
    occurredAt: new Date().toISOString(),
  };
  window.__asteriumVisualEventListener?.({ ...base, eventId: 'visual-auth-1', sequence: 1, type: 'session.bound', isNew: false });
  window.__asteriumVisualEventListener?.({ ...base, eventId: 'visual-auth-2', sequence: 2, type: 'message.accepted' });
  window.__asteriumVisualEventListener?.({ ...base, eventId: 'visual-auth-3', sequence: 3, type: 'tool.started', toolCallId: 'visual-write', toolName: 'write_file', summary: 'write_file 正在准备…', mutatesExternalState: true });
  window.__asteriumVisualEventListener?.({ ...base, eventId: 'visual-auth-4', sequence: 4, type: 'authorization.requested', authorizationId: 'visual-authorization', toolCallId: 'visual-write', action: 'write_file', risk: 'high', summary: '测试伙伴请求写入文件。', targets: ['C:\\fixture-workspace\\测试文件-测试伙伴.md'] });
});
await page.getByText('需要你的确认').waitFor();
await page.screenshot({ path: `${output}/authorization-active-light.png`, fullPage: true });
await page.getByRole('button', { name: /切换主题/ }).click();
await page.screenshot({ path: `${output}/authorization-active-dark.png`, fullPage: true });
await page.getByRole('button', { name: /切换主题/ }).click();
await page.evaluate(() => {
  const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
  const partner = state.partners.find((item) => item.id === state.activePartnerId);
  window.__asteriumVisualEventListener?.({
    protocolVersion: 2,
    eventId: 'visual-auth-5',
    partnerId: partner.id,
    conversationId: state.activeConversationId,
    connectionSource: partner.sourceMode,
    clientMessageId: 'visual-authorization-message',
    sessionId: 'visual-authorization-session',
    runId: 'visual-authorization-run',
    sequence: 5,
    occurredAt: new Date().toISOString(),
    type: 'authorization.resolved',
    authorizationId: 'visual-authorization',
    decision: 'allow_once',
  });
});
await page.getByText('已允许 · 写入文件').waitFor({ state: 'visible' });
await page.locator('.timeline-operation--file_write').last().waitFor();
await page.getByRole('status', { name: /仍在工作/ }).waitFor({ state: 'visible' });
const streamScrollDistance = await page.locator('.message-list').evaluate((list) => list.scrollHeight - list.scrollTop - list.clientHeight);
if (streamScrollDistance > 2) throw new Error('Streaming output did not stay anchored to the latest message');
const guidanceInput = page.getByRole('textbox', { name: /输入补充要求/ });
await guidanceInput.fill('先把测试结果补进总结，再继续。');
await page.getByRole('button', { name: '暂存中途消息' }).click();
const pendingGuidance = page.getByLabel('待发送的中途消息');
await pendingGuidance.waitFor();
if (!(await pendingGuidance.getByText('已暂存 · 点击后发送').count())) throw new Error('Mid-run guidance was not staged before sending');
await page.screenshot({ path: `${output}/guidance-staged-light.png`, fullPage: true });
await pendingGuidance.getByRole('button', { name: '取消待发送消息' }).click();
await page.screenshot({ path: `${output}/authorization-resolved-light.png`, fullPage: true });
await page.evaluate(() => {
  const state = JSON.parse(localStorage.getItem('asterium.prototype.v7'));
  const partner = state.partners.find((item) => item.id === state.activePartnerId);
  window.__asteriumVisualEventListener?.({
    protocolVersion: 2,
    eventId: 'visual-auth-6',
    partnerId: partner.id,
    conversationId: state.activeConversationId,
    connectionSource: partner.sourceMode,
    clientMessageId: 'visual-authorization-message',
    sessionId: 'visual-authorization-session',
    runId: 'visual-authorization-run',
    sequence: 6,
    occurredAt: new Date().toISOString(),
    type: 'run.completed',
    finishReason: 'end_turn',
  });
});
await page.getByRole('button', { name: '发送' }).waitFor({ state: 'visible' });
if (await page.getByRole('status', { name: /仍在工作/ }).count()) throw new Error('Stream tail did not clear after the terminal event');
const quoteAction = page.getByRole('button', { name: '引用', exact: true }).first();
await quoteAction.click();
const wholeQuote = page.getByLabel('引用 测试伙伴 A 的完整回复');
await wholeQuote.waitFor();
const collapsedQuoteHeight = await wholeQuote.locator('strong').evaluate((node) => node.getBoundingClientRect().height);
await wholeQuote.getByRole('button', { name: '展开引用' }).click();
const expandedQuoteHeight = await wholeQuote.locator('strong').evaluate((node) => node.getBoundingClientRect().height);
if (expandedQuoteHeight <= collapsedQuoteHeight) throw new Error('Quote card did not expand beyond its one-line preview');
await page.screenshot({ path: `${output}/message-quote-expanded-light.png`, fullPage: true });
await page.getByRole('button', { name: /切换主题/ }).click();
await page.setViewportSize({ width: 1280, height: 800 });
await page.screenshot({ path: `${output}/message-quote-expanded-1280-dark.png`, fullPage: true });
await page.setViewportSize({ width: 1536, height: 1024 });
await page.getByRole('button', { name: /切换主题/ }).click();
await wholeQuote.getByRole('button', { name: '移除引用' }).click();
const selectableBody = page.locator('.assistant-quote-source .markdown-content p').first();
await selectableBody.selectText();
await selectableBody.click({ button: 'right' });
await page.getByRole('menuitem', { name: '引用选中内容' }).click();
const selectionQuote = page.getByLabel('引用 测试伙伴 A 的选中片段');
await selectionQuote.waitFor();
await selectionQuote.getByRole('button', { name: '移除引用' }).click();
const artifactList = page.getByLabel('交付文件', { exact: true });
const artifactMetrics = await artifactList.evaluate((list) => ({ clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, maxHeight: window.getComputedStyle(list).maxHeight }));
if (artifactMetrics.scrollHeight <= artifactMetrics.clientHeight) throw new Error('Artifact delivery list did not become independently scrollable');
const artifactBox = await artifactList.boundingBox();
if (artifactBox) await page.mouse.move(artifactBox.x + artifactBox.width - 3, artifactBox.y + artifactBox.height / 2);
if (!(await artifactList.evaluate((list) => list.classList.contains('artifact-list--scrollbar')))) throw new Error('Artifact scrollbar did not reveal near the right edge');
if (await page.getByText(/ombre_brain|remember/).count()) throw new Error('Internal MCP names leaked into the user-facing runtime');
await page.screenshot({ path: `${output}/chat-runtime-light.png`, fullPage: true });
const completedReasoning = page.locator('details.timeline-reasoning').first();
if (await completedReasoning.getAttribute('open') !== null) throw new Error('Completed reasoning should start collapsed');
await completedReasoning.locator('summary').click();
if (await completedReasoning.getAttribute('open') === null) throw new Error('Reasoning detail did not expand');
await page.screenshot({ path: `${output}/chat-runtime-details-light.png`, fullPage: true });
const runtimePreview = page.locator('.turn-timeline [title="预览 runtime-notes.md"]');
if (!(await runtimePreview.isVisible())) throw new Error('Runtime delivery preview is not independently visible');
await runtimePreview.click();
await page.getByText('Runtime 交付', { exact: true }).waitFor();
await page.screenshot({ path: `${output}/chat-runtime-preview-light.png`, fullPage: true });
await page.getByRole('button', { name: '关闭 runtime-notes.md' }).click();
await page.getByRole('button', { name: /切换主题/ }).click();
await page.setViewportSize({ width: 1280, height: 800 });
await page.screenshot({ path: `${output}/chat-runtime-1280-dark.png`, fullPage: true });
const metrics = await page.locator('body').evaluate((body) => ({ scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight }));
console.log(JSON.stringify({ ...metrics, artifactList: artifactMetrics, bubbles: bubbleMetrics, composer: composerMetrics }));
await browser.close();
